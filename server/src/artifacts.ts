// アーティファクト実体（原本バイト / パース結果）の取得を一箇所に集約する層。
//
// storage_key を「参照の種類」を表す形にして、取得元を隠蔽する:
//   - ローカル保存:  project-<id>/raw/...        → ローカルディスクから読む（従来動作）
//   - Drive 無保存:  drive:<fileId>              → その都度 Google Drive から取得（デプロイ設計 C3）
//
// これにより「原本をサーバーに永続保存しない」への切り替えが、各消費側の散在した getObject を
// 書き換えることなく、この層と取り込み時のキー付与だけで完結する。
//
// 2026-07-28 以降: ネイティブ Google シートは xlsx 化をやめ、Drive からチャンク読みして
// 解析済み構造(ParsedArtifact)を直接作る（drive.ts の streamNativeSheets）。つまりネイティブシートは
// 「原本バイト」を持たない。バイトが要る消費側は materializeWorkbookSource で分岐する。
import { getObject, getJson } from './storage.js';
import { fetchDriveArtifact } from './google/drive.js';
import { parseArtifact, type ParsedArtifact } from './preprocess/parse.js';
import { parseArtifactsInWorker } from './preprocess/parseInWorker.js';

const DRIVE_PREFIX = 'drive:';

/** storage_key が Drive 参照（無保存・都度取得）か */
export function isDriveKey(storageKey: string): boolean {
  return storageKey.startsWith(DRIVE_PREFIX);
}

/** Drive 参照キーを組み立てる（取り込み時に付与） */
export function driveKey(fileId: string): string {
  return `${DRIVE_PREFIX}${fileId}`;
}

/** Drive 参照キーからファイル ID を取り出す */
export function driveIdOf(storageKey: string): string {
  return storageKey.slice(DRIVE_PREFIX.length);
}

/**
 * storage_key から原本バイトを取得する。
 * ネイティブ Google シートは原本バイトを持たないため取得できない（例外）。
 * バイトと構造のどちらでもよい消費側は materializeWorkbookSource / materializeParsed を使う。
 */
export async function materializeBuffer(storageKey: string): Promise<Buffer> {
  if (isDriveKey(storageKey)) {
    const art = await fetchDriveArtifact(driveIdOf(storageKey));
    if (art.kind !== 'buffer') {
      throw new Error('ネイティブ Google シートは原本バイトを持ちません（解析済み構造を使ってください）');
    }
    return art.buffer;
  }
  return getObject(storageKey);
}

/**
 * アーティファクトのパース結果を取得する。
 * ローカル保存モードは保存済み JSON（parsed_key）を読む。無保存モードは parsed_key を持たないので、
 * ネイティブシートは Drive からチャンク読みして解析し、実ファイルは原本を落としてパースし直す
 * （原本相当の構造化物も永続保存しない=C4）。
 */
export async function materializeParsed(row: { storage_key: string; parsed_key: string | null; original_filename: string }): Promise<ParsedArtifact> {
  if (row.parsed_key) return getJson<ParsedArtifact>(row.parsed_key);
  if (isDriveKey(row.storage_key)) {
    const art = await fetchDriveArtifact(driveIdOf(row.storage_key));
    if (art.kind === 'parsed') return art.parsed;
    return parseArtifact(row.original_filename, art.buffer);
  }
  return parseArtifact(row.original_filename, await getObject(row.storage_key));
}

/**
 * 複数アーティファクトのパース結果をまとめて取得する（decode/generate/match の入り口）。
 * 原本バイトの取得（Drive/ディスク I/O）はメイン側で行い、CPU 重量級の exceljs パースだけを
 * ワーカースレッドへ隔離する。単一プロセスでフロント配信・API・/healthz を兼ねる本構成で、
 * パースがイベントループを止めると ALB ヘルスチェックが落ち→単一タスク構成では 503 になるため
 * （2026-07-24 の「重い処理中の 503」対策。関係解析の analyzeArtifactsInWorker と同じ方針）。
 *
 * ネイティブシートはチャンク読みの過程で解析まで終わるためワーカーへ渡す原本が無い。
 * こちらはチャンクごとにネットワーク待ちが挟まりイベントループが解放されるので、
 * まとめてブロックすることはない。ピークを抑えるため Drive 取得は1件ずつ直列で行う。
 * 戻り値は入力 rows と同じ並び（loadArtifacts の ORDER BY id を維持）。
 */
export async function materializeParsedMany(
  rows: { storage_key: string; parsed_key: string | null; original_filename: string }[],
): Promise<ParsedArtifact[]> {
  const result: ParsedArtifact[] = new Array(rows.length);
  const toParse: { index: number; filename: string; buffer: Buffer }[] = [];

  // 保存済み JSON とローカル原本は軽いので並行で読む
  await Promise.all(rows.map(async (row, i) => {
    if (row.parsed_key) { result[i] = await getJson<ParsedArtifact>(row.parsed_key); return; }
    if (isDriveKey(row.storage_key)) return; // Drive は下で直列に処理する
    toParse.push({ index: i, filename: row.original_filename, buffer: await getObject(row.storage_key) });
  }));

  // Drive 参照は1件ずつ。ネイティブシートはここで解析済み構造が返り、実ファイルはパース対象に積む。
  for (const [i, row] of rows.entries()) {
    if (row.parsed_key || !isDriveKey(row.storage_key)) continue;
    const art = await fetchDriveArtifact(driveIdOf(row.storage_key));
    if (art.kind === 'parsed') result[i] = art.parsed;
    else toParse.push({ index: i, filename: row.original_filename, buffer: art.buffer });
  }

  if (toParse.length > 0) {
    const parsed = await parseArtifactsInWorker(toParse.map(t => ({ filename: t.filename, buffer: t.buffer })));
    toParse.forEach((t, k) => { result[t.index] = parsed[k]; });
  }
  return result;
}

/**
 * ExcelJS ワークブックが要る消費側（Q&A のセル参照ツール）向けの供給元。
 * 原本バイトがあるものはバイトで返す（従来どおり全行が見える）。ネイティブ Google シートは
 * バイトが無いので解析済み構造を返し、呼び出し側で組み立ててもらう。
 */
export async function materializeWorkbookSource(
  row: { storage_key: string; parsed_key: string | null; original_filename: string },
): Promise<{ kind: 'buffer'; buffer: Buffer } | { kind: 'parsed'; parsed: ParsedArtifact }> {
  if (isDriveKey(row.storage_key)) {
    const art = await fetchDriveArtifact(driveIdOf(row.storage_key));
    return art.kind === 'buffer' ? { kind: 'buffer', buffer: art.buffer } : { kind: 'parsed', parsed: art.parsed };
  }
  return { kind: 'buffer', buffer: await getObject(row.storage_key) };
}

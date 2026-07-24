// アーティファクト実体（原本バイト / パース結果）の取得を一箇所に集約する層。
//
// storage_key を「参照の種類」を表す形にして、取得元を隠蔽する:
//   - ローカル保存:  project-<id>/raw/...        → ローカルディスクから読む（従来動作）
//   - Drive 無保存:  drive:<fileId>              → その都度 Google Drive から取得（デプロイ設計 C3）
//
// これにより「原本をサーバーに永続保存しない」への切り替えが、各消費側の散在した getObject を
// 書き換えることなく、この層と取り込み時のキー付与だけで完結する。
import { getObject, getJson } from './storage.js';
import { fetchDriveFile } from './google/drive.js';
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

/** storage_key から原本バイトを取得する。Drive 参照なら都度 fetch（作業終了後は呼び出し側で破棄される） */
export async function materializeBuffer(storageKey: string): Promise<Buffer> {
  if (isDriveKey(storageKey)) {
    const { buffer } = await fetchDriveFile(storageKey.slice(DRIVE_PREFIX.length));
    return buffer;
  }
  return getObject(storageKey);
}

/**
 * アーティファクトのパース結果を取得する。
 * ローカル保存モードは保存済み JSON（parsed_key）を読む。無保存モードは parsed_key を持たないので、
 * 原本を都度取得してメモリ上でパースし直す（原本相当の構造化物も永続保存しない=C4）。
 */
export async function materializeParsed(row: { storage_key: string; parsed_key: string | null; original_filename: string }): Promise<ParsedArtifact> {
  if (row.parsed_key) return getJson<ParsedArtifact>(row.parsed_key);
  const buffer = await materializeBuffer(row.storage_key);
  return parseArtifact(row.original_filename, buffer);
}

/**
 * 複数アーティファクトのパース結果をまとめて取得する（decode/generate/match の入り口）。
 * 原本バイトの取得（Drive/ディスク I/O）はメイン側で行い、CPU 重量級の exceljs パースだけを
 * ワーカースレッドへ隔離する。単一プロセスでフロント配信・API・/healthz を兼ねる本構成で、
 * パースがイベントループを止めると ALB ヘルスチェックが落ち→単一タスク構成では 503 になるため
 * （2026-07-24 の「重い処理中の 503」対策。関係解析の analyzeArtifactsInWorker と同じ方針）。
 * 戻り値は入力 rows と同じ並び（loadArtifacts の ORDER BY id を維持）。
 */
export async function materializeParsedMany(
  rows: { storage_key: string; parsed_key: string | null; original_filename: string }[],
): Promise<ParsedArtifact[]> {
  const result: ParsedArtifact[] = new Array(rows.length);
  const toParse: { index: number; filename: string; buffer: Buffer }[] = [];
  // parsed_key があるもの（ローカル保存モード）はメインで JSON を読むだけでパース不要。
  // 無保存モード（デプロイ運用）は parsed_key を持たないので原本を取得してパース対象に積む。
  await Promise.all(rows.map(async (row, i) => {
    if (row.parsed_key) { result[i] = await getJson<ParsedArtifact>(row.parsed_key); return; }
    const buffer = await materializeBuffer(row.storage_key);
    toParse.push({ index: i, filename: row.original_filename, buffer });
  }));
  if (toParse.length > 0) {
    const parsed = await parseArtifactsInWorker(toParse.map(t => ({ filename: t.filename, buffer: t.buffer })));
    toParse.forEach((t, k) => { result[t.index] = parsed[k]; });
  }
  return result;
}

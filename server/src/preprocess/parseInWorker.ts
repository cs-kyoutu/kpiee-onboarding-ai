// アーティファクトのパース（exceljs）をワーカースレッドで走らせる実行器。
//
// なぜワーカーか: Node は単一スレッドで、xlsx パースは 5MB 級で数秒の同期CPU。decode/generate/match は
// collectByRole → loadArtifacts で全ファイルをパースするため、これをメインで回すとイベントループが止まり、
// /healthz が ALB のヘルスチェックに応答できず→タスク不健全判定→単一タスク構成では 503 になる
// （2026-07-24 の「重い処理中の 503」の直接原因。関係解析が analyzeInWorker で解決したのと同じ構図）。
//
// 原本バイトの取得（Drive/ディスク I/O）はメイン側で行い、buffer だけをワーカーへ渡す
// （ワーカーは OAuth トークンや http を持たないため）。パース結果(ParsedArtifact[])は構造化クローンで戻る。
import { Worker } from 'node:worker_threads';
import { parseArtifact, type ParsedArtifact } from './parse.js';

// tsx 実行時は .ts をワーカーで読むため tsx ローダーを渡す。将来 tsc コンパイル運用に切り替わっても
// 壊れないよう、このモジュール自身の拡張子で分岐する（.ts→tsx/.ts、.js→追加フラグ無し/.js）。
// analyzeInWorker.ts と同一方式。
const IS_TS = import.meta.url.endsWith('.ts');
const WORKER_URL = new URL(IS_TS ? './parseWorker.ts' : './parseWorker.js', import.meta.url);
const EXEC_ARGV = IS_TS ? ['--import', 'tsx'] : [];

type WorkerMsg = { ok: true; parsed: ParsedArtifact[] } | { ok: false; error: string };

function runInWorker(files: { filename: string; buffer: Buffer }[]): Promise<ParsedArtifact[]> {
  return new Promise<ParsedArtifact[]>((resolve, reject) => {
    const worker = new Worker(WORKER_URL, { workerData: { files }, execArgv: EXEC_ARGV });
    let settled = false;
    const done = (fn: () => void) => { if (!settled) { settled = true; void worker.terminate(); fn(); } };
    worker.once('message', (msg: WorkerMsg) =>
      done(() => (msg.ok ? resolve(msg.parsed) : reject(new Error(msg.error)))));
    worker.once('error', err => done(() => reject(err)));
    worker.once('exit', code => { if (code !== 0) done(() => reject(new Error(`parse worker exited: ${code}`))); });
  });
}

/**
 * ワーカーで複数アーティファクトをパースする。原本取得はメインで行い、パースはワーカーへ隔離する。
 * ワーカー起動に失敗した場合（tsx ローダー不整合など想定外）だけ、メインスレッドでの逐次パースへ
 * フォールバックする（機能停止を避ける。最悪でもブロッキングするだけで結果は同一）。
 */
export async function parseArtifactsInWorker(
  items: { filename: string; buffer: Buffer }[],
): Promise<ParsedArtifact[]> {
  if (items.length === 0) return [];
  try {
    return await runInWorker(items);
  } catch (e) {
    console.warn(`[parse] ワーカー実行に失敗、メインスレッドでの逐次パースへフォールバック: ${String(e)}`);
    const out: ParsedArtifact[] = [];
    for (const it of items) out.push(await parseArtifact(it.filename, it.buffer));
    return out;
  }
}

// 関係グラフ解析をワーカースレッドで走らせる実行器。
//
// なぜワーカーか: Node は単一スレッドで、関係解析（特に exceljs の xlsx パースは 5MB 級で数秒の
// 同期CPU）はイベントループを丸ごと止める。単一プロセスでフロント配信・API・/healthz を兼ねる本構成では、
// これが「プロジェクト一覧が出るまで待たされる」「ALB ヘルスチェック失敗→タスク再起動→キャッシュ保存前に
// 死んで再計算…」の悪循環（2026-07-15 の全体遅延）の直接原因になる。解析をワーカーへ隔離すれば
// メインループは常に応答でき、一覧表示もヘルスチェックも詰まらない。
//
// 原本バイトの取得（Drive/ディスク I/O）はメイン側で行い、buffer だけをワーカーへ渡す
// （ワーカーは OAuth トークンや http を持たないため）。解析結果(RelationGraph)は構造化クローンで戻る。
import { Worker } from 'node:worker_threads';
import { analyzeArtifacts, type RelationGraph } from './relations.js';

// tsx 実行時は .ts をワーカーで読むため tsx ローダーを渡す。将来 tsc コンパイル運用に切り替わっても
// 壊れないよう、このモジュール自身の拡張子で分岐する（.ts→tsx/.ts、.js→追加フラグ無し/.js）。
const IS_TS = import.meta.url.endsWith('.ts');
const WORKER_URL = new URL(IS_TS ? './relationsWorker.ts' : './relationsWorker.js', import.meta.url);
const EXEC_ARGV = IS_TS ? ['--import', 'tsx'] : [];

type WorkerMsg = { ok: true; graph: RelationGraph } | { ok: false; error: string };

function runInWorker(files: { filename: string; buffer: Buffer }[]): Promise<RelationGraph> {
  return new Promise<RelationGraph>((resolve, reject) => {
    const worker = new Worker(WORKER_URL, { workerData: { files }, execArgv: EXEC_ARGV });
    let settled = false;
    const done = (fn: () => void) => { if (!settled) { settled = true; void worker.terminate(); fn(); } };
    worker.once('message', (msg: WorkerMsg) =>
      done(() => (msg.ok ? resolve(msg.graph) : reject(new Error(msg.error)))));
    worker.once('error', err => done(() => reject(err)));
    worker.once('exit', code => { if (code !== 0) done(() => reject(new Error(`relations worker exited: ${code}`))); });
  });
}

/**
 * ワーカーで関係解析を実行する。原本取得はメインで行い、解析はワーカーへ隔離する。
 * ワーカー起動に失敗した場合（tsx ローダー不整合など想定外）だけ、イベントループ内実行へフォールバックする
 * （analyzeArtifacts はステップ間で setImmediate 譲歩するため、最悪でも単一ステップ分のブロックに収まる）。
 */
export async function analyzeArtifactsInWorker(
  arts: { filename: string; load: () => Promise<Buffer> }[],
): Promise<RelationGraph> {
  const files = await Promise.all(arts.map(async a => ({ filename: a.filename, buffer: await a.load() })));
  try {
    return await runInWorker(files);
  } catch (e) {
    console.warn(`[relations] ワーカー実行に失敗、イベントループ内実行へフォールバック: ${String(e)}`);
    return analyzeArtifacts(files.map(f => ({ filename: f.filename, load: async () => f.buffer })));
  }
}

// 関係グラフ解析ワーカー本体。CPU 重量級（exceljs パース + 数式リネージュ + 手コピー推定）を
// メインのイベントループから隔離するための worker_threads エントリ。
// メイン側で原本バイトを取得（Drive/ディスク I/O）して workerData で渡し、ここでは解析だけ行う。
import { parentPort, workerData } from 'node:worker_threads';
import { analyzeArtifacts, type RawGrid, type RelationInput } from './relations.js';

// 原本バイト経路（xlsx/CSV）と、既に組んだ格子の経路（Drive ネイティブシートのチャンク読み）の両方を受ける。
interface InputFile {
  filename: string;
  buffer?: Uint8Array;
  grids?: RawGrid[];
  rowTotals?: Record<string, number>;
  skipFingerprintSheets?: string[];
}

async function run(): Promise<void> {
  const { files } = workerData as { files: InputFile[] };
  const arts: RelationInput[] = files.map(f => ({
    filename: f.filename,
    ...(f.grids ? { grids: f.grids } : { load: async () => Buffer.from(f.buffer!) }),
    rowTotals: f.rowTotals,
    skipFingerprintSheets: f.skipFingerprintSheets,
  }));
  const graph = await analyzeArtifacts(arts);
  parentPort!.postMessage({ ok: true, graph });
}

run().catch((e: unknown) => {
  parentPort!.postMessage({ ok: false, error: e instanceof Error ? (e.stack ?? e.message) : String(e) });
});

// アーティファクト・パースワーカー本体。exceljs の xlsx パース（5MB 級で数秒の同期CPU）を
// メインのイベントループから隔離するための worker_threads エントリ。
// メイン側で原本バイトを取得（Drive/ディスク I/O）して workerData で渡し、ここではパースだけ行う。
// decode/generate/match は collectByRole 経由で全ファイルをパースするため、ここが詰まると
// /healthz が応答できず ALB がタスクを不健全判定→単一タスク構成では 503 になる（2026-07-24 の 503 の直接原因）。
import { parentPort, workerData } from 'node:worker_threads';
import { parseArtifact, type ParsedArtifact } from './parse.js';

interface InputFile { filename: string; buffer: Uint8Array }

async function run(): Promise<void> {
  const { files } = workerData as { files: InputFile[] };
  const parsed: ParsedArtifact[] = [];
  // 逐次パース（同一ワーカー内なのでイベントループは元々メイン側にあり、ここでの直列化は
  // ワーカー内メモリのピークを抑える意味を持つ）。
  for (const f of files) parsed.push(await parseArtifact(f.filename, Buffer.from(f.buffer)));
  parentPort!.postMessage({ ok: true, parsed });
}

run().catch((e: unknown) => {
  parentPort!.postMessage({ ok: false, error: e instanceof Error ? (e.stack ?? e.message) : String(e) });
});

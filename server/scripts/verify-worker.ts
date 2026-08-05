// ワーカー経路の検証: (1)メインのイベントループを止めないか (2)出力が golden と一致するか。
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { analyzeArtifactsInWorker } from '../src/preprocess/analyzeInWorker.js';
import type { RelationGraph } from '../src/preprocess/relations.js';

const files = process.argv.slice(2);

// メインの 50ms ハートビートで遅延計測（ワーカー隔離なら ~0 のはず）
let expected = Date.now() + 50, maxLag = 0;
const timer = setInterval(() => { const n = Date.now(); const lag = n - expected; expected = n + 50; if (lag > maxLag) maxLag = lag; }, 50);
await new Promise(r => setTimeout(r, 300)); maxLag = 0;

const t0 = Date.now();
const g = await analyzeArtifactsInWorker(files.map(f => ({ filename: path.basename(f).replace(/^\d+-/, ''), load: async () => readFileSync(f) })));
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
clearInterval(timer);

console.log(`ワーカー解析 ${elapsed}s  regions=${g.regions.length} edges=${g.edges.length} warnings=${g.warnings.length}`);
console.log(`メインのイベントループ最大遅延: ${maxLag}ms  ${maxLag < 500 ? '✅ メインは詰まらない' : '⚠ まだブロックしている'}`);

// golden 比較（proj23 用の golden があれば）
function normalize(x: RelationGraph) {
  const edges = [...x.edges].map(e => ({ from: e.from, to: e.to, type: e.type, confidence: e.confidence, evidence: e.evidence, needsConfirmation: !!e.needsConfirmation })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return { regions: [...x.regions].map(r => ({ ...r })).sort((a, b) => a.id.localeCompare(b.id)), edges, warnings: [...x.warnings].sort((a, b) => (a.ref + a.kind).localeCompare(b.ref + b.kind)), sheetStructures: [...x.sheetStructures].sort((a, b) => a.regionId.localeCompare(b.regionId)) };
}
const gp = path.resolve('scripts/.golden/proj23.json');
if (existsSync(gp)) {
  const golden = readFileSync(gp, 'utf8');
  const now = JSON.stringify(normalize(g));
  // edges は最適化で 504 件（集約後は不変）減る。regions/warnings/structs は完全一致すべき。
  const a = JSON.parse(golden), b = JSON.parse(now);
  for (const k of ['regions', 'warnings', 'sheetStructures'] as const) {
    console.log(`${k}: ${JSON.stringify(a[k]) === JSON.stringify(b[k]) ? '✅一致' : `❌差分 golden=${a[k].length} now=${b[k].length}`}`);
  }
  console.log(`edges: golden=${a.edges.length} worker=${b.edges.length}（集約後同値は probe-collapsed で確認済み）`);
}

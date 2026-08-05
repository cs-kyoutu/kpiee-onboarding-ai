// 出力同値検証: analyzeArtifacts の結果を正規化して golden と突き合わせる。
// 使い方:
//   capture: tsx scripts/golden-relations.ts capture <label> <file...>
//   compare: tsx scripts/golden-relations.ts compare <label> <file...>
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { analyzeArtifacts, type RelationGraph } from '../src/preprocess/relations.js';

const [mode, label, ...files] = process.argv.slice(2);
const OUT = path.resolve('scripts/.golden');
mkdirSync(OUT, { recursive: true });
const goldenPath = path.join(OUT, `${label}.json`);

function normalize(g: RelationGraph) {
  const edges = [...g.edges]
    .map(e => ({ from: e.from, to: e.to, type: e.type, confidence: e.confidence, evidence: e.evidence, needsConfirmation: !!e.needsConfirmation }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const regions = [...g.regions].map(r => ({ ...r })).sort((a, b) => a.id.localeCompare(b.id));
  const warnings = [...g.warnings].sort((a, b) => (a.ref + a.kind).localeCompare(b.ref + b.kind));
  const sheetStructures = [...g.sheetStructures].sort((a, b) => a.regionId.localeCompare(b.regionId));
  return { regions, edges, warnings, sheetStructures };
}

const arts = files.map(f => ({ filename: path.basename(f).replace(/^\d+-/, ''), load: async () => readFileSync(f) }));
const t0 = Date.now();
const g = await analyzeArtifacts(arts);
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
const norm = normalize(g);
const json = JSON.stringify(norm);
console.log(`[${label}] ${elapsed}s  regions=${norm.regions.length} edges=${norm.edges.length} warnings=${norm.warnings.length} structs=${norm.sheetStructures.length}`);

if (mode === 'capture') {
  writeFileSync(goldenPath, json);
  console.log(`golden 保存: ${goldenPath}`);
} else if (mode === 'compare') {
  if (!existsSync(goldenPath)) { console.error(`golden なし: ${goldenPath}`); process.exit(2); }
  const golden = readFileSync(goldenPath, 'utf8');
  if (golden === json) {
    console.log(`✅ 完全一致（出力不変）`);
  } else {
    console.error(`❌ 差分あり`);
    // 何がどれだけ違うか概略
    const a = JSON.parse(golden), b = norm;
    for (const k of ['regions', 'edges', 'warnings', 'sheetStructures'] as const) {
      if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) console.error(`  - ${k}: golden=${a[k].length} now=${b[k].length}`);
    }
    const ga = new Set(a.edges.map((e: object) => JSON.stringify(e)));
    const gb = new Set(b.edges.map((e: object) => JSON.stringify(e)));
    const missing = [...ga].filter(x => !gb.has(x)).slice(0, 5);
    const added = [...gb].filter(x => !ga.has(x)).slice(0, 5);
    if (missing.length) console.error(`  失われた辺(例):`, missing);
    if (added.length) console.error(`  増えた辺(例):`, added);
    process.exit(1);
  }
}

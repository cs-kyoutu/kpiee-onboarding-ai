// analyzeArtifacts のファイル単位リファクタが「全グリッド同時保持」版と
// 同一グラフを出すかを検証する diff テスト。
//   - 参照(旧挙動): 全ファイルのグリッドを結合して analyzeGrids に一括投入
//   - 新挙動:        analyzeArtifacts（ファイル単位 + 指紋持ち越し）
// 両者の regions / edges / warnings / sheetStructures が完全一致すれば、
// ピークメモリを「最大単一ファイル」に抑えつつクロスファイル関係も失っていないと言える。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  gridsFromArtifact,
  analyzeGrids,
  analyzeArtifacts,
  type RelationGraph,
} from '../src/preprocess/relations.js';

const SAMPLE_DIR = path.resolve('sample-data');
const FILES = [
  '中間集計シート.xlsx',
  '予実管理_統合ワークブック.xlsx',
  '売上データ.csv',
  '月次帳票.xlsx',
];

// 比較用に順序非依存へ正規化（配列順の揺れで誤検出しないよう安定ソート）
function normalize(g: RelationGraph) {
  const edges = [...g.edges]
    .map(e => ({ from: e.from, to: e.to, type: e.type, confidence: e.confidence, evidence: e.evidence, needsConfirmation: !!e.needsConfirmation }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const regions = [...g.regions].sort((a, b) => a.id.localeCompare(b.id));
  const warnings = [...g.warnings].sort((a, b) => (a.ref + a.kind).localeCompare(b.ref + b.kind));
  const sheetStructures = [...g.sheetStructures].sort((a, b) => a.regionId.localeCompare(b.regionId));
  return { regions, edges, warnings, sheetStructures };
}

async function main() {
  const bufs = FILES.map(f => ({ filename: f, buffer: readFileSync(path.join(SAMPLE_DIR, f)) }));

  // 参照: 全グリッドを結合 → analyzeGrids（リファクタ前 analyzeArtifacts と同等）
  const allGrids = [];
  for (const a of bufs) allGrids.push(...(await gridsFromArtifact(a.filename, a.buffer)));
  const reference = analyzeGrids(allGrids);

  // 新: ファイル単位（遅延ロード。実サーバーでは load が Drive fetch になる）
  const actual = await analyzeArtifacts(bufs.map(a => ({ filename: a.filename, load: async () => a.buffer })));

  const refN = normalize(reference);
  const actN = normalize(actual);

  const refStr = JSON.stringify(refN);
  const actStr = JSON.stringify(actN);

  console.log(`files=${FILES.length}`);
  console.log(`reference: regions=${refN.regions.length} edges=${refN.edges.length} warnings=${refN.warnings.length} structures=${refN.sheetStructures.length}`);
  console.log(`per-file : regions=${actN.regions.length} edges=${actN.edges.length} warnings=${actN.warnings.length} structures=${actN.sheetStructures.length}`);

  // クロスファイルのコピー辺が実際に存在するか（テストの有効性確認）
  const crossCopy = refN.edges.filter(e => e.type === 'copy' && e.from.split('／')[0] !== e.to.split('／')[0]).length;
  console.log(`cross-file copy edges in reference = ${crossCopy}`);

  if (refStr === actStr) {
    console.log('\nRESULT: IDENTICAL ✅  ファイル単位処理は出力を保存している');
    process.exit(0);
  }

  console.error('\nRESULT: MISMATCH ❌');
  // どのセクションが違うか切り分け
  for (const k of ['regions', 'edges', 'warnings', 'sheetStructures'] as const) {
    const a = JSON.stringify((refN as any)[k]);
    const b = JSON.stringify((actN as any)[k]);
    if (a !== b) console.error(`  differs: ${k} (ref len=${(refN as any)[k].length}, act len=${(actN as any)[k].length})`);
  }
  process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });

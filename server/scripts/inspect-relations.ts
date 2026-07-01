// 関係グラフの内訳を点検する診断スクリプト（シート内 vs シート間の比率など）。
// 使い方: npx tsx scripts/inspect-relations.ts "<xlsx の絶対パス>"
import { readFileSync } from 'node:fs';
import { buildGridsFromBuffer, detectRegions, formulaEdges, valueCopyEdges } from '../src/preprocess/relations.js';

const buf = readFileSync(process.argv[2]);
const grids = await buildGridsFromBuffer(buf, 'f');
const regions = grids.flatMap(detectRegions);
const fEdges = formulaEdges(grids, regions);
const up = (a: string, b: string) => (a < b ? `${a}::${b}` : `${b}::${a}`);
const fl = new Set(fEdges.map(e => up(e.from, e.to)));
const vEdges = valueCopyEdges(grids, regions, fl);
const all = [...fEdges, ...vEdges];
const rid = (k: string) => k.slice(0, k.indexOf(':'));

let intra = 0, cross = 0;
const byTypeIntra: Record<string, number> = {};
const byTypeCross: Record<string, number> = {};
const crossPairs = new Set<string>();
const perRegionIntra: Record<string, number> = {};
for (const e of all) {
  const fr = rid(e.from), tr = rid(e.to);
  if (fr === tr) {
    intra++; byTypeIntra[e.type] = (byTypeIntra[e.type] ?? 0) + 1;
    perRegionIntra[fr] = (perRegionIntra[fr] ?? 0) + 1;
  } else {
    cross++; byTypeCross[e.type] = (byTypeCross[e.type] ?? 0) + 1;
    crossPairs.add(`${fr}->${tr}`);
  }
}
console.log(`총 변: ${all.length}`);
console.log(`  시트 내부(intra): ${intra}  (${(intra / all.length * 100).toFixed(1)}%)`);
console.log(`  시트 간(cross)   : ${cross}  (${(cross / all.length * 100).toFixed(1)}%)`);
console.log(`  시트 간 고유 (region쌍): ${crossPairs.size}`);
console.log(`intra 종류별:`, byTypeIntra);
console.log(`cross 종류별:`, byTypeCross);
console.log(`intra 변이 많은 region top10:`);
Object.entries(perRegionIntra).sort((a, b) => b[1] - a[1]).slice(0, 10).forEach(([r, n]) => console.log(`  ${r}: ${n}`));

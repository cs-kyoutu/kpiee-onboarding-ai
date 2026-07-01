// 関係分析の各フェーズ所要時間を計測する診断スクリプト（サーバーを介さず単体実行）。
// 使い方: npx tsx scripts/time-relations.ts "<xlsx の絶対パス>"
import { readFileSync } from 'node:fs';
import { buildGridsFromBuffer, detectRegions, formulaEdges, valueCopyEdges } from '../src/preprocess/relations.js';

const path = process.argv[2];
if (!path) { console.error('usage: tsx scripts/time-relations.ts <xlsx path>'); process.exit(1); }
const buf = readFileSync(path);

const t0 = Date.now();
const grids = await buildGridsFromBuffer(buf, 'f');
const t1 = Date.now();
console.log(`1) exceljs load + grid化 : ${((t1 - t0) / 1000).toFixed(1)}s  (grids=${grids.length}, cells=${grids.reduce((a, g) => a + g.cells.length, 0)})`);

const regions = grids.flatMap(detectRegions);
const t2 = Date.now();
console.log(`2) detectRegions        : ${((t2 - t1) / 1000).toFixed(1)}s  (regions=${regions.length})`);

const fEdges = formulaEdges(grids, regions);
const t3 = Date.now();
console.log(`3) formulaEdges         : ${((t3 - t2) / 1000).toFixed(1)}s  (edges=${fEdges.length})`);

const up = (a: string, b: string) => (a < b ? `${a}::${b}` : `${b}::${a}`);
const formulaLinked = new Set(fEdges.map(e => up(e.from, e.to)));
const vEdges = valueCopyEdges(grids, regions, formulaLinked);
const t4 = Date.now();
console.log(`4) valueCopyEdges       : ${((t4 - t3) / 1000).toFixed(1)}s  (edges=${vEdges.length})`);

console.log(`合計                     : ${((t4 - t0) / 1000).toFixed(1)}s`);

// 各フェーズを計時。各行は即 flush（同期フェーズの境界を確実に出力に残す）。
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  gridsFromArtifact, detectRegions, formulaEdges, valueCopyEdges,
  type RawGrid, type Region, type Edge,
} from '../src/preprocess/relations.js';

const RAW = 'C:/Users/seongjin.park/kpiee-research/onboarding-ai/server/data/storage/project-23/raw';
const files = readdirSync(RAW).map(f => ({ filename: f, buffer: readFileSync(path.join(RAW, f)) }));
const log = (s: string) => process.stdout.write(s + '\n');
const ms = (t: number) => `${((Date.now() - t) / 1000).toFixed(1)}s`;

void (async () => {
  let t = Date.now();
  const grids: RawGrid[] = [];
  for (const a of files) grids.push(...(await gridsFromArtifact(a.filename, a.buffer)));
  log(`parse: ${ms(t)} cells=${grids.reduce((s, g) => s + g.cells.length, 0).toLocaleString()}`);

  t = Date.now();
  const regions: Region[] = grids.flatMap(detectRegions);
  log(`detectRegions: ${ms(t)} regions=${regions.length}`);

  t = Date.now();
  const fEdges: Edge[] = formulaEdges(grids, regions);
  log(`formulaEdges: ${ms(t)} edges=${fEdges.length}`);

  t = Date.now();
  const unordered = (a: string, b: string) => a < b ? `${a}::${b}` : `${b}::${a}`;
  const formulaLinked = new Set(fEdges.map(e => unordered(e.from, e.to)));
  const cEdges: Edge[] = valueCopyEdges(grids, regions, formulaLinked);
  log(`valueCopyEdges: ${ms(t)} edges=${cEdges.length}`);
  log('ALL DONE');
})();

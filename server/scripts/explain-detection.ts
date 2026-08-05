// 関係検出がどこまで効いていて、どこで止まっているかをファイル単位で数える。
// 「数式で書いてあるなら全部辿れるはず」がどこで崩れるかを実データで示すための計測。
// 使い方: npx tsx scripts/explain-detection.ts [プロジェクトdir名]
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { gridsFromArtifact, detectRegions, analyzeArtifacts, type RawGrid, type RelationInput } from '../src/preprocess/relations.js';

const proj = process.argv[2] ?? 'project-23';
const dir = join('data/storage', proj, 'raw');
const files = readdirSync(dir);
const nameOf = (f: string) => f.replace(/^\d{10,}-/, '');
const shortOf = (f: string) => nameOf(f).replace(/^業績管理表2603期 /, '').replace(/ 2601 0213\.xlsx$/, '').replace(/\.xlsx$/, '');

// ---- ファイルごとの素の数字（数式セルがそもそも何個あるか） ----
interface Row {
  file: string; sheets: number; regions: number;
  formulaCells: number; extRefCells: number; valueOnlyRegions: number;
}
const rows: Row[] = [];
for (const f of files) {
  const grids: RawGrid[] = await gridsFromArtifact(nameOf(f), readFileSync(join(dir, f)));
  const regions = grids.flatMap(detectRegions);
  let formulaCells = 0, extRefCells = 0;
  for (const g of grids) {
    for (const c of g.cells) {
      if (!c.formula) continue;
      formulaCells++;
      if (/\[\d+\]/.test(c.formula)) extRefCells++;
    }
  }
  // 「表の中に数式が1つも無い」表 = 値だけの表。数式からは辿れない
  const valueOnlyRegions = regions.filter(r => r.columns.every(c => !c.hasFormula)).length;
  rows.push({ file: shortOf(f), sheets: grids.length, regions: regions.length, formulaCells, extRefCells, valueOnlyRegions });
}

// ---- 実際に検出できた関係 ----
const arts: RelationInput[] = files.map(f => ({ filename: nameOf(f), load: async () => readFileSync(join(dir, f)) }));
const g = await analyzeArtifacts(arts);
const fileOfRegion = new Map(g.regions.map(r => [r.id, r.file]));
const touched = new Set<string>();
for (const e of g.edges) {
  touched.add(e.from.slice(0, e.from.lastIndexOf(':')));
  touched.add(e.to.slice(0, e.to.lastIndexOf(':')));
}
const connectedRegions = g.regions.filter(r => touched.has(r.id)).length;

console.log(`${proj}\n`);
console.log('ファイル別（表の数 / 数式セル / うち外部参照 / 数式ゼロの表）');
for (const r of rows.sort((a, b) => b.formulaCells - a.formulaCells)) {
  console.log(`  ${r.file.padEnd(14)} 表${String(r.regions).padStart(4)}  数式${String(r.formulaCells).padStart(7)}  外部参照${String(r.extRefCells).padStart(7)}  数式ゼロの表 ${r.valueOnlyRegions}/${r.regions}`);
}
const tot = rows.reduce((a, r) => ({
  regions: a.regions + r.regions, formulaCells: a.formulaCells + r.formulaCells,
  extRefCells: a.extRefCells + r.extRefCells, valueOnly: a.valueOnly + r.valueOnlyRegions,
}), { regions: 0, formulaCells: 0, extRefCells: 0, valueOnly: 0 });

console.log(`\n合計: 表 ${tot.regions} / 数式セル ${tot.formulaCells.toLocaleString()}（うち外部参照 ${tot.extRefCells.toLocaleString()}）`);
console.log(`数式が1つも無い表: ${tot.valueOnly} / ${tot.regions}  ← 数式からは辿れない表`);
console.log(`関係が1本以上ついた表: ${connectedRegions} / ${g.regions.length}`);
console.log(`つながらなかった表: ${g.regions.length - connectedRegions}`);

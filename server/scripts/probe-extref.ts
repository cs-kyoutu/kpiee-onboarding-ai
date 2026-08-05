// 外部通合文書参照（=SUM([1]top:end!E6)）が現行パイプラインでどう扱われるかの実測。
// 実データ（法人合計ファイル）に 164,158 件ある支配的パターンをそのまま流す。
//
// 修正前: ファイル間の数式辺 0 件。値が偶然一致した copy 辺だけが、しかも逆向きに出ていた。
// 修正後: [1] を実ファイルへ解決し、保育事業 → 法人合計 の数式辺が出る。
import { analyzeGrids, type RawGrid, type RawCell } from '../src/preprocess/relations.js';
import type { ExternalBook } from '../src/preprocess/externalLinks.js';

const cell = (r: number, c: number, value: string | number | null, formula?: string): RawCell =>
  ({ r, c, value, formula });

const HOIKU = '業績管理表 FY 02 保育事業';
const GOKEI = '業績管理表 FY 00 法人合計';

// 保育事業ブックのシート順（実データと同じ形: top と end の間に明細シートが挟まる）
const hoikuSheets = ['FY 保育事業', 'top', '9101+', 'end'];

// 法人合計が持つ外部参照索引（xlsx の xl/externalLinks から読まれるもの）
const externalBooks: ExternalBook[] = [
  { index: 1, filename: `${HOIKU}.xlsx`, sheetNames: hoikuSheets },
];

/** 保育事業ブックの各シート。top と 9101+ に実績値が入る */
const hoikuGrids: RawGrid[] = hoikuSheets.map(name => ({
  file: HOIKU, name,
  cells: name === 'top' || name === '9101+'
    ? [
      cell(1, 5, '4月'), cell(1, 6, '5月'), cell(1, 7, '6月'),
      ...Array.from({ length: 12 }, (_, i) => [
        cell(2 + i, 5, (name === 'top' ? 1000 : 500) + i * 7),
        cell(2 + i, 6, (name === 'top' ? 2000 : 600) + i * 11),
        cell(2 + i, 7, (name === 'top' ? 3000 : 700) + i * 13),
      ]).flat(),
    ]
    : [cell(1, 1, name)],
  maxR: 13, maxC: 7,
  externalBooks: undefined,
}));

// 法人合計: 実データと同じ =SUM([1]top:end!E6) 形式で保育事業ブックを集計する
const gokei: RawGrid = {
  file: GOKEI, name: 'FY 保育事業',
  cells: [
    cell(1, 5, '4月'), cell(1, 6, '5月'), cell(1, 7, '6月'),
    ...Array.from({ length: 12 }, (_, i) => [
      cell(2 + i, 5, 1500 + i * 14, `=SUM([1]top:end!E${2 + i})`),
      cell(2 + i, 6, 2600 + i * 22, `=SUM([1]top:end!F${2 + i})`),
      cell(2 + i, 7, 3700 + i * 26, `=SUM([1]top:end!G${2 + i})`),
    ]).flat(),
  ],
  maxR: 13, maxC: 7,
  externalBooks,
};

const g = analyzeGrids([...hoikuGrids, gokei]);

console.log('検出された表領域:');
for (const r of g.regions) console.log(`  ${r.id}`);

const fileOfRegion = new Map(g.regions.map(r => [r.id, r.file]));
const fileOfKey = (key: string) => fileOfRegion.get(key.slice(0, key.lastIndexOf(':'))) ?? '(不明)';

console.log(`\n検出された辺: ${g.edges.length} 件`);
for (const e of g.edges) console.log(`  [${e.type}] ${e.from}\n      -> ${e.to}   conf=${e.confidence}`);

const cross = g.edges.filter(e => fileOfKey(e.from) !== fileOfKey(e.to));
const wrongWay = cross.filter(e => fileOfKey(e.from) === GOKEI);
const copyEdges = g.edges.filter(e => e.type === 'copy');
const selfFile = g.edges.filter(e => fileOfKey(e.from) === GOKEI && fileOfKey(e.to) === GOKEI);

const checks: [string, boolean][] = [
  ['ファイルをまたぐ辺が検出される', cross.length > 0],
  ['向きが 保育事業 → 法人合計 になっている', cross.length > 0 && wrongWay.length === 0],
  ['集計元の中間シート（9101+）も辿れている', cross.some(e => e.from.includes('9101+'))],
  ['手修正（copy）として誤検出しない', copyEdges.length === 0],
  ['法人合計ファイル内に実在しない辺を作らない', selfFile.length === 0],
];

let ok = true;
for (const [name, pass] of checks) {
  console.log(`${pass ? '  OK ' : '  NG '} ${name}`);
  if (!pass) ok = false;
}
console.log(`\nファイル間の辺 ${cross.length} 件 / copy 辺 ${copyEdges.length} 件 / 自ファイル内の偽辺 ${selfFile.length} 件`);
process.exit(ok ? 0 : 1);

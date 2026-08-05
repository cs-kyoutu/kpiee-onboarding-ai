// 変形2: 外部参照の「残骸」が同一シートの別列に着地するケース。
// =SUM([1]top:end!E6) を G列に書くと、[1] とシート名が脱落し E6 が自シート参照として解決される。
// この場合 G ← E の「存在しない自ファイル内の辺」が生まれるはず、という仮説の実測。
import { analyzeGrids, type RawGrid, type RawCell } from '../src/preprocess/relations.js';

const cell = (r: number, c: number, value: string | number | null, formula?: string): RawCell =>
  ({ r, c, value, formula });

// 法人合計ファイル単体。E列=手入力の何か / G列=外部ファイルからの集計（実データと同じ形）
const grid: RawGrid = {
  file: '業績管理表 FY 00 法人合計', name: 'FY 保育事業',
  cells: [
    cell(1, 5, 'コード'), cell(1, 6, '名称'), cell(1, 7, '4月実績'),
    ...Array.from({ length: 12 }, (_, i) => [
      cell(2 + i, 5, 9101 + i),
      cell(2 + i, 6, `勘定${i}`),
      cell(2 + i, 7, 55500 + i * 37, `=SUM([1]top:end!E${2 + i})`),
    ]).flat(),
  ],
  maxR: 13, maxC: 7,
};

const g = analyzeGrids([grid]);
console.log(`表領域: ${g.regions.map(r => r.id).join(', ')}`);
console.log(`\n検出された辺: ${g.edges.length} 件`);
for (const e of g.edges) {
  console.log(`  ${e.from}  ->  ${e.to}`);
  console.log(`      type=${e.type} conf=${e.confidence} evidence=${e.evidence}`);
}
if (g.edges.length > 0) {
  console.log('\n★ 実在しない「自ファイル内の辺」が生成された（外部参照の残骸が自シート参照として解決された）');
} else {
  console.log('\n★ 辺は生成されなかった（残骸は捨てられた）');
}

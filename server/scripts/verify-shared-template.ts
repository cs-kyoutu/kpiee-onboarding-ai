// 「共通様式の使い回し」判定の検証。
//
// 見分けたい2つの形（実データで確認した違いをそのまま合成する）:
//   A. 共通様式  … 同じ一覧（部署コード等）が各ブックの中で何枚ものシートに入っている。
//                  どれかが「元」になる関係ではないので、総当たりの手修正辺は出さない。
//   B. 原本の転記 … 原本の列を複数ブックへ1箇所ずつ貼った。これは本物の論点なので必ず残す。
// 判定の分かれ目は「同じ値が1つのブックの中で複数箇所に出るか」。
import { analyzeGrids, type RawGrid, type RawCell } from '../src/preprocess/relations.js';

const cell = (r: number, c: number, value: string | number | null, formula?: string): RawCell =>
  ({ r, c, value, formula });

/** 部署コードの一覧（値だけ・数式なし）を1シートぶん作る */
const codeListSheet = (file: string, name: string): RawGrid => ({
  file, name,
  cells: [
    cell(1, 1, '部署コード'), cell(1, 2, '部署名'),
    ...Array.from({ length: 12 }, (_, i) => [
      cell(2 + i, 1, 401100 + i * 10), cell(2 + i, 2, `部署${String.fromCharCode(65 + i)}`),
    ]).flat(),
  ],
  maxR: 13, maxC: 2,
});

/** 売上明細（値だけ・数式なし）を1シートぶん作る */
const salesSheet = (file: string, name: string): RawGrid => ({
  file, name,
  cells: [
    cell(1, 1, '日付'), cell(1, 2, '売上'),
    ...Array.from({ length: 12 }, (_, i) => [
      cell(2 + i, 1, `2026-01-${String(i + 1).padStart(2, '0')}`), cell(2 + i, 2, 100000 + i * 3137),
    ]).flat(),
  ],
  maxR: 13, maxC: 2,
});

// ---- A: 共通様式。3ブック、各ブックの中に同じ一覧が2枚ずつ ----
const templateGrids: RawGrid[] = ['帳票A', '帳票B', '帳票C'].flatMap(f => [
  codeListSheet(f, 'マスタ1'), codeListSheet(f, 'マスタ2'),
]);
const a = analyzeGrids(templateGrids);

// ---- B: 原本の転記。3ブック、各ブックに1箇所ずつ ----
const fanoutGrids: RawGrid[] = [
  salesSheet('売上データ', 'データ'),
  salesSheet('中間集計シート', '元データ'),
  salesSheet('予実管理', '元データ'),
];
const b = analyzeGrids(fanoutGrids);

const copyOf = (g: typeof a) => g.edges.filter(e => e.type === 'copy');
const checks: [string, boolean, string][] = [
  [
    'A 共通様式: 手修正辺を出さない',
    copyOf(a).length === 0,
    `copy 辺 ${copyOf(a).length} 本`,
  ],
  [
    'A 共通様式: 共通マスタとして1件に集約して報告する',
    (a.sharedTemplates ?? []).length > 0,
    `sharedTemplates ${(a.sharedTemplates ?? []).length} 件`,
  ],
  [
    'B 原本の転記: 手修正辺を残す（ブック内で重複しないので様式ではない）',
    copyOf(b).length > 0,
    `copy 辺 ${copyOf(b).length} 本`,
  ],
  [
    'B 原本の転記: 共通マスタとして丸めない',
    (b.sharedTemplates ?? []).length === 0,
    `sharedTemplates ${(b.sharedTemplates ?? []).length} 件`,
  ],
];

let ok = true;
for (const [name, pass, detail] of checks) {
  console.log(`${pass ? '  OK ' : '  NG '} ${name}  … ${detail}`);
  if (!pass) ok = false;
}
for (const t of a.sharedTemplates ?? []) {
  console.log(`\n  共通マスタと判定: 「${t.columnName}」${t.rowCount}行`);
  console.log(`    ${new Set(t.places.map(p => p.file)).size} ブック / 計 ${t.places.length} 箇所`);
}
process.exit(ok ? 0 : 1);

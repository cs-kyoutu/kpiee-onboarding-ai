// 修正1の検証: 分類確認で「最終帳票」と指定したシートが、最終アウトプット判定に届くか。
//
// JTB2 の状況を再現する:
//   - 2601_全社_営業成績表.xlsx … 単月_全社 / 累計_全社 を最終帳票と指定。ファイル間の関係は未検出（独立）
//   - 予算データ_1005.xlsx      … 他ファイルから流入があり流出が無い（自動推定なら「終着点」に見える）
// 期待:
//   - 最終アウトプットは指定した 2601_全社_営業成績表 になる（「ご指定にもとづきます」の文言）
//   - 単月_全社 / 累計_全社 の表役割が「最終アウトプット」になる
//   - 「出所不明の表」ではなく「最終帳票の元データ」を尋ねる問いが立つ
import { buildRelationsReportHtml, summarizeReportQuestions, type RelationsReportInput } from '../src/relationsReport.js';
import type { RelationGraph, Region, Edge } from '../src/preprocess/relations.js';

const region = (file: string, sheet: string, n: number, cols: string[], rows: number): Region => ({
  id: `${file}／${sheet}#${n}`, file, sheet,
  r0: 1, r1: rows + 1, c0: 1, c1: cols.length,
  headerRow: 1, dataRowCount: rows,
  columns: cols.map((name, i) => ({
    c: i + 1, name, hasFormula: false, mixedFormula: false, manualNumeric: 0,
    stats: { filled: rows, uniq: rows, text: 0 },
  })),
} as unknown as Region);

// 2601_全社_営業成績表: 2シート。ファイル内で相互参照（＝どちらも「中間集計」に見える）
const tanS = region('2601_全社_営業成績表', '単月_全社', 1, ['4月', '5月'], 66);
const ruiS = region('2601_全社_営業成績表', '累計_全社', 1, ['4月', '5月'], 66);
// 予算データ_1005: 他ファイルから流入あり・流出なし
const yosan = region('予算データ_1005', '10_account_budget', 1, ['company_code', 'amount'], 1000);
const yosanSrc = region('予算データ_1004', '10_account_budget', 1, ['company_code', 'amount'], 1000);

const edge = (from: string, to: string): Edge =>
  ({ from, to, type: 'aggregation', evidence: '=SUM(...)', confidence: 0.95 } as Edge);

const graph: RelationGraph = {
  regions: [tanS, ruiS, yosan, yosanSrc],
  edges: [
    // ファイル内の相互参照（JTB2 で両シートが「中間集計」になっていた状況）
    edge(`${tanS.id}:4月`, `${ruiS.id}:4月`),
    edge(`${ruiS.id}:5月`, `${tanS.id}:5月`),
    // 予算データ_1004 → 予算データ_1005（自動推定ならこちらが終着点に見える）
    edge(`${yosanSrc.id}:amount`, `${yosan.id}:amount`),
  ],
  warnings: [],
  keyLinks: [],
} as unknown as RelationGraph;

const input: RelationsReportInput = {
  customerName: 'JTB検証', generatedAt: new Date('2026-08-05T00:00:00Z'), fileCount: 3, graph,
  artifacts: [
    {
      filename: '2601_全社_営業成績表.xlsx', kind: 'mixed',
      sheetRoles: { 単月_全社: 'final_output', 累計_全社: 'final_output' },
    },
    {
      filename: '予算データ_1005.xlsx', kind: 'mixed',
      sheetRoles: { '10_account_budget': 'input_data' },
    },
    {
      filename: '予算データ_1004.xlsx', kind: 'mixed',
      sheetRoles: { '10_account_budget': 'input_data' },
    },
  ],
};

const html = buildRelationsReportHtml(input);
const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

const checks: [string, boolean][] = [
  ['最終アウトプットが「ご指定にもとづきます」になる', text.includes('取込時のご指定にもとづきます')],
  ['最終アウトプットに 2601_全社_営業成績表 が挙がる', /最終アウトプットは.*2601_全社_営業成績表/.test(text)],
  ['「自動判定」の文言が消える', !text.includes('流れの終着点から自動判定')],
  ['「最終帳票の元データ」の問いが立つ', text.includes('最終帳票の元データ')],
  ['指定シートを「出所不明の表」で問い直さない', !/出所不明の表[\s\S]{0,200}単月_全社/.test(text)],
];

let ok = true;
for (const [name, pass] of checks) {
  console.log(`${pass ? '  OK ' : '  NG '} ${name}`);
  if (!pass) ok = false;
}

console.log('\n--- 問い一覧 ---');
for (const t of summarizeReportQuestions(input).titles) console.log('  ' + t);

const m = /最終アウトプットは[\s\S]{0,160}/.exec(text);
console.log('\n--- サマリ該当箇所 ---\n  ' + (m ? m[0].trim() : '(見つからず)'));

process.exit(ok ? 0 : 1);

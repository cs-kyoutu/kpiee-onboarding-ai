// レポートの構成（道案内カード → 02 再現するアウトプットの確認 → 03 の確認欄）が
// 実際に出力へ入るかだけを見る煙試験。受領ファイルを読まずに済むよう、関係グラフは空のまま組み立てる。
//
// 使い方:
//   npx tsx scripts/smoke-report-layout.ts
import { buildRelationsReportHtml } from '../src/relationsReport.js';
import { DEFAULT_REPORT_SPEC } from '../src/reportSpec.js';
import type { Region, Edge } from '../src/preprocess/relations.js';

// 小見出し（＝切り口の札が付く場所）は、表と表のつながりが1本でもないと出ない。
// 元→先の2表と、その間の数式1本だけを置く。
const region = (id: string, file: string, sheet: string): Region => ({
  id, file, sheet, r0: 1, r1: 3, c0: 1, c1: 2, headerRow: 1,
  columns: [
    { c: 1, name: '得意先', hasFormula: false, mixedFormula: false, manualNumeric: 0 },
    { c: 2, name: '売上', hasFormula: false, mixedFormula: false, manualNumeric: 2 },
  ],
  dataRowCount: 2,
});
const edge: Edge = {
  from: 'src!A1:B3', to: 'out!A1:B3', type: 'filtered-agg',
  evidence: 'SUMIF($A$2:$A$3,A2,$B$2:$B$3)', confidence: 0.9,
};

const html = buildRelationsReportHtml({
  customerName: '煙試験株式会社',
  generatedAt: new Date('2026-08-18T00:00:00Z'),
  fileCount: 2,
  graph: {
    regions: [region('src!A1:B3', '元データ', 'src'), region('out!A1:B3', '帳票', 'out')],
    edges: [edge], warnings: [], sheetStructures: [],
  },
  artifacts: [
    { filename: '元データ.xlsx', kind: 'source', sheetRoles: { src: 'input' } },
    { filename: '帳票.xlsx', kind: 'output', sheetRoles: { out: 'final_output' } },
  ],
  spec: {
    ...DEFAULT_REPORT_SPEC,
    title: '煙試験レポート',
    howMadeSource: '指示メモ（煙試験）',
    reproduce: [
      { label: '4本グラフ', text: '週次の収支表をもとに<b>経常利益差異</b>を分解したものです。' },
    ],
    howMade: ['元データ → 中間ファイル → 最終アウトプットです。'],
    assumptions: ['取込は縦持ちで揃える前提です。'],
    fileNotes: [{ file: '帳票.xlsx', note: 'この案件の<b>アウトプット</b>です。' }],
    outputPlans: [{
      file: '帳票.xlsx',
      blocks: [
        { kind: 'bullets', title: 'この帳票の形', items: ['横に <b>得意先</b>、縦に月が並びます。'], notes: [] },
        { kind: 'flow', lede: '', repeat: ['売上'], title: '{名}', text: '元データの <b>{名}</b> を月で突き合わせます。',
          key: '月', sourceNote: 'このブックのタブ', sources: ['src'],
          stages: [{ title: '拠点ごとの{名}', note: '' }, { title: '全社の{名}', note: '＝ 合計' }], note: '' },
        { kind: 'check', question: 'この読み方で合っておりますでしょうか。', detail: ['根拠の1文目です。'] },
        { kind: 'graph' },
      ],
    }],
  },
});

const checks: [string, boolean][] = [
  ['道案内カードが出る', html.includes('class="sumcard"') && html.includes('この資料の進め方')],
  ['節が5つ並ぶ', (html.match(/class="skn"/g) ?? []).length === 5],
  ['02 が出る', html.includes('再現するアウトプットの確認')],
  ['再現するもの・作られ方・今回の前提の3箱が出る',
    html.includes('再現するもの') && html.includes('作られ方') && html.includes('今回の前提')],
  ['本文の <b> が生きている', html.includes('<b>経常利益差異</b>')],
  ['切り口の札が出る', html.includes('class="lens"')],
  ['カードのCSSが入る', html.includes('.sumcard{')],
  ['札のCSSが入る', html.includes('.sub-h .lens{')],
  ['帳票の読み方（指定）が出る', html.includes('この帳票の形') && html.includes('横に <b>得意先</b>')],
  ['伺った作り方の流れ図が出る', html.includes('突き合わせるもの') && html.includes('拠点ごとの売上')],
  ['確認欄が 03-A で出る', html.includes('class="chk"') && html.includes('ここをご確認ください　03-A')],
  ['確認欄のCSSが入る', html.includes('.chk{')],
  ['道案内から確認欄を指している', html.includes('<b>03-A</b>')],
  ['ファイルの補足が出る', html.includes('この案件の<b>アウトプット</b>です。')],
  // 表が2つだけの煙試験では関係図そのものが出ない。出るときは必ず付録（開閉）の中に入っていること
  ['関係図が出るなら付録（開閉）に入る',
    !html.includes('class="map-static') || html.includes('表どうしの関係図（クリックで開く・付録）')],
  ['おられる／私たち／うかがっ が残っていない', !/おられ|私たち|うかがっ/.test(html)],
];

let ng = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'OK  ' : 'NG  '}${name}`);
  if (!ok) ng++;
}

// 伺った作り方が無い案件では 02 を出さず、節番号を繰り上げる（既存案件の見た目を変えない）
const plain = buildRelationsReportHtml({
  customerName: '煙試験株式会社',
  generatedAt: new Date('2026-08-18T00:00:00Z'),
  fileCount: 2,
  graph: { regions: [], edges: [], warnings: [], sheetStructures: [] },
});
const plainChecks: [string, boolean][] = [
  ['指定が無ければ 02 を出さない', !plain.includes('再現するアウトプットの確認')],
  ['節番号が繰り上がる（03 が確認事項）', plain.includes('<span class="secno">03</span>ご確認いただきたい点')],
  ['道案内カードは指定が無くても出る', plain.includes('この資料の進め方')],
];
for (const [name, ok] of plainChecks) {
  console.log(`${ok ? 'OK  ' : 'NG  '}${name}`);
  if (!ok) ng++;
}

console.log(ng === 0 ? '\nすべて通りました' : `\n${ng} 件が通りませんでした`);
process.exit(ng === 0 ? 0 : 1);

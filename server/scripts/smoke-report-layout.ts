// レポートの構成（道案内カード → 02 再現するアウトプットの確認 → 03 の確認欄）が
// 実際に出力へ入るかだけを見る煙試験。受領ファイルを読まずに済むよう、関係グラフは空のまま組み立てる。
//
// 使い方:
//   npx tsx scripts/smoke-report-layout.ts
import { buildRelationsReportHtml } from '../src/relationsReport.js';
import { DEFAULT_REPORT_SPEC } from '../src/reportSpec.js';
import type { Region, Edge } from '../src/preprocess/relations.js';

// 最終アウトプットの節は、表と表のつながりが1本でもないと出ない。
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
    // 図の指定が入っていれば、箇条書きの箱ではなく図のほうを出す
    howMadeTable: {
      title: '数字の入り口', head: ['ファイル', '入るタブ'],
      rows: [['<b>元データ.xlsx</b>', '①実績']], note: '伺った内容から整理したものです。',
    },
    howMadeFigure: {
      title: '',
      note: '数値は説明のための例です。',
      groups: [
        { label: '元データ（土台）', tone: 'base', columns: [
          { name: '得意先', sample: '甲社' }, { name: '売上', sample: '500' },
        ] },
        { label: '足すもの', tone: 'ratio', columns: [{ name: '経費', sample: '80' }] },
        { label: '手入力', tone: 'manual', columns: [{ name: '調整', sample: '0' }] },
        { label: '＝利益', tone: 'result', columns: [{ name: '利益', sample: '420' }] },
      ],
      steps: [
        { tag: '土台', tone: 'base', text: 'もとからある<b>売上</b>です。' },
        { tag: '足す', tone: 'ratio', text: '売上の比率で経費を配賦します。' },
        { tag: '手入力', tone: 'manual', text: '調整額は数式が無いため、入力としていただきます。' },
      ],
    },
    assumptions: ['取込は縦持ちで揃える前提です。'],
    fileNotes: [{ file: '帳票.xlsx', note: 'この案件の<b>アウトプット</b>です。' }],
    outputPlans: [{
      file: '帳票.xlsx',
      blocks: [
        { kind: 'bullets', title: 'この帳票の形', items: ['横に <b>得意先</b>、縦に月が並びます。'], notes: [] },
        { kind: 'flow', lede: '', repeat: ['売上'], title: '{名}', text: '元データの <b>{名}</b> を月で突き合わせます。',
          key: '月', sourceNote: 'このブックのタブ', sources: ['src'],
          stages: [{ title: '拠点ごとの{名}', note: '' }, { title: '全社の{名}', note: '＝ 合計' }], note: '' },
        { kind: 'heading', title: '別の帳票の話', lede: 'ここから話が変わります。' },
        { kind: 'steps', title: 'ステップ別の内訳', cards: [
          { title: 'ステップ1', text: '<b>集計得意先CD</b>でそのまま付けます。', steps: [], note: '' },
          { title: 'ステップ2', text: '', note: '※ 残りの出し方で結果が変わります。', steps: [
            { tag: '①集計', tone: 'base', text: '訪問数を集計します。' },
            { tag: '②演算', tone: 'direct', text: '訪問率を計算します。' },
            { tag: '③配賦', tone: 'ratio', text: '人件費 × 訪問率で配賦します。' },
          ] },
        ] },
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
  ['再現するもの・作られ方・再現するうえでの前提の3箱が出る',
    html.includes('再現するもの') && html.includes('作られ方') && html.includes('再現するうえでの前提')],
  ['本文の <b> が生きている', html.includes('<b>経常利益差異</b>')],
  // 小見出し自体が視点を言っているので、「切り口：…」の札は付けない（付けると同じ話の重複になる）
  ['切り口の札が残っていない', !html.includes('class="lens"') && !html.includes('.sub-h .lens{')],
  ['カードのCSSが入る', html.includes('.sumcard{')],
  // 例の値を入れた1行の図（指定があるとき）
  ['作られ方の図が出る',
    html.includes('<figure class="fig">') && html.includes('作られ方（イメージ）')
    && html.includes('<figcaption>')],
  // 図は箇条書きを置き換えず、その下に並ぶ（図に寄せた項目を箇条書きから外すのは指定側の仕事）
  ['箇条書きの箱と図が並ぶ',
    html.includes('<div class="stitle">作られ方</div>')
    && html.indexOf('<div class="stitle">作られ方</div>') < html.indexOf('<figure class="fig">')],
  ['作られ方の表が出る',
    html.includes('数字の入り口') && html.includes('<th>入るタブ</th>')
    && html.indexOf('<th>入るタブ</th>') < html.indexOf('<figure class="fig">')],
  ['図の値と札が出る', html.includes('>甲社<') && html.includes('class="tag base"')],
  ['手入力の色が出る', html.includes('class="tag manual"') && html.includes('.mini-step .tag.manual{')],
  // 札の幅が行ごとに変わると、右の説明の始まる位置がそろわない
  ['札の幅が塊ごとにそろう',
    /class="mini-steps" style="--tagw:\d+px"/.test(html)
    && html.includes('.mini-step .tag{flex:0 0 var(--tagw,auto)')],
  ['図と札のCSSが入る', html.includes('figure.fig{') && html.includes('.mini-step .tag.ratio{')],
  // ステップ別の内訳カード
  // 1ブックに複数のアウトプットがある案件で、話の切れ目が線と見出しで分かること
  ['話の切れ目の見出しが出る',
    html.includes('<h4 class="blk-h">別の帳票の話</h4>') && html.includes('.blk-h{')],
  // 全体関係図の凡例は図の枠の中に入れる（枠を閉じた直後に凡例が来ていたら外へ出ている）。
  // 付録の関係図は静止画と操作版を切り替えるので、凡例は両方の外側に置いたままでよい
  ['全体関係図の凡例が枠の外に出ていない', !/<\/div>\s*<div class="legend">\s*<span class="lg-h">丸＝ファイル/.test(html)],
  ['ステップの内訳カードが出る',
    html.includes('class="stepcard"') && html.includes('ステップ別の内訳')
    && html.includes('<b>集計得意先CD</b>でそのまま付けます。')],
  ['カードの中の手順が札付きで出る',
    html.includes('class="tag direct"') && html.includes('訪問率を計算します。')],
  ['カードのCSSが入る（内訳）', html.includes('.stepcard{') && html.includes('.mini-steps{')],
  ['帳票の読み方（指定）が出る', html.includes('この帳票の形') && html.includes('横に <b>得意先</b>')],
  ['伺った作り方の流れ図が出る', html.includes('突き合わせるもの') && html.includes('拠点ごとの売上')],
  ['確認欄が 03-A で出る', html.includes('class="chk"') && html.includes('ここをご確認ください　03-A')],
  ['確認欄のCSSが入る', html.includes('.chk{')],
  ['道案内から確認欄を指している', html.includes('<b>03-A</b>')],
  ['ファイルの補足が出る', html.includes('この案件の<b>アウトプット</b>です。')],
  // 01 で開くのは最終アウトプットだけ。元データなどは一覧の1行にとどめる
  ['最終アウトプット以外は開閉にしない', (() => {
    const sec = html.slice(html.indexOf('<span class="secno">01'));
    const body = sec.slice(0, sec.indexOf('</section>'));
    return (body.match(/<details class="fileblk/g) ?? []).length
      === (body.match(/<details class="fileblk out"/g) ?? []).length;
  })()],
  // 01 は「どのファイルが何か」まで。列構成と数式の根拠は付録の中だけに出す
  ['列構成は 01 ではなく付録に入る',
    !html.includes('表と列の構成を開く')
    || html.indexOf('付録を開く') < html.indexOf('表と列の構成を開く')],
  // 表が2つだけの煙試験では関係図そのものが出ない。出るときは必ず付録（開閉）の中に入っていること
  ['関係図が出るなら付録（開閉）に入る',
    !html.includes('class="map-static')
    || (html.includes('表どうしの関係図（クリックで開く）')
      && html.indexOf('付録を開く') < html.indexOf('表どうしの関係図（クリックで開く）'))],
  ['おられる／私たち／うかがっ が残っていない', !/おられ|私たち|うかがっ/.test(html)],
  // 設問の見出しは「お答えいただきたいこと」から始める。根拠（どのファイルの何が、どう見えたか）を
  // 前に置くと、質問との間に話が1つ挟まって「結局、何を聞かれているのか」が読めなくなる
  ['設問の見出しが聞きたいことから始まる',
    html.includes('各ファイルの更新頻度・ご担当者と、今回いただいた以外に使っているファイルがあるかを教えてください。')],
  ['設問の見出しに ？ と「伺いました。」を使っていない',
    [...html.matchAll(/class="qtitle"[^>]*>(.*?)</g)].every(m => !/？|伺いました。/.test(m[1]))],
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

// 「顧客別営業利益」（★顧客別営業利益試算ver5「メイン」を kpiee 上で再現する）の
// 構造分析レポートを、実ファイル＋業務資料から組み立てる。
//
// この案件は JCD と違い、業務資料が2つ揃っている:
//   要件定義シート … 何がアウトプットで、どのファイルが何番のインプットか、特殊対応（配賦の例外など）
//   顧客別営業利益試算手順.txt … ステップ1〜4 の計算手順（どのファイルから何を付与するか）
// 数式からは読み取れないこの2つを、シート役割・ブック関係・案件の前提としてレポートへ流し込む。
//
// 使い方:
//   npx tsx --max-old-space-size=8192 scripts/simulate-kokyaku-rieki.ts <出力.html>
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';
import { parseArtifact } from '../src/preprocess/parse.js';
import { classifySheetRoles } from '../src/preprocess/classify.js';
import { analyzeArtifacts, fileLabelOf, type RelationInput } from '../src/preprocess/relations.js';
import { buildRelationsReportHtml, type ReportArtifact } from '../src/relationsReport.js';
import { applyDeclaredFileRelations, type DeclaredFileRel, type FileRelType } from '../src/relations/declared.js';
import { DEFAULT_REPORT_SPEC } from '../src/reportSpec.js';

const OUT = process.argv[2] ?? 'C:/Users/seongjin.park/kpiee-research/顧客別営業利益_データ構造分析レポート.html';
const D = 'C:/Users/seongjin.park/Downloads/';

const FILES = [
  '①68期集計得意先別実績.xlsx',
  '②AMEX手数料計算.xlsx',
  '③SPD収支管理表.xlsx',
  '④プロ得意先別実績.xlsx',
  '⑤人件費データ.xlsx',
  '⑥得意先別訪問数.xlsx',
  '⑥拠点別経費.csv',
  '⑦kintone得意先変換表.xlsx',
  '⑧得意先マスタ.xlsx',
  '★顧客別営業利益試算ver5.xlsx',
].filter(f => existsSync(D + f));

// ---- ① 取込相当: 自動判定したシート役割へ、要件定義シートの指定を上書きする ----
// 自動判定は「数式があるか・raw か」しか見ないため、最終アウトプット（メイン）と
// マスタ（得意先マスタ・kintone変換表）を言い当てられない。そこは資料の指定が正。
const ROLE_OVERRIDE: Record<string, Record<string, string>> = {
  // アウトプット。要件定義シート「受領データの確認」でタブ名まで指定されている
  '★顧客別営業利益試算ver5': {
    'メイン': 'final_output',
    // 試算ブックの中に受領データを貼り付けたシートと、計算途中のシートが同居している
    '担当者別経費試算': 'working_sheet',
    'プロ得意先別実績': 'working_sheet',
    'kintone訪問率': 'working_sheet',
    '得意先別エリア経費': 'working_sheet',
    '拠点別配賦経費': 'working_sheet',
    'SPD収支管理表': 'input_data',
    'SPD収支管理表_部門計': 'input_data',
    'AMEX支払手数料': 'input_data',
    '得意先マスタ': 'master_data',
  },
  '①68期集計得意先別実績': { 'Export': 'input_data' },
  '③SPD収支管理表': { 'Export': 'input_data' },
  '④プロ得意先別実績': { 'Export': 'input_data' },
  '⑤人件費データ': { 'Sheet1': 'input_data' },
  '⑥得意先別訪問数': { 'Export': 'input_data' },
  // 要件定義シートでは ⑦ は「その他マスタ」、⑧ は「その他データ」だが、どちらも
  // 明細ではなくコードを引き当てるための表なので、インプットとは分けてマスタとして扱う。
  // kpiee 上の持ち方も変換表であって取り込む明細ではない。
  '⑦kintone得意先変換表': { '*': 'master_data' },  // タブ名が長いので全シート指定
  '⑧得意先マスタ': { 'Sheet1': 'master_data' },
};
// ②AMEX手数料計算 は月次タブが23枚。要件定義では「インプット②」なので全タブをインプット扱い
const ALL_INPUT = new Set(['②AMEX手数料計算', '⑥拠点別経費']);

const log = (s: string) => process.stdout.write(`${new Date().toISOString().slice(11, 19)}  ${s}\n`);
const mb = () => `${Math.round(process.memoryUsage().rss / 1048576)}MB`;

log(`取込: ${FILES.length} ファイル`);
const artifacts: ReportArtifact[] = [];
for (const f of FILES) {
  const label = fileLabelOf(f);
  const parsed = await parseArtifact(basename(f), readFileSync(D + f));
  const cls = classifySheetRoles(parsed);
  const ov = ROLE_OVERRIDE[label] ?? {};
  const roles: Record<string, string> = {};
  for (const [sheet, c] of Object.entries(cls)) {
    roles[sheet] = ALL_INPUT.has(label) ? 'input_data' : (ov[sheet] ?? ov['*'] ?? c.role);
  }
  artifacts.push({ filename: basename(f), kind: 'mixed', sheetRoles: roles });
  log(`  ${f}  ${parsed.sheets.length}シート  rss=${mb()}`);
}

// ---- ③ 関係解析 ----
log('関係解析…');
const t0 = Date.now();
const inputs: RelationInput[] = FILES.map(f => ({ filename: basename(f), load: async () => readFileSync(D + f) }));
const graph = await analyzeArtifacts(inputs);
log(`解析完了 ${((Date.now() - t0) / 1000).toFixed(1)}s  表${graph.regions.length} 辺${graph.edges.length} rss=${mb()}`);

// ---- ブック関係（顧客別営業利益試算手順.txt のステップ1〜4）----
// 手順書は「①へ付与していく」書き方なので、受け渡しの行き先も手順書のとおりに置く。
// 以前はすべてを ★ 宛てにしていたため、
//   ・①が土台であること（他の8ファイルは①へ足されていく）
//   ・⑤人件費データは①ではなく⑥得意先別訪問数へ付くこと
// が図から落ち、9本の線が★へ集まるだけの扇形になっていた。
const OUT_FILE = '★顧客別営業利益試算ver5';
const BASE_FILE = '①68期集計得意先別実績';   // 土台。ここへ足していく
const VISIT_FILE = '⑥得意先別訪問数';
type Rel = {
  from: string; to: string; relType: FileRelType; note: string;
  step?: number; stepTitle?: string; adds?: string;
};
const RELS: Rel[] = [
  // ステップ1：得意先直下
  { from: '⑧得意先マスタ', to: BASE_FILE, relType: 'reference', step: 1, stepTitle: '得意先直下', adds: '部門コード',
    note: 'ステップ1：①へ部門コードを付与。集計得意先CD（J列＝代表コード）と得意先CD（E列＝ユニーク）で突合' },
  { from: '③SPD収支管理表', to: BASE_FILE, relType: 'reference', step: 1, stepTitle: '得意先直下', adds: '管理料・経費合計',
    note: 'ステップ1：①へ管理料・経費合計を付与（集計得意先CD同士）。F列の管理料とJ列の経費の差分がSPDの収支' },
  { from: '②AMEX手数料計算', to: BASE_FILE, relType: 'reference', step: 1, stepTitle: '得意先直下', adds: '手数料金額',
    note: 'ステップ1：①へ手数料金額を付与。②の得意先CDを集計得意先CDへ変換してから突合（E列とQ列を取得）' },
  // ステップ2：エリア人件費の計算（①ではなく⑥へ付くものが2件ある）
  { from: '⑤人件費データ', to: VISIT_FILE, relType: 'reference', step: 2, stepTitle: 'エリア人件費の計算',
    note: 'ステップ2：⑥得意先別訪問数へ作成者の人件費を付与（社員コードで突合）。エリア人件費の元' },
  { from: '⑦kintone得意先変換表', to: VISIT_FILE, relType: 'reference', step: 2, stepTitle: 'エリア人件費の計算',
    note: 'ステップ2：訪問数と集計得意先コードの突合に使用（T列とAB列）' },
  { from: VISIT_FILE, to: BASE_FILE, relType: 'aggregate', step: 2, stepTitle: 'エリア人件費の計算', adds: '顧客別のエリア経費',
    note: 'ステップ2：作成者ごとの顧客別訪問率を算出し、顧客別のエリア経費として①へ付与' },
  // ステップ3：プロ人件費の計算
  { from: '④プロ得意先別実績', to: BASE_FILE, relType: 'aggregate', step: 3, stepTitle: 'プロ人件費の計算', adds: '得意先別粗利構成比',
    note: 'ステップ3：拠点内の得意先別粗利構成比を算出して①へ付与。構成比×プロ本部経費部門計＝得意先別プロ人件費' },
  // ステップ4：その他拠点経費の計算
  { from: '⑥拠点別経費', to: BASE_FILE, relType: 'aggregate', step: 4, stepTitle: 'その他拠点経費の計算', adds: '部門別の販管費合計',
    note: 'ステップ4：部門別の販管費合計を①へ付与。販管費合計から得意先配賦済み経費を引いた残りを拠点内売上構成比で配賦' },
  // 仕上げ：土台の①が、そのまま試算表になる
  { from: BASE_FILE, to: OUT_FILE, relType: 'transcribe',
    note: '売上・粗利の実績。ステップ1〜4を足し込んだ①が試算表の土台として貼り付けられる（備品と備品外に分かれており、非表示で分けている）' },
];
const declared: DeclaredFileRel[] = RELS.map((r, i) => ({
  id: i + 1, fromFile: r.from, toFile: r.to, relType: r.relType, note: r.note,
  origin: 'manual' as const, step: r.step, stepTitle: r.stepTitle, adds: r.adds,
}));

const merged = applyDeclaredFileRelations(graph, declared);

// ---- 案件の前提（要件定義シートの「特殊対応の確認」と、未受領データ）----
const html = buildRelationsReportHtml({
  customerName: '協和医科器械',
  generatedAt: new Date(),
  fileCount: FILES.length,
  graph: merged,
  artifacts,
  declaredFileRels: declared,
  fileRelAudit: merged.fileRelAudit,
  spec: {
    ...DEFAULT_REPORT_SPEC,
    title: '「顧客別営業利益」ご提供データの構造分析レポート',
    // 「〜を確認したいと考えています」に続く語なので、体言止めで書く。今日の場は構築ではなく
    // ロジックの読み合わせなので、「再現できる状態にすること」のような完了形の目標は置かない
    focus: '★顧客別営業利益試算ver5「メイン」が、どのファイルの何から、どう計算されているか',
    // 「表と列の構成」（列名の一覧）は付録として残す。この案件は列名で突合を決めるため、
    // 読み合わせのあとに担当者が開いて確認する使い方になる
    items: { ...DEFAULT_REPORT_SPEC.items, sheetDetails: true },
    // ---- 02 再現するアウトプットの確認 ----
    howMadeSource: '要件定義シート（協和医科器械様_顧客別営業利益pjt）と試算手順（顧客別営業利益試算手順）',
    reproduce: [
      { label: '顧客別営業利益',
        text: '（★顧客別営業利益試算ver5 の <b>メイン</b>）　得意先ごとの <b>売上・粗利</b> に、'
          + '配賦した経費（SPD管理料・AMEX手数料・エリア人件費・プロ人件費・その他拠点経費）を並べて、'
          + '<b>営業利益</b>まで見る表です。月次で経営会議にてご覧になる想定と伺っています。' },
    ],
    howMade: [
      '土台は <b>①68期集計得意先別実績</b>（売上・粗利の実績）です。'
        + 'ここへステップ1〜4で経費を足していき、足し込んだ①がそのまま試算表「メイン」になります。',
      '<b>ステップ1（得意先直下）</b>：⑧得意先マスタから<b>部門コード</b>、③SPD収支管理表から<b>管理料・経費合計</b>、'
        + '②AMEX手数料計算から<b>手数料金額</b>を、①へ付与します（いずれも集計得意先CDで突合。'
        + '②は得意先CDを集計得意先CDへ変換してから突合と伺っています）。',
      '<b>ステップ2（エリア人件費）</b>：⑥得意先別訪問数で作成者ごとの<b>顧客別訪問率</b>を出し、'
        + '⑤人件費データの人件費（社員コードで突合）を掛けて<b>顧客別のエリア経費</b>として①へ付与します。'
        + '訪問数と集計得意先コードの突合には ⑦kintone得意先変換表 を使っていらっしゃいます。',
      '<b>ステップ3（プロ人件費）</b>：④プロ得意先別実績から<b>拠点内の得意先別粗利構成比</b>を出し、'
        + '<b>プロ本部経費部門計</b>に掛けて得意先別のプロ人件費を計算します。',
      '<b>ステップ4（その他拠点経費）</b>：⑥拠点別経費の<b>部門別の販管費合計</b>から、'
        + 'ステップ1〜3で得意先へ配賦済みの経費を引き、<b>残りを拠点内売上構成比で配賦</b>します。',
    ],
    assumptions: [
      '<b>「集計得意先コード」は得意先の代表コード、「得意先コード」はユニークな得意先</b>'
        + '（⑧得意先マスタ J列・E列）として扱っております。',
      '⑦kintone得意先変換表・⑧得意先マスタは、月々の実績データ（インプット）ではなく'
        + '<b>コードを引き当てるマスタ</b>として分けて整理しております。',
      '配賦基準の計算では、<b>粗利が負の場合は 0</b> として扱う前提で伺っております。',
      '検算は<b>拠点ごとの合算（販管費合計の一致）</b>で確認する前提です。',
      '要件定義シートの<b>組織マスタ・科目マスタ</b>は空欄のため、まだいただいていないものとして整理しております。',
    ],
    // ---- 01 のファイルごとの補足（要件定義シート「受領データの確認」の種別・更新頻度・備考）----
    fileNotes: [
      { file: '★顧客別営業利益試算ver5.xlsx',
        note: '<b>アウトプット</b>（月次）。要件定義シートでは対象タブを「メイン」と伺っております。'
          + '受領データを貼り付けたタブと計算途中のタブが、同じブックの中に同居しています。' },
      { file: '①68期集計得意先別実績.xlsx',
        note: '<b>インプット①</b>（月次・Export）。売上／粗利の実績が<b>備品と備品外</b>に分かれています'
          + '（非表示で分けており、備品には波があるためご確認したい、と伺っております）。' },
      { file: '②AMEX手数料計算.xlsx',
        note: '<b>インプット②</b>（月次・YYYYMM のタブ）。集計結果として <b>E列とQ列</b> を取得すれば足りる、'
          + 'と伺っております（手数料率と請求金額の出どころは確認事項です）。' },
      { file: '③SPD収支管理表.xlsx',
        note: '<b>インプット③</b>（月次・Export）。<b>F列（管理料）と J列（経費）の差分</b>で'
          + 'SPD の収支を確認できる、と伺っております。' },
      { file: '④プロ得意先別実績.xlsx',
        note: '<b>インプット④</b>（月次・Export）。集計得意先の記号の扱いが確認事項として挙がっています。' },
      { file: '⑤人件費データ.xlsx',
        note: '<b>インプット⑤</b>（月次・Sheet1）。仮のデータで、<b>社員コード</b>に紐づけて得意先まで'
          + '突合する（合計金額を使う）と伺っております。' },
      { file: '⑥拠点別経費.csv',
        note: '<b>インプット⑥</b>（月次）。<b>すべての販管費</b>が入っており（予実対比表からも集計可能）、'
          + 'ここから得意先へ配賦済みの経費を引いた残りを、拠点内の売上比率で按分すると伺っております。' },
      { file: '⑥得意先別訪問数.xlsx',
        note: '<b>インプット⑦</b>（月次・Export）。社員の人件費を顧客へ按分するための<b>配賦基準</b>です。' },
      { file: '⑦kintone得意先変換表.xlsx',
        note: 'その他マスタ。訪問数と集計得意先コードを突き合わせるための変換表として扱っております。' },
      { file: '⑧得意先マスタ.xlsx',
        note: 'その他マスタ。<b>集計得意先CD（J列）と得意先CD（E列）</b>、部門コードの引き当てに使います。' },
    ],
    // ---- 03 ロジックの確認：配賦の考え方と、確認したい点 ----
    outputPlans: [
      {
        file: '★顧客別営業利益試算ver5.xlsx',
        blocks: [
          // 数式に残らない受け渡し（★へは値貼り付け）なので、自動生成のレシピ図は出ない。
          // 伺った手順のとおりに「何から何ができるか」を1枚にして、ここで読み合わせる
          { kind: 'flow',
            lede: '<b>★顧客別営業利益試算ver5「メイン」</b>は、'
              + '①68期集計得意先別実績（売上・粗利）を土台に、ステップ1〜4で配賦した経費を足して作られています。'
              + 'まず全体の流れをご覧ください。',
            repeat: [], title: '', key: '集計得意先CD', sourceNote: 'いただいたファイル',
            text: '各ファイルの経費を <b>集計得意先CD</b> で ①68期集計得意先別実績 へ突き合わせ、'
              + '得意先ごとの経費を足し上げて <b>営業利益</b> までを出す作りです。',
            sources: [
              '⑧得意先マスタ（部門コード）',
              '③SPD収支管理表（管理料・経費）',
              '②AMEX手数料計算（手数料金額）',
              '⑥得意先別訪問数 ＋ ⑤人件費データ',
              '④プロ得意先別実績（粗利構成比）',
              '⑥拠点別経費（部門別の販管費）',
            ],
            stages: [
              { title: '①68期集計得意先別実績', note: '売上・粗利の実績（備品／備品外）＝ 配賦の土台' },
              { title: '得意先ごとの配賦経費', note: 'ステップ1〜4の経費を、得意先の行へ横に足していく' },
              { title: '顧客別営業利益（メイン）', note: '＝ 粗利 − 配賦した経費' },
            ],
            note: '※ ★へは値を貼る形で運ばれているため、Excel 上に数式の根拠が残っておりません。'
              + 'この図は<b>伺った手順のとおりに描いたもの</b>です。線の向きと、足すものがこれで合っているかをご覧ください。' },
          { kind: 'table', title: '経費を得意先へ配賦する考え方', emphasize: false,
            lede: '試算手順のステップ1〜4を、<b>何を足すのか</b>と<b>何で割り振るのか</b>で並べ直したものです。'
              + '配賦の基準がこれで合っているかをご覧ください。',
            head: ['ステップ', '足すもの', '割り振り方（配賦の基準）'],
            groups: [{ label: '', note: '', rows: [
              ['<b>1</b>　得意先直下',
                '部門コード（⑧）／管理料・経費合計（③）／手数料金額（②）',
                '<b>配賦しません</b>。集計得意先CDで突き合わせて、そのまま得意先の行に付きます。'],
              ['<b>2</b>　エリア人件費',
                '作成者の人件費（⑤）',
                '⑥得意先別訪問数の<b>作成者ごとの顧客別訪問率</b>で按分します。'],
              ['<b>3</b>　プロ人件費',
                'プロ本部経費部門計（未受領）',
                '④プロ得意先別実績の<b>拠点内の得意先別粗利構成比</b>で按分します。'],
              ['<b>4</b>　その他拠点経費',
                '部門別の販管費合計（⑥拠点別経費）',
                '販管費合計から<b>1〜3で配賦済みの経費を引いた残り</b>を、<b>拠点内売上構成比</b>で按分します。'],
            ] }],
            notes: ['※ ステップ4の「残り」の出し方が、配賦の結果を大きく動かします。'
              + '1〜3で引く対象がこの4つでよいかを、あわせてご確認いただけますでしょうか。'] },
          { kind: 'check',
            question: 'ステップ3で使う <b>プロ本部経費部門計</b>（予算対比表の科目695・エリアの部分）は、'
              + '今回まだいただいておりません。この科目の範囲と、いただき方をご教示いただけますでしょうか。',
            detail: [
              '①〜⑧のファイルからは、プロ本部経費の部門計に当たる数値が見つけられませんでした。',
              'そのため<b>ステップ3のプロ人件費</b>は、配賦の基準（得意先別粗利構成比）までは追えているものの、'
                + '金額までは追えていない状態です。',
              '毎月どの資料から取っていらっしゃるかが分かりますと、kpiee 側でも同じ金額を再現できるようになります。',
            ] },
          { kind: 'check',
            question: '配賦基準の計算で、<b>粗利が負の得意先は 0 として扱う</b>前提で伺っております。'
              + 'この扱いで合っておりますでしょうか。',
            detail: [
              'ステップ3の得意先別粗利構成比と、ステップ4の拠点内売上構成比が、この扱いで変わります。',
              '負の値をそのまま合計すると、構成比の分母が小さくなり、ほかの得意先へ配賦される金額が増えます。',
              'kpiee では1つに決めて計算しますので、ご意向をお聞かせいただけますでしょうか。',
            ] },
          { kind: 'recipes' },
          { kind: 'graph' },
        ],
      },
    ],
  },
});
writeFileSync(OUT, html, 'utf8');
log(`レポート: ${OUT} (${Math.round(html.length / 1024)}KB)`);

const txt = html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, '|').replace(/\|+/g, '|');
console.log('\n=== ご確認いただきたい点 ===');
for (const m of txt.matchAll(/(Q-\d\d)\|優先度 (高|中)\|([^|]+)\|([^|]{0,140})/g)) {
  console.log(`  ${m[1]} [${m[2]}/${m[3]}] ${m[4].trim().slice(0, 120)}`);
}

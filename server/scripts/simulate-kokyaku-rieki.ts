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
  '⑨拠点別経費.csv',
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
const ALL_INPUT = new Set(['②AMEX手数料計算', '⑨拠点別経費']);

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
  { from: '⑨拠点別経費', to: BASE_FILE, relType: 'aggregate', step: 4, stepTitle: 'その他拠点経費の計算', adds: '部門別の販管費合計',
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
    // ステップ1〜4は下の図（howMadeFigure）とその読み方で見せるので、ここには並べない。
    // 同じ手順を箇条書きと図で二度読ませると、02 が長くなるわりに分かることは増えない
    howMade: [],
    // ステップ1〜4を箇条書きにすると、読み合わせで頭から読むには長い。得意先1行に列が
    // 足されて営業利益になるまでを1枚の絵にし、細かい条件は 03 のステップ別の内訳で読む
    howMadeFigure: {
      title: '',
      note: '数値は説明のための例（単位：万円）です。実際の値ではございません。',
      groups: [
        { label: '①68期実績（土台）', tone: 'base', columns: [
          { name: '得意先', sample: '甲病院' },
          { name: '売上', sample: '500万円' },
          { name: '粗利', sample: '150万円' },
        ] },
        { label: 'ステップ1・直接付与', tone: 'direct', columns: [
          { name: '部門コード', sample: 'A12' },
          { name: '管理料', sample: '20万円' },
          { name: '手数料', sample: '5万円' },
        ] },
        { label: 'ステップ2・訪問比率', tone: 'ratio', columns: [{ name: 'エリア人件費', sample: '12万円' }] },
        { label: 'ステップ3・粗利比率', tone: 'ratio', columns: [{ name: 'プロ人件費', sample: '8万円' }] },
        { label: 'ステップ4・売上比率', tone: 'ratio', columns: [{ name: 'その他経費', sample: '10万円' }] },
        { label: '＝営業利益', tone: 'result', columns: [{ name: '営業利益', sample: '95万円' }] },
      ],
      steps: [
        { tag: '①土台', tone: 'base', text: 'もとからある売上・粗利' },
        { tag: 'ステップ1', tone: 'direct',
          text: '⑧得意先マスタ・③SPD収支管理表・②AMEX手数料計算から、部門コード・管理料・手数料をそのまま付けます' },
        { tag: 'ステップ2', tone: 'ratio',
          text: '⑥得意先別訪問数の訪問回数の比率で、⑤人件費データの人件費を配賦します' },
        { tag: 'ステップ3', tone: 'ratio', text: '④プロ得意先別実績の粗利の比率で、プロ本部の経費を配賦します' },
        { tag: 'ステップ4', tone: 'ratio', text: '⑨拠点別経費の残りを、売上の比率で配賦します' },
        { tag: '営業利益', tone: 'result', text: '①の粗利－付け加えた経費（ステップ1〜4）です' },
      ],
    },
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
      { file: '⑨拠点別経費.csv',
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
            lede: '',
            repeat: [], title: '', key: '集計得意先CD', sourceNote: 'いただいたファイル',
            text: '得意先ごとに、<b>①68期集計得意先別実績</b>を土台に、<b>集計得意先CD</b>で各ファイルの経費を'
              + '突き合わせて足し込み、<b>営業利益</b>まで出す作りです。',
            sources: [
              '⑧得意先マスタ（部門コード）',
              '③SPD収支管理表（管理料・経費）',
              '②AMEX手数料計算（手数料金額）',
              '⑥得意先別訪問数 ＋ ⑤人件費データ',
              '④プロ得意先別実績（粗利構成比）',
              '⑨拠点別経費（部門別の販管費）',
            ],
            stages: [
              { title: '①68期集計得意先別実績', note: '売上・粗利の実績（備品／備品外）＝ 配賦の土台' },
              { title: '得意先ごとの配賦経費', note: 'ステップ1〜4の経費を、得意先の行へ横に足していく' },
              { title: '顧客別営業利益（メイン）', note: '＝ 粗利 − 配賦した経費' },
            ],
            note: '※ ★へは値を貼る形で運ばれているため、Excel 上に数式の根拠が残っておりません。'
              + 'この図は<b>伺った手順のとおりに描いたもの</b>です。線の向きと、足すものがこれで合っているかをご覧ください。' },
          // 配賦のステップは「何を集めて・何で割って・何を掛けるか」の3手に分かれている。
          // 表に並べると1マスに3手が入って読めないので、ステップごとのカードに分けて置く
          { kind: 'steps', title: 'ステップ別の内訳（集計 → 演算 → 配賦の順）',
            cards: [
              { title: 'ステップ1　得意先直下', steps: [], note: '',
                text: '部門コード（⑧得意先マスタ）・管理料・経費合計（③SPD収支管理表）・'
                  + '手数料金額（②AMEX手数料計算）を、<b>集計得意先CD</b>でそのまま得意先の行に付けます'
                  + '（比率による配賦はありません）。' },
              { title: 'ステップ2　エリア人件費', text: '', note: '',
                steps: [
                  { tag: '①集計', tone: 'base', text: '⑥得意先別訪問数で、担当者ごとの総訪問数を集計します。' },
                  { tag: '②演算', tone: 'direct', text: '得意先ごとの訪問数 ÷ 担当者の総訪問数 ＝ 訪問率（％）を計算します。' },
                  { tag: '③配賦', tone: 'ratio', text: '⑤人件費データの担当者の人件費 × 訪問率 ＝ その得意先へのエリア人件費です。' },
                ] },
              { title: 'ステップ3　プロ人件費', text: '', note: '',
                steps: [
                  { tag: '①集計', tone: 'base', text: '④プロ得意先別実績で、拠点内の得意先ごとの粗利を集計します。' },
                  { tag: '②演算', tone: 'direct', text: '得意先の粗利 ÷ 拠点内の粗利合計 ＝ 粗利構成比（％）を計算します。' },
                  { tag: '③配賦', tone: 'ratio', text: 'プロ本部経費部門計（未受領） × 粗利構成比 ＝ その得意先へのプロ人件費です。' },
                ] },
              { title: 'ステップ4　その他拠点経費', text: '',
                steps: [
                  { tag: '①集計', tone: 'base',
                    text: '⑨拠点別経費の部門別販管費合計から、ステップ1〜3で配賦済みの経費を引いた「残り」を集計します。' },
                  { tag: '②演算', tone: 'direct', text: '得意先の売上 ÷ 拠点内の売上合計 ＝ 売上構成比（％）を計算します。' },
                  { tag: '③配賦', tone: 'ratio', text: '残りの経費 × 売上構成比 ＝ その得意先へのその他拠点経費です。' },
                ],
                note: '※ この「残り」の出し方が、配賦の結果を大きく動かします。'
                  + '1〜3で引く対象がこの4つでよいかを、あわせてご確認いただけますでしょうか。' },
            ] },
          { kind: 'check',
            question: 'ステップ2で使う <b>得意先別エリア経費</b>タブ（★の中）は、何から作っていらっしゃいますか。',
            detail: [
              '①〜⑨のファイルの中に、このタブと列見出しが一致する表が見つけられませんでした。',
              'そのため<b>ステップ2のエリア人件費</b>は、配賦の基準（訪問回数の比率）までは追えているものの、'
                + '金額までは追えていない状態です。',
              '何から作っていらっしゃるかが分かりますと、kpiee 側でも同じ金額を再現できるようになります。',
            ] },
          { kind: 'check',
            question: 'ステップ3で使う <b>プロ本部経費部門計</b>（予算対比表の科目695・エリアの部分）は、'
              + '今回まだいただいておりません。この科目の範囲と、いただき方をご教示いただけますでしょうか。',
            detail: [
              '①〜⑨のファイルからは、プロ本部経費の部門計に当たる数値が見つけられませんでした。',
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

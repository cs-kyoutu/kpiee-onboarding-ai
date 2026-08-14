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
    notes: [
      'いまお使いの ★顧客別営業利益試算ver5「メイン」を、kpiee 上で再現することを目指しています。月次で経営会議にて経営陣がご覧になる想定で、科目単位・顧客単位の実績／予算を対象としています。',
      '「集計得意先コード」は得意先の代表コード、「得意先コード」はユニークな得意先を指すものとして扱っています（⑧得意先マスタ J列・E列）。',
      '⑦kintone得意先変換表・⑧得意先マスタは、月々の実績データ（インプット）ではなくコードを引き当てるマスタとして分けて整理しています。',
      '配賦基準の計算では、粗利が負の場合は 0 として扱う前提でうかがっています。',
      '検算は拠点ごとの合算（販管費合計の一致）で確認する前提です。',
      '「プロ本部経費部門計」（予算対比表の科目695、エリアの部分のみ）は今回まだ受領しておらず、ステップ3のプロ人件費までは追えていません。',
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

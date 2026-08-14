// 「収支報告・4本グラフ」案件（デリカフーズ）の構造分析レポートを、実ファイル＋要件メモから組み立てる。
//
// この案件の特徴は、最終アウトプットが2種あること:
//   ① 収支サマリー（拠点横断。売上・営業利益・経常利益を「前年／予算／月初見込／週次／実績」で並べる）
//   ② 4本グラフ（拠点別。月初見込→各週→確定の経常利益差異を、売上・仕入・変動費・固定費・営業外へ分解）
// どちらも同じ「事業所が毎週入力する収支表」を起点にしているが、集める先が別なので、
// レポートも最終アウトプットごとに「関係図 → ロジック」を2セット並べる構成になる。
//
// シート役割・ブック関係・案件の前提は、いただいた要件メモ（Google スプレッドシート3本）と
// ファイルの中身を突き合わせて、こちらで判定した内容を入れている。数式から読み取れるものは
// 解析（analyzeArtifacts）に任せ、数式に残らないもの（どのファイルからどのファイルへ値を持ち込むか、
// どのシートが最終帳票か）だけを人の判定として渡す、という切り分けは他案件と同じ。
//
// 使い方:
//   npx tsx --max-old-space-size=12288 scripts/simulate-df-shushi.ts <出力.html>
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';
import { parseArtifact } from '../src/preprocess/parse.js';
import { classifySheetRoles } from '../src/preprocess/classify.js';
import { analyzeArtifacts, fileLabelOf, type RelationInput } from '../src/preprocess/relations.js';
import { buildRelationsReportHtml, type ReportArtifact } from '../src/relationsReport.js';
import { applyDeclaredFileRelations, type DeclaredFileRel, type FileRelType } from '../src/relations/declared.js';
import { DEFAULT_REPORT_SPEC } from '../src/reportSpec.js';

const OUT = process.argv[2] ?? 'C:/Users/seongjin.park/kpiee-research/収支報告4本グラフ_データ構造分析レポート.html';
const D = 'C:/Users/seongjin.park/Downloads/';

// 「0. 受け渡しデータ」は数値データではなく、ダッシュボードで再現する対象を示した指示メモ。
// 解析へ混ぜると「どの表ともつながらない表」として確認事項に並んでしまうので、
// ファイル一覧には入れず、案件の前提（spec.notes）で受領した旨を書く。
const FILES = [
  '1. 20260809 7月収支報告（売上_利益 サマリー）7月確定.xlsx',
  '2. 20260802 【神奈川】7月収支分析（7月月初見込vs確定実績).xlsx',
  '3. 月次収支202607_2606Ver.1.7.xlsx',
  '③仮予算 20260410 2027年3月期 DF予算編成（仮予算）.xlsx',
  '④本予算 20260613 2027年3月期 DF予算編成（本予算_編集用）Final.xlsx',
  '⑦【社外秘】【本会議資料】2026年7月度本会議.xlsx',
].filter(f => existsSync(D + f));

const SUMMARY = fileLabelOf('1. 20260809 7月収支報告（売上_利益 サマリー）7月確定.xlsx');
const KANAGAWA = fileLabelOf('2. 20260802 【神奈川】7月収支分析（7月月初見込vs確定実績).xlsx');
const MONTHLY = fileLabelOf('3. 月次収支202607_2606Ver.1.7.xlsx');
const KARI = fileLabelOf('③仮予算 20260410 2027年3月期 DF予算編成（仮予算）.xlsx');
const HON = fileLabelOf('④本予算 20260613 2027年3月期 DF予算編成（本予算_編集用）Final.xlsx');
const HONKAIGI = fileLabelOf('⑦【社外秘】【本会議資料】2026年7月度本会議.xlsx');
const WATASHI = fileLabelOf('0. 20260807 受け渡しデータ.xlsx');

// ---- シート役割（自動判定を、こちらの読み取りで上書きする）----
// 自動判定は「数式があるか・raw か」しか見ないため、どのシートが顧客の見ている帳票なのかは当てられない。
// 4本グラフ・収支サマリー・折れ線グラフが再現対象で、そこへ並べる各バージョン（予算・見込・週次・実績）は
// インプット、という切り分けは要件メモに沿う。
const ROLE_OVERRIDE: Record<string, Record<string, string>> = {
  [SUMMARY]: {
    // 再現対象。拠点×指標の一覧と、そこから作る折れ線・乖離率
    'サマリー': 'final_output',
    '①サマリー': 'final_output',
    '⑮折れ線グラフ_利益': 'final_output',
    '⑯折れ線グラフ_売上': 'final_output',
    '⑰利益乖離率': 'final_output',
    // 並べる元のバージョン。いずれも他ファイル・PCA からの持ち込み
    '②前年': 'input_data',
    '③仮予算': 'input_data',
    '④本予算': 'input_data',
    '⑤修正予算': 'input_data',
    '⑥月初見込': 'input_data',
    '⑦本会議': 'input_data',
    '⑧第1週': 'input_data',
    '⑨第2週': 'input_data',
    '⑩第3週': 'input_data',
    '⑪第4週': 'input_data',
    '⑫1日速報_当月': 'input_data',
    '⑬1日速報_次月': 'input_data',
    '⑭実績': 'input_data',
  },
  [KANAGAWA]: {
    '①2607': 'input_data',        // 事業所が毎週入力する収支表（月初見込・各週・確定）
    '②グラフ用縦表': 'working_sheet', // 標準縦表へコンバートした中間表
    '③利益グラフ（1本）': 'final_output',
    '④利益グラフ（4本）': 'final_output',
    '補足': 'working_sheet',
  },
  // 月次収支は PCA 由来の予算・実績明細と、そこから作る拠点別収支表の集まり。
  // 今回のスコープでは「実績・前年実績の出どころ」として扱う（収支表の再現はその他スコープ）。
  [MONTHLY]: { '*': 'input_data' },
  [KARI]: { '*': 'input_data' },
  [HON]: { '*': 'input_data' },
  [HONKAIGI]: { '*': 'input_data' },
  // データではなく「ダッシュボードで何を再現するか」の指示メモ
  [WATASHI]: { '*': 'working_sheet' },
};

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
    roles[sheet] = ov[sheet] ?? ov['*'] ?? c.role;
  }
  artifacts.push({ filename: basename(f), kind: 'mixed', sheetRoles: roles });
  log(`  ${f}  ${parsed.sheets.length}シート  rss=${mb()}`);
}

// ---- 関係解析（数式から読み取れる部分）----
log('関係解析…');
const t0 = Date.now();
const inputs: RelationInput[] = FILES.map(f => ({ filename: basename(f), load: async () => readFileSync(D + f) }));
const graph = await analyzeArtifacts(inputs);
log(`解析完了 ${((Date.now() - t0) / 1000).toFixed(1)}s  表${graph.regions.length} 辺${graph.edges.length} rss=${mb()}`);

// ---- ブック関係（数式に残らない受け渡し。こちらの読み取り）----
// 値貼り付けで運ばれているため数式の根拠は無い。読み合わせで確認する前提で、
// 「どのファイルの何を、どこへ持ち込んでいるか」を説明として渡す。
const RELS: [string, string, FileRelType, string][] = [
  [KANAGAWA, SUMMARY, 'transcribe',
    '各事業所の週次の見込（月初見込・第1〜4週）を、サマリーの「⑥月初見込」「⑧第1週」〜「⑪第4週」へ拠点の列に並べておられると読み取りました。神奈川の 7 月（売上 414,000 千円／経常利益 34,043 千円）が両方で一致しています。'],
  [MONTHLY, SUMMARY, 'transcribe',
    '確定実績を、サマリーの「⑭実績」へ拠点の列に並べておられると読み取りました。月次収支は PCA 由来の予算・実績明細をまとめたブックで、前年実績（「②前年」）の出どころもここだと理解しています。'],
  [KARI, SUMMARY, 'transcribe',
    '当初予算（仮予算）の拠点別 売上・営業利益・経常利益を、サマリーの「③仮予算」へ並べておられると読み取りました。'],
  [HON, SUMMARY, 'transcribe',
    '本予算の拠点別 売上・営業利益・経常利益を、サマリーの「④本予算」へ並べておられると読み取りました。'],
  [HONKAIGI, SUMMARY, 'transcribe',
    '本会議で報告した見込値を、サマリーの「⑦本会議」へ並べておられると読み取りました。「⑰利益乖離率」はこの本会議見込と確定実績の差を見る表になっています。'],
  [MONTHLY, KANAGAWA, 'transcribe',
    '4本グラフの「確定」列に入る確定実績は、PCA（月次収支）から持ち込んでおられると理解しています。'],
  [KARI, HON, 'transcribe',
    '仮予算をもとに本予算へ組み替えておられます（本予算ブックの「仮予算⇒本予算」シートが対応表になっています）。'],
];
const declared: DeclaredFileRel[] = RELS.map(([from, to, relType, note], i) => ({
  id: i + 1, fromFile: from, toFile: to, relType, note, origin: 'manual' as const,
}));

const merged = applyDeclaredFileRelations(graph, declared);

const html = buildRelationsReportHtml({
  customerName: 'デリカフーズ',
  generatedAt: new Date(),
  fileCount: FILES.length,
  graph: merged,
  artifacts,
  declaredFileRels: declared,
  fileRelAudit: merged.fileRelAudit,
  spec: {
    ...DEFAULT_REPORT_SPEC,
    title: '「収支報告・4本グラフ」ご提供データの構造分析レポート',
    focus: '拠点別の4本グラフと、拠点を集計した収支サマリーが、どのファイルの何から、どう作られているか',
    notes: [
      'メインスコープは、拠点別の4本グラフ（月初見込→各週→確定の経常利益差異を、売上・仕入・変動費・固定費・営業外へ分解したもの）と、拠点を集計した収支サマリー（売上高・営業利益・経常利益）と理解しています。あわせて収支表の作成も必要とうかがっています。',
      '起点は、各事業所長が毎週入力される収支表（月初目標／各週／確定）です。これを「グラフ用縦表」へコンバートし、指標（月初見込・1週目〜5週目・実績）として取り込む流れで理解しています。',
      '取込形式は「日付／科目コード／科目／月初見込・1週目〜5週目／組織」の縦持ちで揃える前提です。すでにスプレッドシート上でコンバート済みのタブがあるため、そのタブを読む形を想定しています。',
      '実績と前年実績は PCA から、年初予算はスプレッドシートから取得する前提です。',
      '収支サマリーはシート上は経常利益ですが、できれば営業利益を見せたいとうかがっています。',
      '4本グラフの内訳は、売上（売価・数量）／仕入（差損益・単価差・歩留り・廃棄・棚差・その他）／変動費（人件費（製造）・人件費（出荷）・その他変動経費）／固定費／営業外（雑収入）を前提にしています。差異の3分解（売上高差異＝（実績売上高－予算売上高）×予算限界利益率、限界利益率差異＝（実績限界利益率－予算限界利益率）×実績売上高、固定費差異＝実績固定費－予算固定費）も収支表の記載どおりに置いています。',
      '「0. 20260807 受け渡しデータ.xlsx」もいただいていますが、こちらはダッシュボードで再現する対象（緑色の表・折れ線グラフ）をお示しいただいた指示メモで、数値データではないため、下のファイル一覧には含めていません。',
      '事業所ごとに収支表の様式が揃っていないため（奈良が標準縦表に一番近いとうかがっています）、まずは様式をそろえる範囲をご相談させてください。',
    ],
  },
});
writeFileSync(OUT, html, 'utf8');
log(`レポート: ${OUT} (${Math.round(html.length / 1024)}KB)`);

const txt = html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, '|').replace(/\|+/g, '|');
console.log('\n=== ご確認いただきたい点 ===');
for (const m of txt.matchAll(/(Q-\d\d)\|優先度 (高|中)\|([^|]+)\|([^|]{0,160})/g)) {
  console.log(`  ${m[1]} [${m[2]}/${m[3]}] ${m[4].trim().slice(0, 140)}`);
}

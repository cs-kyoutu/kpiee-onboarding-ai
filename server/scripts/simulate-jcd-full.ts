// 「必要なデータが全部そろった状態」の構造分析レポートを、実際のレポート生成器で出す。
//
// 目的: ②仕訳汎用検索-変換 / ④2601_実績表_Base_局別 / ⑤補助科目集計表の変換用 が未入手のため、
//      いまのレポートは「最終帳票の元データが辿れない」で止まる。それらが入ったら何が見えるのかを
//      先に示して、資料をご提供いただく判断材料にする。
//
// つくり方:
//   - 手元にある実ファイルは本物を解析する（構造・数式は実物）
//   - 未入手のファイルは、ご説明いただいたシート構成から最小の表領域を組む（＝仮）
//   - ファイル間のつながりは、ご説明の R1〜R22 を「担当者が登録したブック関係」として渡す
//     （実際にコピペで作られており Excel 上に根拠が残らないため、本番でもこの経路になる）
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import {
  analyzeArtifacts, fileLabelOf,
  type RelationInput, type RelationGraph, type Region, type RegionColumn,
} from '../src/preprocess/relations.js';
import { buildRelationsReportHtml, type ReportArtifact } from '../src/relationsReport.js';
import { applyDeclaredFileRelations, type DeclaredFileRel, type FileRelType } from '../src/relations/declared.js';

const OUT = process.argv[2] ?? 'C:/Users/seongjin.park/kpiee-research/onboarding-ai/docs/report-jcd-full-simulated.html';
const D = 'C:/Users/seongjin.park/Downloads/';

// ---- 手元にある実ファイル（本物を解析する） ----
const REAL = [
  '仕訳汎用検索_2601.xlsx', '仕訳汎用検索_2602.xlsx',
  '2601_全社_営業成績表.xlsx', '2601_プロモーション部門_営業成績表.xlsx',
  '2025年度【売総および損益実績】2601.xlsx', '000まとめ_2025年度利益計画改定(2025-0725).xlsx',
].filter(f => existsSync(D + f));
// 2601 が無ければ手元の月次で代用（構造は同じ）
if (!REAL.some(f => f.startsWith('仕訳汎用検索'))) REAL.unshift('仕訳汎用検索_2602.xlsx');

// ---- 未入手ファイル（ご説明のシート構成から仮に組む） ----
const SYNTH: { file: string; sheets: { name: string; cols: string[]; rows: number }[] }[] = [
  {
    file: '仕訳汎用検索-変換-2026-0212',
    sheets: [
      { name: '元データ', cols: ['仕訳', '会計日', '組織コード', '勘定科目', 'ソース', '借方_入力_明細', '貸方_入力_明細'], rows: 620000 },
      { name: 'データ変換', cols: ['組織コード', '局管理読替後', '勘定科目', '成績表科目', 'PL/BS', '金額'], rows: 620000 },
      { name: '減価償却を抜粋', cols: ['組織コード', '勘定科目', '金額', '相殺対象'], rows: 4200 },
      { name: '減価償却の相殺', cols: ['組織コード', '勘定科目', '相殺額', 'ソース'], rows: 4200 },
      { name: 'データ変換からPLのみ値にして管理計算追加', cols: ['組織コード', '成績表科目', '金額', 'ソース'], rows: 480000 },
      { name: 'pivot管理計算', cols: ['組織コード', '成績表科目', '金額'], rows: 8600 },
      { name: '営業成績形式 (管理計算)', cols: ['組織コード', '成績表科目', '当月', '累計'], rows: 8600 },
    ],
  },
  {
    file: '補助科目集計表の変換用2601',
    sheets: [
      { name: '補助科目集計表(全社)', cols: ['勘定科目コード', '勘定科目名', '補助科目コード', '累計残高'], rows: 3400 },
      { name: '補助科目集計表(末端組織)', cols: ['組織コード', '勘定科目コード', '補助科目コード', '累計残高'], rows: 28000 },
      { name: '変換用シート', cols: ['組織コード', '成績表科目', '当月', '累計', '前年当月', '前年累計'], rows: 28000 },
    ],
  },
  {
    file: '2601_実績表_Base_局別',
    sheets: [
      { name: 'FY25_実績', cols: ['対象月', '部CD', '組織コード', '組織名略称', '成績表科目', '当月', '累計', '前年'], rows: 186000 },
      { name: '局コード', cols: ['局コード', '局名', '略称'], rows: 30 },
      { name: '単月', cols: ['成績表科目', '実績', '予算', '達成率', '前年', '前年比'], rows: 66 },
      { name: '累計', cols: ['成績表科目', '実績', '予算', '達成率', '前年', '前年比'], rows: 66 },
      { name: 'Tangetsu', cols: ['成績表科目', '4月', '5月', '6月', '7月', '8月', '9月'], rows: 66 },
      { name: 'Ruikei', cols: ['成績表科目', '4月', '5月', '6月', '7月', '8月', '9月'], rows: 66 },
      { name: '◆', cols: ['マクロ'], rows: 38 },
      { name: '◆◆', cols: ['出力先'], rows: 10 },
    ],
  },
  {
    file: '2025-総勘定元帳-2601までP',
    sheets: [{ name: '総勘定元帳', cols: ['会計日', '組織コード', '成績表科目', '借方', '貸方', 'ソース'], rows: 480000 }],
  },
  {
    file: '2025年度_実績表_value',
    sheets: [{ name: '実績value', cols: ['組織コード', '成績表科目', '区分', '当月', '累計'], rows: 372000 }],
  },
  {
    file: 'エリマネ部門施設_営業成績表',
    sheets: [{ name: 'FY25_実績', cols: ['対象月', '部CD', '組織コード', '組織名略称', '成績表科目', '当月', '累計'], rows: 12400 }],
  },
  {
    // 経営会議用資料。2025年度_実績表_value（単月・累計が縦に並んだデータ）と
    // Netsuite の当月計上データから作る。全体構造の一覧に載る以上、図にも出す。
    file: '経営会議用_営業実績表',
    sheets: [{ name: '営業実績表', cols: ['組織コード', '成績表科目', '当月', '累計', '案件番号'], rows: 9600 }],
  },
];

// ---- 財務・外部システムからの入手元データ（表構造を持たない、または未入手のため実物が無い）----
// これらは xlsx/csv のような「表」ではなく、取込前の生データや外部システム出力そのもの。
// 実際のパイプラインが表領域を要求するため、ここでは「1列だけの受け皿」として最小限に表現する
// （＝内容を推定しているのではなく、あくまで「ここから何かが入ってくる」という接続点を示すだけ）。
const RAW_SOURCES: { file: string; sheet: string; cols: string[]; rows: number; into: string; intoSheet: string; note: string }[] = [
  {
    file: '[Fusion]BS_PL仕訳XML', sheet: '仕訳データ', cols: ['仕訳データ(XML)'], rows: 1,
    into: fileLabelOf(REAL.find(f => f.startsWith('仕訳汎用検索'))!), intoSheet: '元データ',
    note: 'BOM付UTF-8で保存 → 外部データのインポート → 元データへ値貼り付け',
  },
  {
    file: '[Fusion]補助科目集計表_全社CSV', sheet: '全社', cols: ['補助科目集計表(全社)'], rows: 1,
    into: '補助科目集計表の変換用2601', intoSheet: '補助科目集計表(全社)',
    note: 'CSV(.txt) をそのまま取込',
  },
  {
    file: '[Fusion]補助科目集計表_末端組織CSV', sheet: '末端組織', cols: ['補助科目集計表(末端組織)'], rows: 1,
    into: '補助科目集計表の変換用2601', intoSheet: '補助科目集計表(末端組織)',
    note: 'CSV(.txt) をそのまま取込',
  },
  {
    file: '[ZERO]前年データ', sheet: '前年実績', cols: ['前年実績(ZERO出力形式)'], rows: 1,
    into: '仕訳汎用検索-変換-2026-0212', intoSheet: 'データ変換',
    note: '2025年3月まで使用のZEROデータ。Fusionデータをこの形式に変換し、累計から単月を出力',
  },
  {
    file: '[Netsuite]過去案件当月計上', sheet: '当月計上', cols: ['過去案件_当月計上'], rows: 1,
    into: '経営会議用_営業実績表', intoSheet: '営業実績表',
    note: '財務から入手した当月計上データ',
  },
];

const col = (name: string, i: number): RegionColumn => ({
  c: i + 1, name, hasFormula: false, mixedFormula: false, manualNumeric: 0,
  stats: { filled: 100, uniq: 100, text: 100 },
});
const synthRegions: Region[] = SYNTH.flatMap(f => f.sheets.map((s, i) => ({
  id: `${f.file}／${s.name}#${i + 1}`, file: f.file, sheet: s.name,
  r0: 1, r1: Math.min(s.rows, 1000) + 1, c0: 1, c1: s.cols.length,
  headerRow: 1, dataRowCount: s.rows,
  columns: s.cols.map(col),
})));
const rawSourceRegions: Region[] = RAW_SOURCES.map(r => ({
  id: `${r.file}／${r.sheet}#1`, file: r.file, sheet: r.sheet,
  r0: 1, r1: 2, c0: 1, c1: r.cols.length,
  headerRow: 1, dataRowCount: r.rows,
  columns: r.cols.map(col),
}));

// ---- 実ファイルを解析 ----
const arts: RelationInput[] = REAL.map(f => ({ filename: f, load: async () => readFileSync(D + f) }));
console.log(`実ファイル ${REAL.length} 件を解析中…`);
const real = await analyzeArtifacts(arts);
console.log(`  表 ${real.regions.length} / 辺 ${real.edges.length}`);

const allRegions: Region[] = [...real.regions, ...synthRegions, ...rawSourceRegions];

// ---- ご説明のブック関係（R1〜R22 のうちファイル同士のもの） ----
const L = (n: string) => fileLabelOf(n);
const rels: [string, string, FileRelType, string][] = [
  [L(REAL.find(f => f.startsWith('仕訳汎用検索'))!), '仕訳汎用検索-変換-2026-0212', 'transcribe',
    'インポート結果を「元データ」へ値貼り付け（CX列に数式追加）'],
  ['仕訳汎用検索-変換-2026-0212', '2025-総勘定元帳-2601までP', 'transcribe',
    '「データ変換からPLのみ値にして管理計算追加」シートをコピペ'],
  ['仕訳汎用検索-変換-2026-0212', '2601_実績表_Base_局別', 'transcribe',
    '減価償却の相殺 AY〜BL列を FY25_実績 の T列最終行以降へコピペ'],
  ['補助科目集計表の変換用2601', '2601_実績表_Base_局別', 'transcribe',
    '変換用シート T〜AF列を当月データとして使用'],
  ['2601_実績表_Base_局別', '2601_全社_営業成績表', 'transcribe',
    'マクロ生成の単月/累計シートを移動し、移動先でリンク解除'],
  ['2601_実績表_Base_局別', '2601_プロモーション部門_営業成績表', 'transcribe',
    '同上（30部署×2＝60シートを部門別へ配布）'],
  ['2601_実績表_Base_局別', 'エリマネ部門施設_営業成績表', 'transcribe',
    'FY25_実績 を 対象月=当月／部CD=6600／組織名略称「SB局」除外 でフィルタしてコピペ'],
  ['2601_実績表_Base_局別', '2025年度_実績表_value', 'transcribe',
    '各組織を縦に並べて値化'],
  ['2025年度_実績表_value', '経営会議用_営業実績表', 'aggregate',
    '単月・累計が縦に並んだデータを使って営業実績表を作成'],
];
// 財務・外部システムからの入手（表構造を持たない生データの取込）。宛先シートまで指定できるので
// 下の rels とは別枠にし、copyEdges もこちらは専用の対応（1列だけ）で作る。
const rawRels: [string, string, FileRelType, string][] =
  RAW_SOURCES.map(r => [r.file, r.into, 'transcribe', r.note]);
const allDeclaredTuples = [...rels, ...rawRels];
const declared: DeclaredFileRel[] = allDeclaredTuples.map(([f, t, relType, note], i) => ({
  id: i + 1, fromFile: f, toFile: t, relType, note, origin: 'manual' as const,
}));

// コピペで運ばれる区間は、値が同一のまま貼られるので本番でも「値一致（手修正推定）」として
// 検出される。ここではその状態を再現して、ファイル間の流れが図に出るようにする。
// （宣言だけでは辺が生まれない ＝ applyDeclaredFileRelations は既存辺の確信度を調整するだけ）
const repRegion = (file: string, prefer: string[]): Region | undefined => {
  const of = allRegions.filter(r => r.file === file);
  for (const p of prefer) { const hit = of.find(r => r.sheet === p); if (hit) return hit; }
  return [...of].sort((a, b) => b.dataRowCount - a.dataRowCount)[0];
};
const OUT_SHEET: Record<string, string[]> = {
  '仕訳汎用検索-変換-2026-0212': ['データ変換からPLのみ値にして管理計算追加', 'データ変換'],
  '補助科目集計表の変換用2601': ['変換用シート'],
  '2601_実績表_Base_局別': ['FY25_実績'],
};
const IN_SHEET: Record<string, string[]> = {
  '仕訳汎用検索-変換-2026-0212': ['元データ'],
  '2025-総勘定元帳-2601までP': ['総勘定元帳'],
  '2601_実績表_Base_局別': ['FY25_実績'],
  '2025年度_実績表_value': ['実績value'],
  'エリマネ部門施設_営業成績表': ['FY25_実績'],
  '2601_全社_営業成績表': ['累計_全社'],
  '2601_プロモーション部門_営業成績表': ['累計_PR1'],
  '経営会議用_営業実績表': ['営業実績表'],
};
const copyEdges = rels.flatMap(([f, t, , note]) => {
  const src = repRegion(f, OUT_SHEET[f] ?? []);
  const dst = repRegion(t, IN_SHEET[t] ?? []);
  if (!src || !dst) return [];
  // 代表列を数本つないで「何本かの列が一致している」状態にする
  return src.columns.slice(0, 3).map((sc, i) => ({
    from: `${src.id}:${sc.name}`,
    to: `${dst.id}:${(dst.columns[i] ?? dst.columns[0]).name}`,
    type: 'copy' as const,
    evidence: `値完全一致(${dst.dataRowCount.toLocaleString()}件, 手修正疑い)｜${note}`,
    confidence: 0.9,
  }));
});
// 入手元データ（生データ）→ 最初の受け皿。宛先シートを明示できるので1列だけ確実につなぐ
const rawCopyEdges = RAW_SOURCES.flatMap(r => {
  const src = allRegions.find(x => x.file === r.file && x.sheet === r.sheet);
  const dst = repRegion(r.into, [r.intoSheet]);
  if (!src || !dst) return [];
  return [{
    from: `${src.id}:${src.columns[0].name}`,
    to: `${dst.id}:${dst.columns[0].name}`,
    type: 'copy' as const,
    evidence: `外部入手データの取込｜${r.note}`,
    confidence: 0.9,
  }];
});

// ---- シート役割（資料 7 章の指定） ----
const roleOf = (file: string): Record<string, string> | undefined => {
  if (file.startsWith('仕訳汎用検索-変換')) return {
    '元データ': 'input_data', 'データ変換': 'working_sheet', '減価償却を抜粋': 'working_sheet',
    '減価償却の相殺': 'working_sheet', 'データ変換からPLのみ値にして管理計算追加': 'working_sheet',
    'pivot管理計算': 'working_sheet', '営業成績形式 (管理計算)': 'working_sheet',
  };
  if (file.startsWith('補助科目集計表の変換用')) return {
    '補助科目集計表(全社)': 'input_data', '補助科目集計表(末端組織)': 'input_data', '変換用シート': 'working_sheet',
  };
  if (file.startsWith('2601_実績表_Base_局別')) return {
    'FY25_実績': 'input_data', '局コード': 'master_data',
    '単月': 'working_sheet', '累計': 'working_sheet', 'Tangetsu': 'working_sheet', 'Ruikei': 'working_sheet',
    '◆': 'working_sheet', '◆◆': 'working_sheet',
  };
  if (file.startsWith('2601_全社_営業成績表')) return { Sheet1: 'input_data', '単月_全社': 'final_output', '累計_全社': 'final_output' };
  if (file.startsWith('2601_プロモーション部門')) return {
    '成績の一部分抜粋用': 'final_output',
    ...Object.fromEntries(['PR1', 'PR2', 'PR3', 'PR4', 'IS', 'CP', 'HRC'].flatMap(k =>
      [[`単月_${k}`, 'final_output'], [`累計_${k}`, 'final_output']])),
  };
  if (file.startsWith('2025年度【売総および損益実績】')) return {
    '損益実全社': 'final_output', '売総実全局': 'final_output', '局コード': 'master_data',
    'その他貼付': 'input_data', '2601成績': 'input_data', '修正計上': 'input_data',
    'ロイＢ調整3月分': 'working_sheet', '◆': 'working_sheet',
  };
  // 最終アウトプットは営業成績表の3ブックのみ（ご指定）。総勘定元帳・value・エリマネは
  // その手前の成果物であって、kpiee で再現する対象ではない
  if (file.startsWith('2025-総勘定元帳')) return { '総勘定元帳': 'working_sheet' };
  if (file.startsWith('2025年度_実績表_value')) return { '実績value': 'working_sheet' };
  if (file.startsWith('エリマネ部門施設')) return { 'FY25_実績': 'working_sheet' };
  if (file.startsWith('経営会議用_営業実績表')) return { '営業実績表': 'working_sheet' };
  // 入手元データ（生データ）は表構造を持たないので「インプット」扱い。最終アウトプットには絶対にしない
  const raw = RAW_SOURCES.find(r => r.file === file);
  if (raw) return { [raw.sheet]: 'input_data' };
  return undefined;
};
const allFiles = [
  ...REAL.map(f => f),
  ...SYNTH.map(s => `${s.file}.xlsx`),
  ...RAW_SOURCES.map(r => r.file), // 表構造を持たないデータなので拡張子は付けない
];
const artifacts: ReportArtifact[] = allFiles.map(f => ({ filename: f, kind: 'mixed', sheetRoles: roleOf(fileLabelOf(f)) }));

// ---- 宣言を重ねてレポート ----
const graph: RelationGraph = {
  ...real,
  regions: allRegions,
  edges: [...real.edges, ...copyEdges, ...rawCopyEdges],
};
const merged = applyDeclaredFileRelations(graph, declared);
const html = buildRelationsReportHtml({
  customerName: 'JCD（必要データが揃った場合の想定）',
  generatedAt: new Date(),
  fileCount: allFiles.length,
  graph: merged,
  artifacts,
  declaredFileRels: declared,
  fileRelAudit: merged.fileRelAudit,
});
writeFileSync(OUT, html, 'utf8');
console.log(`\n${OUT} (${Math.round(html.length / 1024)}KB)  ファイル ${allFiles.length} / 表 ${graph.regions.length}`);

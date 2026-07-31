// 顧客共有用「データ構造 分析レポート」(自己完結 HTML) の生成。
//
// 目的: 受領データの関係分析（RelationGraph）を、顧客との読み合わせに使える1枚のHTMLへ整形する。
//   - 確定事項（数式由来）と推定（値一致・構造推定）を視覚的に分離し、確認は推定部分だけに絞る
//   - 「ご確認いただきたい点」を Q-01.. の番号付きカードとして決定的に自動抽出する（AI 呼び出しなし）
//   - セルの生値は載せない（列名・数式・行数などの構造情報のみ）— 社外共有しても原本数値が漏れない
// summaryDoc.ts（Word/md のパッケージ資料）と同じ「保存済み派生結果から決定的に組み立てる」等級。
//
// 構成は4節。読み合わせの打ち合わせで上から順に説明していける並びにしてある:
//   01 受領データ一覧 … どのブックが何で、各シートがどういう役割か（取込時に入力された情報）
//   02 全体の流れと詳細ロジック … 全体関係図（ブック間）→ 詳細関係図（シート・表間）→ 詳細ロジック表
//   03 ご確認いただきたい点 … 自動解析が「推定」に留まる箇所
//   04 今後の進め方
// 02 は必ず「全体 → 詳細」の順に降りる。1ブックの案件ではブック間の図が1箱になって意味を持たないため、
// 全体の段を省いて詳細関係図から入る（従来の構成と同じ）。
import type { RelationGraph, Region, Edge, RelationWarning, KeyLink } from './preprocess/relations.js';
import { colLetter, fileLabelOf } from './preprocess/relations.js';
import {
  regionIdOf, colNameOf, regionPairKey, filePairKey,
  GROUP_META, GROUP_ORDER, aggregatePairs, dominantGroup, computeLayers,
  aggregateFilePairs, dominantFileGroup, computeFileLayers,
  type Group, type PairAgg, type FilePair,
} from './relations/fileGraph.js';
import { FILE_REL_LABELS, type DeclaredFileRel, type FileRelAudit } from './relations/declared.js';
import { DEFAULT_REPORT_SPEC, type ReportSpec } from './reportSpec.js';

/** 取込時のファイル情報。kind は運用担当者が指定した種別で、final_output が「最終アウトプット」の正解になる */
export interface ReportArtifact {
  filename: string;
  kind?: string;
  /** シート名 → 役割（input_data / working_sheet / final_output / unknown）。未指定なら kind を全シートへ適用 */
  sheetRoles?: Record<string, string>;
}

export interface RelationsReportInput {
  customerName: string;
  generatedAt: Date;
  fileCount: number;
  graph: RelationGraph;
  /** 受領ファイル一覧（取込時の種別指定込み）。無い場合はファイル間の流れから最終アウトプットを推定する */
  artifacts?: ReportArtifact[];
  /** 担当者が確定したブック関係。02 の各ブロックに「担当者の説明」として載る */
  declaredFileRels?: DeclaredFileRel[];
  /** 宣言と自動検出の突き合わせ。01 の表と 03 の質問になる */
  fileRelAudit?: FileRelAudit[];
  /** 「何を載せるか」の指定（アウトプット相談の結果）。未指定なら全部出す＝従来と同じ */
  spec?: ReportSpec;
}

// ============================================================
// 小道具
// ============================================================
const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const shortText = (s: string, max = 72): string => (s.length <= max ? s : `${s.slice(0, max)}…`);

const confLabel = (c: number): string => (c >= 0.8 ? '高' : c >= 0.5 ? '中' : '低');

/** 取込時に指定・確認されたシート役割の表示名（classify.ts / UploadPanel と同じ語彙） */
const SHEET_ROLE_LABELS: Record<string, string> = {
  input_data: 'インプット（raw）',
  master_data: 'マスタ（分類表）',
  working_sheet: '中間シート',
  final_output: '最終帳票',
  unknown: '判定不能',
};

// ============================================================
// 表領域の役割
// ============================================================

type Role = 'マスタ（参照元）' | '元データ（明細）' | '中間集計' | '最終アウトプット' | '独立（つながりなし）';

function computeRoles(regions: Region[], pairs: PairAgg[]): Map<string, Role> {
  const stat = new Map<string, { in: number; outRef: number; outOther: number }>();
  const get = (id: string) => {
    let s = stat.get(id);
    if (!s) { s = { in: 0, outRef: 0, outOther: 0 }; stat.set(id, s); }
    return s;
  };
  for (const p of pairs) {
    get(p.to).in += p.total;
    const g = dominantGroup(p);
    if (g === 'ref') get(p.from).outRef += p.total;
    else get(p.from).outOther += p.total;
  }
  const roles = new Map<string, Role>();
  for (const r of regions) {
    const s = stat.get(r.id);
    if (!s || (s.in === 0 && s.outRef === 0 && s.outOther === 0)) { roles.set(r.id, '独立（つながりなし）'); continue; }
    if (s.in === 0 && s.outRef > 0 && s.outOther === 0) roles.set(r.id, 'マスタ（参照元）');
    else if (s.in === 0) roles.set(r.id, '元データ（明細）');
    else if (s.outRef + s.outOther > 0) roles.set(r.id, '中間集計');
    else roles.set(r.id, '最終アウトプット');
  }
  return roles;
}


// ============================================================
// 表示ラベル・キー要約
// ============================================================
function buildLabels(regions: Region[]): Map<string, string> {
  // 基本はシート名。同名シートが複数ファイルにある時だけファイル名を前置し、
  // 同一シートに複数表がある場合だけ (2) 等で区別する（ラベルは短いほど読みやすい）
  const filesOfSheet = new Map<string, Set<string>>();
  for (const r of regions) {
    let s = filesOfSheet.get(r.sheet);
    if (!s) { s = new Set(); filesOfSheet.set(r.sheet, s); }
    s.add(r.file);
  }
  const perSheet = new Map<string, number>();
  for (const r of regions) perSheet.set(`${r.file}\u0000${r.sheet}`, (perSheet.get(`${r.file}\u0000${r.sheet}`) ?? 0) + 1);
  const seen = new Map<string, number>();
  const labels = new Map<string, string>();
  for (const r of regions) {
    const sk = `${r.file}\u0000${r.sheet}`;
    const n = (seen.get(sk) ?? 0) + 1;
    seen.set(sk, n);
    const ambiguous = (filesOfSheet.get(r.sheet)?.size ?? 1) > 1;
    // CSV 由来のシート名は一律「データ」で意味を持たないため、ファイル名をラベルにする
    const base = r.sheet === 'データ' && r.file ? r.file
      : ambiguous && r.file ? `${r.file} › ${r.sheet}` : r.sheet;
    labels.set(r.id, (perSheet.get(sk) ?? 1) > 1 ? `${base} (${n})` : base);
  }
  return labels;
}

function keySummary(r: Region): string {
  if (r.keys?.grain) return r.keys.grain; // 横持ち: 行キー × 列軸 の2次元グレイン
  const ks = r.keys?.keys ?? [];
  if (ks.length === 0) return '（不明）';
  const primary = ks.filter(k => k.role === 'primary');
  if (primary.length > 0) return primary.map(k => k.column).join('、');
  if (r.keys?.axisNote) return r.keys.axisNote;
  return ks.map(k => k.column).join(' × ');
}

/** 図のノード副題用の短いキー表記（axisNote のような文は使わず列名だけ） */
function keySummaryShort(r: Region): string {
  const ks = r.keys?.keys ?? [];
  if (ks.length === 0) return '';
  const primary = ks.filter(k => k.role === 'primary');
  if (primary.length > 0) return primary.map(k => k.column).join('、');
  return ks.map(k => k.column).join(' × ');
}

const rangeOf = (r: Region): string => `${colLetter(r.c0)}${r.r0}:${colLetter(r.c1)}${r.r1}`;

// ============================================================
// ご確認いただきたい点（決定的な質問抽出）
// ============================================================
interface Question {
  id: string; priority: 'high' | 'mid'; kind: string; title: string;
  analysis?: string; ask: string; kpiee?: string;
  refPair?: string; // copy 質問→辺表・図から参照するための `${from}\u0000${to}`
}

function buildQuestions(
  regions: Region[], pairs: PairAgg[], warnings: RelationWarning[],
  labels: Map<string, string>, roles: Map<string, Role>,
  fileRelAudit: FileRelAudit[], fileNameOf: (label: string) => string,
): Question[] {
  const qs: Omit<Question, 'id'>[] = [];

  // (0) 登録いただいたブック関係と自動検出の食い違い。
  // 人の業務知識と機械の検出がズレている箇所なので、確認の優先度は最も高い。
  for (const a of fileRelAudit.filter(x => x.verdict === 'direction_conflict')) {
    qs.push({
      priority: 'high', kind: 'ブック関係の確認',
      title: `ご登録は「${fileNameOf(a.fromFile)} → ${fileNameOf(a.toFile)}」ですが、検出した値の流れは逆向きです。`,
      analysis: `値の一致からは「${fileNameOf(a.toFile)} → ${fileNameOf(a.fromFile)}」の向きで ${a.detectedTotal} 件を検出しました。`,
      ask: 'どちらが元（正）のデータでしょうか？ 両方向に転記されている場合は、その運用も教えてください。',
      kpiee: '正しい向きが確定すれば、kpiee 側は元データだけを取り込めば済みます。',
    });
  }
  for (const a of fileRelAudit.filter(x => x.verdict === 'declared_not_detected')) {
    qs.push({
      priority: 'high', kind: 'ブック関係の確認',
      title: `ご登録いただいた「${fileNameOf(a.fromFile)} → ${fileNameOf(a.toFile)}」のつながりを自動検出できませんでした。`,
      analysis: '数式・値の一致のいずれからも、この2ファイルを結ぶ根拠が見つかりませんでした。'
        + (a.note ? `（ご登録の説明: ${shortText(a.note, 50)}）` : ''),
      ask: 'このつながりは、外部リンク・ピボットテーブル・手作業のどれにあたりますか？ 手順を教えてください。',
      kpiee: '手順が分かれば、その処理を kpiee の取込ロジックとして再現します。',
    });
  }
  const undeclaredPairs = fileRelAudit.filter(x => x.verdict === 'detected_not_declared');
  if (undeclaredPairs.length > 0) {
    const names = undeclaredPairs.slice(0, 3)
      .map(a => `「${fileNameOf(a.fromFile)} → ${fileNameOf(a.toFile)}」`).join('、')
      + (undeclaredPairs.length > 3 ? ` ほか${undeclaredPairs.length - 3}組` : '');
    qs.push({
      priority: 'mid', kind: 'ブック関係の確認',
      title: `${names} でファイル間のつながりを検出しましたが、関係のご登録がありません。`,
      analysis: '値の一致から自動検出したものです。意図した運用かどうかが判断できませんでした。',
      ask: 'これらは実際に使われているつながりでしょうか？ 偶然の一致であればその旨をお知らせください。',
    });
  }

  // (1) 手コピー推定（値一致）: 表ペア単位に1問。列数の多い順に最大3問。
  // ブック関係の登録で裏が取れた（matched）ファイル対は確認不要なので外す — 残った本当の論点だけを並べる。
  const confirmedFilePairs = new Set(
    fileRelAudit.filter(a => a.verdict === 'matched').map(a => filePairKey(a.fromFile, a.toFile)),
  );
  const fileOfRegion = new Map(regions.map(r => [r.id, r.file]));
  const isConfirmed = (p: PairAgg): boolean => {
    const f = fileOfRegion.get(p.from); const t = fileOfRegion.get(p.to);
    return !!f && !!t && f !== t && confirmedFilePairs.has(filePairKey(f, t));
  };
  const copyPairs = pairs
    .filter(p => (p.counts.copy ?? 0) > 0 && !isConfirmed(p))
    .sort((a, b) => (b.counts.copy ?? 0) - (a.counts.copy ?? 0));
  for (const p of copyPairs.slice(0, 3)) {
    const from = labels.get(p.from) ?? p.from;
    const to = labels.get(p.to) ?? p.to;
    const rep = p.best.copy;
    const n = p.counts.copy ?? 0;
    const undirected = rep?.needsConfirmation;
    qs.push({
      priority: 'high', kind: '手コピーの確認', refPair: `${p.from}\u0000${p.to}`,
      title: undirected
        ? `「${from}」と「${to}」で値が一致する列があります。どちらが元データですか？`
        : `「${to}」の一部の列は「${from}」からの手作業転記ですか？`,
      analysis: `数式が無いのに値が完全一致する列を ${n} 組検出しました（${rep ? shortText(rep.evidence, 40) : '値一致'}）。手作業のコピーと推定しています。`,
      ask: undirected
        ? '①どちらの表が元（正）ですか？ ②転記のタイミングと担当の方を教えてください。'
        : '①この理解で合っていますか？ ②転記のタイミングと担当の方は？ ③両者が一致しない場合はどちらが正ですか？',
      kpiee: '元とする表と集計ロジックが確定すれば、この転記作業は自動化できます。',
    });
  }
  if (copyPairs.length > 3) {
    qs.push({
      priority: 'high', kind: '手コピーの確認',
      title: `ほか ${copyPairs.length - 3} 組の表ペアでも手コピーの可能性を検出しています。`,
      analysis: '個別の一覧はお打ち合わせで画面をご覧いただきながら確認させてください。',
      ask: '主要なものから順に、転記の有無と方向を確認させてください。',
    });
  }

  // (2) 数式列への手入力上書き（mixed_formula_column）: シート単位に集約して最大2問
  const mixedBySheet = new Map<string, { file: string; sheet: string; count: number; cols: Set<string> }>();
  for (const w of warnings) {
    if (w.kind !== 'mixed_formula_column') continue;
    const regionId = regionIdOf(w.ref);
    const col = colNameOf(w.ref);
    const m = /^(.*)／(.*)#\d+$/.exec(regionId);
    const file = m?.[1] ?? '';
    const sheet = m?.[2] ?? regionId;
    const k = `${file}\u0000${sheet}`;
    let g = mixedBySheet.get(k);
    if (!g) { g = { file, sheet, count: 0, cols: new Set() }; mixedBySheet.set(k, g); }
    g.count++;
    if (col) g.cols.add(col);
  }
  const mixed = [...mixedBySheet.values()].sort((a, b) => b.count - a.count);
  for (const g of mixed.slice(0, 2)) {
    const cols = [...g.cols].slice(0, 3).join('、') + (g.cols.size > 3 ? ` ほか${g.cols.size - 3}列` : '');
    qs.push({
      priority: 'high', kind: '数式と手入力の混在',
      title: `「${g.sheet}」の数式列に、数式を上書きした手入力が ${g.count} 箇所あります。意図的な補正ですか？`,
      analysis: `数式が主体の列（${cols}）の中に、数式が消えて数値が直接入っているセルがあります。`,
      ask: '返品・締め処理などによる意図的な修正でしょうか？ 修正のルールがあれば教えてください。',
      kpiee: '補正ルールが明文化できれば取込時に反映します。例外的な修正なら「補正値の入力欄」として設計します。',
    });
  }
  if (mixed.length > 2) {
    qs.push({
      priority: 'mid', kind: '数式と手入力の混在',
      title: `ほか ${mixed.length - 2} シートでも数式と手入力の混在を検出しています。`,
      ask: '一覧を添えますので、意図的な補正かどうかをご確認ください。',
    });
  }

  // (3) どの表ともつながらない表: まとめて1問
  const orphans = regions.filter(r => roles.get(r.id) === '独立（つながりなし）' && r.dataRowCount >= 3);
  if (orphans.length > 0) {
    const names = orphans.slice(0, 4).map(r => `「${labels.get(r.id) ?? r.sheet}」`).join('、')
      + (orphans.length > 4 ? ` ほか${orphans.length - 4}表` : '');
    qs.push({
      priority: 'mid', kind: '出所不明の表',
      title: `${names} は、他のどの表ともつながりが見つかりませんでした。出所を教えてください。`,
      analysis: '受領データ内のどの表とも、数式・値の一致が見つかりませんでした。別ファイル・別システム由来の可能性があります。',
      ask: '元データの所在（別Excel／基幹システム／手入力）と、現役で使われている表かどうかを教えてください。',
      kpiee: '継続して使う表であれば、元データのご提供をお願いします。',
    });
  }

  // (4) 大きい表なのにキーが特定できない: まとめて1問
  const noKey = regions.filter(r => r.dataRowCount >= 20 && (r.keys?.keys?.length ?? 0) === 0);
  if (noKey.length > 0) {
    const names = noKey.slice(0, 3).map(r => `「${labels.get(r.id) ?? r.sheet}」`).join('、')
      + (noKey.length > 3 ? ` ほか${noKey.length - 3}表` : '');
    qs.push({
      priority: 'mid', kind: 'キーの確認',
      title: `${names} について、1行を一意に決める列（キー）が特定できませんでした。`,
      analysis: '値の一意性・数式からのキー利用のいずれからもキー列を推定できませんでした。',
      ask: 'この表の1行は「何が決まると1行になる」のか（例: 受注ごと・店舗×月ごと）を教えてください。',
      kpiee: 'キーの定義は集計の正確さに直結するため、最初に確定させたい項目です。',
    });
  }

  // (5) 運用の確認（固定）
  qs.push({
    priority: 'mid', kind: '運用の確認',
    title: '更新の運用について教えてください（頻度・担当・他ファイルの有無）。',
    ask: '①各ファイルはどのくらいの頻度で、どなたが更新されますか？ ②今回のファイルのほかに、報告・集計に使うファイルはありますか？ ③使われていない古いシートがあれば教えてください。',
  });

  return qs
    .sort((a, b) => (a.priority === b.priority ? 0 : a.priority === 'high' ? -1 : 1))
    .slice(0, 8)
    .map((q, i) => ({ ...q, id: `Q-${String(i + 1).padStart(2, '0')}` }));
}

// ============================================================
// 関係マップ（SVG）— ノード（円）形式
//
// 【変更禁止の要件】表どうしの関係図は必ずノード（円）形式で出す。
// 顧客と構造合意する本体の図であり、箱を並べた図では「どの表が何本つながっているか」が読めない。
// この静的 SVG は印刷・JS 無効・操作版 OFF のときに出るものなので、ここが箱だと
// 「ノード形式で出す」が経路によって破れる（実際に破れていた）。操作版（REPORT_GRAPH_JS）と
// 同じ見え方（円・大きさ＝つながりの本数・色＝表の役割・縦が流れ）に揃えてある。
// ============================================================

// 縦が流れ（上＝元データ → 下＝最終アウトプット）。ガイド文もこの向きで説明している。
const NODE_GAP_X = 176;   // 同じ段のノード間隔
const LAYER_GAP_Y = 152;  // 段の間隔（円＋ラベル2行＋辺ラベルが重ならない高さ）
const MAP_PAD = 46;
const R_MIN = 10, R_MAX = 26;
const PER_ROW = 7;        // 1段に並べる上限。超えたら段内で折り返す（横に伸びすぎるのを防ぐ）
const MAX_NODES = 28, MAX_EDGES = 60;

/** 表の役割 → 円の色。CSS の .relgraph-stage.lightmode（操作版）と同じ配色 */
const ROLE_FILL: Record<Role, string> = {
  '元データ（明細）': '#1E9E6A',
  'マスタ（参照元）': '#1F5FAE',
  '中間集計': '#7B5EA7',
  '最終アウトプット': '#C0392B',
  '独立（つながりなし）': '#9AA7B4',
};

// インタラクティブ・グラフ（Obsidian 風 force graph）へ渡すデータ。静的SVGと同じ kept 集合から作る。
interface GNode { id: string; label: string; sub: string; role: string; deg: number; x: number; y: number }
interface GLink { s: string; t: string; color: string; dashed: boolean; label: string; qid?: string; count: number }
interface GraphData { nodes: GNode[]; links: GLink[]; w: number; h: number }
interface MapResult { svg: string; omittedNodes: number; omittedEdges: number; data: GraphData }

/**
 * 表どうしの関係図（ノード形式）。
 * uid は同一ページに複数の SVG が並ぶための識別子（矢印マーカーの id が衝突すると
 * 後から定義されたものに全部の矢印が引きずられ、色が全て同じになる）。
 */
function buildMap(
  uid: string,
  regions: Region[], pairs: PairAgg[], labels: Map<string, string>,
  copyQuestionByPair: Map<string, string>, roles: Map<string, Role>,
): MapResult | null {
  if (pairs.length === 0) return null;

  // つながりのある表だけを、次数の大きい順に上限まで採用
  const degree = new Map<string, number>();
  for (const p of pairs) {
    degree.set(p.from, (degree.get(p.from) ?? 0) + p.total);
    degree.set(p.to, (degree.get(p.to) ?? 0) + p.total);
  }
  const connected = regions.filter(r => degree.has(r.id));
  const kept = connected
    .slice()
    .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0))
    .slice(0, MAX_NODES);
  const keptIds = new Set(kept.map(r => r.id));
  const drawPairs = pairs.filter(p => keptIds.has(p.from) && keptIds.has(p.to)).slice(0, MAX_EDGES);
  if (drawPairs.length === 0) return null;

  // 段（流れの深さ）ごとに分ける。段内が多いときは折り返して横幅を抑える
  const layers = computeLayers([...keptIds], drawPairs);
  const byLayer = new Map<number, Region[]>();
  for (const r of kept) {
    const l = layers.get(r.id) ?? 0;
    let arr = byLayer.get(l);
    if (!arr) { arr = []; byLayer.set(l, arr); }
    arr.push(r);
  }
  const layerNos = [...byLayer.keys()].sort((a, b) => a - b);
  for (const arr of byLayer.values()) arr.sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0));

  // 円の半径＝つながりの本数（操作版と同じ規則）
  const maxDeg = Math.max(1, ...[...degree.values()]);
  const radiusOf = (id: string) =>
    Math.round(R_MIN + (R_MAX - R_MIN) * Math.sqrt((degree.get(id) ?? 1) / maxDeg));

  // 段ごとに行を作り、行内は中央寄せで並べる
  const rows: Region[][] = [];
  for (const l of layerNos) {
    const arr = byLayer.get(l)!;
    for (let i = 0; i < arr.length; i += PER_ROW) rows.push(arr.slice(i, i + PER_ROW));
  }
  const widest = Math.max(...rows.map(r => r.length), 1);
  const width = MAP_PAD * 2 + (widest - 1) * NODE_GAP_X + NODE_GAP_X; // 端のラベルが切れないよう1枠分の余白
  const height = MAP_PAD * 2 + (rows.length - 1) * LAYER_GAP_Y + 40;

  const pos = new Map<string, { x: number; y: number; r: number }>();
  rows.forEach((row, ri) => {
    const y = MAP_PAD + ri * LAYER_GAP_Y;
    const rowWidth = (row.length - 1) * NODE_GAP_X;
    const startX = (width - rowWidth) / 2;
    row.forEach((r, i) => pos.set(r.id, { x: startX + i * NODE_GAP_X, y, r: radiusOf(r.id) }));
  });

  const showEdgeLabels = drawPairs.length <= 10;
  const parts: string[] = [];
  parts.push(`<svg viewBox="0 0 ${Math.round(width)} ${Math.round(height)}" role="img" aria-label="表どうしの関係図（ノード形式）">`);
  parts.push('<defs>');
  for (const g of GROUP_ORDER) {
    parts.push(`<marker id="arr-${uid}-${g}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="${GROUP_META[g].color}"/></marker>`);
  }
  parts.push('</defs>');

  // 辺（ノードより先に描いて下に敷く）。円の縁で始点・終点を止め、矢印が円に重ならないようにする
  const edgeLabels: string[] = [];
  for (const p of drawPairs) {
    const a = pos.get(p.from)!; const b = pos.get(p.to)!;
    const g = dominantGroup(p);
    const meta = GROUP_META[g];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.max(1, Math.hypot(dx, dy));
    const ux = dx / len, uy = dy / len;
    const x1 = a.x + ux * (a.r + 2), y1 = a.y + uy * (a.r + 2);
    const x2 = b.x - ux * (b.r + 8), y2 = b.y - uy * (b.r + 8); // +8 は矢印の頭の分
    // 同じ段どうし（ほぼ水平）は弧を描いて他のノードを避ける。段をまたぐ辺は緩い縦カーブ
    const horizontal = Math.abs(dy) < 4;
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    const bow = horizontal ? Math.min(46, 14 + len * 0.12) : 0;
    const d = horizontal
      ? `M${x1.toFixed(1)},${y1.toFixed(1)} Q${mx.toFixed(1)},${(my - bow).toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`
      : `M${x1.toFixed(1)},${y1.toFixed(1)} C${x1.toFixed(1)},${(y1 + dy * 0.4).toFixed(1)} ${x2.toFixed(1)},${(y2 - dy * 0.4).toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`;
    const dash = meta.dashed ? ' stroke-dasharray="7 5"' : '';
    parts.push(`<path d="${d}" fill="none" stroke="${meta.color}" stroke-width="${p.total > 3 ? 2.4 : 1.8}"${dash} marker-end="url(#arr-${uid}-${g})" opacity="0.85"/>`);
    const qid = g === 'copy' ? copyQuestionByPair.get(`${p.from}\u0000${p.to}`) : undefined;
    if (showEdgeLabels || qid) {
      const text = qid ? `手コピー推定 → ${qid}` : `${meta.label.split('（')[0]}${p.total > 1 ? ` ×${p.total}` : ''}`;
      // 縦の辺はラベルを「線の横・少し手前」へ置く。中点だと矢印の先＝下のノードの円やラベルに重なる
      const lx = horizontal ? mx : x1 + (x2 - x1) * 0.45 + 12;
      const ly = horizontal ? my - bow - 5 : y1 + (y2 - y1) * 0.45;
      const anchor = horizontal ? 'middle' : 'start';
      // 白フチ（paint-order）でノード・他の辺に重なっても読めるようにする
      edgeLabels.push(`<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" font-size="10" fill="${meta.color}" text-anchor="${anchor}"${qid ? ' font-weight="bold"' : ''} style="paint-order:stroke;stroke:#FCFDFE;stroke-width:3.5px">${esc(text)}</text>`);
    }
  }

  // ノード（円＋ラベル）。最終アウトプットは輪を足して終着点だと分かるようにする
  for (const r of kept) {
    const p = pos.get(r.id)!;
    const role = roles.get(r.id) ?? '中間集計';
    const fill = ROLE_FILL[role] ?? '#7B5EA7';
    const label = labels.get(r.id) ?? r.sheet;
    const key = keySummaryShort(r);
    const sub = key === '' ? `${r.dataRowCount.toLocaleString()}行` : `${r.dataRowCount.toLocaleString()}行 ／ ${key}`;
    const isOut = role === '最終アウトプット';
    parts.push('<g>'
      + (isOut ? `<circle cx="${p.x.toFixed(1)}" cy="${p.y}" r="${p.r + 5}" fill="none" stroke="${fill}" stroke-opacity="0.35" stroke-width="2"/>` : '')
      + `<circle cx="${p.x.toFixed(1)}" cy="${p.y}" r="${p.r}" fill="${fill}" stroke="#FCFDFE" stroke-width="1.5"/>`
      + `<text x="${p.x.toFixed(1)}" y="${p.y + p.r + 15}" font-size="11" font-weight="${isOut ? 800 : 700}" fill="#0E2A47" text-anchor="middle" style="paint-order:stroke;stroke:#FCFDFE;stroke-width:3px">${esc(fitText(label, NODE_GAP_X - 10, 11))}</text>`
      + `<text x="${p.x.toFixed(1)}" y="${p.y + p.r + 28}" font-size="9.5" fill="#7A8794" text-anchor="middle" style="paint-order:stroke;stroke:#FCFDFE;stroke-width:3px">${esc(fitText(sub, NODE_GAP_X - 10, 9.5))}</text>`
      + '</g>');
  }
  parts.push(...edgeLabels);
  parts.push('</svg>');

  // インタラクティブ・グラフ用データ。初期座標は上の階層レイアウト（pos）を種にして
  // ブラウザ側の力学シミュレーションが素早く収束するようにする（決定的な初期配置）。
  const gnodes: GNode[] = kept.map(r => {
    const p = pos.get(r.id)!;
    const key = keySummaryShort(r);
    return {
      id: r.id,
      label: labels.get(r.id) ?? r.sheet,
      sub: key === '' ? `${r.dataRowCount.toLocaleString()}行` : `${r.dataRowCount.toLocaleString()}行 ／ ${key}`,
      role: roles.get(r.id) ?? '',
      deg: degree.get(r.id) ?? 1,
      x: p.x, y: p.y,
    };
  });
  const glinks: GLink[] = drawPairs.map(p => {
    const g = dominantGroup(p);
    const qid = g === 'copy' ? copyQuestionByPair.get(`${p.from}\u0000${p.to}`) : undefined;
    return {
      s: p.from, t: p.to, color: GROUP_META[g].color, dashed: GROUP_META[g].dashed,
      label: GROUP_META[g].label.split('（')[0], qid, count: p.total,
    };
  });

  return {
    svg: parts.join('\n'),
    omittedNodes: connected.length - kept.length,
    omittedEdges: pairs.filter(p => keptIds.has(p.from) && keptIds.has(p.to)).length - drawPairs.length,
    data: { nodes: gnodes, links: glinks, w: Math.round(width), h: Math.round(height) },
  };
}

/** 表示幅に収まるよう全角=1・半角=0.6 で概算して省略する（SVGは自動折返ししないため） */
function fitText(s: string, maxPx: number, fontPx: number): string {
  let acc = 0, out = '';
  for (const ch of s) {
    const cw = /[\x00-\xff｡-ﾟ]/.test(ch) ? fontPx * 0.6 : fontPx;
    if (acc + cw > maxPx) return out + '…';
    acc += cw; out += ch;
  }
  return out;
}

// ============================================================
// キー関係図（ER 図）— キー列でつながる表どうしを、主キー/軸と 1:N で示す
//
// 関係マップ（ノード図）は「どの向きに流れているか」しか示せない。顧客が取込設定で
// 必ず聞かれるのは「どのキーで結合するのか」なので、キーの対応は別図として出す。
// ============================================================
const ER = { W: 226, HEAD: 30, ROW: 22, GX: 148, GY: 26, PAD: 16, CAP: 20 };

interface ErResult { svg: string; omitted: number }

function buildErDiagram(regions: Region[], keyLinks: KeyLink[], labels: Map<string, string>): ErResult | null {
  const links = [...keyLinks].sort((a, b) => b.count - a.count);
  if (links.length === 0) return null; // 表間のキー対応が無ければ ER は描かない（01 の列構成でキーは確認できる）
  const byId = new Map(regions.map(r => [r.id, r]));
  const withKeys = regions.filter(r => (r.keys?.keys?.length ?? 0) > 0);
  const linkedIds = new Set(links.flatMap(l => [regionIdOf(l.a), regionIdOf(l.b)]));
  const pool = withKeys.filter(r => linkedIds.has(r.id));
  if (pool.length === 0) return null;
  const show = [...pool].sort((a, b) => {
    const pa = a.keys!.keys.some(k => k.role === 'primary') ? 1 : 0;
    const pb = b.keys!.keys.some(k => k.role === 'primary') ? 1 : 0;
    return pb - pa;
  }).slice(0, ER.CAP);
  const showIds = new Set(show.map(r => r.id));
  const shownLinks = links.filter(l => showIds.has(regionIdOf(l.a)) && showIds.has(regionIdOf(l.b)));
  if (shownLinks.length === 0) return null;

  // データは b（参照される側=マスタ）→ a（数式側）へ流れる。b を左の層へ置く（最長経路レイヤ）。
  const layer = new Map<string, number>(show.map(r => [r.id, 0]));
  const lp = shownLinks.map(l => ({ from: regionIdOf(l.b), to: regionIdOf(l.a) }));
  const cap = Math.min(show.length + 2, 12);
  for (let pass = 0; pass < cap; pass++) {
    let changed = false;
    for (const e of lp) {
      const lf = layer.get(e.from), lt = layer.get(e.to);
      if (lf === undefined || lt === undefined) continue;
      if (lt < lf + 1 && lf + 1 < cap) { layer.set(e.to, lf + 1); changed = true; }
    }
    if (!changed) break;
  }
  const byLayer = new Map<number, Region[]>();
  for (const r of show) {
    const l = layer.get(r.id) ?? 0;
    if (!byLayer.has(l)) byLayer.set(l, []);
    byLayer.get(l)!.push(r);
  }
  const layersSorted = [...byLayer.entries()].sort((a, b) => a[0] - b[0]);

  // 交差を減らす簡易バリセンタ: 前の層の接続相手の平均位置で並べ替える
  const partners = new Map<string, string[]>();
  for (const l of shownLinks) {
    const a = regionIdOf(l.a), b = regionIdOf(l.b);
    (partners.get(a) ?? partners.set(a, []).get(a)!).push(b);
    (partners.get(b) ?? partners.set(b, []).get(b)!).push(a);
  }
  const orderIndex = new Map<string, number>();
  for (const [l, regs] of layersSorted) {
    if (l > 0) {
      const score = (id: string) => {
        const ps = (partners.get(id) ?? []).filter(p => (layer.get(p) ?? 0) < l && orderIndex.has(p));
        return ps.length === 0 ? 1e9 : ps.reduce((s, p) => s + orderIndex.get(p)!, 0) / ps.length;
      };
      regs.sort((x, y) => score(x.id) - score(y.id));
    }
    regs.forEach((r, i) => orderIndex.set(r.id, i));
  }

  const connectedKeys = new Set(shownLinks.flatMap(l => [l.a, l.b]));
  const keysOf = (r: Region) => {
    const conn = r.keys!.keys.filter(k => connectedKeys.has(`${r.id}:${k.column}`));
    return conn.length > 0 ? conn : r.keys!.keys;
  };
  // カーディナリティ: 列の値が全行一意なら 1（マスタ側）、繰り返しがあれば N（明細側）
  const cardOf = (key: string): string => {
    const st = byId.get(regionIdOf(key))?.columns.find(c => c.name === colNameOf(key))?.stats;
    return st ? (st.uniq === st.filled ? '1' : 'N') : '';
  };

  const heightOf = (r: Region) => ER.HEAD + keysOf(r).length * ER.ROW + 6;
  const layerHeights = layersSorted.map(([, regs]) => regs.reduce((s, r) => s + heightOf(r), 0) + (regs.length - 1) * ER.GY);
  const maxLayerH = Math.max(...layerHeights, 90);

  interface Node { id: string; x: number; y: number; w: number; h: number; title: string; rows: { cy: number; mark: string; label: string; primary: boolean; connected: boolean }[] }
  const nodes: Node[] = [];
  const rowY = new Map<string, number>();
  layersSorted.forEach(([l, regs], li) => {
    let y = ER.PAD + (maxLayerH - layerHeights[li]) / 2;
    for (const r of regs) {
      const ks = keysOf(r);
      const rows = ks.map((k, i) => {
        const cy = y + ER.HEAD + i * ER.ROW + ER.ROW / 2;
        const key = `${r.id}:${k.column}`;
        rowY.set(key, cy);
        return { cy, mark: k.role === 'primary' ? '🔑' : '◇', label: k.column, primary: k.role === 'primary', connected: connectedKeys.has(key) };
      });
      nodes.push({ id: r.id, x: ER.PAD + l * (ER.W + ER.GX), y, w: ER.W, h: heightOf(r), title: labels.get(r.id) ?? r.sheet, rows });
      y += heightOf(r) + ER.GY;
    }
  });
  const nodeById = new Map(nodes.map(n => [n.id, n]));

  // 同じキー列ペアは関数違いでも1本にまとめる
  const pairMap = new Map<string, { a: string; b: string }>();
  for (const l of shownLinks) pairMap.set(`${l.a}|${l.b}`, { a: l.a, b: l.b });

  const maxLayer = Math.max(0, ...layersSorted.map(([l]) => l));
  const width = ER.PAD * 2 + (maxLayer + 1) * (ER.W + ER.GX) - ER.GX;
  const height = ER.PAD * 2 + maxLayerH;

  const parts: string[] = [];
  parts.push(`<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="キー関係図（ER）">`);
  // コネクタ（エルボ）＋端点のカーディナリティ
  for (const p of pairMap.values()) {
    const na = nodeById.get(regionIdOf(p.a))!, nb = nodeById.get(regionIdOf(p.b))!;
    const ya = rowY.get(p.a) ?? na.y + ER.HEAD / 2;
    const yb = rowY.get(p.b) ?? nb.y + ER.HEAD / 2;
    const bLeft = nb.x + nb.w <= na.x;
    const x1 = bLeft ? nb.x + nb.w : nb.x;
    const x2 = bLeft ? na.x : na.x + na.w;
    const midX = (x1 + x2) / 2;
    parts.push(`<path d="M${x1},${yb} L${midX},${yb} L${midX},${ya} L${x2},${ya}" fill="none" stroke="#7A8794" stroke-width="1.6"/>`);
    const bc = cardOf(p.b), ac = cardOf(p.a);
    if (bc) parts.push(`<text x="${x1 + (bLeft ? 6 : -6)}" y="${yb - 5}" font-size="11" font-weight="700" fill="#1F5FAE" text-anchor="${bLeft ? 'start' : 'end'}">${bc}</text>`);
    if (ac) parts.push(`<text x="${x2 + (bLeft ? -6 : 6)}" y="${ya - 5}" font-size="11" font-weight="700" fill="#B96A00" text-anchor="${bLeft ? 'end' : 'start'}">${ac}</text>`);
  }
  // エンティティ（表）ボックス
  for (const n of nodes) {
    parts.push(`<g>`);
    parts.push(`<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="9" fill="#fff" stroke="#C9D4E0" stroke-width="1.2"/>`);
    parts.push(`<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${ER.HEAD}" rx="9" fill="#0E2A47"/>`);
    parts.push(`<rect x="${n.x}" y="${n.y + ER.HEAD - 9}" width="${n.w}" height="9" fill="#0E2A47"/>`);
    parts.push(`<text x="${n.x + 12}" y="${n.y + 20}" font-size="12.5" font-weight="700" fill="#fff">${esc(fitText(n.title, n.w - 24, 12.5))}</text>`);
    n.rows.forEach((row) => {
      const ty = row.cy + 4;
      if (row.connected) parts.push(`<rect x="${n.x + 3}" y="${row.cy - ER.ROW / 2}" width="${n.w - 6}" height="${ER.ROW}" fill="#EDF4FC"/>`);
      parts.push(`<text x="${n.x + 12}" y="${ty}" font-size="11.5" fill="${row.primary ? '#0E2A47' : '#4b5563'}" font-weight="${row.primary ? 700 : 400}">${row.mark} ${esc(fitText(row.label, n.w - 34, 11.5))}</text>`);
    });
    parts.push(`</g>`);
  }
  parts.push('</svg>');
  return { svg: parts.join('\n'), omitted: withKeys.length - show.length };
}

// ============================================================
// ファイル単位の集約 — 「受領データ一覧」と「全体の流れ図」の土台
//
// 表領域（region）単位の関係は細かすぎて全体像が見えないため、ファイル単位へ畳んだ層を別に持つ。
// 顧客が最初に知りたいのは「どのファイルが何のために要るのか」「最終アウトプットはどれか」なので、
// レポートはこのファイル層から入り、シート／キーの話は後段へ回す。
// ============================================================
type FileRole = '元データ' | '中間ファイル' | '最終アウトプット' | '独立';

interface FileStat {
  label: string;                    // region.file と同じラベル（拡張子なし）
  filename: string;                 // 表示用の元ファイル名（判明していれば拡張子込み）
  declaredOutput: boolean;          // 取込時に「最終帳票」として指定されたか
  sheets: string[];
  regionCount: number;
  rowTotal: number;
  inFiles: Map<string, number>;     // 上流ファイル → 関係本数
  outFiles: Map<string, number>;    // 下流ファイル
  role: FileRole;
}


function buildFileStats(
  regions: Region[], filePairs: FilePair[], artifacts: ReportArtifact[],
): Map<string, FileStat> {
  // 取込時の種別指定をラベル（拡張子なし）で引けるようにする
  const declared = new Map<string, ReportArtifact>();
  for (const a of artifacts) declared.set(fileLabelOf(a.filename), a);

  const stats = new Map<string, FileStat>();
  const ensure = (label: string): FileStat => {
    let s = stats.get(label);
    if (!s) {
      const a = declared.get(label);
      s = {
        label, filename: a?.filename ?? label,
        declaredOutput: a?.kind === 'final_output',
        sheets: [], regionCount: 0, rowTotal: 0,
        inFiles: new Map(), outFiles: new Map(), role: '独立',
      };
      stats.set(label, s);
    }
    return s;
  };
  for (const r of regions) {
    const s = ensure(r.file);
    s.regionCount++;
    s.rowTotal += r.dataRowCount;
    if (!s.sheets.includes(r.sheet)) s.sheets.push(r.sheet);
  }
  // region を持たないファイル（解析対象外・空）も一覧には出す
  for (const a of artifacts) ensure(fileLabelOf(a.filename));

  for (const p of filePairs) {
    const f = stats.get(p.from); const t = stats.get(p.to);
    if (!f || !t) continue;
    f.outFiles.set(p.to, (f.outFiles.get(p.to) ?? 0) + p.total);
    t.inFiles.set(p.from, (t.inFiles.get(p.from) ?? 0) + p.total);
  }
  return stats;
}

/**
 * 最終アウトプット（顧客が最後に見ている帳票）を決める。
 * 取込時の指定を最優先にする — これは業務知識であって自動推定で当てるものではない。
 * 指定が無い場合だけ「他ファイルから流れ込むが、どこへも流れ出さないファイル」を推定として使う。
 */
function resolveOutputFiles(stats: Map<string, FileStat>): { labels: string[]; declared: boolean } {
  const declared = [...stats.values()].filter(s => s.declaredOutput).map(s => s.label);
  if (declared.length > 0) return { labels: declared, declared: true };
  const sinks = [...stats.values()]
    .filter(s => s.inFiles.size > 0 && s.outFiles.size === 0)
    .sort((a, b) => b.inFiles.size - a.inFiles.size)
    .map(s => s.label);
  return { labels: sinks, declared: false };
}

/** ファイル役割を確定する（最終アウトプットの指定を反映してから流入・流出で分類） */
function assignFileRoles(stats: Map<string, FileStat>, outputs: Set<string>): void {
  for (const s of stats.values()) {
    if (outputs.has(s.label)) { s.role = '最終アウトプット'; continue; }
    if (s.inFiles.size === 0 && s.outFiles.size === 0) { s.role = '独立'; continue; }
    s.role = s.inFiles.size === 0 ? '元データ' : s.outFiles.size > 0 ? '中間ファイル' : '最終アウトプット';
  }
}

// ---- 全体の流れ図（ファイル単位）----
const FF = { W: 232, H: 74, GX: 116, GY: 26, PAD: 30, HEAD: 26 };
const FILE_ROLE_STYLE: Record<FileRole, { fill: string; stroke: string; text: string }> = {
  '元データ':        { fill: '#E9F7F0', stroke: '#1E9E6A', text: '#0E2A47' },
  '中間ファイル':    { fill: '#F1EDF8', stroke: '#7B5EA7', text: '#0E2A47' },
  '最終アウトプット': { fill: '#FBEFEF', stroke: '#C24141', text: '#0E2A47' },
  '独立':            { fill: '#F2F5F8', stroke: '#9AA7B4', text: '#3A4552' },
};

/**
 * 受領ファイル → 最終アウトプットの流れ図。
 * 最終アウトプットは指定どおり必ず最右列に置く（自動検出でつながりが出なかった場合も、
 * 「つながり未検出」として最右に置いたまま示す — 図から消すと確認したい論点が消えてしまう）。
 */
function buildFileFlow(stats: Map<string, FileStat>, filePairs: FilePair[], outputs: Set<string>): string | null {
  const all = [...stats.values()];
  if (all.length === 0) return null;

  // 最長経路でレイヤを決め、最終アウトプットは最右へ寄せる（02 のセグメント分割と同じ計算）
  const layer = computeFileLayers(all.map(s => s.label), filePairs, outputs);

  const byLayer = new Map<number, FileStat[]>();
  for (const s of all) {
    const l = layer.get(s.label) ?? 0;
    if (!byLayer.has(l)) byLayer.set(l, []);
    byLayer.get(l)!.push(s);
  }
  const layerNos = [...byLayer.keys()].sort((a, b) => a - b);
  const layerIndex = new Map<number, number>(layerNos.map((l, i) => [l, i]));
  for (const arr of byLayer.values()) arr.sort((a, b) => b.rowTotal - a.rowTotal);

  const pos = new Map<string, { x: number; y: number }>();
  let maxRows = 0;
  for (const l of layerNos) {
    const arr = byLayer.get(l)!;
    maxRows = Math.max(maxRows, arr.length);
    arr.forEach((s, i) => {
      pos.set(s.label, { x: FF.PAD + layerIndex.get(l)! * (FF.W + FF.GX), y: FF.PAD + FF.HEAD + i * (FF.H + FF.GY) });
    });
  }
  const width = FF.PAD * 2 + layerNos.length * FF.W + Math.max(0, layerNos.length - 1) * FF.GX;
  const height = FF.PAD * 2 + FF.HEAD + maxRows * FF.H + Math.max(0, maxRows - 1) * FF.GY;

  const parts: string[] = [];
  parts.push(`<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="受領ファイルから最終アウトプットまでの流れ">`);
  parts.push('<defs>');
  for (const g of GROUP_ORDER) {
    parts.push(`<marker id="ff-${g}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="${GROUP_META[g].color}"/></marker>`);
  }
  parts.push('</defs>');

  // 列見出し（元データ／中間／最終アウトプット）
  for (const l of layerNos) {
    const i = layerIndex.get(l)!;
    const arr = byLayer.get(l)!;
    const isOut = arr.every(s => outputs.has(s.label)) && arr.length > 0;
    const cap2 = isOut ? '最終アウトプット' : i === 0 ? '受領データ（起点）' : '経由ファイル';
    parts.push(`<text x="${FF.PAD + i * (FF.W + FF.GX)}" y="${FF.PAD + 8}" font-size="11" font-weight="700" fill="${isOut ? '#C24141' : '#7A8794'}" letter-spacing=".04em">${esc(cap2)}</text>`);
  }

  // 辺
  for (const p of filePairs) {
    const a = pos.get(p.from); const b = pos.get(p.to);
    if (!a || !b) continue;
    const meta = GROUP_META[dominantFileGroup(p)];
    const g = dominantFileGroup(p);
    let d: string;
    if (Math.abs(a.x - b.x) < 1) {
      const x = a.x + FF.W / 2;
      d = a.y < b.y ? `M${x},${a.y + FF.H} L${x},${b.y}` : `M${x},${a.y} L${x},${b.y + FF.H}`;
    } else {
      const rev = a.x > b.x;
      const src = rev ? b : a; const dst = rev ? a : b;
      const x1 = src.x + FF.W, y1 = src.y + FF.H / 2, x2 = dst.x, y2 = dst.y + FF.H / 2;
      d = rev
        ? `M${x2},${y2} C${x2 - 50},${y2} ${x1 + 50},${y1} ${x1},${y1}`
        : `M${x1},${y1} C${x1 + 50},${y1} ${x2 - 50},${y2} ${x2},${y2}`;
    }
    const dash = meta.dashed ? ' stroke-dasharray="7 5"' : '';
    parts.push(`<path d="${d}" fill="none" stroke="${meta.color}" stroke-width="2"${dash} marker-end="url(#ff-${g})"/>`);
  }

  // ノード（ファイル）
  for (const s of all) {
    const p = pos.get(s.label)!;
    const st = FILE_ROLE_STYLE[s.role];
    const isOut = outputs.has(s.label);
    const sub = `${s.sheets.length}シート ／ ${s.regionCount}表 ／ ${s.rowTotal.toLocaleString()}行`;
    const orphanOut = isOut && s.inFiles.size === 0;
    parts.push(`<g>` +
      `<rect x="${p.x}" y="${p.y}" width="${FF.W}" height="${FF.H}" rx="11" fill="${st.fill}" stroke="${st.stroke}" stroke-width="${isOut ? 2 : 1.3}"${orphanOut ? ' stroke-dasharray="6 4"' : ''}/>` +
      `<text x="${p.x + 14}" y="${p.y + 25}" font-size="12" font-weight="700" fill="${st.text}">${esc(fitText(s.filename, FF.W - 28, 12))}</text>` +
      `<text x="${p.x + 14}" y="${p.y + 44}" font-size="10" fill="#7A8794">${esc(sub)}</text>` +
      `<text x="${p.x + 14}" y="${p.y + 62}" font-size="10" font-weight="700" fill="${st.stroke}">${esc(s.role)}${orphanOut ? '（つながり未検出）' : ''}</text>` +
      `</g>`);
  }
  parts.push('</svg>');
  return parts.join('\n');
}

// ============================================================
// 02 の「詳細ロジック」表
//
// 「どのシートのどの列が、どのキーで、どんな処理で、どこへつながっているか」を1行1関係で出す。
// 図（ノード）は向きしか示せないので、キー・処理・根拠はこの表が受け持つ。
// キーは keyLinks（VLOOKUP/SUMIFS 等の引数位置から抽出した表間キー対応）から引く。
// ============================================================
const DETAIL_ROWS_CAP = 30;

/** 表ペア → 「照合に使っているキー列」の要約。無ければ空文字 */
function buildPairKeyIndex(keyLinks: KeyLink[]): Map<string, string> {
  const byPair = new Map<string, Set<string>>();
  const add = (fromRegion: string, toRegion: string, text: string) => {
    for (const k of [regionPairKey(fromRegion, toRegion), regionPairKey(toRegion, fromRegion)]) {
      let s = byPair.get(k);
      if (!s) { s = new Set(); byPair.set(k, s); }
      s.add(text);
    }
  };
  for (const l of keyLinks) {
    const ra = regionIdOf(l.a); const rb = regionIdOf(l.b);
    if (!ra || !rb || ra === rb) continue;
    const ca = colNameOf(l.a); const cb = colNameOf(l.b);
    add(ra, rb, ca === cb ? ca : `${ca} ＝ ${cb}`);
  }
  const out = new Map<string, string>();
  for (const [k, s] of byPair) out.set(k, [...s].slice(0, 3).join('／'));
  return out;
}

/** 数式のトップレベル関数名（VLOOKUP / SUMIFS 等）。処理の説明に添える */
function topFuncOf(formula: string): string {
  return (formula.match(/^\s*=?\s*([A-Za-z]+)\s*\(/) ?? [])[1]?.toUpperCase() ?? '';
}

/**
 * 「SUMIFS で集計」「VLOOKUP で引き当て」のような処理の一言。
 * 種別バッジと同じ文字になるだけなら空を返す（同じ語が2行並ぶのを避ける）。
 */
function processLabel(g: Group, evidence: string): string {
  if (g === 'copy') return '数式なし（値の一致から手作業コピーと推定）';
  const fn = topFuncOf(evidence);
  return fn ? `${fn} で${GROUP_META[g].label.split('（')[0]}` : '';
}

/**
 * 掲載順は「流れの順」。関係の本数で並べると帳票→元データが混ざって読み合わせに使えないため、
 * 送り元表のレイヤ（元データ=0 …）で昇順に並べ、同じレイヤ内は本数の多い順にする。
 */
function buildDetailRows(
  pairs: PairAgg[], labels: Map<string, string>, pairKeys: Map<string, string>,
  copyQuestionByPair: Map<string, string>,
): { rows: string[]; omitted: number } {
  const endLabel = (key: string) => {
    const rid = regionIdOf(key); const col = colNameOf(key);
    const l = labels.get(rid) ?? rid;
    return col ? `${esc(l)}<span class="dl-col">${esc(col)}</span>` : esc(l);
  };
  const ids = [...new Set(pairs.flatMap(p => [p.from, p.to]))];
  const layer = computeLayers(ids, pairs);
  const ordered = [...pairs].sort((a, b) => {
    const la = layer.get(a.from) ?? 0, lb = layer.get(b.from) ?? 0;
    return la !== lb ? la - lb : b.total - a.total;
  });
  const rows: string[] = [];
  const shown = ordered.slice(0, DETAIL_ROWS_CAP);
  for (const p of shown) {
    const g = dominantGroup(p);
    const e = p.best[g] ?? p.best.copy;
    if (!e) continue;
    const key = pairKeys.get(regionPairKey(p.from, p.to)) ?? '';
    const qid = g === 'copy' ? copyQuestionByPair.get(regionPairKey(p.from, p.to)) : undefined;
    const proc = processLabel(g, e.evidence);
    rows.push(`<tr>` +
      `<td>${endLabel(e.from)}</td>` +
      `<td class="mono">${key ? esc(key) : '<span class="dl-none">（キー未特定）</span>'}</td>` +
      `<td><span class="rel ${GROUP_META[g].cls}">${esc(GROUP_META[g].label.split('（')[0])}</span>` +
        `${proc ? `<div class="dl-proc">${esc(proc)}</div>` : ''}</td>` +
      `<td>${endLabel(e.to)}</td>` +
      `<td class="mono dl-ev">${esc(shortText(e.evidence, 54))}</td>` +
      `<td class="conf"><b>${confLabel(e.confidence ?? 0)}</b>${qid ? `<div class="dl-q">${qid}</div>` : ''}</td>` +
      `</tr>`);
  }
  return { rows, omitted: pairs.length - shown.length };
}

/**
 * レポート 03 に載る「ご確認いただきたい点」の件数と見出しだけを求める。
 * アウトプット相談の AI へ「確認事項が何件あるか」を前提として渡すために使う。
 * HTML を組まないので軽い（同じ decision 関数を使うため本文と件数が食い違わない）。
 */
export function summarizeReportQuestions(input: RelationsReportInput): { count: number; titles: string[] } {
  const { graph } = input;
  const regions = graph.regions ?? [];
  const pairs = aggregatePairs((graph.edges ?? []) as Edge[]);
  const labels = buildLabels(regions);
  const roles = computeRoles(regions, pairs);
  const fileStats = buildFileStats(regions, aggregateFilePairs(regions, pairs), input.artifacts ?? []);
  const fileNameOf = (label: string) => fileStats.get(label)?.filename ?? label;
  const qs = buildQuestions(
    regions, pairs, graph.warnings ?? [], labels, roles, input.fileRelAudit ?? [], fileNameOf,
  );
  return { count: qs.length, titles: qs.map(q => `${q.id} ${q.title}`) };
}

// ============================================================
// 本体
// ============================================================
export function buildRelationsReportHtml(input: RelationsReportInput): string {
  const { graph } = input;
  const regions = graph.regions ?? [];
  const edges = (graph.edges ?? []) as Edge[];
  const warnings = graph.warnings ?? [];

  const labels = buildLabels(regions);
  const pairs = aggregatePairs(edges);
  const roles = computeRoles(regions, pairs);

  // ---- ファイル層（一覧・流れ図の土台）と最終アウトプットの確定 ----
  const filePairs = aggregateFilePairs(regions, pairs);
  const fileStats = buildFileStats(regions, filePairs, input.artifacts ?? []);
  const { labels: outputLabels, declared: outputsDeclared } = resolveOutputFiles(fileStats);
  const outputFiles = new Set(outputLabels);
  assignFileRoles(fileStats, outputFiles);
  const fileOfRegion = new Map(regions.map(r => [r.id, r.file]));
  const fileNameOf = (label: string) => fileStats.get(label)?.filename ?? label;
  // 最終アウトプットファイル内で「他ファイルへ流れ出さない表」を最終アウトプット表として扱う。
  // これがないと、ファイル内で相互参照している帳票シートが一律「中間集計」に見えてしまう。
  const outRegionIds = new Set<string>();
  for (const r of regions) {
    if (!outputFiles.has(r.file)) continue;
    if (roles.get(r.id) === '独立（つながりなし）') continue;
    const flowsOut = pairs.some(p => p.from === r.id && fileOfRegion.get(p.to) !== r.file);
    if (!flowsOut) { outRegionIds.add(r.id); roles.set(r.id, '最終アウトプット'); }
  }

  const declaredRels = input.declaredFileRels ?? [];
  const audit = input.fileRelAudit ?? [];
  const questions = buildQuestions(regions, pairs, warnings, labels, roles, audit, fileNameOf);
  const copyQuestionByPair = new Map<string, string>();
  for (const q of questions) if (q.refPair) copyQuestionByPair.set(q.refPair, q.id);
  const fileFlow = buildFileFlow(fileStats, filePairs, outputFiles);

  // ---- 何を載せるか（アウトプット相談の指定）----
  // 未指定なら全部出す＝従来と同じ。関係図（ノード形式）は指定対象に無く、常に出る。
  const spec = input.spec ?? DEFAULT_REPORT_SPEC;

  // ---- 02 全体（ブック間）→ 詳細（シート・表間）の2段構え ----
  // 全体はファイル単位のフロー図、詳細は表単位のノード図（ER＋関係マップ＋操作版）。
  // 複数ファイルのときだけ「全体」を挟む。1ファイル案件ではブック間の図が1箱で意味を持たないので、
  // 従来どおり表単位の関係図から入る。
  const multiFile = fileStats.size > 1;
  const map = buildMap('r', regions, pairs, labels, copyQuestionByPair, roles);
  const er = spec.items.erDiagram ? buildErDiagram(regions, graph.keyLinks ?? [], labels) : null;
  const pairKeys = buildPairKeyIndex(graph.keyLinks ?? []);
  const { rows: detailRows, omitted: detailOmitted } = buildDetailRows(pairs, labels, pairKeys, copyQuestionByPair);
  // 担当者が登録したブック関係の説明。セグメントを廃したので、全体図の直下にまとめて出す。
  const declaredNotes = declaredRels.filter(d => d.note.trim() !== '');
  const showFileFlow = multiFile && spec.items.fileFlow;

  // ---- 節番号 ----
  // 出さない節がある場合は繰り上げる（01 の次が 03 になると読み合わせで指示が噛み合わなくなる）。
  const secOn = {
    inventory: spec.sections.inventory,
    flow: spec.sections.flow,
    questions: spec.sections.questions,
    nextSteps: spec.sections.nextSteps,
  };
  let secCount = 0;
  const secNo = (on: boolean) => (on ? String(++secCount).padStart(2, '0') : '');
  const noInventory = secNo(secOn.inventory);
  const noFlow = secNo(secOn.flow);
  const noQuestions = secNo(secOn.questions);
  const noNext = secNo(secOn.nextSteps);
  // 本文から他の節を指す言い方（節を出していないときは節番号で誘導しない）
  const refInventory = noInventory ? `${noInventory} のとおりです` : '下記のとおりです';
  const refQuestions = noQuestions ? `（${noQuestions} の確認事項をご覧ください）` : '';

  // 02 の小見出しは連番。1ファイル案件では「全体（ブック間）」が無い分だけ番号が繰り上がる。
  // 小見出しの番号は「2-1」の形（節番号の 0 詰めは外す）。
  const flowNo = noFlow.replace(/^0/, '') || '2';
  let subNo = 0;
  const subH = (title: string) => `<h3 class="sub-h">${flowNo}-${++subNo}　${esc(title)}</h3>`;

  const edgeTotal = graph.edgeTotal ?? edges.length;
  const dateStr = input.generatedAt.toISOString().slice(0, 10);
  const customer = input.customerName ? `${input.customerName}様` : 'ご担当者様';

  const sheetTotal = new Set(regions.map(r => `${r.file}\u0000${r.sheet}`)).size;
  const outStats = outputLabels.map(l => fileStats.get(l)!).filter(Boolean);

  // ---- サマリ文（決定的に組み立てる） ----
  // 先頭に「この案件の重点」（アウトプット相談で指定された focus）を置く。読み合わせの目的を
  // 冒頭で共有できるようにするためで、指定が無ければ従来どおり件数の話から始まる。
  const bullets: string[] = [];
  {
    if (spec.focus) bullets.push(`<b>今回の重点：${esc(spec.focus)}</b>`);
    bullets.push(`受領した <b>${input.fileCount} ファイル</b>（${sheetTotal} シート／${regions.length} 表）を解析しました。内訳は ${refInventory}。`);
    if (outStats.length > 0) {
      bullets.push(`最終アウトプットは <b>${outStats.length} 種</b>（${outStats.map(s => `「${esc(s.filename)}」`).join('、')}）` +
        (outputsDeclared ? 'です（取込時のご指定にもとづきます）。' : 'と推定しました（流れの終着点から自動判定）。'));
    }
    if (declaredRels.length > 0) {
      const matched = audit.filter(a => a.verdict === 'matched').length;
      bullets.push(`ブックどうしの関係を <b>${declaredRels.length} 件</b>ご登録いただいており、うち ${matched} 件は自動解析でも同じつながりを確認できました。`);
    }
    const copyCount = pairs.filter(p => (p.counts.copy ?? 0) > 0).length;
    const formulaCount = pairs.length - copyCount;
    if (formulaCount > 0) bullets.push(`表をつなぐ関係の大半は数式（SUMIFS・VLOOKUP等）で、<b>構造は自動で追跡できました</b>。`);
    if (copyCount > 0) bullets.push(`一方、<b>数式ではなく手作業の転記と推定されるつながりが ${copyCount} 組</b>あります（値の一致から逆推定）。ここが今回確認したい中心です。`);
    else if (warnings.length > 0) bullets.push(`数式列への手入力の上書きなど、確認したい箇所が ${warnings.length} 件あります。`);
    else bullets.push('手作業転記の疑いは検出されませんでした。');
    // 案件固有の前提（アウトプット相談で足したメモ）
    for (const n of spec.notes) bullets.push(esc(n));
  }

  // ---- 01 ファイル一覧 ----
  // 登録済みブック関係をファイル単位で引けるようにする（一覧の「ご登録の関係」列）
  const relsByFile = new Map<string, string[]>();
  for (const d of declaredRels) {
    const text = `→ ${fileNameOf(d.toFile)}（${FILE_REL_LABELS[d.relType]}）`;
    const arr = relsByFile.get(d.fromFile) ?? [];
    arr.push(text);
    relsByFile.set(d.fromFile, arr);
  }
  const fileRows = [...fileStats.values()]
    .sort((a, b) => {
      const ra = a.role === '最終アウトプット' ? 1 : 0, rb = b.role === '最終アウトプット' ? 1 : 0;
      return ra !== rb ? ra - rb : b.rowTotal - a.rowTotal; // 最終アウトプットは最後に置いて流れの順に読ませる
    })
    .map(s => {
      const upstream = [...s.inFiles.keys()].map(l => fileNameOf(l));
      const roleCls = s.role === '最終アウトプット' ? 'out' : s.role === '元データ' ? 'src' : s.role === '中間ファイル' ? 'mid' : 'iso';
      const rels = relsByFile.get(s.label) ?? [];
      return `<tr>` +
        `<td><b>${esc(s.filename)}</b>${s.declaredOutput ? '<div class="rnote">取込時に「最終帳票」として指定</div>' : ''}</td>` +
        `<td class="r">${s.sheets.length}</td><td class="r">${s.regionCount}</td><td class="r">${s.rowTotal.toLocaleString()}</td>` +
        `<td><span class="nrole ${roleCls}"></span> ${esc(s.role)}</td>` +
        `<td>${upstream.length > 0 ? esc(shortText(upstream.join('、'), 44)) : '—'}</td>` +
        `<td>${rels.length > 0 ? esc(shortText(rels.join('／'), 44)) : '<span class="dl-none">—</span>'}</td>` +
        `</tr>`;
    });

  // ---- 01 ファイルごとの内訳（シートの役割 ＋ 表・列構成）----
  // シートの役割は取込時に人が指定・確認した情報なので、自動推定の役割とは分けて見せる。
  const sheetRoleOf = new Map<string, Record<string, string> | undefined>();
  const kindOfFile = new Map<string, string | undefined>();
  for (const a of input.artifacts ?? []) {
    sheetRoleOf.set(fileLabelOf(a.filename), a.sheetRoles);
    kindOfFile.set(fileLabelOf(a.filename), a.kind);
  }
  const REGION_CAP_PER_FILE = 8;
  const fileBlocks = [...fileStats.values()]
    .sort((a, b) => b.rowTotal - a.rowTotal)
    .map((s, i) => {
      const myRegions = regions.filter(r => r.file === s.label)
        .sort((a, b) => b.dataRowCount - a.dataRowCount);
      // シート役割: sheet_roles があればそれ、無ければ kind を全シートへ適用（orchestrator の rolesOf と同じ規則）
      const roleMap = sheetRoleOf.get(s.label);
      const kind = kindOfFile.get(s.label);
      const roleChips = s.sheets.map(name => {
        const role = roleMap?.[name] ?? (kind && kind !== 'mixed' ? kind : undefined);
        const label = role ? (SHEET_ROLE_LABELS[role] ?? role) : '未指定';
        const cls = role === 'final_output' ? 'sr out' : role === 'working_sheet' ? 'sr mid'
          : role === 'input_data' ? 'sr src' : role === 'master_data' ? 'sr mst' : 'sr unk';
        return `<span class="${cls}">${esc(name)}<em>${esc(label)}</em></span>`;
      }).join('');
      const regionBlocks = myRegions.slice(0, REGION_CAP_PER_FILE).map(r => {
        const keyCols = new Set((r.keys?.keys ?? []).map(k => k.column));
        const chips = r.columns.slice(0, 24).map(c => {
          const cls = keyCols.has(c.name) ? 'colchip key'
            : c.mixedFormula ? 'colchip manual'
            : c.hasFormula ? 'colchip formula'
            : c.manualNumeric > 0 ? 'colchip manual' : 'colchip';
          const mark = c.mixedFormula ? ' ⚠' : '';
          return `<span class="${cls}">${esc(c.name)}${mark}</span>`;
        }).join('');
        const more = r.columns.length > 24 ? `<span class="colchip">…他${r.columns.length - 24}列</span>` : '';
        const keyNote = r.keys?.grain
          ? `<p class="key-note">🔑 セルは <b>${esc(r.keys.grain)}</b> の組合せで決まります（横持ち表。縦持ちに展開すると「行キー・軸・値」の形になります）。</p>`
          : r.keys?.axisNote
          ? `<p class="key-note">🔑 ${esc(r.keys.axisNote)}</p>`
          : keyCols.size > 0
            ? `<p class="key-note">🔑 <b>${esc(keySummary(r))}</b> が1行を決めるキーと推定しています。</p>`
            : '';
        const mixedCols = r.columns.filter(c => c.mixedFormula).map(c => c.name);
        const mixedNote = mixedCols.length > 0
          ? `<p class="rnote">⚠ ${esc(mixedCols.slice(0, 3).join('、'))} 列で数式と手入力の混在があります。</p>` : '';
        return `<div class="rblock">
          <div class="rhead"><b>${esc(r.sheet)}</b><span class="loc">${esc(rangeOf(r))}</span>` +
          `<span class="rows">${r.dataRowCount.toLocaleString()}行 × ${r.columns.length}列</span>` +
          `<span class="rrole">${esc(roles.get(r.id) ?? '')}</span></div>
          <div class="colchips">${chips}${more}</div>${keyNote}${mixedNote}
        </div>`;
      }).join('\n');
      const moreRegions = myRegions.length > REGION_CAP_PER_FILE
        ? `<p class="tbl-note">※ 行数の多い上位 ${REGION_CAP_PER_FILE} 表を掲載しています（このファイルの全 ${myRegions.length} 表）。</p>` : '';
      return `<details class="fileblk"${i === 0 ? ' open' : ''}>
      <summary><b>${esc(s.filename)}</b><span class="rows">${s.sheets.length}シート ／ ${s.regionCount}表 ／ ${s.rowTotal.toLocaleString()}行</span></summary>
      <div class="rbody">
        <p class="sub-lede">シートの役割（取込時にご指定・ご確認いただいた内容です）</p>
        <div class="srchips">${roleChips || '<span class="dl-none">シート情報なし</span>'}</div>
        <p class="sub-lede">表と列の構成</p>
        ${regionBlocks || '<p class="dl-none">表を検出できませんでした。</p>'}
        ${moreRegions}
      </div>
    </details>`;
    }).join('\n');

  // ---- 01 末尾: ご登録の関係と自動検出の突き合わせ ----
  const AUDIT_LABELS: Record<string, { text: string; cls: string }> = {
    matched: { text: '一致', cls: 'ok' },
    declared_not_detected: { text: '自動検出できず', cls: 'ng' },
    detected_not_declared: { text: 'ご登録なし', cls: 'warn' },
    direction_conflict: { text: '向きが逆', cls: 'ng' },
  };
  const auditRows = audit.map(a => {
    const m = AUDIT_LABELS[a.verdict];
    return `<tr>` +
      `<td>${esc(fileNameOf(a.fromFile))} → ${esc(fileNameOf(a.toFile))}</td>` +
      `<td>${a.relType ? esc(FILE_REL_LABELS[a.relType]) : '<span class="dl-none">—</span>'}</td>` +
      `<td><span class="av ${m.cls}">${esc(m.text)}</span></td>` +
      `<td class="r">${a.detectedTotal > 0 ? a.detectedTotal.toLocaleString() : '—'}</td>` +
      `<td>${a.note ? esc(shortText(a.note, 46)) : '<span class="dl-none">—</span>'}</td>` +
      `</tr>`;
  });

  // ---- 質問カード ----
  const qCards = questions.map(q => `
    <div class="qcard${q.priority === 'high' ? ' p-high' : ''}">
      <div class="qhead"><span class="qid">${q.id}</span><span class="qtag ${q.priority === 'high' ? 'high' : 'mid'}">優先度 ${q.priority === 'high' ? '高' : '中'}</span><span class="qtag kind">${esc(q.kind)}</span></div>
      <div class="qtitle">${esc(q.title)}</div>
      <dl class="qgrid">
        ${q.analysis ? `<dt>分析結果</dt><dd>${esc(q.analysis)}</dd>` : ''}
        <dt>伺いたいこと</dt><dd>${esc(q.ask)}</dd>
        ${q.kpiee ? `<dt>kpieeでは</dt><dd>${esc(q.kpiee)}</dd>` : ''}
      </dl>
      <div class="ansbox">ご回答メモ：</div>
    </div>`).join('\n');

  // 表題と、冒頭で示す「読む順番」。出さない節はここにも並べない。
  const reportTitle = spec.title || 'ご提供データの構造分析レポート';
  const heroH1 = spec.title
    ? `<h1>${esc(spec.title)}</h1>`
    : '<h1>ご提供データの<span class="em">構造分析</span>レポート<br>── 読み合わせのお願い</h1>';
  const readOrder = [
    secOn.inventory ? `${noInventory} 受領データ一覧` : '',
    secOn.flow ? `${noFlow} 全体の流れと詳細ロジック` : '',
    secOn.questions ? `${noQuestions} ご確認いただきたい点` : '',
    secOn.nextSteps ? `${noNext} 今後の進め方` : '',
  ].filter(Boolean).join(' → ');

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(reportTitle)}｜${esc(input.customerName || 'kpiee')}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Zen+Old+Mincho:wght@600;700;900&family=Noto+Sans+JP:wght@400;500;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
${REPORT_CSS}
</style>
</head>
<body>

<header>
  <div class="wrap">
    <div class="hero">
      <div class="brand">kpiee ONBOARDING ── DATA STRUCTURE REVIEW / dataX Inc.</div>
      ${heroH1}
      <p class="lede">kpiee導入に先立ち、ご提供いただいたExcel・CSVファイルの構造を解析しました。${readOrder ? `<b style="color:#fff">${esc(readOrder)}</b> の順に、` : ''}私たちの理解を整理しています。「この理解で合っているか」をご確認いただき、${secOn.questions ? `特に <b style="color:#fff">${noQuestions}. ご確認いただきたい点</b> についてお打ち合わせでご回答をいただけますと幸いです。` : 'お打ち合わせでご意見をいただけますと幸いです。'}${spec.focus ? `<br>今回は特に <b style="color:#fff">${esc(spec.focus)}</b> を確認したいと考えています。` : ''}</p>
      <div class="hero-meta">
        <span>宛先：<b>${esc(customer)}</b></span>
        <span>分析日：<b>${dateStr}</b></span>
        <span>作成：dataX カスタマーサクセス</span>
      </div>
    </div>
  </div>
</header>

${secOn.inventory ? `
<section class="alt">
  <div class="wrap">
    <div class="sec-head">
      <div class="eyebrow">${noInventory} ── INVENTORY</div>
      <h2>受領データ一覧</h2>
      <p class="sec-lede">いただいたファイル（ブック）と、その中の各シートがどういう役割かの一覧です。1つのシートに複数の表が含まれる場合は、表単位に分割して解析しています。</p>
    </div>
    <div class="tiles">
      <div class="tile"><div class="tl">受領ファイル</div><div class="tv">${input.fileCount}<small>件</small></div></div>
      <div class="tile"><div class="tl">検出した表</div><div class="tv">${regions.length}<small>表</small></div></div>
      <div class="tile"><div class="tl">表どうしの関係</div><div class="tv">${edgeTotal.toLocaleString()}<small>件</small></div></div>
      <div class="tile warn"><div class="tl">ご確認いただきたい点</div><div class="tv">${questions.length}<small>件</small></div></div>
    </div>
    <div class="summary">
      <div class="stitle">まとめ</div>
      <ul>
        ${bullets.map(b => `<li>${b}</li>`).join('\n        ')}
      </ul>
    </div>

    ${spec.items.fileTable ? `
    <h3 class="sub-h">ブック（ファイル）別</h3>
    <div style="overflow-x:auto">
      <table class="ot">
        <tr><th>ファイル</th><th>シート</th><th>表</th><th>行数（合計）</th><th>役割</th><th>流れ込む元ファイル</th><th>ご登録の関係</th></tr>
        ${fileRows.join('\n        ')}
      </table>
    </div>` : ''}

    ${spec.items.sheetDetails ? `
    <h3 class="sub-h">ブックの中身（シートの役割と列構成）</h3>
    <p class="graph-guide">クリックで展開できます。列の色分け：<span class="colchip key">キー列</span> <span class="colchip formula">数式列</span> <span class="colchip manual">手入力の数値</span></p>
    ${fileBlocks}` : ''}

    ${spec.items.declaredAudit && auditRows.length > 0 ? `
    <h3 class="sub-h">ご登録いただいたブック関係と、自動解析の突き合わせ</h3>
    <p class="graph-guide">ご登録内容と自動解析の結果が一致しているかの確認です。${noQuestions ? `食い違いは ${noQuestions} でご確認をお願いしています。` : ''}</p>
    <div style="overflow-x:auto">
      <table class="ot">
        <tr><th>ブック関係</th><th>種類</th><th>判定</th><th>検出した関係数</th><th>ご登録の説明</th></tr>
        ${auditRows.join('\n        ')}
      </table>
    </div>` : ''}
  </div>
</section>` : ''}

${secOn.flow ? `
<section>
  <div class="wrap">
    <div class="sec-head">
      <div class="eyebrow">${noFlow} ── FLOW &amp; LOGIC</div>
      <h2>全体の流れと詳細ロジック</h2>
      <p class="sec-lede">${showFileFlow
        ? 'まず<b>ブックどうしの全体関係図</b>で流れをご覧いただき、続けて<b>シート・表単位の詳細関係図</b>と、その処理内容（キー・数式）へ降りていきます。'
        : multiFile
        ? '<b>シート・表単位の関係図</b>で流れをご覧いただき、続けてその処理内容（キー・数式）を説明します。'
        : 'ご提供は1ブックのため、<b>シート・表単位の関係</b>で流れをご覧いただき、続けてその処理内容（キー・数式）を説明します。'}</p>
    </div>
    ${showFileFlow ? (fileFlow ? `
    ${subH('全体関係図（ブックどうしの流れ）')}
    <ul class="graph-guide">
      <li><b>ボックス＝ファイル</b>。左が起点、<b style="color:#C24141">右端が最終アウトプット</b>で、矢印の向きにデータが流れます</li>
      <li><b>線の色＝関係の種類</b>／<b>破線の線＝手作業コピー（要確認）</b>／<b>破線の枠＝つながりが自動検出できなかった最終アウトプット</b></li>
    </ul>
    <div class="map-scroll">${fileFlow}</div>
    <div class="legend">
      <span class="lg-h">ファイルの役割</span>
      <span class="li"><span class="nrole src"></span>元データ</span>
      <span class="li"><span class="nrole mid"></span>中間ファイル</span>
      <span class="li"><span class="nrole out"></span>最終アウトプット</span>
      <span class="li"><span class="nrole iso"></span>独立（つながり未検出）</span>
    </div>
    ${declaredNotes.length > 0 ? `<div class="seg-note"><span class="mark">📝</span><div>${declaredNotes.map(d =>
      `<p><b>${esc(fileNameOf(d.fromFile))} → ${esc(fileNameOf(d.toFile))}（${esc(FILE_REL_LABELS[d.relType])}）</b>：${esc(d.note)}</p>`).join('')}</div></div>` : ''}` : `
    <p class="sec-lede">ファイルをまたぐ関係は検出されませんでした。各ファイルが独立して管理されている可能性があります${refQuestions}。</p>`) : ''}

    ${map ? `
    ${er ? `
    ${subH('詳細関係図①　キー関係図（ER）')}
    <ul class="graph-guide">
      <li><b>ボックス＝表</b>。<span class="k">🔑</span>＝主キー（1行を一意に決める列）／<span class="k">◇</span>＝軸</li>
      <li><b>線＝同じキー列での対応</b>。端の <b>1 / N</b> が1対多（<b>1</b>＝マスタ側／<b>N</b>＝明細側）</li>
    </ul>
    <div class="map-scroll er-scroll">${er.svg}</div>
    ${er.omitted > 0 ? `<p class="tbl-note">※ キーでつながる表を優先表示（ほか ${er.omitted} 表は省略）。</p>` : ''}` : ''}

    ${subH(er ? '詳細関係図②　最終アウトプットへの流れ（シート・表単位）' : '詳細関係図　最終アウトプットへの流れ（シート・表単位）')}
    <ul class="graph-guide">
      <li><b>ノード＝表</b>。<b>上＝元データ → 下＝最終アウトプット</b>、矢印の向きにデータが流れます</li>
      <li><b>線の色＝関係の種類</b>／<b>破線＝手作業コピー（要確認）</b></li>
      ${spec.items.interactiveGraph ? `<li class="only-screen"><b>クリック</b>すると、その表の関係先と最終アウトプットまでの経路を右パネルに表示します（パンくずで戻れます）</li>
      <li class="only-screen">右上のボタン：<span class="k">＋ －</span> 拡大縮小／<span class="k">▤</span> レイアウト／<span class="k">☾</span> 配色／<span class="k">⤢</span> 全画面（Escで戻る）／<span class="k">⟳</span> リセット。背景ドラッグで移動</li>` : ''}
    </ul>
    ${spec.items.interactiveGraph ? '<p class="graph-guide only-print">※ 本紙は静止画です。操作版はブラウザでご覧ください。</p>' : ''}
    <div class="map-static map-scroll">${map.svg}</div>
    ${spec.items.interactiveGraph ? `<div class="map-interactive relgraph-wrap" id="relgraph-wrap">
      <figure class="relgraph-stage lightmode" id="relgraph" aria-label="表どうしの関係グラフ（操作可能）"></figure>
      <aside class="relgraph-panel">
        <div class="relgraph-crumbs" id="relgraph-crumbs"><span class="cur">表を選択</span></div>
        <div class="relgraph-pbody" id="relgraph-pbody"><div class="empty">左のグラフで<b>表</b>をクリックすると、関係している表（上流／下流）と<b>最終アウトプットまでの経路</b>がここに出て、そのまま掘り下げられます。</div></div>
      </aside>
    </div>
    <script type="application/json" id="relgraph-data">${JSON.stringify(map.data).replace(/</g, '\\u003c')}</script>` : ''}
    <div class="legend">
      <span class="lg-h">関係の種類</span>
      ${GROUP_ORDER.map(g => `<span class="li"><span class="sw${GROUP_META[g].dashed ? ' dash' : ''}" style="border-color:${GROUP_META[g].color}"></span>${esc(GROUP_META[g].label)}</span>`).join('\n      ')}
    </div>
    <div class="legend">
      <span class="lg-h">表の役割</span>
      <span class="li"><span class="nrole src"></span>元データ（明細）</span>
      <span class="li"><span class="nrole mst"></span>マスタ（参照元）</span>
      <span class="li"><span class="nrole mid"></span>中間集計</span>
      <span class="li"><span class="nrole out"></span>最終アウトプット</span>
      <span class="li"><span class="nrole iso"></span>独立（つながりなし・要確認）</span>
    </div>
    ${map.omittedNodes > 0 || map.omittedEdges > 0
      ? `<p class="tbl-note">※ 円の大きさ＝つながりの本数。つながりの多い表を優先表示（省略: 表 ${map.omittedNodes}・関係 ${map.omittedEdges}）。</p>`
      : '<p class="tbl-note">※ 円の大きさ＝つながりの本数。</p>'}

    ${spec.items.detailLogic ? `
    ${subH('詳細ロジック — どのシートが、どのキーで、どうつながっているか')}
    <div style="overflow-x:auto">
      <table class="ot dl">
        <tr><th>元（表・列）</th><th>キー</th><th>処理</th><th>先（表・列）</th><th>根拠（数式・一致）</th><th>確度</th></tr>
        ${detailRows.join('\n        ')}
      </table>
      ${detailOmitted > 0 ? `<p class="tbl-note">※ 関係が多いため流れの順に上位 ${DETAIL_ROWS_CAP} 件を掲載しています（全 ${pairs.length} 件）。残りはお打ち合わせで画面をご覧いただけます。</p>` : ''}
    </div>` : ''}
    <div class="callout info">
      <span class="mark">ℹ️</span>
      <span>ピボットテーブル・INDIRECT関数・ファイル間の数式リンクは自動追跡の対象外です。図に出ていないつながりがあれば、お打ち合わせで補足をお願いします。</span>
    </div>` : `
    <p class="sec-lede">表どうしをつなぐ数式・値一致の関係は検出されませんでした。各表が独立して管理されている可能性があります${refQuestions}。</p>`}
  </div>
</section>` : ''}

${secOn.questions ? `
<section class="alt">
  <div class="wrap">
    <div class="sec-head">
      <div class="eyebrow">${noQuestions} ── QUESTIONS</div>
      <h2>ご確認いただきたい点（${questions.length}件）</h2>
      <p class="sec-lede">自動解析では「推定」までしかできない箇所です。上から順にご回答をいただけますと、kpieeの設定を正確に進められます。<b>回答メモ欄は印刷してそのままお使いいただけます。</b></p>
    </div>
    ${qCards}
    <div class="callout info">
      <span class="mark">💡</span>
      <span>実線の関係（数式由来）は数式そのものが根拠のため、原則ご確認は不要です。上記は<b>自動解析が「推定」に留まる箇所だけ</b>を抽出しています。</span>
    </div>
  </div>
</section>` : ''}

${secOn.nextSteps ? `
<section>
  <div class="wrap">
    <div class="sec-head">
      <div class="eyebrow">${noNext} ── NEXT STEP</div>
      <h2>今後の進め方</h2>
    </div>
    <div class="steps">
      <div class="step"><div class="no">1</div>
        <h3>本資料の読み合わせ<span class="who">貴社 × 弊社</span></h3>
        <p>お打ち合わせ（30〜60分）で、${noQuestions ? `${noQuestions}の確認事項に` : '確認事項に'}ご回答をいただきます。わかる範囲で結構です。</p>
      </div>
      <div class="step"><div class="no">2</div>
        <h3>定義の確定・追加データのご提供<span class="who">貴社 × 弊社</span></h3>
        <p>ご回答をもとにデータ定義を確定します。不足データがあればご提供をお願いします。</p>
      </div>
      <div class="step"><div class="no">3</div>
        <h3>kpieeへの取込設定・KPIツリー構築<span class="who">弊社主導</span></h3>
        <p>確定した構造にもとづき、kpieeのデータ取込とKPIの紐付けを設定します。手転記いただいていた箇所は自動化されます。</p>
      </div>
      <div class="step"><div class="no">4</div>
        <h3>数値検証・運用開始<span class="who">貴社 × 弊社</span></h3>
        <p>既存のExcel報告と kpiee の数値を突き合わせ、一致を確認してから運用に切り替えます。</p>
      </div>
    </div>
    <div class="callout warn">
      <span class="mark">⚠️</span>
      <span>本レポートは自動解析の結果にもとづきます。数式のないつながり（破線）や役割・キーの表記は推定であり、ご確認の結果によって内容を更新します。本資料に原本の数値データは含まれていません（列名・数式・行数などの構造情報のみ）。</span>
    </div>
  </div>
</section>` : ''}

<footer>
  <div class="wrap">© dataX Inc.　|　kpiee データ構造分析レポート（${dateStr} 生成）　|　本資料は貴社との確認用資料であり、社外への共有はお控えください。</div>
</footer>
<script>${REPORT_PRINT_JS}</script>
${map && spec.items.interactiveGraph ? `<script>${REPORT_GRAPH_JS}</script>` : ''}
</body>
</html>
`;
}

// レポートのスタイル（bdash 提案資料と同じデザイン言語）。JSの開示アニメーションは
// 配布ファイルでは不要なので持たず、CSSのみで完結させる。
const REPORT_CSS = `
:root{
  --ink:#0E2A47;--blue:#1F5FAE;--sky:#3D9BE9;
  --green:#1E9E6A;--green-bg:#E9F7F0;--violet:#7B5EA7;--violet-bg:#F1EDF8;
  --amber:#B96A00;--amber-bg:#FFF4E3;--red:#C24141;--red-bg:#FBEFEF;
  --paper:#F7F9FC;--text:#3A4552;--sub:#7A8794;--line:#DDE5EE;--blue-bg:#EDF4FC;
  --mono:'IBM Plex Mono',monospace;--disp:'Zen Old Mincho',serif;--body:'Noto Sans JP',sans-serif;
}
*{margin:0;padding:0;box-sizing:border-box}
html{scroll-behavior:smooth}
body{font-family:var(--body);color:var(--text);background:var(--paper);font-size:15px;line-height:1.85;-webkit-font-smoothing:antialiased}
.wrap{max-width:1060px;margin:0 auto;padding:0 28px}
header{background:var(--ink);color:#fff;position:relative;overflow:hidden}
header::after{content:'';position:absolute;right:-120px;top:-120px;width:420px;height:420px;border-radius:50%;background:radial-gradient(circle,rgba(61,155,233,.25),transparent 70%);pointer-events:none}
.hero{padding:64px 0 52px;position:relative;z-index:1;max-width:820px}
.brand{font-family:var(--mono);font-size:12px;letter-spacing:.18em;color:var(--sky);margin-bottom:20px}
h1{font-family:var(--disp);font-weight:900;font-size:34px;line-height:1.5;letter-spacing:.02em;margin-bottom:16px}
h1 .em{color:var(--sky)}
.lede{color:#C6D6E8;font-size:15px;max-width:40em}
.hero-meta{display:flex;gap:10px;margin-top:24px;flex-wrap:wrap}
.hero-meta span{font-size:12px;border:1px solid rgba(255,255,255,.28);border-radius:999px;padding:4px 14px;color:#D8E4F2}
.hero-meta span b{color:#fff;font-weight:500}
section{padding:60px 0}
section.alt{background:#fff}
.sec-head{margin-bottom:32px}
.eyebrow{font-family:var(--mono);font-size:12px;letter-spacing:.16em;color:var(--blue);margin-bottom:10px}
h2{font-family:var(--disp);font-weight:700;font-size:26px;color:var(--ink);line-height:1.5}
.sec-lede{margin-top:12px;max-width:46em;color:var(--text)}
.tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:18px}
.tile{background:#fff;border:1px solid var(--line);border-radius:16px;padding:20px 22px}
.tile .tl{font-size:12px;color:var(--sub);letter-spacing:.04em}
.tile .tv{font-family:var(--mono);font-size:30px;color:var(--ink);line-height:1.4;margin-top:2px}
.tile .tv small{font-size:14px;color:var(--sub);margin-left:2px}
.tile.warn{border-top:4px solid var(--amber)}
.tile.warn .tv{color:var(--amber)}
.summary{margin-top:26px;background:#fff;border:1px solid var(--line);border-radius:16px;padding:24px 28px}
.summary .stitle{font-weight:700;color:var(--ink);font-size:14px;border-left:3px solid var(--blue);padding-left:10px;margin-bottom:10px}
.summary ul{list-style:none;display:flex;flex-direction:column;gap:8px;font-size:13.5px}
.summary li{padding-left:16px;position:relative}
.summary li::before{content:'▸';position:absolute;left:0;color:var(--blue)}
.summary li b{color:var(--ink)}
.ot{width:100%;border-collapse:collapse;font-size:12.5px;background:#fff;border-radius:12px;overflow:hidden;border:1px solid var(--line)}
.ot th{background:var(--ink);color:#fff;padding:8px 12px;text-align:left;font-weight:500;white-space:nowrap}
.ot td{padding:8px 12px;border-bottom:1px solid var(--line);vertical-align:top}
.ot tr:last-child td{border-bottom:none}
.ot td.mono{font-family:var(--mono);font-size:11.5px;white-space:nowrap}
.ot td.r{text-align:right;font-family:var(--mono);font-size:11.5px}
.tbl-note{font-size:11.5px;color:var(--sub);margin-top:8px}
.rel{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:700;border-radius:999px;padding:2px 10px;white-space:nowrap}
.rel::before{content:'';width:8px;height:8px;border-radius:50%;background:currentColor}
.rel.lookup{background:var(--blue-bg);color:var(--blue)}
.rel.agg{background:var(--green-bg);color:var(--green)}
.rel.move{background:var(--violet-bg);color:var(--violet)}
.rel.copy{background:var(--amber-bg);color:var(--amber)}
.conf{font-family:var(--mono);font-size:11px;color:var(--sub)}
.conf b{color:var(--ink);font-weight:500}
.map-scroll{overflow-x:auto;background:#FCFDFE;border:1px solid var(--line);border-radius:16px;padding:18px}
.map-scroll svg{min-width:760px;width:100%;height:auto;display:block;font-family:var(--body)}
.er-scroll svg{min-width:640px;width:100%;height:auto;display:block;font-family:var(--body)}
.legend{display:flex;gap:14px;flex-wrap:wrap;margin-top:14px;font-size:12px}
.legend .li{display:inline-flex;align-items:center;gap:7px;color:var(--text)}
.legend .sw{width:22px;height:0;border-top:3px solid;border-radius:2px}
.legend .sw.dash{border-top-style:dashed}
/* 折りたたみブロック（01 のブック別）。三角は自前で描く */
details.fileblk>summary{list-style:none}
details.fileblk>summary::-webkit-details-marker{display:none}
details.fileblk>summary::before{content:'▸';color:var(--blue);transition:transform .2s}
details.fileblk[open]>summary::before{transform:rotate(90deg)}
.loc{font-family:var(--mono);font-size:11px;color:var(--sub)}
.rows{font-family:var(--mono);font-size:11px;color:var(--sub);margin-left:auto}
.rbody{padding:14px 20px 18px}
.colchips{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0 4px}
.colchip{font-size:11.5px;border:1px solid var(--line);border-radius:8px;padding:3px 10px;background:#FCFDFE}
.colchip.key{border-color:#C9DEF4;background:var(--blue-bg);color:var(--blue);font-weight:700}
.colchip.formula{border-color:#BFE5D3;background:var(--green-bg);color:var(--green)}
.colchip.manual{border-color:#F0D8B0;background:var(--amber-bg);color:var(--amber)}
.rnote{font-size:12px;color:var(--sub)}
.key-note{font-size:12.5px;margin-top:8px}
.key-note b{color:var(--ink)}
.qcard{background:#fff;border:1px solid var(--line);border-left:5px solid var(--amber);border-radius:14px;padding:20px 24px;margin-bottom:16px}
.qcard.p-high{border-left-color:var(--red)}
.qhead{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px}
.qid{font-family:var(--mono);font-size:13px;font-weight:500;color:var(--ink)}
.qtag{font-size:10.5px;font-weight:700;border-radius:999px;padding:2px 11px}
.qtag.kind{background:var(--blue-bg);color:var(--blue)}
.qtag.high{background:var(--red-bg);color:var(--red)}
.qtag.mid{background:var(--amber-bg);color:var(--amber)}
.qtitle{font-size:15px;font-weight:700;color:var(--ink)}
.qgrid{display:grid;grid-template-columns:96px 1fr;gap:6px 14px;font-size:13px;margin-top:6px}
.qgrid dt{color:var(--sub);font-size:12px;padding-top:2px}
.qgrid dd{line-height:1.75}
.ansbox{margin-top:12px;border:1.5px dashed var(--line);border-radius:10px;min-height:56px;padding:8px 12px;font-size:12px;color:var(--sub);background:#FCFDFE}
.steps{position:relative;margin-left:12px}
.steps::before{content:'';position:absolute;left:21px;top:8px;bottom:8px;width:2px;background:var(--line)}
.step{position:relative;padding:0 0 26px 66px}
.step:last-child{padding-bottom:0}
.step .no{position:absolute;left:0;top:0;width:44px;height:44px;border-radius:50%;background:var(--blue);color:#fff;display:flex;align-items:center;justify-content:center;font-family:var(--disp);font-weight:700;font-size:18px;box-shadow:0 0 0 5px var(--paper)}
.step h3{font-size:16px;color:var(--ink);display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.step h3 .who{font-size:11px;font-weight:700;border-radius:999px;padding:2px 11px;background:var(--blue-bg);color:var(--blue)}
.step p{font-size:13.5px;margin-top:4px;max-width:46em}
.callout{margin-top:24px;border-radius:14px;padding:16px 20px;font-size:13px;display:flex;gap:12px;align-items:flex-start}
.callout.warn{background:var(--amber-bg);border:1px solid #F0D8B0;color:#7A5100}
.callout.info{background:var(--blue-bg);border:1px solid #C9DEF4;color:#1C4B84}
.callout .mark{font-size:17px;line-height:1.4}
footer{padding:30px 0 42px;color:var(--sub);font-size:11.5px;text-align:center}
@media (max-width:900px){
  h1{font-size:26px}
  .tiles{grid-template-columns:1fr 1fr}
  .qgrid{grid-template-columns:1fr}
  .qgrid dt{padding-top:6px}
}
.via{font-family:var(--mono);font-size:10.5px;color:var(--sub);margin-left:8px;white-space:nowrap}

/* ---- 01 ブックの中身（シート役割＋列構成）---- */
.fileblk{background:#fff;border:1px solid var(--line);border-radius:14px;margin-bottom:10px;overflow:hidden}
.fileblk>summary{cursor:pointer;padding:13px 18px;display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;font-size:14px}
.fileblk>summary:hover{background:var(--blue-bg)}
.fileblk[open]>summary{border-bottom:1px solid var(--line)}
.fileblk>summary b{word-break:break-all}
.sub-lede{font-size:12px;font-weight:700;color:var(--sub);letter-spacing:.04em;margin:14px 0 7px}
.sub-lede:first-child{margin-top:0}
.srchips{display:flex;flex-wrap:wrap;gap:7px;margin-bottom:4px}
.sr{display:inline-flex;flex-direction:column;gap:1px;border:1px solid var(--line);border-left-width:4px;border-radius:8px;padding:5px 10px;font-size:12px;color:var(--ink);background:#FCFDFE}
.sr em{font-style:normal;font-size:10.5px;color:var(--sub)}
.sr.src{border-left-color:var(--green)}
.sr.mst{border-left-color:var(--blue)}
.sr.mid{border-left-color:var(--violet)}
.sr.out{border-left-color:var(--red)}
.sr.unk{border-left-color:#9AA7B4}
.rblock{border-top:1px dashed var(--line);padding-top:12px;margin-top:12px}
.rblock:first-of-type{border-top:0;padding-top:0;margin-top:0}
.rhead{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;font-size:13px;margin-bottom:7px}
.rrole{font-size:10.5px;color:var(--sub)}
/* ---- 01 突き合わせ判定バッジ ---- */
.av{display:inline-block;padding:2px 9px;border-radius:20px;font-size:11px;font-weight:700;white-space:nowrap}
.av.ok{background:var(--green-bg);color:var(--green)}
.av.warn{background:var(--amber-bg);color:var(--amber)}
.av.ng{background:var(--red-bg);color:var(--red)}

/* ---- 02 ご登録いただいたブック関係の説明（全体関係図の直下）---- */
.seg-note{display:flex;gap:10px;background:var(--blue-bg);border-radius:10px;padding:11px 14px;margin-top:14px;font-size:12.5px;line-height:1.8}
.seg-note p{margin:0}
.seg-note p+p{margin-top:4px}
/* ---- 02 詳細ロジック表 ---- */
table.dl{font-size:12px}
table.dl td{vertical-align:top}
.dl-col{display:block;font-family:var(--mono);font-size:10.5px;color:var(--blue)}
.dl-proc{font-size:11px;color:var(--sub);margin-top:3px}
.dl-ev{font-size:10.5px;color:var(--sub);word-break:break-all}
.dl-q{font-family:var(--mono);font-size:10.5px;color:var(--red);font-weight:700}
.dl-none{color:var(--sub)}
/* ---- 図の凡例・見出し ---- */
.sub-h{font-family:var(--disp);font-weight:700;font-size:18px;color:var(--ink);margin:30px 0 6px}
.graph-guide{font-size:12.5px;color:var(--text);line-height:1.7;margin-bottom:12px}
/* 図の凡例テキスト: 1行1項目で読ませる */
ul.graph-guide{list-style:none;padding:0;display:flex;flex-direction:column;gap:4px}
ul.graph-guide li{padding-left:15px;position:relative}
ul.graph-guide li::before{content:'―';position:absolute;left:0;color:var(--sub)}
ul.graph-guide b{color:var(--ink)}
ul.graph-guide .k{font-family:var(--mono);font-size:11.5px;color:var(--ink)}
.only-print{display:none}
.legend .lg-h{font-weight:700;color:var(--ink);font-size:12px;margin-right:2px}
.nrole{width:13px;height:13px;border-radius:50%;display:inline-block;border:2px solid;vertical-align:-2px}
.nrole.src{background:var(--green-bg);border-color:var(--green)}
.nrole.mst{background:var(--blue-bg);border-color:var(--blue)}
.nrole.mid{background:var(--violet-bg);border-color:var(--violet)}
.nrole.out{background:var(--red-bg);border-color:var(--red)}
.nrole.iso{background:#F2F5F8;border-color:#9AA7B4}

/* 関係グラフ本体（JS 有効時のみ表示。印刷・JS無効は静的SVG .map-static へ） */
.map-interactive{display:none}
.relgraph-wrap{grid-template-columns:1fr 300px;gap:14px;align-items:stretch}
.relgraph-stage{position:relative;border:1px solid var(--line);border-radius:14px;overflow:hidden;min-height:560px;touch-action:none;
  --gbg:#12141C;--glbl:#C9D1DE;--glbl2:#7F8A9C;
  --c-src:#3FCF8E;--c-mst:#5AA9FF;--c-mid:#B392F0;--c-out:#FF8B7B;--c-iso:#8B98A5;
  background:radial-gradient(circle at 50% 38%,#1C1F2A 0%,#12141C 72%)}
.relgraph-stage.lightmode{--gbg:#FCFDFE;--glbl:#0E2A47;--glbl2:#7A8794;
  --c-src:#1E9E6A;--c-mst:#1F5FAE;--c-mid:#7B5EA7;--c-out:#C0392B;--c-iso:#9AA7B4;
  background:#FCFDFE;background-image:radial-gradient(circle at 1px 1px,#E4EBF3 1px,transparent 0);background-size:22px 22px}
.relgraph-stage svg{width:100%;height:100%;display:block;font-family:var(--body);cursor:grab}
.relgraph-stage svg.panning{cursor:grabbing}
.relgraph-ctrl{position:absolute;top:10px;right:10px;display:flex;gap:6px;z-index:3}
.relgraph-ctrl button{width:32px;height:32px;padding:0;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.09);color:#E3E9F2;border-radius:8px;font-size:14px;line-height:1;cursor:pointer;backdrop-filter:blur(4px)}
.relgraph-ctrl button:hover{background:rgba(255,255,255,.2);border-color:rgba(255,255,255,.34)}
.relgraph-stage.lightmode .relgraph-ctrl button{border-color:var(--line);background:#fff;color:var(--ink);box-shadow:0 1px 3px rgba(14,42,71,.1)}
.relgraph-stage.lightmode .relgraph-ctrl button:hover{background:var(--blue-bg);border-color:var(--blue);color:var(--blue)}
.relgraph-hint{position:absolute;left:12px;bottom:10px;z-index:3;font-size:10.5px;letter-spacing:.02em;color:var(--glbl2);pointer-events:none}
/* ノード（Obsidian風の円） */
.node{cursor:pointer;transition:opacity .18s}
.node .dot{stroke:var(--gbg);stroke-width:1.5}
.node .halo{fill:none;stroke:none;transition:.18s}
.node.role-src .dot{fill:var(--c-src)}
.node.role-mst .dot{fill:var(--c-mst)}
.node.role-mid .dot{fill:var(--c-mid)}
.node.role-out .dot{fill:var(--c-out)}
.node.role-iso .dot{fill:var(--c-iso)}
.node.role-out .halo{stroke:var(--c-out);stroke-opacity:.32;stroke-width:2}
.node .lbl{fill:var(--glbl);font-size:11px;font-weight:600;text-anchor:middle;paint-order:stroke;stroke:var(--gbg);stroke-width:3.4px;stroke-linejoin:round;pointer-events:none}
.node.hov .lbl,.node.sel .lbl{fill:#fff;font-weight:700}
.relgraph-stage.lightmode .node.hov .lbl,.relgraph-stage.lightmode .node.sel .lbl{fill:var(--ink)}
.node.hov .halo,.node.sel .halo{stroke:#fff;stroke-opacity:.55;stroke-width:2.4}
.relgraph-stage.lightmode .node.hov .halo,.relgraph-stage.lightmode .node.sel .halo{stroke:var(--blue);stroke-opacity:.85}
.node.role-out .lbl{font-weight:800}
.edge{fill:none;stroke-width:1.3;opacity:.5;transition:opacity .18s,stroke-width .18s}
.relgraph-stage svg.focused .node:not(.hl):not(.path){opacity:.14}
.relgraph-stage svg.focused .edge:not(.epath):not(.ehl){opacity:.05}
.edge.epath{stroke-width:3;opacity:1}
.edge.ehl{stroke-width:2.4;opacity:1}
/* インスペクタ（クリックした表の上流・下流と最終アウトプットまでの経路） */
.relgraph-panel{background:#fff;border:1px solid var(--line);border-radius:14px;overflow:hidden;display:flex;flex-direction:column;min-height:480px}
.relgraph-crumbs{display:flex;align-items:center;gap:4px;flex-wrap:wrap;padding:10px 13px;border-bottom:1px solid var(--line);font-size:11.5px;min-height:42px}
.relgraph-crumbs .c{color:var(--blue);cursor:pointer;background:none;border:0;padding:2px 4px;font:inherit;border-radius:6px}
.relgraph-crumbs .c:hover{background:var(--blue-bg)}
.relgraph-crumbs .sep{color:var(--sub)}
.relgraph-crumbs .cur{color:var(--ink);font-weight:700}
.relgraph-pbody{padding:15px 15px 20px;overflow:auto;font-size:13px}
.relgraph-pbody .empty{color:var(--sub);font-size:12.5px;line-height:1.9}
.relgraph-pbody .empty b{color:var(--ink)}
.pname{font-size:15px;font-weight:800;color:var(--ink);line-height:1.35;margin:0 0 8px}
.rolechip{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:700;border-radius:999px;padding:3px 11px;border:1px solid}
.rolechip.rc-src{color:var(--green);background:var(--green-bg);border-color:var(--green)}
.rolechip.rc-mst{color:var(--blue);background:var(--blue-bg);border-color:var(--blue)}
.rolechip.rc-mid{color:var(--violet);background:var(--violet-bg);border-color:var(--violet)}
.rolechip.rc-out{color:var(--red);background:var(--red-bg);border-color:var(--red)}
.rolechip.rc-iso{color:var(--sub);background:#F2F5F8;border-color:#9AA7B4}
.p-meta{font-size:11.5px;color:var(--sub);margin:10px 0 3px}
.p-keys{font-family:var(--mono);font-size:11.5px;color:var(--text);background:var(--paper);border:1px solid var(--line);border-radius:8px;padding:6px 10px}
.p-route{display:flex;align-items:center;flex-wrap:wrap;gap:4px;background:var(--paper);border:1px solid var(--line);border-radius:10px;padding:8px 10px;font-size:12px}
.p-route .r{cursor:pointer;color:var(--blue);background:none;border:0;font:inherit;padding:1px 3px;border-radius:5px}
.p-route .r:hover{background:var(--blue-bg)}
.p-route .r.out{color:var(--red);font-weight:700}
.p-route .arw{color:var(--sub)}
.p-grp{margin-top:15px}
.p-grp h4{margin:0 0 7px;font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--sub);font-weight:700}
.p-chips{display:flex;flex-direction:column;gap:6px}
.p-chip{display:flex;align-items:center;gap:8px;width:100%;text-align:left;background:#fff;border:1px solid var(--line);border-radius:10px;padding:7px 10px;cursor:pointer;font:inherit;font-size:12px;color:var(--ink);transition:.12s}
.p-chip:hover{border-color:var(--blue);background:var(--blue-bg)}
.p-chip .dot{width:9px;height:9px;border-radius:50%;flex:none}
.p-chip .via{margin-left:auto;font-family:var(--mono);font-size:10px;color:var(--sub);white-space:nowrap}
.p-chip.none{cursor:default;color:var(--sub);border-style:dashed}
.p-chip.none:hover{border-color:var(--line);background:#fff}
.relgraph-wrap.expanded{position:fixed;inset:0;z-index:9999;margin:0;padding:16px;background:var(--paper);grid-template-columns:1fr 320px}
.relgraph-wrap.expanded .relgraph-stage,.relgraph-wrap.expanded .relgraph-panel{min-height:0;height:100%}
body.relgraph-noscroll{overflow:hidden}
@media (max-width:760px){ .relgraph-wrap{grid-template-columns:1fr} .relgraph-panel{min-height:0} }
@media print{
  header::after{display:none}
  section{padding:28px 0}
  .qcard{page-break-inside:avoid}
  /* 印刷時は折りたたみを全て開いて紙に載せる（details[open] は JS で付ける） */
  .fileblk{page-break-inside:avoid}
  .fileblk>summary{list-style:none}
  /* 操作版は紙に出せないので静的SVGへ差し替える */
  .map-interactive{display:none!important}
  .map-static{display:block!important}
  .only-print{display:inline}
  .only-screen{display:none}
}
`;

// 01 の折りたたみ（ブックの中身）を印刷時だけ開く。閉じた details は中身が紙に出ないため。
const REPORT_PRINT_JS = `
(function(){
  var opened = [];
  window.addEventListener('beforeprint', function(){
    opened = [];
    var ds = document.querySelectorAll('details.fileblk');
    for (var i = 0; i < ds.length; i++) {
      if (!ds[i].open) { ds[i].open = true; opened.push(ds[i]); }
    }
  });
  window.addEventListener('afterprint', function(){
    for (var i = 0; i < opened.length; i++) opened[i].open = false;
    opened = [];
  });
})();
`;

// 関係グラフ（Obsidian 風の力学配置＋階層レイアウト）。#relgraph-data(JSON) を読み、円ノードで各表を描く。
// 円の大きさ＝つながりの本数、縦位置＝最終アウトプットまでの距離（上=元データ→下=最終）。ホバーで一時強調、
// クリックで固定し、右パネル（パンくず＋経路＋上流/下流）から掘り下げる。右上ボタンで拡大・レイアウト切替
// （階層⇔力学）・配色切替（ライト⇔ダーク）・全画面・リセット。
// 初期化に失敗したら静的SVG（.map-static）へ戻す。※テンプレートリテラルに埋めるためバッククォート/${ は使わない。
const REPORT_GRAPH_JS = `
(function(){
  try{
    var wrap=document.getElementById('relgraph-wrap');
    var host=document.getElementById('relgraph');
    var dataEl=document.getElementById('relgraph-data');
    var pbody=document.getElementById('relgraph-pbody');
    var crumbsEl=document.getElementById('relgraph-crumbs');
    if(!wrap||!host||!dataEl) return;
    var data=JSON.parse(dataEl.textContent);
    if(!data||!data.nodes||!data.nodes.length) return;
    var staticEl=document.querySelector('.map-static'); if(staticEl) staticEl.style.display='none';
    wrap.style.display='grid';

    var NS='http://www.w3.org/2000/svg';
    var nodes=data.nodes, byId={};
    nodes.forEach(function(n){ byId[n.id]=n; });
    var links=(data.links||[]).filter(function(l){ return byId[l.s]&&byId[l.t]; });
    var outAdj={}, inAdj={}; nodes.forEach(function(n){ outAdj[n.id]=[]; inAdj[n.id]=[]; });
    links.forEach(function(l){ outAdj[l.s].push(l); inAdj[l.t].push(l); });

    function roleClass(role){ if(/最終/.test(role)) return 'out'; if(/マスタ/.test(role)) return 'mst'; if(/中間/.test(role)) return 'mid'; if(/元/.test(role)) return 'src'; return 'iso'; }
    function ekey(l){ return l.s+'>'+l.t+'#'+(l.label||''); }
    function fit(s,n){ s=String(s); return s.length<=n? s : s.slice(0,n)+'…'; }
    function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

    /* ---- 最終アウトプット & 階層（経路計算・縦位置のヒントに使用） ---- */
    var output=null,bestDeg=-1;
    nodes.forEach(function(n){ if(/最終/.test(n.role)){ var d=inAdj[n.id].length; if(d>bestDeg){bestDeg=d;output=n.id;} } });
    if(!output){ bestDeg=-1; nodes.forEach(function(n){ if(outAdj[n.id].length===0){ var d=inAdj[n.id].length; if(d>bestDeg){bestDeg=d;output=n.id;} } }); }
    if(!output){ bestDeg=-1; nodes.forEach(function(n){ if((n.deg||0)>bestDeg){bestDeg=n.deg||0;output=n.id;} }); }
    var layer={};
    function dist(id,seen){ if(id===output) return 0; if(layer[id]!=null) return layer[id]; if(seen[id]) return 0; seen[id]=1; var best=0,any=false; outAdj[id].forEach(function(l){ any=true; var d=1+dist(l.t,seen); if(d>best) best=d; }); layer[id]=any?best:1; return layer[id]; }
    nodes.forEach(function(n){ dist(n.id,{}); }); layer[output]=0;
    function pathToOutput(id){ var ns=[id],es=[],cur=id,guard=0; while(cur!==output&&guard++<60){ var outs=outAdj[cur]; if(!outs.length) break; var best=outs[0]; for(var i=1;i<outs.length;i++){ if(layer[outs[i].t]<layer[best.t]) best=outs[i]; } es.push(ekey(best)); ns.push(best.t); cur=best.t; } return {ns:ns,es:es}; }

    /* ---- ノード半径＝つながりの多さ ---- */
    var W=1280,H=780,PAD=64,maxLink=1;
    nodes.forEach(function(n){ n._d=inAdj[n.id].length+outAdj[n.id].length; if(n._d>maxLink) maxLink=n._d; });
    nodes.forEach(function(n){ n.r=8+18*Math.sqrt(n._d/maxLink); if(roleClass(n.role)==='out') n.r=Math.max(n.r,13); });

    /* ---- 初期配置（元の階層座標を種にして再現性を確保） ---- */
    var sw=data.w||1848, sh=data.h||634;
    function jit(i,k){ var v=Math.sin((i+1)*(k===0?12.9898:78.233))*43758.5453; return (v-Math.floor(v))-0.5; }
    nodes.forEach(function(n,i){
      n.px=PAD+((n.x||0)/sw)*(W-2*PAD)+jit(i,0)*70;
      n.py=PAD+((n.y||0)/sh)*(H-2*PAD)+jit(i,1)*70;
      n.vx=0; n.vy=0; n.fx=null; n.fy=null;
    });
    /* 階層レイアウト時の目標座標（＋力学時の緩やかな縦バイアス） */
    var byLayer={}; nodes.forEach(function(n){ (byLayer[layer[n.id]]=byLayer[layer[n.id]]||[]).push(n); });
    var maxL=0; Object.keys(byLayer).forEach(function(k){ maxL=Math.max(maxL,+k); });
    Object.keys(byLayer).forEach(function(k){
      var L=+k,row=byLayer[k], y=PAD+((maxL-L)/(maxL||1))*(H-2*PAD-40)+20;
      var gap=Math.min(210,(W-2*PAD)/Math.max(1,row.length)), x0=W/2-gap*(row.length-1)/2;
      row.forEach(function(n,i){ n.tx=x0+i*gap; n.ty=y; });
    });

    /* ---- SVG 生成 ---- */
    var svg=document.createElementNS(NS,'svg');
    svg.setAttribute('viewBox','0 0 '+W+' '+H);
    svg.setAttribute('preserveAspectRatio','xMidYMid meet');
    host.appendChild(svg);
    var defs=document.createElementNS(NS,'defs'); svg.appendChild(defs);
    var gZoom=document.createElementNS(NS,'g'); svg.appendChild(gZoom);
    var gE=document.createElementNS(NS,'g'); gZoom.appendChild(gE);
    var gN=document.createElementNS(NS,'g'); gZoom.appendChild(gN);

    var dark=false;
    var DARKMAP={'#1F5FAE':'#6BB0FF','#1E9E6A':'#43D39E','#7B5EA7':'#B392F0','#B96A00':'#F2A33C'};
    function ecol(l){ return dark? (DARKMAP[l.color]||l.color) : l.color; }
    var markers={};
    function markerFor(col){
      if(markers[col]) return markers[col];
      var id='rgar'+Object.keys(markers).length;
      var m=document.createElementNS(NS,'marker');
      m.setAttribute('id',id); m.setAttribute('viewBox','0 0 10 10'); m.setAttribute('refX','9'); m.setAttribute('refY','5');
      m.setAttribute('markerWidth','6'); m.setAttribute('markerHeight','6'); m.setAttribute('orient','auto');
      var pa=document.createElementNS(NS,'path'); pa.setAttribute('d','M0,0 L10,5 L0,10 z'); pa.setAttribute('fill',col); pa.setAttribute('fill-opacity','.85');
      m.appendChild(pa); defs.appendChild(m); markers[col]=id; return id;
    }

    /* 平行エッジのカーブ量 */
    var cnt={}; links.forEach(function(l){ var k=[l.s,l.t].sort().join('|'); cnt[k]=(cnt[k]||0)+1; });
    var seen={}; links.forEach(function(l){ var k=[l.s,l.t].sort().join('|'); var i=(seen[k]=(seen[k]||0)); seen[k]++; l._cv=(i-(cnt[k]-1)/2)*38; });

    var edgeEls={};
    links.forEach(function(l){
      var p=document.createElementNS(NS,'path'); p.setAttribute('class','edge');
      if(l.dashed) p.setAttribute('stroke-dasharray','6 5');
      p.setAttribute('stroke-width', Math.min(3.2,1+Math.log10((l.count||1)+1)*1.1));
      var tt=document.createElementNS(NS,'title'); tt.textContent=byId[l.s].label+' → '+byId[l.t].label+' ／ '+(l.label||'')+(l.qid?(' ／ '+l.qid):'')+(l.count?(' ／ '+l.count+'件'):''); p.appendChild(tt);
      gE.appendChild(p); edgeEls[ekey(l)]=p;
    });
    function paintEdges(){ links.forEach(function(l){ var c=ecol(l), e=edgeEls[ekey(l)]; e.setAttribute('stroke',c); e.setAttribute('marker-end','url(#'+markerFor(c)+')'); }); }
    paintEdges();

    var nodeEls={}, lblEls={};
    nodes.forEach(function(n){
      var g=document.createElementNS(NS,'g'); g.setAttribute('class','node role-'+roleClass(n.role));
      var halo=document.createElementNS(NS,'circle'); halo.setAttribute('class','halo'); halo.setAttribute('r',n.r+5); g.appendChild(halo);
      var c=document.createElementNS(NS,'circle'); c.setAttribute('class','dot'); c.setAttribute('r',n.r); g.appendChild(c);
      var t=document.createElementNS(NS,'text'); t.setAttribute('class','lbl'); t.setAttribute('y','13');
      t.textContent=(roleClass(n.role)==='out'?'★ ':'')+fit(n.label,14); g.appendChild(t);
      var tt=document.createElementNS(NS,'title'); tt.textContent=n.label+' ／ '+n.role+' ／ '+(n.sub||'')+' ／ つながり '+n._d+'本'; g.appendChild(tt);
      g.addEventListener('pointerdown',function(ev){ startDrag(n,ev); });
      g.addEventListener('mouseenter',function(){ hoverId=n.id; paintFocus(); });
      g.addEventListener('mouseleave',function(){ if(hoverId===n.id){ hoverId=null; paintFocus(); } });
      g.addEventListener('click',function(ev){ ev.stopPropagation(); if(lastDragDist<5) jumpTo(n.id,true); });
      gN.appendChild(g); nodeEls[n.id]=g; lblEls[n.id]=t;
    });

    /* ---- 力学シミュレーション ---- */
    var REP=20000, SPRING=0.006, GRAV=0.003, FLOW=0.014, DAMP=0.86;
    var alpha=1, mode='layer', raf=null;
    function step(){
      var i,j,a,b,dx,dy,d,d2,f,ux,uy;
      if(mode==='layer'){
        var moving=false;
        for(i=0;i<nodes.length;i++){ a=nodes[i];
          if(a.fx!=null){ a.px=a.fx; a.py=a.fy; continue; }
          dx=a.tx-a.px; dy=a.ty-a.py; if(Math.abs(dx)+Math.abs(dy)>0.4) moving=true;
          a.px+=dx*0.16; a.py+=dy*0.16; }
        return moving||!!dragN;
      }
      if(alpha<0.005 && !dragN) return false;
      for(i=0;i<nodes.length;i++){ a=nodes[i];
        for(j=i+1;j<nodes.length;j++){ b=nodes[j];
          dx=b.px-a.px; dy=b.py-a.py; d2=dx*dx+dy*dy;
          if(d2<1){ dx=(i-j)||1; dy=1; d2=2; }
          d=Math.sqrt(d2); ux=dx/d; uy=dy/d;
          f=REP/d2; if(f>3) f=3;
          a.vx-=ux*f; a.vy-=uy*f; b.vx+=ux*f; b.vy+=uy*f;
          var mn=a.r+b.r+40;
          if(d<mn){ var ps=(mn-d)*0.22; a.vx-=ux*ps; a.vy-=uy*ps; b.vx+=ux*ps; b.vy+=uy*ps; }
        }
      }
      for(i=0;i<links.length;i++){ var l=links[i]; a=byId[l.s]; b=byId[l.t];
        dx=b.px-a.px; dy=b.py-a.py; d=Math.sqrt(dx*dx+dy*dy)||1; ux=dx/d; uy=dy/d;
        var s=(d-(a.r+b.r+120))*SPRING;
        a.vx+=ux*s; a.vy+=uy*s; b.vx-=ux*s; b.vy-=uy*s;
      }
      for(i=0;i<nodes.length;i++){ a=nodes[i];
        a.vx+=(W/2-a.px)*GRAV; a.vy+=(H/2-a.py)*GRAV;
        a.vy+=(a.ty-a.py)*FLOW;              /* 上流→下流の縦の流れを緩く維持 */
        if(a.fx!=null){ a.px=a.fx; a.py=a.fy; a.vx=0; a.vy=0; continue; }
        a.vx*=DAMP; a.vy*=DAMP;
        var sp=Math.sqrt(a.vx*a.vx+a.vy*a.vy); if(sp>14){ a.vx*=14/sp; a.vy*=14/sp; }
        a.px+=a.vx*alpha; a.py+=a.vy*alpha;
        a.px=Math.max(a.r+44,Math.min(W-a.r-44,a.px));
        a.py=Math.max(a.r+22,Math.min(H-a.r-36,a.py));
      }
      alpha*=0.985;
      return true;
    }
    function draw(){
      for(var i=0;i<links.length;i++){ var l=links[i], a=byId[l.s], b=byId[l.t];
        var dx=b.px-a.px, dy=b.py-a.py, d=Math.sqrt(dx*dx+dy*dy)||1, ux=dx/d, uy=dy/d;
        var mx=(a.px+b.px)/2-uy*l._cv, my=(a.py+b.py)/2+ux*l._cv;
        var sx=a.px+ux*(a.r+2), sy=a.py+uy*(a.r+2);
        var ex=b.px-ux*(b.r+7), ey=b.py-uy*(b.r+7);
        edgeEls[ekey(l)].setAttribute('d','M'+sx.toFixed(1)+','+sy.toFixed(1)+' Q'+mx.toFixed(1)+','+my.toFixed(1)+' '+ex.toFixed(1)+','+ey.toFixed(1));
      }
      for(i=0;i<nodes.length;i++){ var n=nodes[i]; nodeEls[n.id].setAttribute('transform','translate('+n.px.toFixed(1)+','+n.py.toFixed(1)+')'); }
    }
    function loop(){ raf=null; var more=step(); draw(); if(more) raf=requestAnimationFrame(loop); }
    function kick(a){ if(a!=null&&a>alpha) alpha=a; if(!raf) raf=requestAnimationFrame(loop); }
    for(var w=0;w<60;w++) step();   /* 初期は少し落ち着かせてから描画 */

    /* ---- ハイライト（ホバー＝一時／クリック＝固定） ---- */
    var trail=[], selId=null, hoverId=null;
    function paintFocus(){
      var act=hoverId||selId;
      svg.classList.toggle('focused',!!act);
      var hl={},pN={},pE={},eH={};
      if(act){ hl[act]=1;
        inAdj[act].forEach(function(l){ hl[l.s]=1; eH[ekey(l)]=1; });
        outAdj[act].forEach(function(l){ hl[l.t]=1; eH[ekey(l)]=1; });
        var p=pathToOutput(act); p.ns.forEach(function(x){ pN[x]=1; }); p.es.forEach(function(x){ pE[x]=1; });
      }
      nodes.forEach(function(n){ var c='node role-'+roleClass(n.role);
        if(n.id===selId) c+=' sel'; if(n.id===hoverId) c+=' hov';
        if(hl[n.id]) c+=' hl'; if(pN[n.id]) c+=' path';
        nodeEls[n.id].setAttribute('class',c); });
      links.forEach(function(l){ var k=ekey(l),c='edge'; if(pE[k]) c+=' epath'; else if(eH[k]) c+=' ehl'; edgeEls[k].setAttribute('class',c); });
    }
    function render(){ paintFocus(); renderPanel(); renderCrumbs(); }
    function jumpTo(id,push){ if(push){ var ix=trail.indexOf(id); if(ix>=0) trail=trail.slice(0,ix+1); else trail.push(id); } selId=id; render(); }
    function crumbJump(i){ trail=trail.slice(0,i+1); selId=trail[i]; render(); }
    function clearFocus(){ trail=[]; selId=null; hoverId=null; render(); }

    function renderCrumbs(){ if(!selId){ crumbsEl.innerHTML='<span class="cur">表を選択</span>'; return; } var h=''; trail.forEach(function(id,i){ if(i>0) h+='<span class="sep">›</span>'; if(i===trail.length-1) h+='<span class="cur">'+esc(byId[id].label)+'</span>'; else h+='<button class="c" data-i="'+i+'">'+esc(byId[id].label)+'</button>'; }); crumbsEl.innerHTML=h; Array.prototype.forEach.call(crumbsEl.querySelectorAll('.c'),function(b){ b.addEventListener('click',function(){ crumbJump(+b.getAttribute('data-i')); }); }); }
    function chip(l,dir){ var other=dir==='in'?l.s:l.t; var b=document.createElement('button'); b.className='p-chip'; b.innerHTML='<span class="dot" style="background:'+l.color+'"></span><span>'+esc(byId[other].label)+'</span><span class="via">'+esc(l.label||'')+(l.qid?(' '+l.qid):'')+'</span>'; b.addEventListener('click',function(){ jumpTo(other,true); }); b.addEventListener('mouseenter',function(){ hoverId=other; paintFocus(); }); b.addEventListener('mouseleave',function(){ if(hoverId===other){ hoverId=null; paintFocus(); } }); return b; }
    function renderPanel(){ if(!selId){ pbody.innerHTML='<div class="empty">左のグラフで<b>表</b>をクリックすると、関係している表（上流／下流）と<b>最終アウトプットまでの経路</b>がここに出て、そのまま掘り下げられます。</div>'; return; } var n=byId[selId]; pbody.innerHTML=''; var nm=document.createElement('div'); nm.className='pname'; nm.textContent=n.label; pbody.appendChild(nm); var rc=document.createElement('span'); rc.className='rolechip rc-'+roleClass(n.role); rc.textContent=n.role; pbody.appendChild(rc); if(n.sub){ var mt=document.createElement('div'); mt.className='p-meta'; mt.textContent='規模 / キー'; pbody.appendChild(mt); var kb=document.createElement('div'); kb.className='p-keys'; kb.textContent=n.sub; pbody.appendChild(kb); }
      var mt2=document.createElement('div'); mt2.className='p-meta'; mt2.textContent='つながりの数'; pbody.appendChild(mt2); var kb2=document.createElement('div'); kb2.className='p-keys'; kb2.textContent='上流 '+inAdj[selId].length+' ／ 下流 '+outAdj[selId].length+'（計 '+n._d+'）'; pbody.appendChild(kb2);
      var rt=document.createElement('div'); rt.className='p-grp'; rt.innerHTML='<h4>最終アウトプットまでの経路</h4>'; var route=document.createElement('div'); route.className='p-route'; if(roleClass(n.role)==='out'){ route.innerHTML='<span>この表が最終アウトプットです。</span>'; } else { var p=pathToOutput(selId); if(p.ns.length<=1){ route.innerHTML='<span>最終アウトプットへの経路は見つかりませんでした。</span>'; } else { p.ns.forEach(function(id,i){ if(i>0){ var a=document.createElement('span'); a.className='arw'; a.textContent='▸'; route.appendChild(a); } var b=document.createElement('button'); b.className='r'+(id===output?' out':''); b.textContent=byId[id].label; b.addEventListener('click',function(){ jumpTo(id,true); }); route.appendChild(b); }); } } rt.appendChild(route); pbody.appendChild(rt);
      var g1=document.createElement('div'); g1.className='p-grp'; g1.innerHTML='<h4>← この表に入ってくる（上流）</h4>'; var c1=document.createElement('div'); c1.className='p-chips'; if(inAdj[selId].length) inAdj[selId].forEach(function(l){ c1.appendChild(chip(l,'in')); }); else { var e=document.createElement('div'); e.className='p-chip none'; e.textContent='上流なし（起点データ）'; c1.appendChild(e); } g1.appendChild(c1); pbody.appendChild(g1);
      var g2=document.createElement('div'); g2.className='p-grp'; g2.innerHTML='<h4>→ この表から出ていく（下流）</h4>'; var c2=document.createElement('div'); c2.className='p-chips'; if(outAdj[selId].length) outAdj[selId].forEach(function(l){ c2.appendChild(chip(l,'out')); }); else { var e2=document.createElement('div'); e2.className='p-chip none'; e2.textContent='下流なし（最終アウトプット）'; c2.appendChild(e2); } g2.appendChild(c2); pbody.appendChild(g2);
    }

    /* ---- 座標変換 / ズーム / パン ---- */
    var scale=1,ox=0,oy=0,pan=null,moved=false;
    function apply(){
      gZoom.setAttribute('transform','translate('+ox+','+oy+') scale('+scale+')');
      var k=1/scale;
      nodes.forEach(function(n){ lblEls[n.id].setAttribute('transform','translate(0,'+n.r+') scale('+k+')'); });
    }
    function toVB(cx,cy){ var m=svg.getScreenCTM(); if(!m) return {x:0,y:0,k:1}; var p=svg.createSVGPoint(); p.x=cx; p.y=cy; var q=p.matrixTransform(m.inverse()); q.k=m.a||1; return q; }
    function toWorld(ev){ var v=toVB(ev.clientX,ev.clientY); return {x:(v.x-ox)/scale, y:(v.y-oy)/scale}; }
    function zoomAt(vx,vy,f){ var ns=Math.max(0.35,Math.min(5,scale*f)); ox=vx-(vx-ox)*(ns/scale); oy=vy-(vy-oy)*(ns/scale); scale=ns; apply(); }

    var dragN=null, lastDragDist=0, dragStart=null;
    function startDrag(n,ev){
      ev.stopPropagation();
      dragN=n; lastDragDist=0; dragStart={x:ev.clientX,y:ev.clientY};
      var p=toWorld(ev); n._ox=p.x-n.px; n._oy=p.y-n.py; n.fx=n.px; n.fy=n.py;
      kick(0.4);
    }
    window.addEventListener('pointermove',function(ev){
      if(dragN){ var p=toWorld(ev); dragN.fx=p.x-dragN._ox; dragN.fy=p.y-dragN._oy;
        lastDragDist=Math.abs(ev.clientX-dragStart.x)+Math.abs(ev.clientY-dragStart.y); kick(0.35); return; }
      if(pan){ moved=true; var v=toVB(ev.clientX,ev.clientY); ox=pan.ox+(ev.clientX-pan.x)/v.k; oy=pan.oy+(ev.clientY-pan.y)/v.k; apply(); }
    });
    window.addEventListener('pointerup',function(){
      if(dragN){ dragN.fx=null; dragN.fy=null; dragN=null; kick(0.2); }
      if(pan){ pan=null; svg.classList.remove('panning'); }
    });
    svg.addEventListener('pointerdown',function(ev){ if(ev.target.closest&&ev.target.closest('.node')) return; pan={x:ev.clientX,y:ev.clientY,ox:ox,oy:oy}; moved=false; svg.classList.add('panning'); });
    svg.addEventListener('click',function(ev){ if(!(ev.target.closest&&ev.target.closest('.node'))&&!moved) clearFocus(); });
    svg.addEventListener('wheel',function(ev){ ev.preventDefault(); var v=toVB(ev.clientX,ev.clientY); zoomAt(v.x,v.y, ev.deltaY<0?1.12:0.9); },{passive:false});

    /* ---- コントロール ---- */
    var bar=document.createElement('div'); bar.className='relgraph-ctrl';
    function ctl(txt,title,fn){ var b=document.createElement('button'); b.type='button'; b.textContent=txt; b.title=title; b.setAttribute('aria-label',title); b.addEventListener('click',function(ev){ ev.stopPropagation(); fn(b); }); bar.appendChild(b); return b; }
    ctl('＋','拡大',function(){ zoomAt(W/2,H/2,1.25); });
    ctl('－','縮小',function(){ zoomAt(W/2,H/2,0.8); });
    ctl('▤','レイアウト切替（階層 → 力学）',function(b){ mode=(mode==='force'?'layer':'force'); b.textContent=(mode==='force'?'⚛':'▤'); b.title=(mode==='force'?'レイアウト切替（力学 → 階層）':'レイアウト切替（階層 → 力学）'); alpha=1; kick(1); });
    ctl('☾','配色切替（ライト ⇔ ダーク）',function(b){ dark=!dark; host.classList.toggle('lightmode',!dark); b.textContent=dark?'☀':'☾'; paintEdges(); });
    var expanded=false; function toggleExpand(){ expanded=!expanded; wrap.classList.toggle('expanded',expanded); document.body.classList.toggle('relgraph-noscroll',expanded); }
    ctl('⤢','全画面で見る（Escで戻る）',function(){ toggleExpand(); });
    ctl('⟳','配置と表示をリセット',function(){ scale=1; ox=0; oy=0; apply(); nodes.forEach(function(n,i){ n.px=PAD+((n.x||0)/sw)*(W-2*PAD)+jit(i,0)*70; n.py=PAD+((n.y||0)/sh)*(H-2*PAD)+jit(i,1)*70; n.vx=0; n.vy=0; n.fx=null; n.fy=null; }); alpha=1; kick(1); });
    host.appendChild(bar);
    var hint=document.createElement('div'); hint.className='relgraph-hint'; hint.textContent='ドラッグで移動 ／ ホイールで拡大縮小 ／ ノードをドラッグして並べ替え';
    host.appendChild(hint);
    document.addEventListener('keydown',function(e){ if(e.key==='Escape'){ if(expanded) toggleExpand(); else clearFocus(); } });

    apply(); draw(); render(); kick(1);
  }catch(e){
    var w=document.getElementById('relgraph-wrap'); if(w) w.style.display='none';
    var s=document.querySelector('.map-static'); if(s) s.style.display='';
  }
})();
`;

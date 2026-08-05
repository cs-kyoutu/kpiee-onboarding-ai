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
import type {
  RelationGraph, Region, Edge, RelationWarning, KeyLink, SharedTemplateColumn,
} from './preprocess/relations.js';
import { colLetter, fileLabelOf } from './preprocess/relations.js';
import {
  regionIdOf, colNameOf, regionPairKey, filePairKey,
  GROUP_META, GROUP_ORDER, aggregatePairs, dominantGroup, computeLayers,
  aggregateFilePairs, dominantFileGroup, computeFileLayers,
  type Group, type PairAgg, type FilePair,
} from './relations/fileGraph.js';
import { FILE_REL_LABELS, type DeclaredFileRel, type FileRelAudit } from './relations/declared.js';
import { DEFAULT_REPORT_SPEC, type ReportSpec } from './reportSpec.js';

/**
 * 取込時のファイル情報。「最終アウトプットはどれか」は業務知識なので自動推定より優先する。
 * その出典は kind（ファイル単位の種別指定）と sheetRoles（分類確認でのシート単位の役割）の両方。
 * 片方だけを見ると、シートに「最終帳票」を付けた指定が判定に届かない（buildDeclaredOutputIndex 参照）。
 */
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

/**
 * 取込時に「最終帳票」と指定された箇所を引くための索引。
 *
 * 以前はファイル単位の kind だけを最終アウトプットの出典にしていたため、分類確認の画面で
 * シートに「最終帳票」を付けても判定に届かず、自動推定（流れの終着点＝他ファイルからの流入がある
 * 終端）へ落ちていた。その結果「最終帳票のシートを持つファイル」が独立扱いになり、逆に
 * 最終帳票シートを1つも持たないファイルが最終アウトプットと名指しされる状態になっていた。
 * 最終アウトプットが何かは業務知識なので、シート単位の指定も同格の出典として扱う。
 */
interface DeclaredOutputIndex {
  /** 最終帳票を含むファイル（ラベル） */
  files: Set<string>;
  /** そのシートが最終帳票として指定されているか */
  hasSheet: (fileLabel: string, sheet: string) => boolean;
  /**
   * そのシートに人が付けた役割（input_data / master_data / working_sheet / final_output）。
   * 未指定なら undefined。「最終帳票ではないと明示されている」ことを知るために要る。
   * これが無いと、最終アウトプットのファイル内にあるインプットシートまで最終アウトプット扱いになる。
   */
  roleOfSheet: (fileLabel: string, sheet: string) => string | undefined;
}

function buildDeclaredOutputIndex(artifacts: ReportArtifact[]): DeclaredOutputIndex {
  const files = new Set<string>();
  const sheets = new Set<string>();
  const wholeFile = new Set<string>();
  const roles = new Map<string, string>();
  for (const a of artifacts) {
    const label = fileLabelOf(a.filename);
    for (const [sheet, role] of Object.entries(a.sheetRoles ?? {})) {
      roles.set(`${label}\u0000${sheet}`, role);
    }
    const marked = Object.entries(a.sheetRoles ?? {})
      .filter(([, role]) => role === 'final_output')
      .map(([sheet]) => sheet);
    if (marked.length > 0) {
      files.add(label);
      for (const s of marked) sheets.add(`${label}\u0000${s}`);
    } else if (a.kind === 'final_output') {
      // シート役割が未設定（sheet_roles を持たない旧データ）なら kind を全シートへ適用する。
      // 本文の役割チップ（下部の roleChips）と同じ規則。
      files.add(label);
      wholeFile.add(label);
    }
  }
  return {
    files,
    roleOfSheet: (f, s) => roles.get(`${f}\u0000${s}`) ?? (wholeFile.has(f) ? 'final_output' : undefined),
    hasSheet: (f, s) => wholeFile.has(f) || sheets.has(`${f}\u0000${s}`),
  };
}

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
  // 行を決める列（axis）だけを出す。照合列（join）は 1行を決めるとは限らないので混ぜない
  const axis = ks.filter(k => k.role === 'axis');
  return axis.length > 0 ? axis.map(k => k.column).join(' × ') : '（不明）';
}

/** 図のノード副題用の短いキー表記（axisNote のような文は使わず列名だけ） */
function keySummaryShort(r: Region): string {
  const ks = r.keys?.keys ?? [];
  if (ks.length === 0) return '';
  const primary = ks.filter(k => k.role === 'primary');
  if (primary.length > 0) return primary.map(k => k.column).join('、');
  const axis = ks.filter(k => k.role === 'axis');
  return axis.length > 0 ? axis.map(k => k.column).join(' × ') : '';
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
  declaredOut: DeclaredOutputIndex, sharedTemplates: SharedTemplateColumn[],
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

  // (1) 手修正推定（値一致）: 表ペア単位に1問。列数の多い順に最大3問。
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
      priority: 'high', kind: '手修正の確認', refPair: `${p.from}\u0000${p.to}`,
      title: undirected
        ? `「${from}」と「${to}」で値が一致する列があります。どちらが元データですか？`
        : `「${to}」の一部の列は「${from}」からの手作業転記ですか？`,
      analysis: `数式が無いのに値が完全一致する列を ${n} 組検出しました（${rep ? shortText(rep.evidence, 40) : '値一致'}）。手修正と推定しています。`,
      ask: undirected
        ? '①どちらの表が元（正）ですか？ ②転記のタイミングと担当の方を教えてください。'
        : '①この理解で合っていますか？ ②転記のタイミングと担当の方は？ ③両者が一致しない場合はどちらが正ですか？',
      kpiee: '元とする表と集計ロジックが確定すれば、この転記作業は自動化できます。',
    });
  }
  if (copyPairs.length > 3) {
    qs.push({
      priority: 'high', kind: '手修正の確認',
      title: `ほか ${copyPairs.length - 3} 組の表ペアでも手修正の可能性を検出しています。`,
      analysis: '個別の一覧はお打ち合わせで画面をご覧いただきながら確認させてください。',
      ask: '主要なものから順に、転記の有無と方向を確認させてください。',
    });
  }

  // (1b) 同じ列が3ブック以上に同一の値で存在する（共通様式・マスタの使い回し）。
  // 表ペアの総当たりで「手修正疑い」を出すと N*(N-1)/2 本のノイズになり確認事項が水増しされるため、
  // 辺は出さずにここで1問にまとめる。件数が消えたことを見えなくしないための出口でもある。
  if (sharedTemplates.length > 0) {
    const top = [...sharedTemplates].sort((a, b) => b.places.length - a.places.length);
    const names = top.slice(0, 3)
      .map(t => `「${t.columnName}」（${new Set(t.places.map(p => p.file)).size}ブック・${t.rowCount.toLocaleString()}行）`)
      .join('、') + (top.length > 3 ? ` ほか${top.length - 3}列` : '');
    qs.push({
      priority: 'mid', kind: '共通マスタの確認',
      title: `${names} は、複数のブックに同じ値で入っています。共通の元（マスタ・様式）はどれですか？`,
      analysis: '同じ値の列が3ブック以上にあり、いずれも数式を持ちません。'
        + '同じ様式を使い回している（部署コード・勘定科目などのマスタ）状態と見て、'
        + '個別の転記としては数えていません。',
      ask: '①この一覧の「正」はどこで管理されていますか？ ②追加・変更があったとき、各ブックへどう反映していますか？',
      kpiee: 'マスタを1か所に集約できれば、各ブックへの反映作業そのものが不要になります。',
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

  // (2b) 最終帳票と指定されたのに、他ファイルからの流入が見つからないシート。
  // 「出所不明の表」に混ぜると、人が「最終帳票です」と答えたシートを「これは何ですか」と
  // 問い直す形になってしまう（実際にそうなっていた）。最終帳票の元データが辿れていないのは
  // 移行の前提が欠けている状態なので、専用の問いとして優先度を上げて出す。
  {
    const inflowSheets = new Set<string>();
    const fileOf = new Map(regions.map(r => [r.id, r.file]));
    for (const p of pairs) {
      const to = regions.find(r => r.id === p.to);
      if (!to) continue;
      if (fileOf.get(p.from) !== to.file) inflowSheets.add(`${to.file}\u0000${to.sheet}`);
    }
    const declaredSheets = new Map<string, { file: string; sheet: string }>();
    for (const r of regions) {
      if (!declaredOut.hasSheet(r.file, r.sheet)) continue;
      declaredSheets.set(`${r.file}\u0000${r.sheet}`, { file: r.file, sheet: r.sheet });
    }
    const untraced = [...declaredSheets].filter(([k]) => !inflowSheets.has(k)).map(([, v]) => v);
    if (untraced.length > 0) {
      const names = untraced.slice(0, 4).map(v => `「${v.sheet}」`).join('、')
        + (untraced.length > 4 ? ` ほか${untraced.length - 4}シート` : '');
      qs.push({
        priority: 'high', kind: '最終帳票の元データ',
        title: `${names} は最終帳票とお伺いしていますが、この帳票を作る元データが受領データの中に見つかりませんでした。`,
        analysis: '他ファイルからこの帳票へ流れ込む数式・値の一致を検出できませんでした。'
          + '別ブックからの参照（リンク切れ・別フォルダのファイル）や、基幹システムからの手貼りが考えられます。',
        ask: '①この帳票の数値はどこから作られていますか？（別Excel／基幹システム／手入力）'
          + ' ②元になるファイルがあれば、そちらもご提供いただけますか？',
        kpiee: '最終帳票をkpieeで再現するには元データが必要です。ここが最優先の確認事項になります。',
      });
    }
  }

  // (3) どの表ともつながらない表: まとめて1問
  // 最終帳票と指定された表は上の (2b) で扱うので、役割昇格により自然にここから外れる。
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
  // 「1行を決める列が分からない表」。照合列（join）しか無い表もここに含める —
  // 数式が条件に使っている列は分かっても、1行の単位が決まらなければ移行時に困るのは同じ。
  const noKey = regions.filter(r => r.dataRowCount >= 20 && !r.keys?.grain
    && !(r.keys?.keys ?? []).some(k => k.role !== 'join'));
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

// 静的SVG は「操作版グラフ（REPORT_GRAPH_JS）の階層レイアウトを、そのまま止め絵にしたもの」。
// 参照レポート（顧客と合意済みの見た目）と同じ図にするため、下の値・式は操作版と一致させてある。
// 変えるときは必ず両方を同時に直すこと。片方だけ変えると印刷・JS無効時の図が別物になる。
//   キャンバス: W=1280 / H=780 / PAD=64
//   半径:       r = 8 + 18*√(つながり本数 / 最大本数)、最終アウトプットは最低 13
//   段:         最終アウトプットまでの距離。段0（最終）を下端に置き、上へ遡る
//   段内の並び: 中央寄せ、間隔 = min(210, (W-2PAD)/件数)
//   辺:         二次ベジエ（同じ対の複数辺は 38px ずつ左右へ振る）、円の縁で止める
//   ラベル:     円の下（y = r + 13）、中央揃え、白フチ付き
const MAP_W = 1280, MAP_H = 780, MAP_PAD = 64;
const R_BASE = 8, R_SPAN = 18, R_OUT_MIN = 13;
const LAYER_GAP_MAX = 210, EDGE_BOW = 38;
const MAX_NODES = 28, MAX_EDGES = 60;

/** 表の役割 → 円の色。操作版 CSS（.relgraph-stage.lightmode の --c-*）と同じ値 */
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
 * 表どうしの関係図（ノード形式）。静的SVGと操作版の両方をこの1か所から作る。
 * uid は同一ページに複数の SVG が並ぶための識別子（矢印マーカーの id が衝突すると
 * 後から定義されたものに全部の矢印が引きずられ、色が全て同じになる）。
 */
function buildMap(
  uid: string,
  regions: Region[], pairs: PairAgg[], labels: Map<string, string>,
  copyQuestionByPair: Map<string, string>, roles: Map<string, Role>,
): MapResult | null {
  if (pairs.length === 0) return null;

  // つながりのある表だけを、関係の重み順に上限まで採用
  const weight = new Map<string, number>();
  for (const p of pairs) {
    weight.set(p.from, (weight.get(p.from) ?? 0) + p.total);
    weight.set(p.to, (weight.get(p.to) ?? 0) + p.total);
  }
  // 最終アウトプットの表は、つながりが1本も検出できなくても必ず図に出す。
  // ここで落とすと「kpiee で再現する対象がどれか」が図から消えてしまい、読み合わせの目的地が
  // 分からなくなる（つながりが見つかっていないこと自体が確認したい論点なので、隠さず置く）。
  const isOut = (r: Region) => (roles.get(r.id) ?? '') === '最終アウトプット';
  const connected = regions.filter(r => weight.has(r.id) || isOut(r));
  const kept = connected
    .slice()
    // 同じ重みなら最終アウトプットを優先して残す（上限で切られて消えないように）
    .sort((a, b) => (Number(isOut(b)) - Number(isOut(a)))
      || (weight.get(b.id) ?? 0) - (weight.get(a.id) ?? 0))
    .slice(0, MAX_NODES);
  const keptIds = new Set(kept.map(r => r.id));
  const drawPairs = pairs.filter(p => keptIds.has(p.from) && keptIds.has(p.to)).slice(0, MAX_EDGES);
  // 辺が1本も無くても、最終アウトプットが居るなら図は出す（「どれが目的地か」は示す）
  if (drawPairs.length === 0 && !kept.some(isOut)) return null;

  // 隣接（操作版と同じく「辺の本数」で数える。重みではない）
  const outAdj = new Map<string, PairAgg[]>();
  const inAdj = new Map<string, PairAgg[]>();
  for (const id of keptIds) { outAdj.set(id, []); inAdj.set(id, []); }
  for (const p of drawPairs) { outAdj.get(p.from)!.push(p); inAdj.get(p.to)!.push(p); }
  const degOf = (id: string) => (inAdj.get(id)?.length ?? 0) + (outAdj.get(id)?.length ?? 0);
  const maxDeg = Math.max(1, ...[...keptIds].map(degOf));

  // 最終アウトプット（操作版の output 決定と同じ順序で選ぶ）
  let output: string | null = null;
  let best = -1;
  for (const r of kept) {
    if ((roles.get(r.id) ?? '') !== '最終アウトプット') continue;
    const d = inAdj.get(r.id)!.length;
    if (d > best) { best = d; output = r.id; }
  }
  if (!output) {
    best = -1;
    for (const r of kept) {
      if (outAdj.get(r.id)!.length > 0) continue;
      const d = inAdj.get(r.id)!.length;
      if (d > best) { best = d; output = r.id; }
    }
  }
  if (!output) {
    best = -1;
    for (const r of kept) { const d = degOf(r.id); if (d > best) { best = d; output = r.id; } }
  }

  // 段＝最終アウトプットまでの距離（操作版 dist と同じ考え方。最長経路で取る）
  const layer = new Map<string, number>();
  const dist = (id: string, seen: Set<string>): number => {
    if (id === output) return 0;
    const memo = layer.get(id);
    if (memo !== undefined) return memo;
    if (seen.has(id)) return 0; // 循環参照は打ち切る
    seen.add(id);
    let far = 0, any = false;
    for (const l of outAdj.get(id) ?? []) { any = true; far = Math.max(far, 1 + dist(l.to, seen)); }
    const v = any ? far : 1; // どこへも流れない表は1段目に置く
    layer.set(id, v);
    return v;
  };
  for (const r of kept) dist(r.id, new Set());
  if (output) layer.set(output, 0);

  // 段ごとに中央寄せで配置。段0（最終アウトプット）が下端
  const byLayer = new Map<number, Region[]>();
  for (const r of kept) {
    const l = layer.get(r.id) ?? 0;
    if (!byLayer.has(l)) byLayer.set(l, []);
    byLayer.get(l)!.push(r);
  }
  for (const arr of byLayer.values()) arr.sort((a, b) => (weight.get(b.id) ?? 0) - (weight.get(a.id) ?? 0));
  const maxLayer = Math.max(...byLayer.keys(), 0);

  const pos = new Map<string, { x: number; y: number; r: number }>();
  for (const [l, row] of byLayer) {
    const y = MAP_PAD + ((maxLayer - l) / (maxLayer || 1)) * (MAP_H - 2 * MAP_PAD - 40) + 20;
    const gap = Math.min(LAYER_GAP_MAX, (MAP_W - 2 * MAP_PAD) / Math.max(1, row.length));
    const x0 = MAP_W / 2 - (gap * (row.length - 1)) / 2;
    row.forEach((r, i) => {
      const isOut = (roles.get(r.id) ?? '') === '最終アウトプット';
      let rad = R_BASE + R_SPAN * Math.sqrt(degOf(r.id) / maxDeg);
      if (isOut) rad = Math.max(rad, R_OUT_MIN);
      pos.set(r.id, { x: x0 + i * gap, y, r: Math.round(rad * 10) / 10 });
    });
  }

  // 同じ対に複数の辺があるときは左右へ振り分ける（操作版 _cv と同じ 38px 刻み）
  const pairCount = new Map<string, number>();
  for (const p of drawPairs) {
    const k = [p.from, p.to].sort().join('|');
    pairCount.set(k, (pairCount.get(k) ?? 0) + 1);
  }
  const seenPair = new Map<string, number>();

  const showEdgeLabels = drawPairs.length <= 10;
  const parts: string[] = [];
  parts.push(`<svg viewBox="0 0 ${MAP_W} ${MAP_H}" role="img" aria-label="表どうしの関係図（ノード形式）">`);
  parts.push('<defs>');
  for (const g of GROUP_ORDER) {
    parts.push(`<marker id="arr-${uid}-${g}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="${GROUP_META[g].color}" fill-opacity="0.85"/></marker>`);
  }
  parts.push('</defs>');
  // 背景の点（操作版 lightmode の dotted background と同じ見え方にする）
  parts.push(`<rect x="0" y="0" width="${MAP_W}" height="${MAP_H}" fill="#FCFDFE"/>`);
  parts.push(`<pattern id="dot-${uid}" width="22" height="22" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="#E4EBF3"/></pattern>`);
  parts.push(`<rect x="0" y="0" width="${MAP_W}" height="${MAP_H}" fill="url(#dot-${uid})"/>`);

  // 辺（ノードより先に描いて下に敷く）
  const edgeLabels: string[] = [];
  for (const p of drawPairs) {
    const a = pos.get(p.from)!; const b = pos.get(p.to)!;
    const g = dominantGroup(p);
    const meta = GROUP_META[g];
    const k = [p.from, p.to].sort().join('|');
    const idx = seenPair.get(k) ?? 0;
    seenPair.set(k, idx + 1);
    const cv = (idx - ((pairCount.get(k) ?? 1) - 1) / 2) * EDGE_BOW;
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.max(1, Math.hypot(dx, dy));
    const ux = dx / len, uy = dy / len;
    const mx = (a.x + b.x) / 2 - uy * cv, my = (a.y + b.y) / 2 + ux * cv;
    const sx = a.x + ux * (a.r + 2), sy = a.y + uy * (a.r + 2);
    const ex = b.x - ux * (b.r + 7), ey = b.y - uy * (b.r + 7);
    const dash = meta.dashed ? ' stroke-dasharray="6 5"' : '';
    parts.push(`<path d="M${sx.toFixed(1)},${sy.toFixed(1)} Q${mx.toFixed(1)},${my.toFixed(1)} ${ex.toFixed(1)},${ey.toFixed(1)}" fill="none" stroke="${meta.color}" stroke-width="1.3" stroke-opacity="0.5"${dash} marker-end="url(#arr-${uid}-${g})"/>`);
    const qid = g === 'copy' ? copyQuestionByPair.get(`${p.from}\u0000${p.to}`) : undefined;
    if (showEdgeLabels || qid) {
      const text = qid ? `手修正推定 → ${qid}` : `${meta.label.split('（')[0]}${p.total > 1 ? ` ×${p.total}` : ''}`;
      // 線に対して垂直へ逃がす。線の上や中点に置くと円とラベルに重なって読めない
      // （操作版はラベルを持たず右パネルで見せるが、静止画では Q 番号を図に出したい）。
      const side = cv >= 0 ? 1 : -1;
      const off = R_BASE + R_SPAN + 12 + Math.abs(cv) / 2; // 最大半径＋余白
      // 線の法線 (-uy, ux) 方向へ逃がす
      const nx = -uy * off * side, ny = ux * off * side;
      const lx = (a.x + b.x) / 2 + nx;
      const ly = (a.y + b.y) / 2 + ny + 3;
      // 文字は「線から離れる向き」へ伸ばす。左へ逃がしたら右揃え、右へ逃がしたら左揃え。
      // ここを取り違えると、逃がした分だけ文字が線側へ戻ってきて円に重なる。
      const anchor = Math.abs(nx) < 6 ? 'middle' : nx < 0 ? 'end' : 'start';
      edgeLabels.push(`<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" font-size="10" fill="${meta.color}" text-anchor="${anchor}"${qid ? ' font-weight="bold"' : ''} style="paint-order:stroke;stroke:#FCFDFE;stroke-width:3.5px">${esc(text)}</text>`);
    }
  }

  // ノード（円＋下にラベル）。操作版と同じく最終アウトプットには輪を足す
  for (const r of kept) {
    const p = pos.get(r.id)!;
    const role = roles.get(r.id) ?? '中間集計';
    const fill = ROLE_FILL[role] ?? '#7B5EA7';
    const isOut = role === '最終アウトプット';
    const label = labels.get(r.id) ?? r.sheet;
    parts.push('<g>'
      + (isOut ? `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${(p.r + 5).toFixed(1)}" fill="none" stroke="${fill}" stroke-opacity="0.32" stroke-width="2"/>` : '')
      + `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${p.r}" fill="${fill}" stroke="#FCFDFE" stroke-width="1.5"/>`
      + `<text x="${p.x.toFixed(1)}" y="${(p.y + p.r + 13).toFixed(1)}" font-size="11" font-weight="${isOut ? 800 : 600}" fill="#0E2A47" text-anchor="middle" style="paint-order:stroke;stroke:#FCFDFE;stroke-width:3.4px">${esc(fitText((isOut ? '★ ' : '') + label, LAYER_GAP_MAX - 16, 11))}</text>`
      + '</g>');
  }
  parts.push(...edgeLabels);
  parts.push('</svg>');

  // 操作版へ渡すデータ。初期座標は上の階層配置をそのまま種にする（同じ図から始まる）
  const gnodes: GNode[] = kept.map(r => {
    const p = pos.get(r.id)!;
    const key = keySummaryShort(r);
    return {
      id: r.id,
      label: labels.get(r.id) ?? r.sheet,
      sub: key === '' ? `${r.dataRowCount.toLocaleString()}行` : `${r.dataRowCount.toLocaleString()}行 ／ ${key}`,
      role: roles.get(r.id) ?? '',
      deg: weight.get(r.id) ?? 1,
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
    data: { nodes: gnodes, links: glinks, w: MAP_W, h: MAP_H },
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
/** 最終アウトプットの見出しに付ける番号。①②… は読み合わせで「②の話」と口頭で指せる */
const OUT_NO = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];
/** ER のボックス1つに並べるキー行の上限。照合列が多い表でボックスが縦に伸び切るのを防ぐ */
const ER_KEY_ROWS_CAP = 8;

// ============================================================
// ロジック別ブロック
//
// ER 図を1枚の巨大な図として出すと、直前に全体の流れを見ていても「これは何の話か」が
// 分からない（465表から上位20表を抜いた図なので、全体のどこを切り出したのかが読めない）。
// そこで「最終アウトプットへ流れ込むファイル1つ」を1ブロックとして切り、
//   ① 全体のどの部分か → ② その計算の中身 → ③ 関係する表のキーと定義 → ④ だからこのER
// の順に、関係の本数が多い（＝説明の重みが大きい）ブロックから並べる。
// ============================================================
interface LogicBlock {
  fromFile: string;                 // 上流ファイル（ラベル）
  toFile: string;                   // 最終アウトプット（ラベル）
  total: number;                    // 関係の本数
  group: Group | undefined;         // 関係の種類（代表）
  srcRegionIds: string[];
  dstRegionIds: string[];
  srcSheets: string[];
  dstSheets: string[];
  repFormula: string;               // 代表の数式（根拠）
  /** キーで引き当てているか。false なら「セル位置で対応」＝行の並びが同一である前提 */
  byKey: boolean;
}

function buildLogicBlocks(
  regions: Region[], pairs: PairAgg[], filePairs: FilePair[], outputs: Set<string>,
): LogicBlock[] {
  const fileOfRegion = new Map(regions.map(r => [r.id, r.file]));
  const sheetOfRegion = new Map(regions.map(r => [r.id, r.sheet]));
  const blocks: LogicBlock[] = [];
  for (const out of outputs) {
    const ups = [...new Set(filePairs.filter(p => p.to === out).map(p => p.from))];
    for (const up of ups) {
      const fp = filePairs.filter(p => p.from === up && p.to === out);
      const rp = pairs.filter(p => fileOfRegion.get(p.from) === up && fileOfRegion.get(p.to) === out);
      if (rp.length === 0) continue;
      const srcRegionIds = [...new Set(rp.map(p => p.from))];
      const dstRegionIds = [...new Set(rp.map(p => p.to))];
      // 代表の数式は「一番本数の多い表ペア」から取る（例外的な1本を代表にしない）
      const top = [...rp].sort((a, b) => b.total - a.total)[0];
      const rep = Object.values(top.best).find(e => e && e.evidence)?.evidence ?? '';
      blocks.push({
        fromFile: up, toFile: out,
        total: fp.reduce((s, p) => s + p.total, 0),
        group: fp.length > 0 ? dominantFileGroup(fp[0]) : undefined,
        srcRegionIds, dstRegionIds,
        srcSheets: [...new Set(srcRegionIds.map(id => sheetOfRegion.get(id) ?? ''))].filter(Boolean),
        dstSheets: [...new Set(dstRegionIds.map(id => sheetOfRegion.get(id) ?? ''))].filter(Boolean),
        repFormula: rep,
        // ref グループ = VLOOKUP・SUMIFS の条件範囲など「キーの値で引き当てている」関係。
        // これが1本も無ければ、対応はセル位置（行・列の並び）に依っている。
        byKey: rp.some(p => (p.counts.ref ?? 0) > 0),
      });
    }
  }
  return blocks.sort((a, b) => b.total - a.total);
}

/**
 * 代表の数式を「どの部分が何を指しているか」に分解して見せる。
 *
 * 「どういう計算か」を文章だけで書くと、=SUM([1]top:end!E6) のどこがどのファイルの
 * どのシートを指しているのかが読み取れない。数式そのものを部位ごとに色分けし、
 * 直下に対応表を置くことで「どこが何を意味するか」を目で追えるようにする。
 *
 * 数式が無い（値のコピーで運ばれている）区間は分解できないが、そこで何も書かないと
 * ブロックが空になり「説明が抜けている」ようにしか見えない。分解の代わりに
 * 「なぜ計算の根拠が出せないのか」と「では何を前提に対応しているのか」を書く。
 */
function renderFormulaAnatomy(b: LogicBlock, fileNameOf: (l: string) => string): string {
  const f = b.repFormula;
  const howNote = (body: string) => `<div class="fx"><p class="fx-how">${body}</p></div>`;
  // 判定は関係の種別で行う。evidence の文字列で見分けようとすると、値一致の根拠文
  //「値完全一致(66件, 手修正疑い)」の括弧を数式と誤認する。
  if (b.group === 'copy' || !f) {
    // 数式ではなく値の一致から推定した区間（コピペ・貼り付け）
    return howNote('<b>この区間は数式ではなく、値のコピーで運ばれています。</b>'
      + 'Excel 上に計算の根拠が残らないため、どの列がどの列になるのかを自動では確定できません'
      + `（値が一致していることから ${b.total.toLocaleString()} 本のつながりを推定しています）。`
      + '<br>両ブックの行の並びが同じであることが前提になっているとみられます。'
      + 'どちらかで行を挿入・並べ替えすると、気づかないまま数値がずれます。'
      + '<br><b>kpieeで再現するには、対応づけの基準になる列（組織コード・科目コード等）の指定が必要です。</b>');
  }
  const parts: { cls: string; text: string; note: string }[] = [];
  // 外部ブック参照 [n]
  const book = /\[(\d+)\]/.exec(f);
  if (book) parts.push({ cls: 'fx1', text: book[0], note: `別ブック＝「${fileNameOf(b.fromFile)}」` });
  // シート指定（範囲 a:b もそのまま拾う）
  const sheet = /(?:\[\d+\])?((?:'[^']+')|[^!'[\]]+)!/.exec(f);
  if (sheet) {
    const spec = sheet[1];
    const range = spec.includes(':');
    parts.push({
      cls: 'fx2', text: `${spec}!`,
      note: range
        ? `${spec.replace(':', '〜')} の ${b.srcSheets.length} シート（範囲内すべて）`
        : `シート「${spec}」`,
    });
  }
  // 参照先セル
  const cell = /!\$?([A-Za-z]{1,3}\$?\d+)/.exec(f);
  if (cell) {
    parts.push({
      cls: 'fx3', text: cell[1],
      note: b.byKey ? '照合するセル' : '自分と同じセル位置（行・列がそのまま対応）',
    });
  }
  // 数式はあるが部位に分解できなかった（想定外の書き方）。素の数式だけでも根拠として出す
  if (parts.length === 0) {
    return `<div class="fx"><div class="fx-code">${esc(shortText(f, 120))}</div>`
      + `<p class="fx-how">この数式の参照先を自動で読み取れませんでした。お打ち合わせで内容をご確認させてください。</p></div>`;
  }

  // 数式を部位で塗り分ける。拾えなかった部分は素のまま残す
  let rest = f;
  let code = '';
  for (const p of parts) {
    const i = rest.indexOf(p.text);
    if (i < 0) continue;
    code += `${esc(rest.slice(0, i))}<span class="${p.cls}">${esc(p.text)}</span>`;
    rest = rest.slice(i + p.text.length);
  }
  code += esc(rest);

  return `<div class="fx">
    <div class="fx-code">${code}</div>
    <ul class="fx-legend">
      ${parts.map(p => `<li><span class="${p.cls}">${esc(p.text)}</span>${esc(p.note)}</li>`).join('\n      ')}
    </ul>
    <p class="fx-how">${b.byKey
      ? '<b>対応のしかた：キーの値で引き当て</b>（値が一致する行を探して結合します）'
      : '<b>対応のしかた：セル位置で対応（結合キーなし）</b>'
        + ' ── 両ブックの行の並び（勘定科目などの順序）が同一であることが前提です。'
        + 'どちらかで行を挿入・並べ替えすると、気づかないまま数値がずれます。'}</p>
  </div>`;
}

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
    if (conn.length > 0) return conn;
    // つながっている列が無いときは全部出すが、照合列（join）が多い表では行数ぶん
    // ボックスが縦に伸びて図が読めなくなるので、行を決めるキーを優先して上限で切る
    const ks = r.keys!.keys;
    const identity = ks.filter(k => k.role !== 'join');
    return (identity.length > 0 ? identity : ks).slice(0, ER_KEY_ROWS_CAP);
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
  declaredOutput: boolean;          // 取込時に「最終帳票」として指定されたか（kind／シート役割のどちらでも）
  sheets: string[];
  regionCount: number;
  rowTotal: number;
  inFiles: Map<string, number>;     // 上流ファイル → 関係本数
  outFiles: Map<string, number>;    // 下流ファイル
  role: FileRole;
}


function buildFileStats(
  regions: Region[], filePairs: FilePair[], artifacts: ReportArtifact[],
  declaredOut: DeclaredOutputIndex,
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
        // ファイル単位の kind と、シート単位の「最終帳票」指定のどちらでも最終アウトプットと見なす
        declaredOutput: declaredOut.files.has(label),
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

/**
 * 表（region）の役割を「最終アウトプット」へ昇格させる。roles を直接書き換える。
 *
 * 3つの経路がある:
 *  (a) 取込時に「最終帳票」と指定されたシートの表 … つながりが未検出でも昇格させる。
 *      出典が人の業務知識なので、自動検出の有無で覆さない（覆すと 03 で「出所不明の表」として
 *      指定済みのシートを問い直す形になり、実際にそうなっていた）。
 *  (b) 「最終帳票ではない役割」を指定されたシートの表 … 昇格させないだけでなく、構造推定で
 *      付いた「最終アウトプット」も指定どおりの役割へ引き下げる。これが無いと、最終アウトプットの
 *      ファイル内にあるインプットシート（貼付元・修正計上など）まで赤く塗られ、図全体が
 *      「どれが最終アウトプットか分からない」状態になっていた（実データで表 28 件すべてが赤）。
 *  (c) 指定が無く、最終アウトプットファイル内で「他ファイルへ流れ出さない表」… これが無いと、
 *      ファイル内で相互参照している帳票シートが一律「中間集計」に見えてしまう。
 */
function promoteDeclaredOutputRegions(
  regions: Region[], pairs: PairAgg[], roles: Map<string, Role>,
  declaredOut: DeclaredOutputIndex, outputFiles: Set<string>, outputsDeclared: boolean,
): void {
  const fileOfRegion = new Map(regions.map(r => [r.id, r.file]));
  // 人が指定した役割 → 表の役割。構造推定より優先する（指定は業務知識で、推定は当て推量）
  const BY_DECLARED: Record<string, Role> = {
    input_data: '元データ（明細）',
    master_data: 'マスタ（参照元）',
    working_sheet: '中間集計',
  };
  for (const r of regions) {
    const declaredRole = declaredOut.roleOfSheet(r.file, r.sheet);
    if (declaredRole === 'final_output') { roles.set(r.id, '最終アウトプット'); continue; }
    const mapped = declaredRole ? BY_DECLARED[declaredRole] : undefined;
    if (mapped) {
      // つながりが1本も無い表は「独立（つながりなし）」のままにする（確認事項として拾うため）
      if (roles.get(r.id) !== '独立（つながりなし）') roles.set(r.id, mapped);
      continue;
    }
    if (declaredRole) continue; // unknown 等。推定で最終アウトプットにはしない
    if (!outputFiles.has(r.file)) {
      // 最終アウトプットが指定されているなら、その外側の「行き止まりの表」は最終アウトプットでは
      // ない。computeRoles は構造だけを見て終着点を最終アウトプットと呼ぶので、ここで引き下げる。
      // これが無いと、指定と無関係なファイルの終端表まで赤くなり目的地が埋もれる。
      if (outputsDeclared && roles.get(r.id) === '最終アウトプット') roles.set(r.id, '中間集計');
      continue;
    }
    if (roles.get(r.id) === '独立（つながりなし）') continue;
    const flowsOut = pairs.some(p => p.from === r.id && fileOfRegion.get(p.to) !== r.file);
    if (!flowsOut) roles.set(r.id, '最終アウトプット');
  }
}

/**
 * 最終アウトプット1つぶんの説明のかたまり。
 *
 * 02 は「最終アウトプットごとに、関係図 → ロジック」を1セットにして並べる。以前は関係図を
 * 全体で1枚だけ描き、ロジックを「流れ込む上流ファイル」で切っていたため、図には
 * プロモーション部門しか出ていないのに下の説明には別の帳票の話が混ざり、どの帳票の説明を
 * 読んでいるのか分からなくなっていた。読み手の関心は「この帳票はどう作られるか」なので、
 * 帳票を単位にする。
 */
interface OutputSection {
  file: string;                  // 最終アウトプットのファイルラベル
  filename: string;              // 表示名
  finalSheets: string[];         // その中で最終帳票として指定されたシート
  regionIds: Set<string>;        // この帳票に関わる表（帳票自身 ＋ 上流をたどったもの）
  blocks: LogicBlock[];          // この帳票へ流れ込むロジックブロック
}

/**
 * 最終アウトプットから上流へ辿って、その帳票に関わる表だけを集める。
 * 全体図から「この帳票の部分」を切り出すのが目的なので、経路上の表はすべて含める。
 */
function collectUpstream(startIds: string[], pairs: PairAgg[]): Set<string> {
  const incoming = new Map<string, string[]>();
  for (const p of pairs) {
    const arr = incoming.get(p.to) ?? [];
    arr.push(p.from);
    incoming.set(p.to, arr);
  }
  const seen = new Set<string>(startIds);
  const queue = [...startIds];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const up of incoming.get(id) ?? []) {
      if (seen.has(up)) continue;
      seen.add(up);
      queue.push(up);
    }
  }
  return seen;
}

function buildOutputSections(
  regions: Region[], pairs: PairAgg[], roles: Map<string, Role>,
  outputFiles: Set<string>, blocks: LogicBlock[],
  declaredOut: DeclaredOutputIndex, fileNameOf: (l: string) => string,
): OutputSection[] {
  const sections: OutputSection[] = [];
  for (const file of outputFiles) {
    const own = regions.filter(r => r.file === file && roles.get(r.id) === '最終アウトプット');
    if (own.length === 0) continue;
    const finalSheets = [...new Set(regions.filter(r => r.file === file
      && declaredOut.hasSheet(r.file, r.sheet)).map(r => r.sheet))];
    sections.push({
      file, filename: fileNameOf(file),
      finalSheets: finalSheets.length > 0 ? finalSheets : [...new Set(own.map(r => r.sheet))],
      regionIds: collectUpstream(own.map(r => r.id), pairs),
      blocks: blocks.filter(b => b.toFile === file),
    });
  }
  // 関係の本数が多い（＝説明の重みが大きい）帳票から並べる
  return sections.sort((a, b) =>
    b.blocks.reduce((s, x) => s + x.total, 0) - a.blocks.reduce((s, x) => s + x.total, 0));
}

/**
 * 1ブロックの本文。① どの部分か → ② その計算 → ③ キーと定義 → ④ ER の順で組む。
 * ER はこのブロックに登場する表だけに絞って描くので、直前の説明と1対1で対応する。
 */
function renderLogicBlock(
  b: LogicBlock, no: number, regions: Region[], keyLinks: KeyLink[],
  labels: Map<string, string>, fileNameOf: (l: string) => string, showEr: boolean,
): string {
  const byId = new Map(regions.map(r => [r.id, r]));
  const ids = new Set([...b.srcRegionIds, ...b.dstRegionIds]);
  const mine = [...ids].map(id => byId.get(id)).filter((r): r is Region => !!r);
  // 「キーが分かっている表」= 1行を決めるキー（主キー・複合軸・2次元グレイン）が取れた表。
  // 照合列（join）しか無い表は行の単位が未特定なので、ここには数えない。
  const keyed = mine.filter(r => !!r.keys?.grain
    || (r.keys?.keys ?? []).some(k => k.role !== 'join'));
  // ER はこのブロックの表どうしのキー対応だけ
  const myLinks = keyLinks.filter(l => ids.has(regionIdOf(l.a)) && ids.has(regionIdOf(l.b)));
  const er = showEr ? buildErDiagram(mine, myLinks, labels) : null;

  // 表の呼び名はシート名だけにする。ファイル名はブロックの見出しで既に2回出ているので、
  // ここで繰り返すと1セルが100文字を超えて表が読めなくなる。
  const sheetLabel = (r: Region): string => {
    const l = labels.get(r.id) ?? r.sheet;
    const i = l.lastIndexOf('›');
    return i >= 0 ? l.slice(i + 1).trim() : l;
  };
  const keyRows = keyed.slice(0, 8).map(r => `<tr>`
    + `<td><b>${esc(sheetLabel(r))}</b><div class="rnote">${esc(rangeOf(r))}・${r.dataRowCount.toLocaleString()}行</div></td>`
    + `<td>${esc(cappedKeys(r))}</td>`
    + `<td>${esc(cappedGrain(r))}</td>`
    + `<td>${esc(joinKeysOf(r))}</td>`
    + `</tr>`).join('\n        ');

  return `<div class="lb">
    <div class="lb-head"><span class="lb-no">${no}</span>
      <div><b>${esc(fileNameOf(b.fromFile))}</b> → <b>${esc(fileNameOf(b.toFile))}</b>
        <div class="lb-sub">関係 ${b.total.toLocaleString()} 本${b.group ? ` ／ ${esc(GROUP_META[b.group].label)}` : ''}
          ／ 元 ${b.srcRegionIds.length} 表 → 先 ${b.dstRegionIds.length} 表</div></div>
    </div>

    <div class="lb-step"><span class="lb-st">どういう計算か</span>
      <p>最終アウトプット側の${b.dstSheets.length === 1 ? `<b>${esc(b.dstSheets[0])}</b>シート` : `<b>${b.dstSheets.length}</b>シート`}が、
      元データ側の${b.srcSheets.length === 1 ? `<b>${esc(b.srcSheets[0])}</b>シート` : `<b>${b.srcSheets.length}</b>シート`}から
      ${b.group ? esc(GROUP_META[b.group].label.replace(/（.*$/, '')) : '値を取得'}しています。</p>
      ${renderFormulaAnatomy(b, fileNameOf)}
    </div>

    ${keyed.length > 0 ? `<div class="lb-step"><span class="lb-st">関係する表のキーと1行の定義</span>
      <div style="overflow-x:auto"><table class="ot">
        <tr><th>表</th><th>1行を決めるキー</th><th>1行の単位</th><th>数式が照合に使う列</th></tr>
        ${keyRows}
      </table></div>
      <p class="tbl-note">※「1行を決めるキー」は値の一意性から確認できたものだけを載せています。
      「照合に使う列」は VLOOKUP・SUMIFS 等の条件に現れる列で、結合キーの候補ですが1行を決めるとは限りません。</p>
      ${keyed.length > 8 ? `<p class="tbl-note">※ キーが特定できた ${keyed.length} 表のうち上位8表。</p>` : ''}
      ${keyed.length < mine.length ? `<p class="tbl-note">※ このブロックの ${mine.length} 表のうち ${mine.length - keyed.length} 表は、1行を決める列を特定できていません（03 でお伺いします）。</p>` : ''}
    </div>` : `<div class="lb-step"><span class="lb-st">関係する表のキーと1行の定義</span>
      <p class="tbl-note">このブロックの ${mine.length} 表では、1行を決める列（キー）を特定できませんでした。${b.byKey ? '' : '上記のとおりセル位置で対応しているため、キー列が数式に現れません。'}03 でお伺いします。</p>
    </div>`}

    ${er ? `<div class="lb-step"><span class="lb-st">キー関係図（ER）— 上記の表だけ</span>
      <div class="map-scroll er-scroll">${er.svg}</div>
      ${er.omitted > 0 ? `<p class="tbl-note">※ キーでつながる表を優先表示（ほか ${er.omitted} 表は省略）。</p>` : ''}
    </div>` : showEr ? `<div class="lb-step"><span class="lb-st">キー関係図（ER）</span>
      <p class="tbl-note">このブロックには、キー列で結ばれる表の対がありません${b.byKey ? '' : '（セル位置での対応のため、結合キーが存在しません）'}。</p>
    </div>` : ''}
  </div>`;
}

/** 表示上限。横持ちの広い表では軸列が数十本立つので、並べると1セルが読めなくなる */
const KEY_COLS_SHOWN = 3;

const capList = (names: string[], sep: string): string => names.length <= KEY_COLS_SHOWN
  ? names.join(sep)
  : `${names.slice(0, KEY_COLS_SHOWN).join(sep)} ほか${names.length - KEY_COLS_SHOWN}列`;

/**
 * 軸だけが多数立っている表を「キー未特定」と扱う本数のしきい値。
 * 248行 × 250列のような横持ちの帳票では月別列などが軸として大量に立つ。それを並べて
 * 「42列ごとに1行」と書くと、読み手には確定した事実に見えるが実際には特定できていない。
 * 主キーが無くこの本数を超えるなら、断定せず 03 の確認事項に回す。
 */
const AXIS_ONLY_GIVEUP = 6;

/**
 * 「1行を決めるキー」の要約。行を決めると言えるのは primary（単独一意）と axis（複合軸）だけ。
 * join（数式が照合に使っている列）はここに混ぜない — 混ぜると横持ち帳票で数十列が並び、
 * 「42列ごとに1行」という確定事実に見える誤った要約になっていた。
 */
function cappedKeys(r: Region): string {
  if (r.keys?.grain) return r.keys.grain; // 横持ち: 行キー × 列軸 の2次元グレイン
  const ks = r.keys?.keys ?? [];
  const primary = ks.filter(k => k.role === 'primary');
  if (primary.length > 0) return capList(primary.map(k => k.column), '、');
  const axis = ks.filter(k => k.role === 'axis');
  if (axis.length > 0) return capList(axis.map(k => k.column), ' × ');
  return '（特定できていません）';
}

/** 「1行の単位」の説明文。断定できるのは主キー・複合軸・2次元グレインがあるときだけ */
function cappedGrain(r: Region): string {
  if (r.keys?.grain) return r.keys.grain;
  const ks = r.keys?.keys ?? [];
  const primary = ks.filter(k => k.role === 'primary');
  if (primary.length > 0) return `${capList(primary.map(k => k.column), '・')} ごとに1行`;
  const axis = ks.filter(k => k.role === 'axis');
  if (axis.length > 0) return `${capList(axis.map(k => k.column), ' × ')} の組合せで1行`;
  return '（特定できていません）';
}

/** 数式が照合・条件に使っている列（結合キーの候補）。行を決めるかは別問題なので分けて出す */
function joinKeysOf(r: Region): string {
  const js = (r.keys?.keys ?? []).filter(k => k.role === 'join');
  if (js.length === 0) return '—';
  const omitted = r.keys?.joinKeysOmitted ?? 0;
  const base = capList(js.map(k => k.column), '、');
  return omitted > 0 ? `${base}（ほか${omitted}列）` : base;
}

/**
 * ファイル役割を確定する（最終アウトプットの指定を反映してから流入・流出で分類）。
 *
 * declared=true（人が最終アウトプットを指定している）ときは、指定されていないファイルを
 * 「流出が無いから」という理由だけで最終アウトプットにしない。総勘定元帳や値化ファイルのような
 * 途中の成果物まで最終アウトプットとして並び、「kpiee で再現する対象はどれか」がぼやけるため。
 * 指定が無いときだけ、従来どおり終端を最終アウトプットと推定する。
 */
function assignFileRoles(stats: Map<string, FileStat>, outputs: Set<string>, declared: boolean): void {
  for (const s of stats.values()) {
    if (outputs.has(s.label)) { s.role = '最終アウトプット'; continue; }
    if (s.inFiles.size === 0 && s.outFiles.size === 0) { s.role = '独立'; continue; }
    if (s.inFiles.size === 0) { s.role = '元データ'; continue; }
    s.role = s.outFiles.size > 0 || declared ? '中間ファイル' : '最終アウトプット';
  }
}

// ---- 全体関係図（ファイル単位）----
// 表単位の関係図（buildMap）と同じノード形式で描く。図の種類ごとに見た目が変わると、
// 「全体 → 詳細」で降りていくときに同じものを見ている感覚が切れるため、円・色・線の規則を揃える。
// 違いは粒度だけ（円＝ファイル、円の大きさ＝そのファイルが持つ関係の本数）。
const FF = { W: 1280, PAD: 64, HEAD: 26, ROW: 150 };
const FILE_ROLE_FILL: Record<FileRole, string> = {
  '元データ': '#1E9E6A',
  '中間ファイル': '#7B5EA7',
  '最終アウトプット': '#C0392B',
  '独立': '#9AA7B4',
};

/**
 * 受領ファイル → 最終アウトプットの流れ図（ノード形式）。
 * 最終アウトプットは指定どおり必ず最下段に置く（自動検出でつながりが出なかった場合も、
 * 「つながり未検出」として置いたまま示す — 図から消すと確認したい論点が消えてしまう）。
 */
function buildFileFlow(stats: Map<string, FileStat>, filePairs: FilePair[], outputs: Set<string>): string | null {
  const all = [...stats.values()];
  if (all.length === 0) return null;

  // 最長経路で段を決める。段が大きいほど下流（最終アウトプットが最大）
  const layer = computeFileLayers(all.map(s => s.label), filePairs, outputs);
  const byLayer = new Map<number, FileStat[]>();
  for (const s of all) {
    const l = layer.get(s.label) ?? 0;
    if (!byLayer.has(l)) byLayer.set(l, []);
    byLayer.get(l)!.push(s);
  }
  const layerNos = [...byLayer.keys()].sort((a, b) => a - b);
  for (const arr of byLayer.values()) arr.sort((a, b) => b.rowTotal - a.rowTotal);
  // 出てきた段だけを詰める（0,1,3 → 0,1,2）。飛んだ段の分だけ空白が空くのを防ぐ
  const layerIndex = new Map<number, number>(layerNos.map((l, i) => [l, i]));
  const maxLayer = layerNos.length - 1;

  // 円の大きさ＝そのファイルが持つ関係の本数（表単位の図と同じ考え方）
  const linkCount = new Map<string, number>();
  for (const p of filePairs) {
    linkCount.set(p.from, (linkCount.get(p.from) ?? 0) + 1);
    linkCount.set(p.to, (linkCount.get(p.to) ?? 0) + 1);
  }
  const maxLinks = Math.max(1, ...[...linkCount.values()]);

  const height = FF.PAD * 2 + FF.HEAD + Math.max(1, layerNos.length - 1) * FF.ROW;
  const pos = new Map<string, { x: number; y: number; r: number }>();
  for (const [l, row] of byLayer) {
    const y = FF.PAD + FF.HEAD + (layerIndex.get(l)! / (maxLayer || 1)) * (height - 2 * FF.PAD - FF.HEAD - 40);
    const gap = Math.min(260, (FF.W - 2 * FF.PAD) / Math.max(1, row.length));
    const x0 = FF.W / 2 - (gap * (row.length - 1)) / 2;
    row.forEach((s, i) => {
      const isOut = outputs.has(s.label);
      let rad = 11 + 17 * Math.sqrt((linkCount.get(s.label) ?? 0) / maxLinks);
      if (isOut) rad = Math.max(rad, 16);
      pos.set(s.label, { x: x0 + i * gap, y, r: Math.round(rad * 10) / 10 });
    });
  }

  const h = Math.round(height);
  const parts: string[] = [];
  parts.push(`<svg viewBox="0 0 ${FF.W} ${h}" role="img" aria-label="ブックどうしの関係図（ノード形式）">`);
  parts.push('<defs>');
  for (const g of GROUP_ORDER) {
    parts.push(`<marker id="ff-${g}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="${GROUP_META[g].color}" fill-opacity="0.85"/></marker>`);
  }
  parts.push('</defs>');
  parts.push(`<rect x="0" y="0" width="${FF.W}" height="${h}" fill="#FCFDFE"/>`);
  parts.push('<pattern id="dot-ff" width="22" height="22" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="#E4EBF3"/></pattern>');
  parts.push(`<rect x="0" y="0" width="${FF.W}" height="${h}" fill="url(#dot-ff)"/>`);

  // 段の見出し（上＝受領データ、下＝最終アウトプット）
  for (const l of layerNos) {
    const row = byLayer.get(l)!;
    const y = pos.get(row[0].label)!.y;
    const isOut = row.every(s => outputs.has(s.label));
    const cap = isOut ? '最終アウトプット' : l === 0 ? '受領データ（起点）' : '経由ファイル';
    parts.push(`<text x="${FF.PAD}" y="${(y - 34).toFixed(1)}" font-size="11" font-weight="700" fill="${isOut ? '#C24141' : '#7A8794'}" letter-spacing=".04em">${esc(cap)}</text>`);
  }

  // 辺（円の縁で止め、同じ段どうしは弧で逃がす）
  for (const p of filePairs) {
    const a = pos.get(p.from); const b = pos.get(p.to);
    if (!a || !b) continue;
    const g = dominantFileGroup(p);
    const meta = GROUP_META[g];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.max(1, Math.hypot(dx, dy));
    const ux = dx / len, uy = dy / len;
    const bow = Math.abs(dy) < 4 ? 26 : 0;
    const sx = a.x + ux * (a.r + 2), sy = a.y + uy * (a.r + 2);
    const ex = b.x - ux * (b.r + 7), ey = b.y - uy * (b.r + 7);
    const mx = (a.x + b.x) / 2 - uy * bow, my = (a.y + b.y) / 2 + ux * bow;
    const dash = meta.dashed ? ' stroke-dasharray="6 5"' : '';
    parts.push(`<path d="M${sx.toFixed(1)},${sy.toFixed(1)} Q${mx.toFixed(1)},${my.toFixed(1)} ${ex.toFixed(1)},${ey.toFixed(1)}" fill="none" stroke="${meta.color}" stroke-width="1.6" stroke-opacity="0.55"${dash} marker-end="url(#ff-${g})"/>`);
  }

  // ノード（ファイル）
  for (const s of all) {
    const p = pos.get(s.label)!;
    const fill = FILE_ROLE_FILL[s.role];
    const isOut = outputs.has(s.label);
    const orphanOut = isOut && s.inFiles.size === 0;
    const sub = `${s.sheets.length}シート ／ ${s.regionCount}表 ／ ${s.rowTotal.toLocaleString()}行`;
    parts.push('<g>'
      + (isOut
        ? `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${(p.r + 5).toFixed(1)}" fill="none" stroke="${fill}" stroke-opacity="0.32" stroke-width="2"${orphanOut ? ' stroke-dasharray="5 4"' : ''}/>`
        : '')
      + `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${p.r}" fill="${fill}" stroke="#FCFDFE" stroke-width="1.5"/>`
      + `<text x="${p.x.toFixed(1)}" y="${(p.y + p.r + 14).toFixed(1)}" font-size="11.5" font-weight="${isOut ? 800 : 700}" fill="#0E2A47" text-anchor="middle" style="paint-order:stroke;stroke:#FCFDFE;stroke-width:3.4px">${esc(fitText((isOut ? '★ ' : '') + s.filename, 250, 11.5))}</text>`
      + `<text x="${p.x.toFixed(1)}" y="${(p.y + p.r + 28).toFixed(1)}" font-size="9.5" fill="#7A8794" text-anchor="middle" style="paint-order:stroke;stroke:#FCFDFE;stroke-width:3px">${esc(sub)}${orphanOut ? '（つながり未検出）' : ''}</text>`
      + '</g>');
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
  const declaredOut = buildDeclaredOutputIndex(input.artifacts ?? []);
  const fileStats = buildFileStats(
    regions, aggregateFilePairs(regions, pairs), input.artifacts ?? [], declaredOut,
  );
  const fileNameOf = (label: string) => fileStats.get(label)?.filename ?? label;
  // 本体と同じ役割昇格を通してから問いを数える（件数が本体とズレると相談画面の表示が食い違う）
  const resolved = resolveOutputFiles(fileStats);
  promoteDeclaredOutputRegions(regions, pairs, roles, declaredOut, new Set(resolved.labels), resolved.declared);
  const qs = buildQuestions(
    regions, pairs, graph.warnings ?? [], labels, roles, input.fileRelAudit ?? [], fileNameOf, declaredOut,
    graph.sharedTemplates ?? [],
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
  const declaredOut = buildDeclaredOutputIndex(input.artifacts ?? []);
  const fileStats = buildFileStats(regions, filePairs, input.artifacts ?? [], declaredOut);
  const { labels: outputLabels, declared: outputsDeclared } = resolveOutputFiles(fileStats);
  const outputFiles = new Set(outputLabels);
  assignFileRoles(fileStats, outputFiles, outputsDeclared);
  const fileNameOf = (label: string) => fileStats.get(label)?.filename ?? label;
  promoteDeclaredOutputRegions(regions, pairs, roles, declaredOut, outputFiles, outputsDeclared);

  const declaredRels = input.declaredFileRels ?? [];
  const audit = input.fileRelAudit ?? [];
  const questions = buildQuestions(
    regions, pairs, warnings, labels, roles, audit, fileNameOf, declaredOut, graph.sharedTemplates ?? [],
  );
  const copyQuestionByPair = new Map<string, string>();
  for (const q of questions) if (q.refPair) copyQuestionByPair.set(q.refPair, q.id);
  // 「元データが辿れない最終アウトプット」を 03 の該当設問へ結ぶ。番号を書かないと
  // 図に「つながり未検出」とだけ出て、どこで確認すればよいのか読み手に伝わらない。
  const srcQuestionRef = questions.find(q => q.kind === '最終帳票の元データ')?.id ?? '';
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
  // ER はロジック別ブロックの結論として各ブロック内に出す（1枚の巨大な図としては出さない）。
  // 「ER を出さない」指定はブロック側へ渡して尊重する — ここで図を作らないだけでは効かない。
  const showEr = spec.items.erDiagram;
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

  const dateStr = input.generatedAt.toISOString().slice(0, 10);
  const customer = input.customerName ? `${input.customerName}様` : 'ご担当者様';

  const sheetTotal = new Set(regions.map(r => `${r.file}\u0000${r.sheet}`)).size;
  const outStats = outputLabels.map(l => fileStats.get(l)!).filter(Boolean);
  // 冒頭のタイルは「受領 → インプット → 最終アウトプット → 確認事項」の順で読ませる。
  // 以前は「検出した表 465表」「表どうしの関係 423,321件」を出していたが、これは解析の規模で
  // あって顧客の関心事ではない（「とても複雑そう」という印象だけが残る）。表数・関係数は
  // まとめ文と 02 の図の中で、文脈が付いた形で触れる。
  const srcFileCount = [...fileStats.values()].filter(s => s.role === '元データ').length;
  const midFileCount = [...fileStats.values()].filter(s => s.role === '中間ファイル').length;
  // 02 を「ロジック別ブロック」で説明するための分割。ER はブロックの結論として各ブロック内に出す。
  const logicBlocks = buildLogicBlocks(regions, pairs, filePairs, outputFiles);
  const isolatedFiles = [...fileStats.values()].filter(s => s.role === '独立');
  // 02 は最終アウトプットごとに「関係図 → ロジック」を1セットで並べる
  const outputSections = buildOutputSections(
    regions, pairs, roles, outputFiles, logicBlocks, declaredOut, fileNameOf,
  );

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
    if (copyCount > 0) bullets.push(`一方、<b>数式ではなく手修正と推定されるつながりが ${copyCount} 組</b>あります（値の一致から逆推定）。ここが今回確認したい中心です。`);
    else if (warnings.length > 0) bullets.push(`数式列への手入力の上書きなど、確認したい箇所が ${warnings.length} 件あります。`);
    else bullets.push('手作業転記の疑いは検出されませんでした。');
    // 案件固有の前提（アウトプット相談で足したメモ）
    for (const n of spec.notes) bullets.push(esc(n));
  }

  // ---- 01 ファイル一覧 ----
  // 登録済みブック関係は 02 の「担当者の説明」に出るので、ここでは繰り返さない。
  // 01 の一覧は「何を受け取り、どれが最終アウトプットか」を一目で掴む場所にする。
  // 以前は 7 列（シート数・表数・行数・流れ込む元・ご登録の関係）を並べていたが、
  // 流れは 02 の図で辿るものであり、ここで数字と関係を全部見せると何を見る表なのか分からなくなる。
  // 役割の順（元データ → 中間 → 最終アウトプット → 独立）に並べ、規模は 1 列にまとめる。
  const ROLE_ORDER: FileRole[] = ['元データ', '中間ファイル', '最終アウトプット', '独立'];
  const fileRows = [...fileStats.values()]
    .sort((a, b) => (ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role)) || (b.rowTotal - a.rowTotal))
    .map(s => {
      const roleCls = s.role === '最終アウトプット' ? 'out' : s.role === '元データ' ? 'src' : s.role === '中間ファイル' ? 'mid' : 'iso';
      // 最終アウトプットのファイルは、どのシートが対象なのかまで書く（再現する的が定まる）
      const finalSheets = s.sheets.filter(sh => declaredOut.hasSheet(s.label, sh));
      const note = s.role === '最終アウトプット' && finalSheets.length > 0
        ? `<div class="rnote">対象シート: ${esc(shortText(finalSheets.join('、'), 56))}</div>`
        : s.role === '独立' ? '<div class="rnote">他のファイルとのつながりが見つかっていません</div>' : '';
      return `<tr>` +
        `<td><b>${esc(s.filename)}</b>${note}</td>` +
        `<td><span class="nrole ${roleCls}"></span> ${esc(s.role)}</td>` +
        `<td class="r">${s.sheets.length} シート<br><span class="dl-none">${s.rowTotal.toLocaleString()} 行</span></td>` +
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
      <div class="tile"><div class="tl">受領ファイル</div><div class="tv">${input.fileCount}<small>件</small></div>
        <div class="tsub">${sheetTotal} シート</div></div>
      <div class="tile"><div class="tl">元データ（インプット）</div><div class="tv">${srcFileCount}<small>ファイル</small></div>
        <div class="tsub">${midFileCount > 0 ? `経由するファイル ${midFileCount}` : '経由ファイルなし'}</div></div>
      <div class="tile out"><div class="tl">最終アウトプット</div><div class="tv">${outStats.length}<small>ファイル</small></div>
        <div class="tsub">${outStats.length > 0 ? esc(shortText(outStats.map(s => s.filename).join('、'), 38)) : '未特定'}</div></div>
      <div class="tile warn"><div class="tl">ご確認いただきたい点</div><div class="tv">${questions.length}<small>件</small></div>
        <div class="tsub">${noQuestions ? `${noQuestions} をご覧ください` : 'お打ち合わせでご相談'}</div></div>
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
        <tr><th>ファイル</th><th>役割</th><th class="r">規模</th></tr>
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
        ? 'まず<b>ブックどうしの全体関係図</b>で流れをご覧いただき、続けて<b>最終アウトプットへの流れ</b>を表・シート単位で確認し、そのうえで<b>ロジック別に区切って</b>計算の中身・キーをご説明します。'
        : multiFile
        ? '<b>シート・表単位の関係図</b>で流れをご覧いただき、続けて<b>ロジック別に区切って</b>その処理内容（キー・数式）をご説明します。'
        : 'ご提供は1ブックのため、<b>シート・表単位の関係</b>で流れをご覧いただき、続けて<b>ロジック別に区切って</b>その処理内容（キー・数式）をご説明します。'}</p>
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
    <ul class="graph-guide">
      <li><b>ノード＝表</b>。<b>上＝元データ → 下＝最終アウトプット</b>、矢印の向きにデータが流れます</li>
      <li><b>線の色＝関係の種類</b>／<b>破線＝手作業コピー（要確認）</b></li>
      ${spec.items.interactiveGraph ? `<li class="only-screen"><b>クリック</b>すると、その表の関係先と最終アウトプットまでの経路を右パネルに表示します（パンくずで戻れます）</li>
      <li class="only-screen">右上のボタン：<span class="k">＋ －</span> 拡大縮小／<span class="k">▤</span> レイアウト／<span class="k">☾</span> 配色／<span class="k">⤢</span> 全画面（Escで戻る）／<span class="k">⟳</span> リセット。背景ドラッグで移動</li>` : ''}
    </ul>
    ${spec.items.interactiveGraph ? '<p class="graph-guide only-print">※ 本紙は静止画です。操作版はブラウザでご覧ください。</p>' : ''}
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
    <p class="tbl-note">※ 円の大きさ＝つながりの本数。以下、最終アウトプットごとに「関係図 → その計算」の順にご説明します。</p>

    ${outputSections.map((sec, si) => {
      const secMap = buildMap(`o${si}`, regions.filter(r => sec.regionIds.has(r.id)),
        pairs.filter(p => sec.regionIds.has(p.from) && sec.regionIds.has(p.to)),
        labels, copyQuestionByPair, roles);
      return `
    ${subH(`最終アウトプット${OUT_NO[si] ?? `(${si + 1})`}　${sec.filename}`)}
    <p class="sec-lede">この帳票を kpiee で再現します。対象シートは
      <b>${esc(shortText(sec.finalSheets.join('、'), 90))}</b> です。
      ${sec.blocks.length > 0
        ? 'まず関係図で全体のどの部分かを見ていただき、続けてその計算をご説明します。'
        : `<b>この帳票へ流れ込む元データを自動検出できませんでした。</b>`
          + `${srcQuestionRef ? `確認事項の <b>${srcQuestionRef}</b> に記載しています。` : 'お打ち合わせでご確認させてください。'}`}</p>
    ${secMap ? `<div class="map-static map-scroll">${secMap.svg}</div>
    ${secMap.omittedNodes > 0 ? `<p class="tbl-note">※ つながりの多い表を優先表示（省略: 表 ${secMap.omittedNodes}）。</p>` : ''}` : ''}
    ${sec.blocks.map((b, i) => renderLogicBlock(b, i + 1, regions, graph.keyLinks ?? [], labels, fileNameOf, showEr)).join('\n')}`;
    }).join('\n')}

    ${isolatedFiles.length > 0 ? `
    ${subH('つながりが検出できなかったファイル')}
    <div class="lb iso">
      <div class="lb-head"><span class="lb-no">—</span>
        <div><b>${isolatedFiles.map(s => esc(s.filename)).join('、')}</b></div>
      </div>
      <div class="lb-step"><span class="lb-st">状況</span>
        <p>これらのファイルは、他のどのファイルとも数式・値の一致でつながりませんでした。
        ${isolatedFiles.some(s => s.regionCount > 0) ? '数式を持たない（システムからの出力をそのまま貼った）ファイルの場合、' : ''}
        どこへどうやって取り込まれているかが Excel 上に根拠として残りません。${refQuestions}</p>
      </div>
    </div>` : ''}

    ${spec.items.detailLogic ? `
    ${subH('関係の一覧（付録）— どのシートが、どのキーで、どうつながっているか')}
    <!-- 付録は行数が多く、読み合わせでは普段たたんでおきたい。既定は閉じる -->
    <details class="fileblk">
      <summary><b>関係の一覧を開く</b><span class="rows">${detailRows.length} 件</span></summary>
    <div style="overflow-x:auto">
      <table class="ot dl">
        <tr><th>元（表・列）</th><th>キー</th><th>処理</th><th>先（表・列）</th><th>根拠（数式・一致）</th><th>確度</th></tr>
        ${detailRows.join('\n        ')}
      </table>
      ${detailOmitted > 0 ? `<p class="tbl-note">※ 関係が多いため流れの順に上位 ${DETAIL_ROWS_CAP} 件を掲載しています（全 ${pairs.length} 件）。残りはお打ち合わせで画面をご覧いただけます。</p>` : ''}
    </div>
    </details>` : ''}
    <div class="callout info">
      <span class="mark">ℹ️</span>
      <span>別ブックを参照する数式（外部リンク）は追跡していますが、参照先のファイルをいただいていない場合・リンクが切れている場合は追跡できません。
      ピボットテーブルも自動追跡の対象外です。図に出ていないつながりがあれば、お打ち合わせで補足をお願いします。</span>
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
/* タイルの補足行。数字だけでは「で、それが何なのか」が伝わらないので、対象名や参照先を1行添える */
.tile .tsub{font-size:11.5px;color:var(--sub);line-height:1.5;margin-top:4px;word-break:break-all}
.tile.warn{border-top:4px solid var(--amber)}
.tile.warn .tv{color:var(--amber)}
/* 最終アウトプット＝kpiee で再現する対象。読み合わせの目的地なので色で際立たせる */
.tile.out{border-top:4px solid var(--red)}
.tile.out .tv{color:var(--red)}
/* ---- ロジック別ブロック ---- */
.lb{border:1px solid var(--line);border-radius:14px;padding:0 0 6px;margin:20px 0;background:#fff;overflow:hidden}
.lb.iso{border-style:dashed}
.lb-head{display:flex;gap:14px;align-items:flex-start;padding:16px 22px;background:var(--bg2);border-bottom:1px solid var(--line)}
.lb-no{flex:0 0 auto;width:26px;height:26px;border-radius:50%;background:var(--ink);color:#fff;
  font-family:var(--mono);font-size:13px;display:flex;align-items:center;justify-content:center}
.lb-sub{font-size:12px;color:var(--sub);margin-top:3px}
.lb-step{padding:14px 22px 4px}
.lb-st{display:inline-block;font-size:11px;letter-spacing:.06em;color:var(--sub);
  border:1px solid var(--line);border-radius:999px;padding:2px 10px;margin-bottom:8px}
/* 数式の部位分解。数式そのものを色分けし、直下に「どこが何を指すか」を並べる */
.fx{margin:10px 0 4px}
.fx-code{font-family:var(--mono);font-size:15px;background:var(--bg2);border:1px solid var(--line);
  border-radius:8px;padding:12px 14px;overflow-x:auto;white-space:nowrap}
.fx-legend{list-style:none;margin:10px 0 0;padding:0;display:grid;gap:6px}
.fx-legend li{font-size:12.5px;color:var(--sub);display:flex;gap:8px;align-items:baseline}
.fx-legend li>span{flex:0 0 auto;font-family:var(--mono);font-size:12px;border-radius:4px;padding:1px 6px}
.fx1{background:#E6F1FB;color:#185FA5}
.fx2{background:#EAF3DE;color:#3B6D11}
.fx3{background:var(--amber-bg);color:var(--amber)}
.fx-how{font-size:12.5px;line-height:1.7;margin:10px 0 0;padding:10px 12px;border-radius:8px;
  background:var(--amber-bg);border:1px solid #F0D8B0;color:#7A5100}
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

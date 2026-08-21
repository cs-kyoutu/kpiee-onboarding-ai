// 顧客共有用「データ構造 分析レポート」(自己完結 HTML) の生成。
//
// 目的: 受領データの関係分析（RelationGraph）を、顧客との読み合わせに使える1枚のHTMLへ整形する。
//   - 確定事項（数式由来）と推定（値一致・構造推定）を視覚的に分離し、確認は推定部分だけに絞る
//   - 「ご確認いただきたい点」を Q-01.. の番号付きカードとして決定的に自動抽出する（AI 呼び出しなし）
//   - セルの生値は載せない（列名・数式・行数などの構造情報のみ）— 社外共有しても原本数値が漏れない
// summaryDoc.ts（Word/md のパッケージ資料）と同じ「保存済み派生結果から決定的に組み立てる」等級。
//
// 構成は5節。読み合わせの打ち合わせで上から順に説明していける並びにしてある:
//   01 受領データ一覧 … どのブックが何で、各タブがどういう役割か（取込時に入力された情報）
//   02 再現するアウトプットの確認 … 何を再現するのか・伺っている作り方・今回の前提
//   03 ロジックの確認 … 全体関係図（ブック間）→ 最終アウトプットごとに「読み方 → でき方 → 確認欄」
//   04 ご確認いただきたい点 … 自動解析が「推定」に留まる箇所
//   05 今後の進め方
// 02 は「合っているかを最初に確かめる」節。ここが違っていると 03 以降の読み方も変わるため先に置く。
// 内容（spec.reproduce / howMade / assumptions / sheetGuide）が無い案件では節そのものを出さず、
// 節番号を繰り上げる。03 は必ず「全体 → 帳票ごと」の順に降りる。1ブックの案件ではブック間の図が
// 1箱になって意味を持たないため、全体の段を省いて帳票ごとの節から入る。
import type {
  RelationGraph, Region, Edge, RelationWarning, KeyLink, SharedTemplateColumn,
} from './preprocess/relations.js';
import { colLetter, fileLabelOf } from './preprocess/relations.js';
import {
  regionIdOf, colNameOf, regionPairKey, filePairKey, groupOf,
  GROUP_META, GROUP_ORDER, aggregatePairs, dominantGroup, computeLayers,
  aggregateFilePairs, dominantFileGroup, computeFileLayers,
  type Group, type PairAgg, type FilePair,
} from './relations/fileGraph.js';
import { FILE_REL_LABELS, type DeclaredFileRel, type FileRelAudit } from './relations/declared.js';
import {
  DEFAULT_REPORT_SPEC, type ReportSpec, type ReportOutputBlock, type ReportOutputPlan,
} from './reportSpec.js';

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

/**
 * 文ごとに折り返す。長い段落をそのまま流すと、ある行は「。」で切れ、次の行は文の途中で切れ、
 * どこで切れるかが行ごとに変わって読みにくい。文を1つの塊（inline-block）にすると、
 * 入る文はまるごと1行に収まり、入らない文だけが内部で折り返す。
 * 引数は1文ずつ渡す（空文字は捨てる）。
 */
const sentences = (...parts: string[]): string =>
  parts.filter(s => s.trim() !== '').map(s => `<span class="s">${s}</span>`).join('<wbr>');

const confLabel = (c: number): string => (c >= 0.8 ? '高' : c >= 0.5 ? '中' : '低');

/** 取込時に指定・確認されたシート役割の表示名（classify.ts / UploadPanel と同じ語彙） */
const SHEET_ROLE_LABELS: Record<string, string> = {
  input_data: 'インプット',
  master_data: 'マスタ',
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

/**
 * ファイルまるごとがマスタ（変換表・コード表）と指定されたものを拾う。
 * 「マスタのシートがある」だけでは足りない — 試算ブックのように受領データを貼り付けた
 * マスタシートを内側に持つファイルまでマスタになってしまうため、全シートがマスタのものに限る。
 */
function buildMasterFileIndex(artifacts: ReportArtifact[]): Set<string> {
  const out = new Set<string>();
  for (const a of artifacts) {
    const roles = Object.values(a.sheetRoles ?? {});
    const named = roles.filter(r => r && r !== 'unknown');
    if (named.length > 0 && named.every(r => r === 'master_data')) out.add(fileLabelOf(a.filename));
    else if (named.length === 0 && a.kind === 'master_data') out.add(fileLabelOf(a.filename));
  }
  return out;
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

type Role = 'マスタ' | '元データ' | '中間集計' | '最終アウトプット' | '独立';

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
    if (!s || (s.in === 0 && s.outRef === 0 && s.outOther === 0)) { roles.set(r.id, '独立'); continue; }
    if (s.in === 0 && s.outRef > 0 && s.outOther === 0) roles.set(r.id, 'マスタ');
    else if (s.in === 0) roles.set(r.id, '元データ');
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
  const used = new Set<string>();
  const labels = new Map<string, string>();
  for (const r of regions) {
    const sk = `${r.file}\u0000${r.sheet}`;
    const n = (seen.get(sk) ?? 0) + 1;
    seen.set(sk, n);
    const ambiguous = (filesOfSheet.get(r.sheet)?.size ?? 1) > 1;
    // CSV 由来のシート名は一律「データ」で意味を持たないため、ファイル名をラベルにする
    const base = r.sheet === 'データ' && r.file ? r.file
      : ambiguous && r.file ? `${r.file} › ${r.sheet}` : r.sheet;
    // 1枚のシートが複数の表に割れているとき、通し番号 (2) では読み手が現物を探せない
    //（「①サマリー (5)」と言われても、シートは1枚しかないので何のことか分からない）。
    // 縦横に並ぶものを添えて、どの表の話かが読んで分かるようにする。軸が読めなかったときだけ
    // セル範囲に落とす。Excel 上の位置は、01 節の表ブロックとロジック表の注記に残している。
    const ax = axisLabel(r);
    let name = base;
    if ((perSheet.get(sk) ?? 1) > 1) {
      name = `${base} ${ax === '' ? rangeOf(r) : ax}`;
      // 軸の説明が同じになる表が2つあると呼び分けられない。そのときだけ番地に戻す
      if (used.has(name)) name = `${base} ${rangeOf(r)}`;
    }
    used.add(name);
    labels.set(r.id, name);
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

/**
 * 見出しの読めなかった列（`I列` のような位置の呼び方）を、意味の分かる呼び方へ直す。
 * 横軸のまとまりと繰り返し単位が読めていれば、`I列` は「東京の売上」と言い直せる。
 * 読み合わせでは列記号を言われても現物を指せないので、分かるものは全て言い直す。
 */
function prettyColumn(r: Region | undefined, name: string): string {
  const m = /^([A-Z]{1,3})列$/.exec(name);
  if (!m || !r?.axes?.colGroupSpans) return name;
  let c = 0;
  for (const ch of m[1]) c = c * 26 + (ch.charCodeAt(0) - 64);
  const span = r.axes.colGroupSpans.find(s => c >= s.c0 && c <= s.c1);
  if (!span) return name;
  const units = r.axes.colUnits ?? [];
  if (units.length === 0) return span.name;
  return `${span.name}の${units[(c - span.c0) % units.length]}`;
}

/** 文の中に混ざった列記号（`A列 × B列` など）を、まとめて意味の分かる呼び方へ直す */
function prettyText(r: Region | undefined, s: string): string {
  return s.replace(/[A-Z]{1,3}列/g, m => prettyColumn(r, m));
}

/** 先頭 n 件だけ並べ、残りは「ほか N」でまとめる（total は省略前の総数） */
function axisList(xs: string[], n: number, total?: number): string {
  const shown = Math.min(n, xs.length);
  const rest = (total ?? xs.length) - shown;
  return xs.slice(0, shown).join('・') + (rest > 0 ? 'ほか' + String(rest) : '');
}

/**
 * 表の呼び名に添える、縦横に何が並ぶかの説明。1枚のシートが複数の表に割れているときの
 * 区別に使う。以前はセル番地（F42:BJ43）を添えていたが、番地では何の表か分からないため、
 * 「（参考）年間仮予算・進捗率 × DF計・東京ほか17」のように中身で呼ぶ。
 * 図のノードにも載るので短く。指標の内訳（売上・営業利益…）は axisDetail に回す。
 */
function axisLabel(r: Region): string {
  const a = r.axes;
  if (!a) return '';
  // 呼び名は図のノードに収まる長さにする。2つまでなら並べ、3つ以上なら先頭1つと件数だけ
  const brief = (xs: string[], total?: number): string =>
    ((total ?? xs.length) <= 2 ? axisList(xs, 2, total) : axisList(xs, 1, total));
  const rows = a.rowLabels ? brief(a.rowLabels, a.rowLabelTotal) : '';
  const cols = a.colGroups ? brief(a.colGroups, a.colGroupTotal)
    : a.colUnits ? brief(a.colUnits) : '';
  const body = rows !== '' && cols !== '' ? rows + ' × ' + cols : rows || cols;
  if (body === '') return '';
  return (a.section ?? '') + body;
}

const SHAPE_SHEET_CAP = 4;  // 「この帳票の形」を書くシートの数（グラフのシートまで並べると長い）

/** 最終アウトプットの節で「この帳票の形」を書くための、シート1枚ぶんの読み取り */
interface SheetShape {
  sheet: string;
  /** 帯の区分。例: 【単月】【累計】（参考） */
  sections: string[];
  rowLabels: string[]; rowTotal: number;
  /** 横に並ぶまとまり。左から順（例: 全社・DF計・東京…） */
  groups: string[];
  /** まとまり1つの中で繰り返される列。例: 売上・営業利益・経常利益 */
  units: string[];
  totals: { name: string; parts: string[]; partTotal: number }[];
}

/**
 * 1枚のシートを「縦に何が、横に何が並び、どれが合計か」で言い直す。
 * 1シートが複数の表に割れていても、読み手にとっては1枚の帳票なので、
 * 同じ行範囲に並ぶ表をつなげて、横軸を左から右へ1本にまとめる。
 */
function buildSheetShape(regions: Region[], file: string, sheet: string): SheetShape | null {
  const mine = regions.filter(r => r.file === file && r.sheet === sheet && r.axes);
  if (mine.length === 0) return null;

  // 横に一番広い帯を、この帳票の本体とみなす（上の見出し行を持つ帯がこれになる）
  const bands = new Map<string, Region[]>();
  for (const r of mine) {
    const k = `${r.r0}:${r.r1}`;
    const arr = bands.get(k);
    if (arr) arr.push(r); else bands.set(k, [r]);
  }
  const width = (rs: Region[]) => rs.reduce((s, r) => s + (r.c1 - r.c0 + 1), 0);
  const band = [...bands.values()].sort((a, b) => width(b) - width(a))[0];

  const spans = band.flatMap(r => r.axes?.colGroupSpans ?? []).sort((a, b) => a.c0 - b.c0);
  const groups = [...new Set(spans.map(s => s.name))];
  const units = band.map(r => r.axes?.colUnits).find(u => u && u.length > 0) ?? [];
  const rowsAxes = band.map(r => r.axes).find(a => a?.rowLabels)
    ?? mine.map(r => r.axes).find(a => a?.rowLabels);
  const sections = [...new Set(mine.map(r => r.axes?.section).filter((s): s is string => !!s))];

  // 合計の関係はシート全体から集める（合計列と内訳列が別の表に分かれていることがある）
  const totals = new Map<string, { name: string; parts: string[]; partTotal: number }>();
  for (const r of mine) for (const t of r.axes?.colTotals ?? []) if (!totals.has(t.name)) totals.set(t.name, t);

  const shape: SheetShape = {
    sheet, sections, groups, units: [...units],
    rowLabels: rowsAxes?.rowLabels ?? [], rowTotal: rowsAxes?.rowLabelTotal ?? 0,
    totals: [...totals.values()],
  };
  const empty = shape.groups.length === 0 && shape.units.length === 0 && shape.rowLabels.length === 0;
  return empty ? null : shape;
}

/** 「この帳票の形」の箇条書き。列記号やセル番地は使わず、並んでいるものの名前だけで書く */
function renderSheetShape(s: SheetShape, showSheet: boolean): string {
  const li: string[] = [];
  if (s.groups.length > 0) {
    const g = `<b>${esc(axisList(s.groups, 6))}</b>`;
    li.push(s.units.length > 0
      ? `横に ${g} が並び、そのひとつひとつに <b>${esc(s.units.join('・'))}</b> があります。`
      : `横に ${g} が並びます。`);
  } else if (s.units.length > 0) {
    li.push(`横に <b>${esc(axisList(s.units, 8))}</b> が並びます。`);
  }
  if (s.rowLabels.length > 0) {
    const r = `<b>${esc(axisList(s.rowLabels, 6, s.rowTotal))}</b>`;
    li.push(s.sections.length > 1
      ? `縦は ${r} で、これが <b>${esc(s.sections.join('・'))}</b> ごとに繰り返されます。`
      : `縦は ${r} です。`);
  }
  for (const t of s.totals) {
    li.push(`<b>${esc(t.name)}</b> は <b>${esc(axisList(t.parts, 4, t.partTotal))}</b> の合計です（数式で確認しております）。`);
  }
  if (li.length === 0) return '';
  // シート名は先頭の項目に付ける。「横に…」が出せない帳票でも、どのシートの話かは要る
  if (showSheet) li[0] = `<b>${esc(s.sheet)}</b>は、${li[0]}`;
  return `<ul class="graph-guide">${li.map(x => `\n      <li>${x}</li>`).join('')}\n    </ul>`;
}

/** 01 節の表ブロックに出す、繰り返し単位まで含めた軸の説明 */
function axisDetail(r: Region): string {
  const a = r.axes;
  if (!a) return '';
  const rows = a.rowLabels ? axisList(a.rowLabels, 4, a.rowLabelTotal) : '';
  const groups = a.colGroups ? axisList(a.colGroups, 4, a.colGroupTotal) : '';
  const units = a.colUnits ? a.colUnits.slice(0, 4).join('・') : '';
  const cols = groups !== '' && units !== '' ? groups + '（' + units + '）' : groups || units;
  const parts: string[] = [];
  if (rows !== '') parts.push('縦に ' + rows);
  if (cols !== '') parts.push('横に ' + cols);
  if (parts.length === 0) return '';
  // 合計と内訳の関係が数式から読めていれば、それも1文で添える
  const totals = (a.colTotals ?? [])
    .map(t => t.name + ' は ' + axisList(t.parts, 3, t.partTotal) + ' の合計です。')
    .join('');
  return (a.section === undefined ? '' : a.section + 'の帯です。')
    + parts.join('、') + ' が並びます。' + totals;
}

/**
 * 01 の「タブごとの役割と中身」に出す、1タブぶんの「何が並ぶタブか」。
 * 表が複数に割れていてもタブは1行で言い切りたいので、シート単位に読み直して
 * 「縦: … ／ 横: …」の1行にする（axisDetail は表1つぶんの説明で、こちらより細かい）。
 */
function tabAxisText(regions: Region[], file: string, sheet: string): string {
  const s = buildSheetShape(regions, file, sheet);
  if (!s) return '';
  const rows = s.rowLabels.length === 0 ? ''
    : `縦: ${axisList(s.rowLabels, 4, s.rowTotal)}`
      + (s.sections.length > 1 ? `（${s.sections.join('')}ごとに繰り返し）` : '');
  const cols = s.groups.length === 0 && s.units.length === 0 ? ''
    : `横: ${s.groups.length > 0 ? axisList(s.groups, 4) : ''}`
      + (s.units.length > 0 ? `（${s.units.slice(0, 4).join('・')}）` : '');
  return [rows, cols].filter(x => x !== '').join(' ／ ');
}

// ============================================================
// ご確認いただきたい点（決定的な質問抽出）
// ============================================================
interface Question {
  id: string; priority: 'high' | 'mid'; kind: string; title: string;
  /** 解析で分かったこと。機械が出した根拠文字列をそのまま載せない（顧客が読む文章にする） */
  analysis?: string;
  /**
   * 「どこの話か」の内訳。件数が多い設問で、文章に詰め込む代わりに箇条書きで並べる。
   * 数千組を1文で言うと何も伝わらず、1組ずつ設問にすると読めない。その間を埋めるための欄。
   */
  detail?: string[];
  /** 伺いたいこと。複数あるときは配列で渡し、箇条書きで出す（1行に①②③を詰め込まない） */
  ask: string | string[];
  refPair?: string; // copy 質問→辺表・図から参照するための `${from}\u0000${to}`
}

/**
 * 値一致（手修正推定）の対を、読み手が「どこの話か」を掴める形で扱うための情報。
 *   kindOf … ブックをまたぐ / 同じブックの別シート / 同じシートの中。論点の重さがまるで違う
 *   colsOf … 一致していた列名。「どこが」を列名で言えないと、読み手は確認のしようがない
 */
interface CopyInfo {
  kindOf: (p: PairAgg) => 'cross' | 'sameBook' | 'sameSheet';
  colsOf: (p: PairAgg) => string[];
}

function buildCopyInfo(regions: Region[], edges: Edge[]): CopyInfo {
  const byId = new Map(regions.map(r => [r.id, r]));
  const cols = new Map<string, string[]>();
  for (const e of edges) {
    if (e.type !== 'copy') continue;
    const k = regionPairKey(regionIdOf(e.from), regionIdOf(e.to));
    const col = colNameOf(e.to) || colNameOf(e.from);
    if (col === '') continue;
    const arr = cols.get(k) ?? [];
    if (!arr.includes(col)) arr.push(col);
    cols.set(k, arr);
  }
  return {
    kindOf: (p) => {
      const a = byId.get(p.from); const b = byId.get(p.to);
      if (!a || !b || a.file !== b.file) return 'cross';
      return a.sheet === b.sheet ? 'sameSheet' : 'sameBook';
    },
    colsOf: (p) => cols.get(regionPairKey(p.from, p.to)) ?? [],
  };
}

function buildQuestions(
  regions: Region[], pairs: PairAgg[], warnings: RelationWarning[],
  labels: Map<string, string>, roles: Map<string, Role>,
  fileRelAudit: FileRelAudit[], fileNameOf: (label: string) => string,
  declaredOut: DeclaredOutputIndex, sharedTemplates: SharedTemplateColumn[],
  copyInfo: CopyInfo,
): Question[] {
  const qs: Omit<Question, 'id'>[] = [];
  // 設問では表の呼び名にファイル名を必ず添える。図の中では短いほうが読みやすいが、設問は
  // 「どのファイルのどのシートの話か」が分からないと答えようがない（月次タブのように、
  // シート名だけでは複数のファイルのどれを指しているのか判断できないものがある）。
  const regionById = new Map(regions.map(r => [r.id, r]));
  const fullName = (id: string): string => {
    const short = labels.get(id) ?? id;
    const r = regionById.get(id);
    return r && r.file && !short.includes('›') && short !== r.file ? `${r.file} › ${short}` : short;
  };
  // 受け渡しを伺っているファイル。ここに出てくるファイルは「出所が分からない」対象から外す
  const declaredFiles = new Set(fileRelAudit.filter(a => a.verdict !== 'detected_not_declared')
    .flatMap(a => [a.fromFile, a.toFile]));

  // (0) 伺った受け渡しと、ファイルの中身が食い違っている箇所。
  // ここに出すのは「いただいたデータを全部見たうえで、それでも分からなかったこと」だけにする。
  // 「自動検出できませんでした」はこちらの作業の報告であって、お客様が答えられる問いではない。
  // 受け渡しの一覧そのものは 02 に出ているので、ここで並べ直さない。
  for (const a of fileRelAudit.filter(x => x.verdict === 'direction_conflict')) {
    qs.push({
      priority: 'high', kind: 'データの受け渡し',
      title: `「${fileNameOf(a.fromFile)}」と「${fileNameOf(a.toFile)}」は、伺った向きと逆に見えます。どちらが元のデータでしょうか。`,
      analysis: `値でみると、${a.detectedTotal.toLocaleString()} 件は「${fileNameOf(a.toFile)}」から「${fileNameOf(a.fromFile)}」へ運ばれた形になっていました。`,
      ask: ['どちらを元として扱っていらっしゃいますか',
            '両方向に運んでいらっしゃる場合は、その手順もお聞かせください'],
    });
  }
  // 貼り付けだけで運ばれていて、元をたどる手がかりがファイルに残っていない受け渡し。
  // 分からないのは「いつ時点のデータを、どのタイミングで、どこまで貼っていらっしゃるか」なので、
  // 関係ごとに1問ずつ出さず、その1点にまとめて聞く。
  const undetected = fileRelAudit.filter(x => x.verdict === 'declared_not_detected');
  if (undetected.length > 0) {
    // 数えているのはファイルなので単位も「ファイル」で書く（「件」だと何の件数か分からない）。
    // 1つのファイルが複数の受け渡しに出てくることがあるので、ファイル名で重複を落としてから数える
    const fromFiles = [...new Set(undetected.map(a => a.fromFile))];
    const names = fromFiles.slice(0, 3).map(f => `「${fileNameOf(f)}」`).join('、')
      + (fromFiles.length > 3 ? ` ほか${fromFiles.length - 3}ファイル` : '');
    const dsts = [...new Set(undetected.map(a => a.toFile))];
    const to = dsts.length === 1 ? `「${fileNameOf(dsts[0])}」へ` : 'それぞれの集計先へ';
    qs.push({
      priority: 'high', kind: '貼り付け時点の確認',
      title: `${names} から${to}は、数式ではなく値を貼る形で運んでいらっしゃると伺いました。`
        + '毎月どの時点のデータを貼っていらっしゃいますか。',
      analysis: 'いただいたファイルには貼り付けた後の値だけが残っていて、'
        + 'いつ時点の数字がどこまで入っているのかを、ファイルからは読み取れませんでした。'
        + 'どの時点の数字かをお教えいただけますと、kpiee 側でも同じ数字を再現できるようになります。',
      detail: undetected.slice(0, 8).map(a => `${fileNameOf(a.fromFile)} → ${fileNameOf(a.toFile)}`)
        .concat(undetected.length > 8 ? [`ほか ${undetected.length - 8} 件`] : []),
      ask: ['毎月どの時点の数字を貼っていらっしゃいますか（例：月次決算の確定後、翌月◯日頃など）。',
            '貼り付けは、どなたが、どのタイミングで行っていらっしゃいますか。',
            '月によって貼る時点が変わることがございましたら、あわせてお聞かせください。'],
    });
  }
  const undeclaredPairs = fileRelAudit.filter(x => x.verdict === 'detected_not_declared');
  if (undeclaredPairs.length > 0) {
    const names = undeclaredPairs.slice(0, 3)
      .map(a => `「${fileNameOf(a.fromFile)}」と「${fileNameOf(a.toFile)}」`).join('、')
      + (undeclaredPairs.length > 3 ? ` ほか${undeclaredPairs.length - 3}組` : '');
    qs.push({
      priority: 'mid', kind: 'データの受け渡し',
      title: `${names} には同じ数値が入っていました。この2つは受け渡しをしていらっしゃいますか。`,
      analysis: '伺った受け渡しには挙がっていない組み合わせですが、値が一致していました。',
      ask: 'たまたま同じ数値になっているだけであれば、その旨をお知らせください。',
    });
  }

  // (1) 手修正推定（値一致）: 表ペア単位に1問。列数の多い順に最大3問。
  // ブック関係の登録で裏が取れた（matched）ファイル対は確認不要なので外す — 残った本当の論点だけを並べる。
  const confirmedFilePairs = new Set(
    fileRelAudit.filter(a => a.verdict === 'matched').map(a => filePairKey(a.fromFile, a.toFile)),
  );
  const fileOfRegion = new Map(regions.map(r => [r.id, r.file]));
  // 向きは値の一致からは決められないので、逆向きの登録でも「確認済み」として扱う
  const isConfirmed = (p: PairAgg): boolean => {
    const f = fileOfRegion.get(p.from); const t = fileOfRegion.get(p.to);
    if (!f || !t || f === t) return false;
    return confirmedFilePairs.has(filePairKey(f, t)) || confirmedFilePairs.has(filePairKey(t, f));
  };
  const copyPairs = pairs
    .filter(p => (p.counts.copy ?? 0) > 0 && !isConfirmed(p))
    .sort((a, b) => (b.counts.copy ?? 0) - (a.counts.copy ?? 0));
  // 1列だけ・数十セルの一致は、区分名や単価のような同じ値が並んでいるだけのことが多い。
  // それを個別の設問にすると、読み合わせの時間を本題でない話に使うことになる。
  // 規模のあるものだけを個別に出し、残りはまとめて1問にする。
  const cellsOf = (p: PairAgg): number =>
    Number((/(\d[\d,]*)\s*件/.exec(p.best.copy?.evidence ?? '')?.[1] ?? '0').replace(/,/g, ''));
  // 一致していた列名を短く並べる。「どこが一致したのか」を列名で言えないと確認のしようがない
  const colList = (p: PairAgg): string => {
    const all = copyInfo.colsOf(p);
    // 「AL列」のような位置の呼び名だけを並べても、読み手はどの項目か分からない。
    // 名前のある列を優先し、名前が無いものは本数だけ言う。
    const named = all.filter(c => !PLACEHOLDER_COL.test(c));
    const anon = all.length - named.length;
    if (named.length === 0) return anon > 0 ? `見出しのない列 ${anon} 列` : '';
    return `${named.slice(0, 4).map(c => `「${c}」`).join('・')}`
      + (named.length > 4 ? ` ほか${named.length - 4}列` : '')
      + (anon > 0 ? `（ほかに見出しのない列 ${anon} 列）` : '');
  };
  // ブックをまたぐ一致だけを個別の設問にする。同じブックの中（とくに同じシートの中）の一致は
  // 同じ様式の表が並んでいるためのことが多く、1件ずつ聞くと本当の論点が埋もれる。
  const crossCopy = copyPairs.filter(p => copyInfo.kindOf(p) === 'cross');
  const innerCopy = copyPairs.filter(p => copyInfo.kindOf(p) !== 'cross');
  const strongCopy = crossCopy.filter(p => (p.counts.copy ?? 0) >= 2 || cellsOf(p) >= 100);
  const shownCopy = strongCopy.slice(0, 3);
  for (const p of shownCopy) {
    const from = fullName(p.from);
    const to = fullName(p.to);
    const rep = p.best.copy;
    const n = p.counts.copy ?? 0;
    const undirected = rep?.needsConfirmation;
    // 根拠文字列（例: 値完全一致(11件, 手修正の可能性)）はそのまま出さず、件数だけ拾って文章に混ぜる
    const cells = /(\d[\d,]*)\s*件/.exec(rep?.evidence ?? '')?.[1];
    const cellNote = cells ? `（${cells} セル）` : '';
    qs.push({
      priority: 'high', kind: '手修正の確認', refPair: `${p.from}\u0000${p.to}`,
      title: undirected
        ? `「${from}」と「${to}」に同じ数値が入っています。どちらを元として運んでいらっしゃいますか。`
        : `「${to}」の一部の列は、「${from}」から手修正で合わせていらっしゃいますか。`,
      analysis: `一致していたのは ${colList(p) || `${n} つの列`} で、${n} 列ぶん${cellNote}が数式なしで完全に同じ値でした。`
        + '数式が残っていないため、どちらからどちらへ運ばれたのかまでは追えていません。',
      ask: undirected
        ? ['元として扱っていらっしゃるのはどちらですか', '貼り替えるのはいつのタイミングで、どなたが担当されていますか']
        : ['この理解で合っていますでしょうか', '貼り替えるのはいつのタイミングで、どなたが担当されていますか',
           '2つの数値が食い違ったときは、どちらを正としていらっしゃいますか'],
    });
  }
  // ブックをまたぐ一致の残り。ファイル対へ畳み、代表の列名まで書いて「どこを見ればよいか」を残す
  const restCross = crossCopy.filter(p => !shownCopy.includes(p));
  if (restCross.length > 0) {
    interface CopyGroup { from: string; to: string; pairs: number; cols: number; sample: PairAgg }
    const groups = new Map<string, CopyGroup>();
    for (const p of restCross) {
      const f = fileOfRegion.get(p.from) ?? ''; const t = fileOfRegion.get(p.to) ?? '';
      const k = filePairKey(f, t);
      let g = groups.get(k);
      if (!g) { g = { from: f, to: t, pairs: 0, cols: 0, sample: p }; groups.set(k, g); }
      g.pairs++;
      g.cols += p.counts.copy ?? 0;
      if ((p.counts.copy ?? 0) > (g.sample.counts.copy ?? 0)) g.sample = p;
    }
    const ordered = [...groups.values()].sort((a, b) => b.cols - a.cols || b.pairs - a.pairs);
    const lines = ordered.slice(0, 4).map(g =>
      `${fileNameOf(g.from)} → ${fileNameOf(g.to)}：${g.pairs} 組（例: ${colList(g.sample) || '列名の取得なし'}）`);
    qs.push({
      priority: 'high', kind: '手修正の確認',
      title: shownCopy.length > 0
        ? `ほかにも、ブックをまたいで同じ値が入っている箇所が ${restCross.length} 組ございました。貼り付けていらっしゃいますか。`
        : `ブックをまたいで同じ値が入っている箇所が ${restCross.length} 組ございました。貼り付けていらっしゃいますか。`,
      analysis: '多い順に、次のファイル間で見つかっています。',
      detail: lines,
      ask: ['この中に、毎月コピーして貼っていらっしゃるものはありますか',
            '貼り替えるのはいつのタイミングで、どなたが担当されていますか'],
    });
  }
  // 同じブックの中の一致。同じ様式の表が繰り返し並ぶブックでは数千組になるため、
  // 件数を数えるだけでは何も伝わらない。どのシートの何列かを代表で挙げて1問にまとめる。
  if (innerCopy.length > 0) {
    const bySheet = new Map<string, { file: string; sheet: string; pairs: number; cols: number; sample: PairAgg }>();
    for (const p of innerCopy) {
      const r = regionById.get(p.to);
      if (!r) continue;
      const k = `${r.file} ${r.sheet}`;
      let g = bySheet.get(k);
      if (!g) { g = { file: r.file, sheet: r.sheet, pairs: 0, cols: 0, sample: p }; bySheet.set(k, g); }
      g.pairs++;
      g.cols += p.counts.copy ?? 0;
      if ((p.counts.copy ?? 0) > (g.sample.counts.copy ?? 0)) g.sample = p;
    }
    const ordered = [...bySheet.values()].sort((a, b) => b.cols - a.cols || b.pairs - a.pairs);
    const lines = ordered.slice(0, 5).map(g =>
      `${fileNameOf(g.file)} › ${g.sheet}：${g.pairs} 組（例: ${colList(g.sample) || '列名の取得なし'}）`);
    // 聞きたいのは「同じ様式かどうか」ではなく「ここは手修正で合わせているのか」。
    // 様式が同じだけなら確認は要らず、手修正なら自動化できる範囲の話になる。
    // 選択肢は1行ずつ渡す（1つの行に①②③を詰めると項目の途中で折り返して読めない）。
    qs.push({
      priority: 'mid', kind: '手修正の確認',
      title: `数式でつながっていないのに同じ値が並んでいる表が、同じブックの中に ${innerCopy.length} 組ございました。`
        + 'ここは手修正で合わせていらっしゃいますか。',
      analysis: '値が同じで、かつ数式のつながりが見つからない表を、こちらで自動的に数えたものです。'
        + 'ただし、拠点ごと・月ごとに同じ様式を並べているだけ（項目名や予算の列が同じ順に並ぶ）の場合も'
        + 'この数に入りますので、手修正なのか、様式が同じだけなのかは、ファイルからは見分けがつきませんでした。'
        + '手修正の箇所が分かりますと、kpiee で自動化できる範囲がはっきりいたします。'
        + '下の①〜③のうち、近いものを1つお選びいただくだけで結構です。',
      detail: lines.concat(ordered.length > 5 ? [`ほか ${ordered.length - 5} シート`] : []),
      ask: ['①同じ様式を並べているだけで、数字はそれぞれ別に入っている。',
            '②手修正で合わせている。',
            '③一部が手修正（その場合は、手修正されているシートをお聞かせください）。'],
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
      title: `${names} は、複数のブックに同じ値で入っています。共通の元（マスタ・様式）はどれでしょうか。`,
      analysis: '同じ値の列が3ブック以上にあり、いずれも数式を持ちません。'
        + '同じ様式を使い回している（部署コード・勘定科目などのマスタ）状態と見て、'
        + '個別の転記としては数えていません。',
      ask: '①この一覧の「正」はどこで管理されていますか。 ②追加・変更があったとき、各ブックへどう反映していますか？',
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
    // 最終アウトプットそのものの上書きは、中間シートの上書きより影響が直接的なので言い方を変える
    const isFinalSheet = declaredOut.hasSheet(g.file, g.sheet);
    qs.push({
      priority: 'high', kind: '数式と手入力の混在',
      title: `「${g.file} › ${g.sheet}」の ${cols} で、数式が消えて数値が直接入っているセルが ${g.count} つあります。意図的な調整でしょうか？`,
      analysis: `${cols} は本来ほぼ全体に同じ数式が入っている列ですが、そのうち ${g.count} セルだけ数式がなくなり、数値が直接入っていました。`
        + (isFinalSheet ? '最終アウトプットそのものの数値にあたるため、影響が直接的です。' : ''),
      ask: '返品や締め処理など、あえて数式を外して調整された箇所でしょうか。もし決まった手順やルールがあれば、あわせてお聞かせください。',
    });
  }
  if (mixed.length > 2) {
    qs.push({
      priority: 'mid', kind: '数式と手入力の混在',
      title: `数式が部分的に消えているシートが、ほかに ${mixed.length - 2} 枚あります。一覧をお渡しいたしますので、後日ご確認いただけますか。`,
      analysis: `上と同じ「数式列の一部が数値で上書きされている」状態が、ほかに ${mixed.length - 2} シートで見つかっています。`,
      ask: '該当シートとセル位置の一覧をお渡しいたします。お手すきのときに、意図的な調整かどうかだけご確認いただけますと助かります。',
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
    // 受け渡しを伺っているファイルは「元が分からない」わけではないので外す
    const untraced = [...declaredSheets]
      .filter(([k, v]) => !inflowSheets.has(k) && !declaredFiles.has(v.file)).map(([, v]) => v);
    if (untraced.length > 0) {
      const names = untraced.slice(0, 4).map(v => `「${v.file} › ${v.sheet}」`).join('、')
        + (untraced.length > 4 ? ` ほか${untraced.length - 4}シート` : '');
      qs.push({
        priority: 'high', kind: '最終帳票の元データ',
        title: `最終アウトプット ${untraced.length} シートについて、その数値の出どころが受領データの中に見当たりません。元になるファイルをご提供いただけますか？`,
        analysis: `${names} について、ほかのファイルから流れ込む数式も、値の一致も見つかりませんでした。`
          + '別フォルダのファイルを参照している、リンクが切れている、または基幹システムの画面から直接貼っていらっしゃる、といった可能性があります。',
        ask: ['これらの数値は、どこから持ってきていらっしゃいますか（別の Excel ／ 基幹システム ／ 手入力）',
              '元になるファイルがあれば、そちらもご提供いただけますでしょうか'],
      });
    }
  }

  // (3) どの表ともつながらない表: まとめて1問
  // 最終帳票と指定された表は上の (2b) で扱うので、役割昇格により自然にここから外れる。
  // 受け渡しを伺っているファイルの表も外す — 出所はもう教えていただいており、それでも
  // つながりが見つからないことは 02 で「根拠なし」として示している。ここで聞き直さない。
  const orphans = regions.filter(r => roles.get(r.id) === '独立' && r.dataRowCount >= 3
    && !declaredFiles.has(r.file));
  if (orphans.length > 0) {
    const names = orphans.slice(0, 4).map(r => `「${fullName(r.id)}」`).join('、')
      + (orphans.length > 4 ? ` ほか${orphans.length - 4}表` : '');
    qs.push({
      priority: 'mid', kind: '出所不明の表',
      title: `${names} は、他のどの表ともつながりが見つかりませんでした。出所をご教示ください。`,
      analysis: '受領データ内のどの表とも、数式・値の一致が見つかりませんでした。別ファイル・別システム由来の可能性があります。',
      ask: '元データの所在（別Excel／基幹システム／手入力）と、現役で使われている表かどうかをご教示ください。',
    });
  }

  // (4) 大きい表なのにキーが特定できない: まとめて1問
  // 「1行を決める列が分からない表」。照合列（join）しか無い表もここに含める —
  // 数式が条件に使っている列は分かっても、1行の単位が決まらなければ移行時に困るのは同じ。
  const noKey = regions.filter(r => r.dataRowCount >= 20 && !r.keys?.grain
    && !(r.keys?.keys ?? []).some(k => k.role !== 'join'));
  if (noKey.length > 0) {
    // 1シートが複数の表に割れていると同じシート名が何度も並ぶので、シート単位でまとめる。
    // どのシートに多いかは「どこか」の欄へ出す（設問の見出しに全部詰めると読めない）。
    const bySheet = new Map<string, { file: string; sheet: string; n: number }>();
    for (const r of noKey) {
      const k = `${r.file} ${r.sheet}`;
      const g = bySheet.get(k) ?? { file: r.file, sheet: r.sheet, n: 0 };
      g.n++;
      bySheet.set(k, g);
    }
    const sheets = [...bySheet.values()].sort((a, b) => b.n - a.n);
    const names = sheets.slice(0, 3).map(s => `「${fileNameOf(s.file)} › ${s.sheet}」`).join('、')
      + (sheets.length > 3 ? ` ほか${sheets.length - 3}シート` : '');
    qs.push({
      priority: 'mid', kind: 'キーの確認',
      title: `${names} は、行を1つに決められる列（キー）が見当たりませんでした。何を目印にすればよいか、ご教示いただけますでしょうか。`,
      analysis: `重複のない列も、数式が突合に使っている列も見当たりませんでした（${sheets.length} シート・${noKey.length} 表）。`
        + '行の並びそのものは読み取れる表もございますが、行を一意に決められる列がないため、'
        + 'このまま kpiee に取り込むと同じ行が重なってしまいます。',
      detail: sheets.length > 1
        ? sheets.slice(0, 6).map(s => `${fileNameOf(s.file)} › ${s.sheet}${s.n > 1 ? `（${s.n} 表）` : ''}`)
          .concat(sheets.length > 6 ? [`ほか ${sheets.length - 6} シート`] : [])
        : undefined,
      ask: ['科目コードや伝票番号のように、行を一意に決められる列をご教示いただけますでしょうか。',
            '小計の行と明細の行が同じ表に並んでいる場合は、どれが小計かもあわせてお聞かせください。'],
    });
  }

  // (5) 運用の確認（固定）
  qs.push({
    priority: 'mid', kind: '運用の確認',
    title: '毎月の更新について、お聞かせいただけますでしょうか。',
    ask: ['各ファイルはどのくらいの頻度で、どなたが更新されていますか。',
          '今回いただいたもののほかに、報告や集計に使っていらっしゃるファイルはありますか。',
          '現在は使われていないシートがあれば、あわせてお聞かせください。'],
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
/**
 * ノード（表）のラベル文字サイズ。読み合わせでは投影・印刷した図をその場で指しながら話すので、
 * シート名が読めない大きさでは図の意味が無い。操作版 CSS の .node .lbl とそろえること。
 */
const NODE_LABEL_PX = 13.5;
const MAX_NODES = 28, MAX_EDGES = 60;

/** 表の役割 → 円の色。操作版 CSS（.relgraph-stage.lightmode の --c-*）と同じ値 */
const ROLE_FILL: Record<Role, string> = {
  '元データ': '#1E9E6A',
  'マスタ': '#1F5FAE',
  '中間集計': '#7B5EA7',
  '最終アウトプット': '#C0392B',
  '独立': '#9AA7B4',
};

// インタラクティブ・グラフ（Obsidian 風 force graph）へ渡すデータ。静的SVGと同じ kept 集合から作る。
// items: この表の列（項目）ごとの計算。売上・費用のような指標が「どの表の何から、どう作られるか」を
// 右パネルで読めるようにするための素。to がこの表の列である辺を列ごとにまとめたもの。
interface GItem { col: string; how: string; formula: string; from: string[] }
// file/kind: 呼び名だけでは「どのファイルの、シートなのか表なのか」が分からない。
// how: 「どこから、どんな処理で作られているか」の一文。パネルを開いて最初に読む場所に置く。
interface GNode {
  id: string; label: string; sub: string; role: string; deg: number; x: number; y: number;
  file?: string; kind?: string; how?: string; items?: GItem[];
}
interface GLink { s: string; t: string; color: string; dashed: boolean; label: string; qid?: string; count: number }
interface GraphData { nodes: GNode[]; links: GLink[]; w: number; h: number }
interface MapResult { svg: string; omittedNodes: number; omittedEdges: number; data: GraphData }

/**
 * 表どうしの関係図（ノード形式）。静的SVGと操作版の両方をこの1か所から作る。
 * uid は同一ページに複数の SVG が並ぶための識別子（矢印マーカーの id が衝突すると
 * 後から定義されたものに全部の矢印が引きずられ、色が全て同じになる）。
 */
/**
 * 表の列（項目）ごとの計算を、辺（列レベル）から組み立てる。
 * to がその表の列である辺を列名でまとめ、「売上 ← 集計 ← 元データ.売上」のように示す。
 * 右パネルで指標の作られ方を読ませるための素。表示は表あたり上位数件に絞る。
 */
const ITEMS_PER_NODE = 14;   // 1表あたり出す項目数の上限（横持ち帳票は列が数百になる）
const SOURCES_PER_ITEM = 4;  // 1項目あたり出す元の表の数
const SRC_KEEP = 24;         // まとめる前に保持する「表・列」の数
const COLS_PER_SRC = 6;      // 1つの表について並べる列名の数

/**
 * 元を表ごとにまとめて1行にする。列単位の辺をそのまま並べると、
 * 同じ表の長い呼び名が列の数だけ繰り返されて読めなくなる。
 * 自分自身が元のとき（同じ表の中での計算）は、呼び名を出さず「この表の」と書く。
 */
function foldSources(src: { label: string; col: string }[], own: string): string[] {
  const order: string[] = [];
  const byLabel = new Map<string, string[]>();
  for (const s of src) {
    let cols = byLabel.get(s.label);
    if (!cols) { cols = []; byLabel.set(s.label, cols); order.push(s.label); }
    cols.push(s.col);
  }
  return order.slice(0, SOURCES_PER_ITEM).map(label => {
    const cols = byLabel.get(label)!;
    const txt = cols.slice(0, COLS_PER_SRC).join('・')
      + (cols.length > COLS_PER_SRC ? `ほか${cols.length - COLS_PER_SRC}` : '');
    return label === own ? `この表の ${txt}` : `${label} の ${txt}`;
  });
}
function buildColumnItems(
  edges: Edge[], keptIds: Set<string>, labels: Map<string, string>, regions: Region[],
): Map<string, GItem[]> {
  const byId = new Map(regions.map(r => [r.id, r]));
  const regionOf = (k: string) => k.slice(0, k.lastIndexOf(':'));
  const colOf = (k: string) => k.slice(k.lastIndexOf(':') + 1);
  // regionId → (colName → 項目)。同じ列に複数の辺が来たら元を足していく。
  // 元は「表・列」で持っておき、表示のときに表ごとにまとめる（同じ表の名前を4回並べない）
  const byRegion = new Map<string, Map<string, GItem & { _w: number; _src: { label: string; col: string }[] }>>();
  for (const e of edges) {
    const rid = regionOf(e.to);
    if (!keptIds.has(rid)) continue;
    const col = prettyColumn(byId.get(rid), colOf(e.to));
    const srcRid = regionOf(e.from);
    const srcLabel = labels.get(srcRid) ?? srcRid;
    const srcCol = prettyColumn(byId.get(srcRid), colOf(e.from));
    const g = groupOf(e.type);
    let cols = byRegion.get(rid);
    if (!cols) { cols = new Map(); byRegion.set(rid, cols); }
    let it = cols.get(col);
    if (!it) {
      it = {
        col, how: GROUP_META[g].label.split('（')[0],
        // filter-key はキー結合なので数式そのものより「参照」の説明が要点。evidence は代表を1つ
        formula: shortText(e.evidence, 90),
        from: [], _w: 0, _src: [],
      };
      cols.set(col, it);
    }
    if (it._src.length < SRC_KEEP && !it._src.some(s => s.label === srcLabel && s.col === srcCol)) {
      it._src.push({ label: srcLabel, col: srcCol });
    }
    // データフローの辺（集計・転記・参照）を、キー(filter-key)より優先して代表にする
    it._w += g === 'ref' ? 1 : 3;
  }
  const out = new Map<string, GItem[]>();
  for (const [rid, cols] of byRegion) {
    const own = labels.get(rid) ?? rid;
    const items = [...cols.values()]
      .sort((a, b) => b._w - a._w || b._src.length - a._src.length)
      .slice(0, ITEMS_PER_NODE)
      .map(({ _w, _src, ...it }) => ({ ...it, from: foldSources(_src, own) }));
    if (items.length > 0) out.set(rid, items);
  }
  return out;
}

function buildMap(
  uid: string,
  regions: Region[], pairs: PairAgg[], labels: Map<string, string>,
  copyQuestionByPair: Map<string, string>, roles: Map<string, Role>,
  edges: Edge[] = [], pairKeys: Map<string, string> = new Map(),
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
  // 貼り付け元として結んだ表（declaredOnly）は関係の本数が 0 なので、重み順に切ると必ず落ちる。
  // 落ちると本文だけが「◯シートの入手元を点線で結んでいます」と言って図に線が無い状態になるため、
  // 最終アウトプットの次に優先して残す。
  const declaredEnds = new Set(pairs.filter(p => p.declaredOnly).flatMap(p => [p.from, p.to]));
  const kept = connected
    .slice()
    // 同じ重みなら最終アウトプットを優先して残す（上限で切られて消えないように）
    // 点線の両端を最優先で確保する。最終アウトプットの表が上限いっぱいまである帳票
    //（1シートが何十もの表に割れているブック）では、これを後ろにすると点線が1本も残らない。
    .sort((a, b) => (Number(declaredEnds.has(b.id)) - Number(declaredEnds.has(a.id)))
      || (Number(isOut(b)) - Number(isOut(a)))
      || (weight.get(b.id) ?? 0) - (weight.get(a.id) ?? 0))
    .slice(0, MAX_NODES);
  const keptIds = new Set(kept.map(r => r.id));
  // 上限で切るときは「貼り付け元の点線」を先に確保し、次に関係の本数が多い順。
  // 配列の順のまま切ると、後ろへ足した点線が真っ先に落ちて、本文だけが線の存在を語る形になる。
  const drawPairs = pairs
    .filter(p => keptIds.has(p.from) && keptIds.has(p.to))
    .sort((a, b) => (Number(!!b.declaredOnly) - Number(!!a.declaredOnly)) || b.total - a.total)
    .slice(0, MAX_EDGES);
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

  // ラベルの文字サイズと横幅は段ごとに決める。以前は段の混み具合に関わらず 11px・固定幅で
  // 切っていたため、表が数個しかない段でもシート名が小さく短く切られていた（読み合わせで
  // 図を指しながら話せない）。空いている段は大きく・幅いっぱいまで、混んだ段は隣と重ならない
  // ところまで縮める。
  const pos = new Map<string, { x: number; y: number; r: number; labelW: number; labelPx: number }>();
  for (const [l, row] of byLayer) {
    const y = MAP_PAD + ((maxLayer - l) / (maxLayer || 1)) * (MAP_H - 2 * MAP_PAD - 40) + 20;
    const gap = Math.min(LAYER_GAP_MAX, (MAP_W - 2 * MAP_PAD) / Math.max(1, row.length));
    const solo = row.length === 1;  // 隣がいないので図の幅いっぱいまで使ってよい
    const labelPx = solo || gap >= 170 ? NODE_LABEL_PX : gap >= 130 ? 12.5 : 11.5;
    const labelW = Math.max(140, (solo ? MAP_W - 2 * MAP_PAD : gap) - 10);
    const x0 = MAP_W / 2 - (gap * (row.length - 1)) / 2;
    row.forEach((r, i) => {
      const isOut = (roles.get(r.id) ?? '') === '最終アウトプット';
      let rad = R_BASE + R_SPAN * Math.sqrt(degOf(r.id) / maxDeg);
      if (isOut) rad = Math.max(rad, R_OUT_MIN);
      pos.set(r.id, { x: x0 + i * gap, y, r: Math.round(rad * 10) / 10, labelW, labelPx });
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
  // 数式の根拠が無い線（貼り付け元の推定）は、色と線種で確定した関係と分ける
  parts.push(`<marker id="arr-${uid}-declared" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="${DECLARED_ONLY.color}" fill-opacity="0.85"/></marker>`);
  parts.push('</defs>');
  // 背景の点（操作版 lightmode の dotted background と同じ見え方にする）
  parts.push(`<rect x="0" y="0" width="${MAP_W}" height="${MAP_H}" fill="#FCFDFE"/>`);
  parts.push(`<pattern id="dot-${uid}" width="22" height="22" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="#E4EBF3"/></pattern>`);
  parts.push(`<rect x="0" y="0" width="${MAP_W}" height="${MAP_H}" fill="url(#dot-${uid})"/>`);

  // 辺（ノードより先に描いて下に敷く）
  const edgeLabels: string[] = [];
  for (const p of drawPairs) {
    const a = pos.get(p.from)!; const b = pos.get(p.to)!;
    const dec = p.declaredOnly === true;
    const g = dominantGroup(p);
    const meta = dec
      ? { label: p.declaredLabel ?? '伺った内容', color: DECLARED_ONLY.color, dashed: true }
      : GROUP_META[g];
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
    const dash = dec ? ' stroke-dasharray="2 5"' : meta.dashed ? ' stroke-dasharray="6 5"' : '';
    parts.push(`<path d="M${sx.toFixed(1)},${sy.toFixed(1)} Q${mx.toFixed(1)},${my.toFixed(1)} ${ex.toFixed(1)},${ey.toFixed(1)}" fill="none" stroke="${meta.color}" stroke-width="1.3" stroke-opacity="0.5"${dash} marker-end="url(#arr-${uid}-${dec ? 'declared' : g})"/>`);
    const qid = g === 'copy' ? copyQuestionByPair.get(`${p.from}\u0000${p.to}`) : undefined;
    // 貼り付け元の線は、本数が多くてもラベルを必ず出す（何を根拠に結んだ線かが要点なので）
    if (showEdgeLabels || qid || dec) {
      const text = qid ? `手修正推定 → ${qid}`
        : dec ? meta.label
        : `${meta.label.split('（')[0]}${p.total > 1 ? ` ×${p.total}` : ''}`;
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
      edgeLabels.push(`<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" font-size="11.5" fill="${meta.color}" text-anchor="${anchor}"${qid ? ' font-weight="bold"' : ''} style="paint-order:stroke;stroke:#FCFDFE;stroke-width:3.5px">${esc(text)}</text>`);
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
      // 呼び名は「シート名＋軸の説明」で長い。1行に押し込むと途中で切れて、図の上で
      // どの表なのか分からなくなるため3行まで折り返す（段の間隔は 200px 前後あり、
      // 円の半径が最大 26px なので3行でも下の段には届かない）
      + `<text x="${p.x.toFixed(1)}" y="${(p.y + p.r + 15).toFixed(1)}" font-size="${p.labelPx}" font-weight="${isOut ? 800 : 600}" fill="#0E2A47" text-anchor="middle" style="paint-order:stroke;stroke:#FCFDFE;stroke-width:3.6px">`
      + wrapText((isOut ? '★ ' : '') + label, p.labelW, p.labelPx, 3)
        .map((ln, i) => `<tspan x="${p.x.toFixed(1)}" dy="${i === 0 ? 0 : p.labelPx + 2}">${esc(ln)}</tspan>`).join('')
      + '</text>'
      + '</g>');
  }
  parts.push(...edgeLabels);
  parts.push('</svg>');

  // 列（項目）ごとの計算を集める。to がこの表の列である辺を列名でまとめ、
  // 「売上 ← （集計）← 元データ.売上」のように右パネルで読めるようにする。
  const itemsByRegion = buildColumnItems(edges, keptIds, labels, regions);

  // 操作版へ渡すデータ。初期座標は上の階層配置をそのまま種にする（同じ図から始まる）
  // 「シート」か、1シートの中に複数ある「表」か。呼び名がシート名なので区別が要る
  const perSheet = new Map<string, number>();
  for (const r of regions) {
    const k = `${r.file} ${r.sheet}`;
    perSheet.set(k, (perSheet.get(k) ?? 0) + 1);
  }
  // 「どこから、どんな処理で作られているか」の一文。パネルの先頭に置く
  const howOf = (id: string): string => {
    const ins = drawPairs.filter(p => p.to === id);
    if (ins.length === 0) return 'ほかの表から流れ込む関係は見つかっていません。ここが起点のデータです。';
    // 貼り付け元だけが根拠のシートは、「何から作られたか」ではなく「どのファイルを貼ったか」を出す。
    // ここで通常の文面を出すと、数式で作られた表と見分けが付かなくなる。
    const declaredIns = ins.filter(p => p.declaredOnly);
    if (declaredIns.length === ins.length) {
      return `${declaredIns.map(p => p.declaredNote ?? '').filter(Boolean).join(' ')}`.trim()
        || 'この表そのものの数式は残っておらず、受領ファイルからの貼り付けと見ております。';
    }
    // 数式で確定している流入だけで文を作る（貼り付け推定を混ぜると根拠の質が混ざる）
    const real = ins.filter(p => !p.declaredOnly);
    // 同じ表から複数の辺が来ることがある。呼び名が同じものは1回にまとめる
    const allSrcs = [...new Set(real.map(p => labels.get(p.from) ?? p.from))];
    const srcs = allSrcs.slice(0, 4);
    const more = allSrcs.length > 4 ? ` ほか${allSrcs.length - 4}表` : '';
    const keys = [...new Set(real.map(p => prettyKey(pairKeys.get(regionPairKey(p.from, p.to)) ?? '').text)
      .filter(Boolean))].slice(0, 2);
    const proc = GROUP_META[dominantGroup(real[0])].label;
    const paste = declaredIns.map(p => p.declaredNote ?? '').filter(Boolean).join(' ');
    const head = keys.length > 0
      ? `${srcs.join('と')}${more}を「${keys.join('・')}」で突き合わせて作られています。処理は${proc}です。`
      : `${srcs.join('と')}${more}から作られています。処理は${proc}です。`;
    return paste === '' ? head : `${head} ${paste}`;
  };
  const gnodes: GNode[] = kept.map(r => {
    const p = pos.get(r.id)!;
    const key = keySummaryShort(r);
    // 呼び名から番地が消えたので、現物を Excel で開けるよう副題に位置を戻す
    // （1シートが1表なら、シート名だけで開けるので出さない）
    const loc = (perSheet.get(`${r.file} ${r.sheet}`) ?? 1) > 1 ? '・' + rangeOf(r) : '';
    return {
      id: r.id,
      label: labels.get(r.id) ?? r.sheet,
      sub: `${r.dataRowCount.toLocaleString()}行${loc}` + (key === '' ? '' : ` ／ ${key}`),
      role: roles.get(r.id) ?? '',
      deg: weight.get(r.id) ?? 1,
      x: p.x, y: p.y,
      file: r.file,
      kind: (perSheet.get(`${r.file} ${r.sheet}`) ?? 1) > 1 ? `${r.sheet} シートの中の表` : 'シート',
      how: howOf(r.id),
      items: itemsByRegion.get(r.id),
    };
  });
  const glinks: GLink[] = drawPairs.map(p => {
    const g = dominantGroup(p);
    if (p.declaredOnly) {
      return {
        s: p.from, t: p.to, color: DECLARED_ONLY.color, dashed: true,
        label: p.declaredLabel ?? '伺った内容', count: 0,
      };
    }
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

/**
 * ファイル名の先頭に付いた通し番号（①②… / 1_ 2_ …）を並び順として読む。
 * 「①②③…」と番号を振って受け渡しされている案件では、その番号が担当者の頭の中の順番であり、
 * 行数順に並べ替えると読み合わせのときに探せなくなる。番号が無いファイルは後ろ（行数順）へ。
 */
const CIRCLED_1 = 0x2460;  // ① … ⑳ (U+2460〜U+2473)
function fileOrderNo(filename: string): number {
  const c = filename.codePointAt(0) ?? 0;
  if (c >= CIRCLED_1 && c <= CIRCLED_1 + 19) return c - CIRCLED_1 + 1;
  const m = /^(\d{1,2})[_\-. 　]/.exec(filename);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
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

/**
 * ラベルを幅に合わせて最大 lines 行へ折る。表の呼び名は「シート名＋軸の説明」で長いため、
 * 1行に押し込むと途中で切れて、どの表なのか読めなくなる。
 * 区切りとして自然な位置（空白・「×」・「・」の後ろ）を優先して折る。
 */
function wrapText(s: string, maxPx: number, fontPx: number, lines: number): string[] {
  const wide = (ch: string) => (/[\x00-\xff｡-ﾟ]/.test(ch) ? fontPx * 0.6 : fontPx);
  const chars = [...s];
  const out: string[] = [];
  let i = 0;
  while (i < chars.length && out.length < lines) {
    const last = out.length === lines - 1;
    let acc = 0, end = i, breakAt = -1;
    while (end < chars.length) {
      const cw = wide(chars[end]);
      // 最終行は「…」の分を空けておく（切れていることが分かるように）
      if (acc + cw > maxPx - (last && end < chars.length - 1 ? fontPx : 0)) break;
      acc += cw; end++;
      if (/[ 　×・、]/.test(chars[end - 1])) breakAt = end;
    }
    if (end >= chars.length) { out.push(chars.slice(i, end).join('').trim()); i = end; break; }
    if (last) { out.push(chars.slice(i, end).join('').trim() + '…'); i = chars.length; break; }
    const cut = breakAt > i ? breakAt : end;
    out.push(chars.slice(i, cut).join('').trim());
    i = cut;
  }
  return out.filter(x => x !== '');
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

// ロジックブロックの一文の述語。GROUP_META のラベルをそのまま「〜しています」に繋ぐと、
// copy が「シートが…から手修正推定しております」となり、推定しているのは解析側なのに
// シートが主語になってしまう。種別ごとに述語を持たせる。
const BLOCK_PREDICATE: Record<Group, string> = {
  ref: '値を参照しています。',
  agg: '集計しています。',
  move: '転記・計算しています。',
  copy: '手作業でコピーされているとみられます。',
};
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
  //「値完全一致(66件, 手修正の可能性)」の括弧を数式と誤認する。
  if (b.group === 'copy' || !f) {
    // 数式ではなく値の一致から推定した区間（コピペ・貼り付け）
    return howNote('<b>この区間は数式ではなく、値のコピーで運ばれています。</b>'
      + 'Excel 上に計算の根拠が残らないため、どの列がどの列になるのかを自動では確定できません'
      + `（値が一致していることから ${b.total.toLocaleString()} 本のつながりを推定しております）。`
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

  // 表の呼び名は「シート名＋軸の説明」で長い。2行必要な表が1つでもあれば見出し帯を高くする
  //（ノードごとに帯の高さが違うと、並んだ箱の中身の位置がそろわず読みにくい）
  const titleOf = (r: Region) => labels.get(r.id) ?? r.sheet;
  const titleLines = (r: Region) => wrapText(titleOf(r), ER.W - 24, 12.5, 2);
  const headH = layersSorted.some(([, regs]) => regs.some(r => titleLines(r).length > 1))
    ? ER.HEAD + 16 : ER.HEAD;

  const heightOf = (r: Region) => headH + keysOf(r).length * ER.ROW + 6;
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
        const cy = y + headH + i * ER.ROW + ER.ROW / 2;
        const key = `${r.id}:${k.column}`;
        rowY.set(key, cy);
        return { cy, mark: k.role === 'primary' ? '🔑' : '◇', label: k.column, primary: k.role === 'primary', connected: connectedKeys.has(key) };
      });
      nodes.push({ id: r.id, x: ER.PAD + l * (ER.W + ER.GX), y, w: ER.W, h: heightOf(r), title: titleOf(r), rows });
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
    const ya = rowY.get(p.a) ?? na.y + headH / 2;
    const yb = rowY.get(p.b) ?? nb.y + headH / 2;
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
    parts.push(`<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${headH}" rx="9" fill="#0E2A47"/>`);
    parts.push(`<rect x="${n.x}" y="${n.y + headH - 9}" width="${n.w}" height="9" fill="#0E2A47"/>`);
    parts.push(`<text x="${n.x + 12}" y="${n.y + 20}" font-size="12.5" font-weight="700" fill="#fff">`
      + wrapText(n.title, n.w - 24, 12.5, headH > ER.HEAD ? 2 : 1)
        .map((ln, i) => `<tspan x="${n.x + 12}" dy="${i === 0 ? 0 : 15}">${esc(ln)}</tspan>`).join('')
      + `</text>`);
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
// マスタは元データと分ける。両方とも「上流にファイルが無い」ので自動判定では区別できないが、
// 読み手にとっては別物で、kpiee 上の扱いも違う（明細は取り込み、マスタは変換表として持つ）。
// 取込時に人が全シートを「マスタ」と指定したファイルだけをマスタと呼ぶ（推定はしない）。
type FileRole = '元データ' | 'マスタ' | '中間ファイル' | '最終アウトプット' | '独立';

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
    input_data: '元データ',
    master_data: 'マスタ',
    working_sheet: '中間集計',
  };
  for (const r of regions) {
    const declaredRole = declaredOut.roleOfSheet(r.file, r.sheet);
    if (declaredRole === 'final_output') { roles.set(r.id, '最終アウトプット'); continue; }
    const mapped = declaredRole ? BY_DECLARED[declaredRole] : undefined;
    if (mapped) {
      // つながりが1本も無い表は「独立」のままにする（確認事項として拾うため）
      if (roles.get(r.id) !== '独立') roles.set(r.id, mapped);
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
    if (roles.get(r.id) === '独立') continue;
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

/**
 * 最終アウトプットのブックの中にある「受領データを貼り付けただけのシート」を、受領ファイルへ結び直す。
 *
 * なぜ要るか:
 *   試算ブックの中には、受領ファイルをそのまま値で貼ったシート（得意先マスタ・SPD収支管理表など）が
 *   同居している。貼り付けなので数式のリンクは残らず、帳票ごとの関係図では
 *   「ここが起点のデータです」としか出ない。読み手からすると、そのマスタがどこから来たのかが
 *   図の中で切れてしまい、「受領ファイルとブックの中身が、どう対応するのか」が読み合わせの
 *   たびに口頭の説明頼みになる。
 *
 * 何を根拠にするか（断定はしない。図でも点線で出す）:
 *   列名の一致 … 貼り付け元と同じ見出しが並んでいること。3列以上かつ少ない側の6割以上で「一致」
 *   お名前の一致 … シート名とファイル名が近いこと（①②の通し番号と拡張子は外して比較）
 *   どちらも取れないシートは結ばない（「入手元が特定できていない」ことがそのまま論点になる）
 */
interface PasteOrigin { file: string; note: string }

/** ①②… の通し番号・拡張子・空白を落として、シート名とファイル名を同じ土俵で比べる */
const normNameForMatch = (s: string): string =>
  s.replace(/\.[A-Za-z0-9]+$/, '')
    .replace(/^[①-⑳0-9]+[_\-.\s]*/, '')
    .replace(/[\s　_\-]/g, '')
    .toLowerCase();

/** 2文字ずつの重なり（Dice 係数）。表記ゆれのある日本語名どうしの近さを見るのに使う */
function nameCloseness(a: string, b: string): number {
  if (a === '' || b === '') return 0;
  if (a === b) return 1;
  const gram = (s: string): Set<string> => {
    const out = new Set<string>();
    for (let i = 0; i + 1 < s.length; i++) out.add(s.slice(i, i + 2));
    return out;
  };
  const ga = gram(a); const gb = gram(b);
  if (ga.size === 0 || gb.size === 0) return 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  return (2 * inter) / (ga.size + gb.size);
}

/** 1つの帳票につき図へ足す貼り付け元の上限。これを超えると図が「点線の束」になって読めない */
const PASTE_PER_OUTPUT = 6;

function buildPasteOrigins(
  regions: Region[], pairs: PairAgg[], outputFiles: Set<string>, stats: Map<string, FileStat>,
  declaredRels: DeclaredFileRel[], roles: Map<string, Role>,
): Map<string, PasteOrigin> {
  const fileOf = new Map(regions.map(r => [r.id, r.file]));
  const hasIn = new Set(pairs.map(p => p.to));
  const crossFileIn = new Set(pairs.filter(p => fileOf.get(p.from) !== fileOf.get(p.to)).map(p => p.to));
  // 流入の本数。「帳票本体はどれか」を選ぶときの手掛かりに使う
  const inDeg = new Map<string, number>();
  for (const p of pairs) inDeg.set(p.to, (inDeg.get(p.to) ?? 0) + p.total);
  // 断片のような小さい表は候補にしない。列名がいくつか合っただけで結ぶと、
  // 同じ様式のシートが何十枚も並ぶブックでは総当たりの点線になってしまう。
  const outside = regions.filter(r => !outputFiles.has(r.file) && r.dataRowCount >= 5);
  const nameOf = (label: string) => stats.get(label)?.filename ?? label;
  // 候補は (受け側の表) 単位で持ち、あとで「元ファイルごとに最良の1件」「帳票ごとに上限」で絞る
  const cand: { to: string; toFile: string; from: string; origin: PasteOrigin; score: number }[] = [];
  for (const r of regions) {
    // 対象は「最終アウトプットのブックの中で、ほかのファイルから流れ込んでいない表」。
    // 同じブックの中だけで計算されている表も対象に含める — 受領データを貼り付けたうえで
    // 列を足しているシート（プロ得意先別実績など）や、土台を貼ってから計算している帳票本体が
    // ここに当たり、そこを外すと肝心の「この数値はどのファイルから来たのか」が抜ける。
    if (!outputFiles.has(r.file)) continue;
    if (crossFileIn.has(r.id)) continue;
    // ブックの中で計算されている表は、お名前の近さだけでは結ばない（列の一致を必須にする）
    const needStrong = hasIn.has(r.id);
    const mine = new Set(r.columns.map(c => c.name.trim()).filter(n => n !== ''));
    let best: { file: string; sheet: string; inter: number; strong: boolean; close: number; score: number } | null = null;
    for (const s of outside) {
      const theirs = new Set(s.columns.map(c => c.name.trim()).filter(n => n !== ''));
      let inter = 0;
      for (const n of mine) if (theirs.has(n)) inter++;
      const min = Math.min(mine.size, theirs.size);
      // 行数が桁違いなら、同じ列名が並んでいても貼り付け元とは考えにくい（別の粒度の表）
      const ratio = r.dataRowCount > 0 && s.dataRowCount > 0
        ? Math.max(r.dataRowCount, s.dataRowCount) / Math.min(r.dataRowCount, s.dataRowCount) : 99;
      // 一致列は4列以上・少ない側の6割以上。7割まで上げると、貼り付け後に列を足している
      // シート（元の13列のうち4列だけが残る等）が落ちて、別ファイルに取り違えられた。
      const strong = inter >= 4 && min > 0 && inter / min >= 0.6 && ratio <= 2.5;
      const ns = normNameForMatch(r.sheet); const nf = normNameForMatch(nameOf(s.file));
      const close = nameCloseness(ns, nf);
      // シート名がファイル名の中にそのまま入っている（サマリーの「③仮予算」シート ↔ ③仮予算….xlsx）
      // なら、名前のほうが列の一致より確かな手がかり。同じ様式のシートが何枚も並ぶブックでは
      // 列だけでは見分けがつかず、列で選ぶと別のファイルへ取り違える。
      const named = ns.length >= 2 && (nf.includes(ns) || ns.includes(nf));
      const nameOk = named || close >= 0.5;
      // ブックの中で計算されているシートは、列が合っただけでは結ばない。
      // 4本グラフのように「売上・仕入・変動費…」という一般的な列名が並ぶ表は、
      // 予算ブックの拠点シートとも一致してしまい、無関係なファイルへ線が伸びる。
      if (needStrong && !(strong && nameOk)) continue;
      if (!needStrong && !strong && !nameOk) continue;
      const score = (named ? 200 : 0) + (strong ? 100 : 0) + inter + close * 10;
      if (!best || score > best.score) best = { file: s.file, sheet: s.sheet, inter, strong, close, score };
    }
    if (!best) continue;
    cand.push({
      to: r.id, toFile: r.file, from: best.file, score: best.score,
      origin: {
        file: best.file,
        note: best.strong
          ? `${nameOf(best.file)}（${best.sheet}）と列の見出しが ${best.inter} 件一致します。${best.score >= 200 ? 'シート名も一致しており、' : ''}これを貼り付けたものと見ております。`
          : `シート名が ${nameOf(best.file)} と一致します。これを貼り付けたものと見ております（列の見出しの一致は確認できませんでした）。`,
      },
    });
  }

  // 「元ファイルごとに、いちばん根拠の強い受け側1件」だけを残す。
  // 同じ様式のシートが何十枚も並ぶブックでは、1つの元ファイルが何十枚とも一致してしまい、
  // 図が点線の束になって「どこから来たのか」がかえって読めなくなる。
  const found = new Map<string, PasteOrigin>();
  const bestPerSource = new Map<string, typeof cand[number]>();
  for (const c of cand) {
    const k = `${c.toFile} ${c.from}`;
    const cur = bestPerSource.get(k);
    if (!cur || c.score > cur.score) bestPerSource.set(k, c);
  }
  // 帳票ごとに上限件数まで（根拠の強い順）
  const perOutput = new Map<string, number>();
  for (const c of [...bestPerSource.values()].sort((a, b) => b.score - a.score)) {
    // 同じ表を複数の元ファイルが指したときは、根拠の強い方だけを採る。
    // ここで弾かないと後から来たほうで上書きされ、先に決まっていた対応が黙って消える
    // （④プロ得意先別実績 との対応が ① に奪われる、という取り違えが実際に起きた）。
    if (found.has(c.to)) continue;
    const n = perOutput.get(c.toFile) ?? 0;
    if (n >= PASTE_PER_OUTPUT) continue;
    perOutput.set(c.toFile, n + 1);
    found.set(c.to, c.origin);
  }

  // 伺ったブック関係が「帳票そのもの」へ向かっている場合は、列の一致が取れていなくても
  // 土台として結ぶ。これは推測ではなく伺った内容そのもので、しかも読み手がいちばん知りたい
  // 「この帳票の数値はどのファイルから来たのか」に直接あたる。
  for (const d of declaredRels) {
    if (!outputFiles.has(d.toFile) || outputFiles.has(d.fromFile)) continue;
    // 同じ元ファイルを二重に結ばないのは「この帳票の中で」の話。帳票ごとに数える。
    // 全体で1回にすると、2つの帳票が同じファイルを元にしている案件で片方から線が消える。
    const already = [...found.entries()].some(([rid, o]) => o.file === d.fromFile && fileOf.get(rid) === d.toFile);
    if (already) continue;
    if ((perOutput.get(d.toFile) ?? 0) >= PASTE_PER_OUTPUT) continue;
    // 結ぶ先は「その帳票のいちばん大きい表」1つだけ。帳票が複数の表に分かれているブックで
    // 全部に結ぶと、1本の受け渡しが何十本もの点線に見えてしまう。
    // 結び先は、名前が元ファイルと対応するシート（サマリーの「⑭実績」など）を優先し、
    // 無ければその帳票のいちばん大きい表にする
    const nf = normNameForMatch(nameOf(d.fromFile));
    const finals = regions.filter(t => t.file === d.toFile && roles.get(t.id) === '最終アウトプット');
    const namedHit = finals.some(t => {
      const nt = normNameForMatch(t.sheet);
      return nt.length >= 2 && nf.includes(nt);
    });
    // 帳票が何枚もあるブックで、名前の手掛かりも無いまま「どれか1枚」へ結ぶと、
    // 無関係なシート（利益乖離率など）へ線が伸びて誤読を生む。そういう時は結ばない
    //（受け渡し自体は 2-2 の一覧に文章で残る）。
    if (!namedHit && new Set(finals.map(t => t.sheet)).size > 2) continue;
    const target = finals
      .filter(t => !found.has(t.id))
      .sort((a, b) => {
        const na = normNameForMatch(a.sheet); const nb = normNameForMatch(b.sheet);
        const ha = na.length >= 2 && nf.includes(na) ? 1 : 0;
        const hb = nb.length >= 2 && nf.includes(nb) ? 1 : 0;
        // 名前が合わないときは「いちばん多くの表から集めている表」＝帳票本体へ結ぶ。
        // 行数だけで選ぶと、脇に置かれたグラフ用のシートへ線が伸びてしまう。
        return (hb - ha) || ((inDeg.get(b.id) ?? 0) - (inDeg.get(a.id) ?? 0))
          || (b.dataRowCount - a.dataRowCount);
      })[0];
    if (!target) continue;
    perOutput.set(d.toFile, (perOutput.get(d.toFile) ?? 0) + 1);
    found.set(target.id, {
      file: d.fromFile,
      note: `${nameOf(d.fromFile)} を土台として貼り付けたものと伺っています（Excel 上に数式は残っていません）。`,
    });
  }
  return found;
}

// ============================================================
// 03 の帳票ごとに並べるブロック（spec.outputPlans）
// ============================================================

// 確認欄の記号。04 の設問（Q-01..）と混ざらないよう、こちらは節番号＋英字にする
const CHECK_MARKS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

/** 差し込み位置で受け取る自動生成分。ブロック指定が無い帳票では従来の順（レシピ→関係図）で出す */
interface AutoBlocks { recipes: string; graph: string }

/**
 * 伺った作り方の流れ図。左＝読んでいるタブ、中＝突き合わせるもの、右＝でき上がる段階。
 * 数式から起こすレシピ図（renderRecipeSvg）と違い、こちらは「ご説明どおりに描くとこうなります」の図で、
 * 貼り付けで受け渡していて数式が残らない箇所も描ける。
 * 最後の段は最終アウトプットなので赤で示す（表紙のタイル・関係図の凡例と同じ色）。
 */
function renderFlowSvg(b: Extract<ReportOutputBlock, { kind: 'flow' }>, name: string, uid: string): string {
  const fill = (t: string): string => t.split('{名}').join(name);
  const n = b.sources.length, m = b.stages.length;
  // 左の箱（54px ピッチ）と右の段（74px ピッチ）の、高い方に合わせる
  const H = Math.max(16 + 54 * n + 8, 74 * m + 18);
  const mid = H / 2;
  const arrow = `ar-${uid}`;
  const kw = b.key === '' ? 0 : Math.max(43, Math.round(12.5 * [...b.key].length + 30));
  const defs = `<defs><marker id="${arrow}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">`
    + '<path d="M0,0 L10,5 L0,10 z" fill="#7A8794"/></marker></defs>';
  const sources = b.sources.map((label, i) => {
    const y = 16 + 54 * i;
    const rows = wrapText(fill(label), 268, 12.5, 2);
    const ty = y + (rows.length > 1 ? 19 : 26.5);
    return `<rect x="8" y="${y}" width="300" height="44" rx="9" fill="#fff" stroke="#1F5FAE" stroke-opacity=".5"/>`
      + `<text x="20" y="${ty}" font-size="12.5" fill="#0E2A47">`
      + rows.map((r, j) => `<tspan x="20" dy="${j === 0 ? 0 : 15}">${esc(r)}</tspan>`).join('')
      + '</text>'
      // 「このブックのタブ」の添え書きは箱の右上。タブ名が2行になる箱では文字とぶつかるので置かない
      + (b.sourceNote === '' || rows.length > 1 ? ''
        : `<text x="298" y="${y + 15}" font-size="9.5" fill="#7A8794" text-anchor="end">${esc(b.sourceNote)}</text>`)
      + `<path d="M308,${y + 22} C338,${y + 22} 342,${mid} 366,${mid}" fill="none" stroke="#B9C6D6" stroke-width="1.4"/>`;
  }).join('');
  const key = kw === 0
    ? `<path d="M366,${mid} L626,${mid}" fill="none" stroke="#7A8794" stroke-width="1.6" marker-end="url(#${arrow})"/>`
    : `<text x="${372 + kw / 2}" y="${mid - 24}" font-size="10" fill="#7A8794" text-anchor="middle">突き合わせるもの</text>`
      + `<rect x="372" y="${mid - 16}" width="${kw}" height="32" rx="16" fill="#EAF2FB" stroke="#C9DEF4"/>`
      + `<text x="${372 + kw / 2}" y="${mid + 5}" font-size="12.5" font-weight="700" fill="#1F5FAE" text-anchor="middle">${esc(b.key)}</text>`
      + `<path d="M${372 + kw},${mid} L626,${mid}" fill="none" stroke="#7A8794" stroke-width="1.6" marker-end="url(#${arrow})"/>`;
  const stages = b.stages.map((st, i) => {
    const y = mid - (74 * m - 22) / 2 + 74 * i;
    const last = i === m - 1;
    return (i === 0 ? ''
      : `<path d="M804,${y - 22} L804,${y - 6}" fill="none" stroke="#7A8794" stroke-width="1.6" marker-end="url(#${arrow})"/>`)
      + `<rect x="636" y="${y}" width="336" height="52" rx="9" fill="${last ? '#FBEFEF' : '#F4F8FD'}" stroke="${last ? '#C0392B' : '#C9DEF4'}" stroke-opacity=".7"/>`
      + `<text x="650" y="${y + 22.5}" font-size="12.5" font-weight="700" fill="#0E2A47">${esc(fitText(fill(st.title), 300, 12.5))}</text>`
      + (st.note === '' ? ''
        : `<text x="650" y="${y + 40}" font-size="10.5" fill="#7A8794">${esc(fitText(fill(st.note), 312, 10.5))}</text>`);
  }).join('');
  // 読み上げ用の名前。指標ごとの図なら「売上のでき方」、名前が無い図は最後の段の名前で呼ぶ
  const alt = fill(b.title) || fill(b.stages[b.stages.length - 1]?.title ?? '');
  return `<svg viewBox="0 0 980 ${H}" role="img" aria-label="${esc(alt)}のでき方">`
    + `${defs}${sources}${key}${stages}</svg>`;
}

/**
 * ブロック1つ分の HTML。
 * 本文（箇条書き・導入・注記・表のセル）は担当者が書く文なので <b> をそのまま通す。
 * 見出しとタブ名はエスケープする（受領ファイルの名前がそのまま入る）。
 */
function renderOutputBlock(b: ReportOutputBlock, mark: string, uid: string, auto: AutoBlocks): string {
  switch (b.kind) {
    case 'bullets':
      return (b.title === '' ? '' : `<p class="sub-lede">${esc(b.title)}</p>\n    `)
        + `<ul class="graph-guide">\n      ${b.items.map(i => `<li>${i}</li>`).join('\n      ')}\n    </ul>`
        + b.notes.map(t => `\n    <p class="tbl-note">${t}</p>`).join('');
    case 'table': {
      // 左端のまとめ列は、まとめ名が入っているときだけ出す（無名の表で空の列が空くのを防ぐ）
      const grouped = b.groups.some(g => g.label !== '');
      const rows = b.groups.map(g => g.rows.map((r, i) => {
        const head = !grouped ? ''
          : i === 0
            ? `<td rowspan="${g.rows.length}"><b>${esc(g.label)}</b>${g.note === '' ? '' : `<br><span class="rnote">${g.note}</span>`}</td>`
            : '';
        return `<tr${b.emphasize ? ' class="out"' : ''}>${head}${r.map(c => `<td>${c}</td>`).join('')}</tr>`;
      }).join('\n        ')).join('\n        ');
      return (b.title === '' ? '' : `<p class="sub-lede">${esc(b.title)}</p>\n    `)
        + (b.lede === '' ? '' : `<p class="graph-guide">${b.lede}</p>\n    `)
        + `<div style="overflow-x:auto">
      <table class="ot">
        ${b.head.length === 0 ? '' : `<tr>${b.head.map(h => `<th>${esc(h)}</th>`).join('')}</tr>\n        `}${rows}
      </table>
    </div>`
        + b.notes.map(t => `\n    <p class="tbl-note">${t}</p>`).join('');
    }
    case 'summary':
      return `<div class="summary">
      ${b.title === '' ? '' : `<div class="stitle">${esc(b.title)}</div>`}
      <ul>
        ${b.items.map(i => `<li>${i}</li>`).join('\n        ')}
      </ul>
    </div>`;
    case 'check':
      return `<div class="chk">
      <div class="chk-h">ここをご確認ください　${esc(mark)}</div>
      <p class="chk-q">${b.question}</p>
      ${b.detail.length === 0 ? '' : `<p class="chk-a">${sentences(...b.detail)}</p>`}
      <textarea class="ansbox" id="chk-${uid}" placeholder="この場でご入力いただけます"></textarea>
    </div>`;
    case 'flow': {
      // repeat が入っていれば指標ごとに同じ図を繰り返す（{名} が指標名になる）
      const names = b.repeat.length > 0 ? b.repeat : [''];
      const fill = (t: string, nm: string): string => t.split('{名}').join(nm);
      return (b.lede === '' ? '' : `<p class="sec-lede">${b.lede}</p>\n    `)
        + names.map((nm, i) => `<div class="rcp">
      ${b.title === '' ? '' : `<p class="sub-lede">${esc(fill(b.title, nm))}</p>`}
      ${b.text === '' ? '' : `<p class="rcp-t">${fill(b.text, nm)}</p>`}
      <div class="map-scroll">${renderFlowSvg(b, nm, `${uid}-${i}`)}</div>
      ${b.note === '' ? '' : `<p class="tbl-note">${fill(b.note, nm)}</p>`}
    </div>`).join('\n    ');
    }
    case 'recipes': return auto.recipes;
    case 'graph': return auto.graph;
  }
}

/** 帳票（ファイル）に対応する読み方の指定。ファイル名は前方一致でも拾う */
function planFor(plans: ReportOutputPlan[], filename: string): ReportOutputPlan | undefined {
  return plans.find(p => p.file === filename)
    ?? plans.find(p => filename.startsWith(p.file) || p.file.startsWith(filename));
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
  // ラベルにセル範囲が入っている（1シートが複数の表に割れている）ときは、注記で繰り返さない
  const keyRows = keyed.slice(0, 8).map(r => `<tr>`
    + `<td><b>${esc(sheetLabel(r))}</b><div class="rnote">${sheetLabel(r).endsWith(rangeOf(r)) ? '' : `${esc(rangeOf(r))}・`}${r.dataRowCount.toLocaleString()}行</div></td>`
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
      <p>最終アウトプット側の${b.dstSheets.length === 1 ? `<b>${esc(b.dstSheets[0])}</b>シート` : `<b>${b.dstSheets.length}</b>シート`}が、元データ側の${b.srcSheets.length === 1 ? `<b>${esc(b.srcSheets[0])}</b>シート` : `<b>${b.srcSheets.length}</b>シート`}から${b.group ? BLOCK_PREDICATE[b.group] : '値を取得しています。'}</p>
      ${renderFormulaAnatomy(b, fileNameOf)}
    </div>

    ${keyed.length > 0 ? `<div class="lb-step"><span class="lb-st">関係する表のキーと1行の定義</span>
      <div style="overflow-x:auto"><table class="ot">
        <tr><th>表</th><th>1行を決めるキー</th><th>1行の単位</th><th>数式が照合に使う列</th></tr>
        ${keyRows}
      </table></div>
      <p class="tbl-note">※「1行を決めるキー」は、値が重複していないことを確認できた列だけを載せています。
      「照合に使う列」は数式が突合の条件に使っている列で、必ずしも1行を決めるとは限りません。</p>
      ${keyed.length > 8 ? `<p class="tbl-note">※ キーが特定できた ${keyed.length} 表のうち上位8表。</p>` : ''}
      ${keyed.length < mine.length ? `<p class="tbl-note">※ このブロックの ${mine.length} 表のうち ${mine.length - keyed.length} 表は、1行を決める列を特定できていません。03 で伺います。</p>` : ''}
    </div>` : `<div class="lb-step"><span class="lb-st">関係する表のキーと1行の定義</span>
      <p class="tbl-note">このブロックの ${mine.length} 表では、1行を決める列（キー）を特定できませんでした。${b.byKey ? '' : '上記のとおりセル位置で対応しているため、キー列が数式に現れません。'}03 で伺います。</p>
    </div>`}

    ${er ? `<div class="lb-step"><span class="lb-st">キー関係図（ER）— 上記の表だけ</span>
      <div class="map-scroll er-scroll">${er.svg}</div>
      ${er.omitted > 0 ? `<p class="tbl-note">※ キーでつながる表を優先して表示しております。ほか ${er.omitted} 表は省略しております。</p>` : ''}
    </div>` : showEr ? `<div class="lb-step"><span class="lb-st">キー関係図（ER）</span>
      <p class="tbl-note">このブロックには、キー列で結ばれる表の対がありません${b.byKey ? '' : '。セル位置で対応しているため、結合キーがありません'}。</p>
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
function assignFileRoles(
  stats: Map<string, FileStat>, outputs: Set<string>, declared: boolean, masters: Set<string>,
): void {
  for (const s of stats.values()) {
    if (outputs.has(s.label)) { s.role = '最終アウトプット'; continue; }
    // マスタは他とつながりが検出できていなくても「独立」にしない。参照される側なので、
    // 参照元の数式が無ければ痕跡が残らないだけで、孤立しているわけではない
    if (masters.has(s.label)) { s.role = 'マスタ'; continue; }
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
/**
 * ご登録いただいたが自動検出できなかった関係の見た目。
 * 「担当者の説明だけが根拠」であることを、色と線種で他の4種とはっきり分ける
 * （実線＝数式、粗い破線＝値一致の推定、点線グレー＝Excel 上に根拠なし）。
 */
const DECLARED_ONLY = { label: '点線＝伺った内容のみ（Excel 上に数式が残っていないもの）', color: '#7A8794', cls: 'declared', dashed: true };
/** ご登録の種別 → 線の色に使う分類。種別が未設定なら転記として扱う */
const DECLARED_REL_GROUP: Record<string, Group> = {
  aggregate: 'agg', reference: 'ref', transcribe: 'move', manual_copy: 'copy', unknown: 'move',
};
const FILE_ROLE_FILL: Record<FileRole, string> = {
  '元データ': '#1E9E6A',
  'マスタ': '#1F5FAE',
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
  parts.push(`<marker id="ff-declared" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="${DECLARED_ONLY.color}" fill-opacity="0.85"/></marker>`);
  parts.push('</defs>');
  parts.push(`<rect x="0" y="0" width="${FF.W}" height="${h}" fill="#FCFDFE"/>`);
  parts.push('<pattern id="dot-ff" width="22" height="22" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="#E4EBF3"/></pattern>');
  parts.push(`<rect x="0" y="0" width="${FF.W}" height="${h}" fill="url(#dot-ff)"/>`);

  // 段の見出し（上＝受領データ、下＝最終アウトプット）
  for (const l of layerNos) {
    const row = byLayer.get(l)!;
    const y = pos.get(row[0].label)!.y;
    const isOut = row.every(s => outputs.has(s.label));
    const cap = isOut ? '最終アウトプット' : l === 0 ? '受領データ' : '経由ファイル';
    parts.push(`<text x="${FF.PAD}" y="${(y - 34).toFixed(1)}" font-size="11" font-weight="700" fill="${isOut ? '#C24141' : '#7A8794'}" letter-spacing=".04em">${esc(cap)}</text>`);
  }

  // 辺（円の縁で止め、同じ段どうしは弧で逃がす）
  for (const p of filePairs) {
    const a = pos.get(p.from); const b = pos.get(p.to);
    if (!a || !b) continue;
    // ご登録のみの関係は点線にして根拠のある線と区別する。色は種別（参照・集計・転記）を示す
    const g = p.declaredOnly ? (p.declaredGroup ?? 'move') : dominantFileGroup(p);
    const meta = GROUP_META[g];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.max(1, Math.hypot(dx, dy));
    const ux = dx / len, uy = dy / len;
    const bow = Math.abs(dy) < 4 ? 26 : 0;
    const sx = a.x + ux * (a.r + 2), sy = a.y + uy * (a.r + 2);
    const ex = b.x - ux * (b.r + 7), ey = b.y - uy * (b.r + 7);
    const mx = (a.x + b.x) / 2 - uy * bow, my = (a.y + b.y) / 2 + ux * bow;
    const dash = p.declaredOnly ? ' stroke-dasharray="2 5"' : meta.dashed ? ' stroke-dasharray="6 5"' : '';
    const marker = `ff-${g}`;
    parts.push(`<path d="M${sx.toFixed(1)},${sy.toFixed(1)} Q${mx.toFixed(1)},${my.toFixed(1)} ${ex.toFixed(1)},${ey.toFixed(1)}" fill="none" stroke="${meta.color}" stroke-width="1.6" stroke-opacity="0.55"${dash} marker-end="url(#${marker})"/>`);
  }

  // ノード（ファイル）
  for (const s of all) {
    const p = pos.get(s.label)!;
    const fill = FILE_ROLE_FILL[s.role];
    const isOut = outputs.has(s.label);
    const orphanOut = isOut && s.inFiles.size === 0;
    const sub = `${s.sheets.length}シート ／ ${s.regionCount}表 ／ ${s.rowTotal.toLocaleString()}行`;
    const nameLines = wrapText(isOut && !s.filename.startsWith('★') ? `★ ${s.filename}` : s.filename, 250, 11.5, 2);
    parts.push('<g>'
      + (isOut
        ? `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${(p.r + 5).toFixed(1)}" fill="none" stroke="${fill}" stroke-opacity="0.32" stroke-width="2"${orphanOut ? ' stroke-dasharray="5 4"' : ''}/>`
        : '')
      + `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${p.r}" fill="${fill}" stroke="#FCFDFE" stroke-width="1.5"/>`
      // ファイル名は日付・版が付いて長い。1行に押し込むと「③仮予算 20260410 2027年3月期 DF予算編…」
      // のように肝心のところで切れるので2行まで折り返し、その分だけ下の注記をずらす
      + `<text x="${p.x.toFixed(1)}" y="${(p.y + p.r + 14).toFixed(1)}" font-size="11.5" font-weight="${isOut ? 800 : 700}" fill="#0E2A47" text-anchor="middle" style="paint-order:stroke;stroke:#FCFDFE;stroke-width:3.4px">`
      + nameLines.map((ln, i) => `<tspan x="${p.x.toFixed(1)}" dy="${i === 0 ? 0 : 13}">${esc(ln)}</tspan>`).join('')
      + '</text>'
      + `<text x="${p.x.toFixed(1)}" y="${(p.y + p.r + 28 + (nameLines.length - 1) * 13).toFixed(1)}" font-size="9.5" fill="#7A8794" text-anchor="middle" style="paint-order:stroke;stroke:#FCFDFE;stroke-width:3px">${esc(sub)}${orphanOut ? '（つながり未検出）' : ''}</text>`
      + '</g>');
  }
  parts.push('</svg>');
  return parts.join('\n');
}

// ---- 作成手順（ステップ）に沿った全体関係図 ----
//
// 手順書をいただけた案件では、ファイル間の矢印を一枚に並べただけの図では足りない。
// 受け渡しの数だけ矢印が最終アウトプットへ集まる扇形になり、
//   ・実際には「①へ足していく」土台のファイルが1つあること
//   ・⑤→⑥のように、途中で1回加工してから土台へ入るものがあること
//   ・どれが何番目の作業なのか
// が図から落ちる。手順のステップ番号が入っているときは、
//   段（帯）＝ステップ、右の縦帯＝土台のファイル、帯から土台へ入る矢印＝そのステップで足す項目
// という並びで描き直す。ステップ番号が無い案件は従来どおり buildFileFlow を使う。
const SFL = {
  W: 1280,
  CAP_X: 40,           // 左の「ステップN」見出し
  COL_X: [246, 556],   // 帯の中のノード列（2列まで。⑤→⑥のような1回だけの中継を表せる幅）
  COL_W_LABEL: 290,    // ノード名の折り返し幅（隣の列と重ならないところまで）
  MERGE_X: 700,        // 帯の矢印を1点へ寄せる位置（土台へ合流していく見た目にする）
  BASE_X: 760,         // 土台のファイル（丸）を置く位置。ステップごとに同じ x へ繰り返す
  // 読み合わせでは投影・印刷した図をその場で指しながら話すので、図の中の字は
  // 本文と同じくらいの大きさが要る（小さいと結局「これは何ですか」と口頭で聞かれる）
  FS_CAP: 14, FS_CAP_SUB: 12, FS_NODE: 13, FS_NODE_SUB: 11, FS_ADD: 12.5, FS_SPINE: 13.5,
  ROW_H: 64, ADD_H: 19, BAND_PAD: 26, BANDS_TOP: 46, OUT_GAP: 76, R: 13,
};

interface StepBand {
  no: number; title: string;
  cols: string[][];                                   // 帯の中のノード（列ごと）
  inner: { from: string; to: string; rel: DeclaredFileRel }[];  // 帯の中の受け渡し
  toSpine: { from: string; rel: DeclaredFileRel }[];  // 土台へ入るもの
  adds: string[];                                     // そのステップで土台に足される項目
  top: number; h: number;
}

/**
 * ステップ帯レイアウトの全体関係図。手順のステップ番号が無い、または土台が定まらないときは
 * null を返し、呼び出し側が従来の図（buildFileFlow）へ落ちる。
 */
function buildStepFlow(
  stats: Map<string, FileStat>, rels: DeclaredFileRel[], outputs: Set<string>, detected: Set<string>,
): { svg: string; backbone: string; output: string } | null {
  const stepRels = rels.filter(r => typeof r.step === 'number');
  const stepNos = [...new Set(stepRels.map(r => r.step!))].sort((a, b) => a - b);
  if (stepNos.length < 2) return null;

  // 土台＝複数のステップで受け側になっているファイル（「①へ付与していく」の①）
  const asTarget = new Map<string, Set<number>>();
  for (const r of stepRels) {
    if (outputs.has(r.toFile)) continue;
    const s = asTarget.get(r.toFile) ?? new Set<number>();
    s.add(r.step!);
    asTarget.set(r.toFile, s);
  }
  let backbone: string | null = null;
  for (const [f, s] of asTarget) {
    if (s.size < 2) continue;
    if (!backbone || s.size > (asTarget.get(backbone)?.size ?? 0)) backbone = f;
  }
  if (!backbone) return null;
  const outLabel = [...outputs][0] ?? null;

  // ---- 帯を組む ----
  const bands: StepBand[] = [];
  const placed = new Set<string>([backbone, ...(outLabel ? [outLabel] : [])]);
  for (const no of stepNos) {
    const mine = stepRels.filter(r => r.step === no);
    const members = [...new Set(mine.flatMap(r => [r.fromFile, r.toFile]))]
      .filter(f => f !== backbone && f !== outLabel && stats.has(f));
    // 列＝帯の中での深さ（受け側になっているものを右へ）。2列で足りない案件は右端へ寄せる
    const depth = new Map<string, number>(members.map(f => [f, 0]));
    for (let pass = 0; pass < members.length; pass++) {
      let changed = false;
      for (const r of mine) {
        const df = depth.get(r.fromFile); const dt = depth.get(r.toFile);
        if (df === undefined || dt === undefined) continue;
        if (dt < df + 1) { depth.set(r.toFile, df + 1); changed = true; }
      }
      if (!changed) break;
    }
    const cols: string[][] = [[], []];
    for (const f of members) {
      cols[Math.min(1, depth.get(f) ?? 0)].push(f);
      placed.add(f);
    }
    const rows = Math.max(1, ...cols.map(c => c.length));
    // 「このステップで土台に足される列」。1件ずつ別の行に出す — つないで1行にすると
    // 折り返しの位置しだいで「・」で切れ、何がいくつ足されるのかが読めなくなる
    const adds = [...new Set(mine.map(r => r.adds ?? '').filter(a => a !== ''))];
    bands.push({
      no, title: mine.find(r => r.stepTitle)?.stepTitle ?? '',
      cols,
      inner: mine.filter(r => members.includes(r.toFile)).map(r => ({ from: r.fromFile, to: r.toFile, rel: r })),
      toSpine: mine.filter(r => r.toFile === backbone).map(r => ({ from: r.fromFile, rel: r })),
      adds,
      // 帯の高さは「左のノード」と「右の土台に足される列」の高いほうに合わせる
      top: 0, h: SFL.BAND_PAD + Math.max(rows * SFL.ROW_H, adds.length * SFL.ADD_H + 12) + 6,
    });
  }
  // 手順に出てこないファイルも図から消さない（消すと「無かったこと」になる）
  const rest = [...stats.values()].map(s => s.label).filter(l => !placed.has(l));
  if (rest.length > 0) {
    bands.push({
      no: 0, title: '', cols: [rest, []], inner: [], toSpine: [], adds: [],
      top: 0, h: SFL.BAND_PAD + rest.length * SFL.ROW_H + 6,
    });
  }

  let y = SFL.BANDS_TOP;
  for (const b of bands) { b.top = y; y += b.h; }
  const bandsBottom = y;
  // 最終アウトプットも「仕上げ」の段として同じ左→右の並びで置く。
  // 最後だけ下へ落とすと、そこで図の読み方が変わってしまう。
  const finalMid = bandsBottom + SFL.BAND_PAD + 18;
  const height = Math.round(finalMid + 104);

  const posOf = new Map<string, { x: number; y: number }>();
  for (const b of bands) {
    const mid = b.top + b.h / 2;
    b.cols.forEach((col, ci) => {
      col.forEach((f, i) => {
        posOf.set(f, { x: SFL.COL_X[ci], y: mid + (i - (col.length - 1) / 2) * SFL.ROW_H });
      });
    });
  }

  const parts: string[] = [];
  parts.push(`<svg viewBox="0 0 ${SFL.W} ${height}" role="img" aria-label="伺った手順に沿ったファイルどうしの関係図">`);
  parts.push('<defs>');
  for (const g of GROUP_ORDER) {
    parts.push(`<marker id="sf-${g}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="${GROUP_META[g].color}" fill-opacity="0.85"/></marker>`);
  }
  parts.push('</defs>');
  parts.push(`<rect x="0" y="0" width="${SFL.W}" height="${height}" fill="#FCFDFE"/>`);
  parts.push('<pattern id="dot-sf" width="22" height="22" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="#E4EBF3"/></pattern>');
  parts.push(`<rect x="0" y="0" width="${SFL.W}" height="${height}" fill="url(#dot-sf)"/>`);

  const bb = stats.get(backbone)!;
  const bbFill = FILE_ROLE_FILL[bb.role];

  for (const b of bands) {
    const mid = b.top + b.h / 2;
    if (b.top > SFL.BANDS_TOP) {
      parts.push(`<line x1="${SFL.CAP_X}" y1="${b.top.toFixed(1)}" x2="${SFL.W - SFL.CAP_X}" y2="${b.top.toFixed(1)}" stroke="#DDE5EE" stroke-width="1"/>`);
    }
    // 帯の見出し
    if (b.no > 0) {
      parts.push(`<text x="${SFL.CAP_X}" y="${(mid - 6).toFixed(1)}" font-size="${SFL.FS_CAP}" font-weight="700" fill="#1F5FAE">ステップ${b.no}</text>`);
      if (b.title !== '') {
        parts.push(`<text x="${SFL.CAP_X}" y="${(mid + 13).toFixed(1)}" font-size="${SFL.FS_CAP_SUB}" fill="#7A8794">${esc(fitText(b.title, 180, SFL.FS_CAP_SUB))}</text>`);
      }
    } else {
      parts.push(`<text x="${SFL.CAP_X}" y="${(mid - 6).toFixed(1)}" font-size="${SFL.FS_CAP}" font-weight="700" fill="#7A8794">手順に出てこない</text>`);
      parts.push(`<text x="${SFL.CAP_X}" y="${(mid + 13).toFixed(1)}" font-size="${SFL.FS_CAP_SUB}" fill="#7A8794">ファイル</text>`);
    }

    // 帯の中の受け渡し（⑤人件費データ → ⑥得意先別訪問数 のような中継）
    for (const e of b.inner) {
      const a = posOf.get(e.from); const t = posOf.get(e.to);
      if (!a || !t) continue;
      const meta = GROUP_META[DECLARED_REL_GROUP[e.rel.relType] ?? 'move'];
      const dash = detected.has(filePairKey(e.from, e.to)) ? '' : ' stroke-dasharray="2 5"';
      const mx = (a.x + t.x) / 2, my = (a.y + t.y) / 2 - 14;
      parts.push(`<path d="M${(a.x + SFL.R + 2).toFixed(1)},${a.y.toFixed(1)} Q${mx.toFixed(1)},${my.toFixed(1)} ${(t.x - SFL.R - 7).toFixed(1)},${t.y.toFixed(1)}" fill="none" stroke="${meta.color}" stroke-width="1.6" stroke-opacity="0.55"${dash} marker-end="url(#sf-${DECLARED_REL_GROUP[e.rel.relType] ?? 'move'})"/>`);
      parts.push(`<text x="${mx.toFixed(1)}" y="${(my - 5).toFixed(1)}" font-size="${SFL.FS_NODE_SUB}" fill="${meta.color}" text-anchor="middle" style="paint-order:stroke;stroke:#FCFDFE;stroke-width:3.5px">${esc(FILE_REL_LABELS[e.rel.relType])}</text>`);
    }

    // 土台へ入る矢印。1点へ寄せてから土台の丸へ入れる（何本あっても行き先は同じ土台）
    for (const e of b.toSpine) {
      const a = posOf.get(e.from);
      if (!a) continue;
      const g = DECLARED_REL_GROUP[e.rel.relType] ?? 'move';
      const meta = GROUP_META[g];
      const dash = detected.has(filePairKey(e.from, backbone)) ? '' : ' stroke-dasharray="2 5"';
      parts.push(`<path d="M${(a.x + SFL.R + 2).toFixed(1)},${a.y.toFixed(1)} Q${SFL.MERGE_X},${mid.toFixed(1)} ${(SFL.BASE_X - SFL.R - 7).toFixed(1)},${mid.toFixed(1)}" fill="none" stroke="${meta.color}" stroke-width="1.6" stroke-opacity="0.55"${dash} marker-end="url(#sf-${g})"/>`);
    }
    // 土台の丸を、ステップごとに置く。同じファイルを毎段くり返すことになるが、
    // 縦長の枠で1つだけ描くより「丸＝ファイル・線＝受け渡し」の読み方だけで通せる
    // （枠は凡例にも無い別の記号になるため、何を指しているのかが伝わらなかった）。
    if (b.toSpine.length > 0) {
      const lines = 1 + b.adds.length;
      const top = mid + 4 - ((lines - 1) / 2) * SFL.ADD_H;
      parts.push(`<circle cx="${SFL.BASE_X}" cy="${mid.toFixed(1)}" r="${SFL.R}" fill="${bbFill}" stroke="#FCFDFE" stroke-width="1.5"/>`);
      parts.push(`<text x="${SFL.BASE_X + SFL.R + 9}" y="${top.toFixed(1)}" font-size="${SFL.FS_NODE}" font-weight="700" fill="#0E2A47">${esc(fitText(bb.filename, SFL.W - SFL.BASE_X - 60, SFL.FS_NODE))}</text>`);
      b.adds.forEach((a, i) => {
        parts.push(`<text x="${SFL.BASE_X + SFL.R + 9}" y="${(top + (i + 1) * SFL.ADD_H).toFixed(1)}" font-size="${SFL.FS_ADD}" fill="#1F5FAE">＋${esc(fitText(a, SFL.W - SFL.BASE_X - 70, SFL.FS_ADD))}</text>`);
      });
    }

    // ノード（受領ファイル）
    for (const col of b.cols) {
      for (const f of col) {
        const s = stats.get(f);
        const p = posOf.get(f);
        if (!s || !p) continue;
        const sub = `${s.sheets.length}シート ／ ${s.rowTotal.toLocaleString()}行`;
        parts.push('<g>'
          + `<circle cx="${p.x}" cy="${p.y.toFixed(1)}" r="${SFL.R}" fill="${FILE_ROLE_FILL[s.role]}" stroke="#FCFDFE" stroke-width="1.5"/>`
          + `<text x="${p.x}" y="${(p.y + SFL.R + 16).toFixed(1)}" font-size="${SFL.FS_NODE}" font-weight="700" fill="#0E2A47" text-anchor="middle" style="paint-order:stroke;stroke:#FCFDFE;stroke-width:3.4px">${esc(fitText(s.filename, SFL.COL_W_LABEL, SFL.FS_NODE))}</text>`
          + `<text x="${p.x}" y="${(p.y + SFL.R + 31).toFixed(1)}" font-size="${SFL.FS_NODE_SUB}" fill="#7A8794" text-anchor="middle" style="paint-order:stroke;stroke:#FCFDFE;stroke-width:3px">${esc(sub)}</text>`
          + '</g>');
      }
    }
  }

  // 仕上げの段：足し終わった土台 → 最終アウトプット。ステップの段と同じ向き（左→右）で置く
  if (outLabel) {
    const o = stats.get(outLabel)!;
    const srcX = SFL.COL_X[0];
    const finalRel = rels.find(r => r.fromFile === backbone && r.toFile === outLabel);
    const g = finalRel ? (DECLARED_REL_GROUP[finalRel.relType] ?? 'move') : 'move';
    const dash = finalRel && detected.has(filePairKey(backbone, outLabel)) ? '' : ' stroke-dasharray="2 5"';
    parts.push(`<line x1="${SFL.CAP_X}" y1="${bandsBottom.toFixed(1)}" x2="${SFL.W - SFL.CAP_X}" y2="${bandsBottom.toFixed(1)}" stroke="#DDE5EE" stroke-width="1"/>`);
    parts.push(`<text x="${SFL.CAP_X}" y="${(finalMid - 6).toFixed(1)}" font-size="${SFL.FS_CAP}" font-weight="700" fill="#C24141">仕上げ</text>`);
    parts.push(`<text x="${SFL.CAP_X}" y="${(finalMid + 13).toFixed(1)}" font-size="${SFL.FS_CAP_SUB}" fill="#7A8794">試算表にする</text>`);
    // 足し終わった土台
    parts.push('<g>'
      + `<circle cx="${srcX}" cy="${finalMid.toFixed(1)}" r="${SFL.R}" fill="${bbFill}" stroke="#FCFDFE" stroke-width="1.5"/>`
      + `<text x="${srcX}" y="${(finalMid + SFL.R + 16).toFixed(1)}" font-size="${SFL.FS_NODE}" font-weight="700" fill="#0E2A47" text-anchor="middle" style="paint-order:stroke;stroke:#FCFDFE;stroke-width:3.4px">${esc(fitText(bb.filename, SFL.COL_W_LABEL, SFL.FS_NODE))}</text>`
      + `<text x="${srcX}" y="${(finalMid + SFL.R + 31).toFixed(1)}" font-size="${SFL.FS_NODE_SUB}" fill="#7A8794" text-anchor="middle" style="paint-order:stroke;stroke:#FCFDFE;stroke-width:3px">ステップ1〜4を足し終わった状態</text>`
      + '</g>');
    parts.push(`<path d="M${(srcX + SFL.R + 2).toFixed(1)},${finalMid.toFixed(1)} Q${SFL.MERGE_X},${finalMid.toFixed(1)} ${(SFL.BASE_X - 40).toFixed(1)},${finalMid.toFixed(1)}" fill="none" stroke="${GROUP_META[g].color}" stroke-width="1.6" stroke-opacity="0.55"${dash} marker-end="url(#sf-${g})"/>`);
    parts.push(`<text x="${((srcX + SFL.BASE_X) / 2).toFixed(1)}" y="${(finalMid - 10).toFixed(1)}" font-size="${SFL.FS_NODE_SUB}" fill="#7A8794" text-anchor="middle" style="paint-order:stroke;stroke:#FCFDFE;stroke-width:3.5px">そのまま貼り付けて試算表になります</text>`);
    parts.push('<g>'
      + `<circle cx="${SFL.BASE_X}" cy="${finalMid.toFixed(1)}" r="31" fill="none" stroke="#C0392B" stroke-opacity="0.32" stroke-width="2"/>`
      + `<circle cx="${SFL.BASE_X}" cy="${finalMid.toFixed(1)}" r="26" fill="#C0392B" stroke="#FCFDFE" stroke-width="1.5"/>`
      // ファイル名の先頭が既に ★ なら重ねない（「★ ★顧客別…」になってしまう）
      + `<text x="${SFL.BASE_X}" y="${(finalMid + 48).toFixed(1)}" font-size="${SFL.FS_NODE}" font-weight="800" fill="#0E2A47" text-anchor="middle" style="paint-order:stroke;stroke:#FCFDFE;stroke-width:3.4px">${esc(fitText(o.filename.startsWith('★') ? o.filename : `★ ${o.filename}`, 340, SFL.FS_NODE))}</text>`
      + `<text x="${SFL.BASE_X}" y="${(finalMid + 63).toFixed(1)}" font-size="${SFL.FS_NODE_SUB}" fill="#7A8794" text-anchor="middle" style="paint-order:stroke;stroke:#FCFDFE;stroke-width:3px">${esc(`${o.sheets.length}シート ／ ${o.rowTotal.toLocaleString()}行`)}</text>`
      + '</g>');
  }

  // 同じファイルが毎段に出てくることを、図の中でも断っておく
  parts.push(`<text x="${SFL.CAP_X}" y="${(height - 18).toFixed(1)}" font-size="${SFL.FS_NODE_SUB}" fill="#7A8794">※ 各ステップの ${esc(bb.filename)} は、すべて同じファイルです。上から順に列を足していきます。</text>`);
  parts.push('</svg>');
  return {
    svg: parts.join('\n'),
    backbone: bb.filename,
    output: outLabel ? (stats.get(outLabel)?.filename ?? outLabel) : '',
  };
}

// ============================================================
// ご登録のブック関係 — 突合キーの候補
//
// 自動検出できなかった関係には数式という根拠が無い。そこで機械的に言えることだけを出す:
// 「両方のファイルに同じ名前の列があり、片方（または両方）では値が一意＝1行を決めるキーと
// 判定されている」。断定はせず候補として並べ、正否の確認は 03 に回す。
// ============================================================
interface FileCols { keyCols: Set<string>; all: Set<string> }

function buildFileColumnIndex(regions: Region[]): Map<string, FileCols> {
  const out = new Map<string, FileCols>();
  for (const r of regions) {
    let f = out.get(r.file);
    if (!f) { f = { keyCols: new Set(), all: new Set() }; out.set(r.file, f); }
    for (const c of r.columns) f.all.add(c.name);
    // join（数式が照合に使っている列）は行を決めるとは限らないので、ここでは数えない
    for (const k of r.keys?.keys ?? []) if (k.role !== 'join') f.keyCols.add(k.column);
  }
  return out;
}

/** コード列らしさ。列名だけで見分けるための最小限の手掛かり */
const CODE_LIKE = /(コード|ｺｰﾄﾞ|CD|ID|No\.?|番号|区分)/i;
/** ヘッダーが無い表で付く仮の列名（A列・B列…）。候補に出しても読み手が突合先を判断できない */
const PLACEHOLDER_COL = /^[A-Z]{1,3}列$/;
/** 名称の列。コードの列と突き合わせる候補にはしない */
const NAME_COL = /(名称|名前|名)$/;
/**
 * 列名らしいか。見出しの無い表では、注意書きや説明文がそのまま列名として拾われることがあり
 *（例:「下記のセルに入力をお願いします」）、それを突合キーの候補に並べると表が読めなくなる。
 */
const looksLikeColumn = (s: string): boolean =>
  s.length <= 14 && !/[。、！？]/.test(s) && !/(ください|お願い|してください)/.test(s);
const KEY_HINT_CAP = 4;

interface KeyHint { name: string; note: string }

/**
 * 突合キーの候補を探すときの列名の正規化。末尾のコード表記だけを落とす。
 * 「集計得意先コード」と「集計得意先」、「得意先CD」と「得意先」は、
 * 現場では同じものを指していることが多く、名前が違うだけで候補から落とすと
 * 「見つかりませんでした」しか出せなくなる（実際にそうなっていた）。
 * 「得意先名」と「得意先コード」のような名称／コードの違いは落とさない — 別の列なので。
 */
const normKeyName = (s: string): string => s
  .replace(/[\s　_\-（）()]/g, '')
  .replace(/(コード|ｺｰﾄﾞ|CD|ID|No\.?|番号)$/i, '')
  .toLowerCase();

/**
 * ご登録のブック関係に対して「どの列で突き合わせられそうか」を出す。
 * 手がかりの強い順に3段。どの段で見つけたかは note に書き、断定はしない。
 *   1. 同じ名前の列が両方にある
 *   2. コード表記を除くと同じ／片方が他方を含む名前がある（集計得意先コード ↔ 集計得意先）
 *   3. どちらも取れないときは、両側のキーらしい列を並べて「どれで突き合わせるか」を尋ねる
 * 3段目が要るのは、「見つかりませんでした」だけでは読み手が何を答えればよいか分からないため。
 */
function joinKeyHints(a: FileCols | undefined, b: FileCols | undefined): KeyHint[] {
  if (!a || !b) return [];
  const usable = (cols: Set<string>) => [...cols]
    .filter(n => n.trim().length >= 2 && !PLACEHOLDER_COL.test(n) && looksLikeColumn(n.trim()));
  const hits: (KeyHint & { score: number })[] = [];
  for (const name of usable(a.all)) {
    if (!b.all.has(name)) continue;
    const ka = a.keyCols.has(name); const kb = b.keyCols.has(name);
    const code = CODE_LIKE.test(name);
    // 「金額」「合計」のようにどこにでもある名前だけで候補にすると、突合キーに見えない列が並ぶ
    if (!ka && !kb && !code) continue;
    hits.push({
      name, score: 100 + (ka ? 2 : 0) + (kb ? 2 : 0) + (code ? 1 : 0),
      note: ka && kb ? 'どちらの表でも値が重複していません'
        : ka || kb ? '片方の表で値が重複していません'
          : '両方のファイルに同じ名前であります',
    });
  }
  // 2段目：コード表記を除けば同じ、または片方が他方を含む名前
  if (hits.length === 0) {
    for (const an of usable(a.all)) {
      const na = normKeyName(an);
      if (na.length < 2) continue;
      for (const bn of usable(b.all)) {
        if (an === bn) continue;
        const nb = normKeyName(bn);
        if (nb.length < 2) continue;
        // 片方だけが名称の列なら別物（「集計得意先コード」と「集計得意先名」を
        // 突合キーの候補として並べると、コードと名前を突き合わせる話に読めてしまう）
        if (NAME_COL.test(an) !== NAME_COL.test(bn)) continue;
        const same = na === nb;
        const part = !same && (na.includes(nb) || nb.includes(na));
        if (!same && !part) continue;
        const ka = a.keyCols.has(an); const kb = b.keyCols.has(bn);
        if (!ka && !kb && !CODE_LIKE.test(an) && !CODE_LIKE.test(bn)) continue;
        hits.push({
          name: `${an} ＝ ${bn}`,
          score: (same ? 50 : 20) + (ka ? 2 : 0) + (kb ? 2 : 0),
          note: same ? 'コードの書き方が違うだけで、同じものを指していそうです'
            : '名称が近いので、この2つを突き合わせていらっしゃるようです',
        });
      }
    }
  }
  // 3段目：手がかりが無いときは、両側のキーらしい列を見せて確認をお願いする
  if (hits.length === 0) {
    const pick = (f: FileCols) => {
      const keys = usable(f.keyCols);
      const codes = usable(f.all).filter(n => CODE_LIKE.test(n));
      return [...new Set([...keys, ...codes])].slice(0, 3);
    };
    const pa = pick(a); const pb = pick(b);
    if (pa.length > 0 || pb.length > 0) {
      if (pa.length > 0) {
        hits.push({ name: `元の側：${pa.join('・')}`, score: 10, note: 'この中のどれで突き合わせていらっしゃいますか' });
      }
      if (pb.length > 0) {
        hits.push({ name: `先の側：${pb.join('・')}`, score: 9, note: '名称が一致する列が無いため、対応をご教示ください' });
      }
    }
  }
  return hits.sort((x, y) => y.score - x.score || x.name.localeCompare(y.name))
    .slice(0, KEY_HINT_CAP)
    .map(({ name, note }) => ({ name, note }));
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
  if (g === 'copy') return '数式なし・値の一致から手作業コピーと推定';
  const fn = topFuncOf(evidence);
  return fn ? `${fn} で${GROUP_META[g].label.split('（')[0]}` : '';
}

/**
 * 掲載順は「流れの順」。関係の本数で並べると帳票→元データが混ざって読み合わせに使えないため、
 * 送り元表のレイヤ（元データ=0 …）で昇順に並べ、同じレイヤ内は本数の多い順にする。
 */
// ============================================================
// 「何と何を、何で突き合わせて、何ができるか」
//
// 関係の一覧表は1行1関係で正確だが、読み手が知りたいのは「結局この表は何からできるのか」。
// 行を追って頭の中で組み立て直さないと分からないので、行き先の表ごとにまとめ直し、
// 1文と1枚の図で「元 → 突合キー → できるもの」を示す。表は付録として下に残す。
// ============================================================
interface Recipe {
  /** 元も先も同じファイルの中で完結するとき、そのファイル名。呼び名からは外して見出しに1回だけ出す */
  file?: string;
  dst: string;                                   // 行き先の表（表示名）
  dstKind: string;                               // それがシートなのか、シート内の1つの表なのか
  dstIsOutput: boolean;                          // 最終アウトプットそのものか
  dstCols: string[];                             // そこにできる項目（列）
  srcs: { label: string; kind: string; key: string; group: Group; evidence: string }[];
  keys: string[];                                // 突合に使われているキー（重複除く）
  /**
   * どうやって元と先を対応づけているか。
   *   key        … 突合キーの列が数式から読み取れた（VLOOKUP・SUMIFS の照合列など）
   *   position   … キーで突き合わせておらず、同じ位置のセルを指している（＝縦横が揃っている前提）
   *   unknown    … 引き当ての式なのに、照合列を読み取れなかった
   * 以前はどれも「キー未特定」と出していたため、キーで突合していない箇所まで
   * 「キーが分からない」と読めてしまい、何を確認すればよいのかが伝わらなかった。
   */
  match: 'key' | 'position' | 'unknown';
  noHeaderCols: string[];                        // 見出しが無く「D列」のように表示している列
}
/**
 * 突合キーの表示を整える。見出しの無い表の列は「D列」のような仮の名前になり、
 * 「D列 ＝ 得意先」と出しても読み手には何のことか分からない。名前のある側だけを見せ、
 * 見出しが無いことは注記として別に伝える。
 */
function prettyKey(raw: string): { text: string; noHeader: string[] } {
  const noHeader: string[] = [];
  const parts = raw.split(/[／・]/).map(s => s.trim()).filter(Boolean).map(part => {
    const m = /^(.+?)\s*＝\s*(.+)$/.exec(part);
    if (!m) return part;
    const [a, b] = [m[1].trim(), m[2].trim()];
    const pa = PLACEHOLDER_COL.test(a); const pb = PLACEHOLDER_COL.test(b);
    if (pa && !pb) { noHeader.push(a); return b; }
    if (pb && !pa) { noHeader.push(b); return a; }
    return `${a} ＝ ${b}`;
  });
  return { text: [...new Set(parts)].join('・'), noHeader: [...new Set(noHeader)] };
}

/** 引き当て・集計の関数。式にこれがあれば「キーで突き合わせている」側として扱う */
const LOOKUP_FN = /\b(VLOOKUP|HLOOKUP|XLOOKUP|LOOKUP|MATCH|INDEX|SUMIFS?|COUNTIFS?|AVERAGEIFS?|GETPIVOTDATA|FILTER)\s*\(/i;

const RECIPE_CAP = 6;        // 載せる行き先の数。多いと「結局どれを見ればいいのか」が消える
const RECIPE_SRC_CAP = 4;    // 1つの行き先につき並べる元の数
const RECIPE_COL_CAP = 5;    // 1つの行き先につき挙げる項目数

/**
 * 2-4 の中身と、その母数。
 *   list  … 実際に載せる行き先（RECIPE_CAP まで）
 *   total … 数式で作られている行き先の総数。「載せたのは何件で、何件を省いたか」を
 *           上限の定数ではなく実数で書くために返す（定数を書くと、母数が上限に満たない
 *           案件で「6 か所を載せています」と出るのに 4 件しか無い、という食い違いになる）
 */
interface RecipeSet { list: Recipe[]; total: number }

function buildRecipes(
  edges: Edge[], pairs: PairAgg[], regions: Region[], pairKeys: Map<string, string>,
  roles: Map<string, Role>,
): RecipeSet {
  // 図では短い呼び名でよいが、ここは「何からできるか」を言い切る場所なのでファイル名まで書く
  const shortLabels = buildLabels(regions);
  const fileOf = new Map(regions.map(r => [r.id, r.file]));
  const regionById = new Map(regions.map(r => [r.id, r]));
  // 呼び名だけでは、それがシートなのか列なのか読み手に伝わらない。1シートに表が1つなら
  // 「シート」、同じシートに複数の表があるならその中の「表」と呼び分けて必ず添える。
  const perSheet = new Map<string, number>();
  for (const r of regions) {
    const k = `${r.file} ${r.sheet}`;
    perSheet.set(k, (perSheet.get(k) ?? 0) + 1);
  }
  const kindOf = (id: string): string => {
    const r = regions.find(x => x.id === id);
    return r && (perSheet.get(`${r.file} ${r.sheet}`) ?? 1) > 1 ? '表' : 'シート';
  };
  const labels = new Map<string, string>();
  for (const r of regions) {
    const s = shortLabels.get(r.id) ?? r.sheet;
    labels.set(r.id, r.file && !s.includes('›') && s !== r.file ? `${r.file} › ${s}` : s);
  }
  // 行き先の表ごとに、元の表・キー・できる項目を集める。
  // 値の一致だけの関係（copy）はここでは扱わない — 「こう作られています」と言い切れる話ではなく、
  // 03 で「実際に貼っていらっしゃいますか」と伺う対象なので、混ぜると推定が事実として読まれる。
  const byDst = new Map<string, {
    cols: Set<string>;
    srcs: Map<string, { key: string; group: Group; n: number; evidence: string }>;
  }>();
  for (const e of edges) {
    if (e.type === 'copy') continue;
    const from = regionIdOf(e.from); const to = regionIdOf(e.to);
    if (!from || !to || from === to) continue;
    if (fileOf.get(from) === undefined || fileOf.get(to) === undefined) continue;
    let d = byDst.get(to);
    if (!d) { d = { cols: new Set(), srcs: new Map() }; byDst.set(to, d); }
    // 見出しの無い列は「D列」のような位置の呼び名になる。落とすと何ができるのかが消えるので
    // そのまま挙げ、見出しが空であることは注記でまとめて伝える。
    const col = colNameOf(e.to);
    if (col) d.cols.add(col);
    const g = groupOf(e.type);
    const cur = d.srcs.get(from);
    if (cur) { cur.n++; if (cur.evidence === '') cur.evidence = e.evidence ?? ''; }
    else {
      d.srcs.set(from, {
        key: pairKeys.get(regionPairKey(from, to)) ?? '', group: g, n: 1,
        // 「キーで突き合わせているか」は種別だけでは決まらない。IFERROR(VLOOKUP(...)) のように
        // 引き当ての式が転記として分類されることがあるので、式そのものも見る
        evidence: e.evidence ?? '',
      });
    }
  }
  const totalOf = new Map(pairs.map(p => [p.to, p.total]));
  // 読み手の関心は最終アウトプットが何からできるか。まずそれ、次に関係の多い順。
  const rank = (id: string) => (roles.get(id) === '最終アウトプット' ? 1e9 : 0)
    + (totalOf.get(id) ?? 0);
  const list = [...byDst]
    .sort((a, b) => rank(b[0]) - rank(a[0]))
    .slice(0, RECIPE_CAP)
    .map(([dstId, d]) => {
      const picked = [...d.srcs].sort((a, b) => b[1].n - a[1].n).slice(0, RECIPE_SRC_CAP);
      // 1つのブックの中で完結する話なら、呼び名にファイル名を繰り返さず見出しへ1回だけ出す
      const files = new Set([dstId, ...picked.map(([sid]) => sid)].map(id => fileOf.get(id)));
      const one = files.size === 1 ? fileOf.get(dstId) : undefined;
      const nameOf = (id: string) => (one ? shortLabels.get(id) ?? id : labels.get(id) ?? id);
      const srcs = picked.map(([sid, v]) => ({
        label: nameOf(sid), kind: kindOf(sid), key: v.key, group: v.group, evidence: v.evidence,
      }));
      const keys = [...new Set(srcs.flatMap(s => (s.key ? [prettyKey(s.key).text] : [])).filter(Boolean))];
      // キーが取れないときの意味は2通り。引き当て・集計の式（VLOOKUP・SUMIFS 等）なら
      // 「照合列を読み取れなかった」、式が単なるセル参照や四則演算なら「キーで突き合わせていない」。
      // 種別だけでは決められない — IFERROR(VLOOKUP(...)) が転記として分類されることがある。
      const match: Recipe['match'] = keys.length > 0 ? 'key'
        : srcs.some(s => s.group === 'ref' || LOOKUP_FN.test(s.evidence)) ? 'unknown' : 'position';
      return {
        file: one,
        dst: nameOf(dstId),
        dstKind: kindOf(dstId),
        dstIsOutput: roles.get(dstId) === '最終アウトプット',
        dstCols: [...d.cols].slice(0, RECIPE_COL_CAP).map(c => prettyColumn(regionById.get(dstId), c)),
        srcs,
        keys,
        match,
        noHeaderCols: [...new Set([
          ...srcs.flatMap(s => (s.key ? prettyKey(s.key).noHeader : [])),
          ...[...d.cols].slice(0, RECIPE_COL_CAP).filter(c => PLACEHOLDER_COL.test(c)),
        ])],
      };
    });
  return { list, total: byDst.size };
}

/** 1件ぶんの図。左に元の表、中央に突合キー、右にできる表。 */
const RCP = { W: 980, SRC_W: 320, DST_W: 300, ROW: 42, BOX_H: 32 };
function renderRecipeSvg(r: Recipe): string {
  // 表の呼び名は「シート名＋軸の説明」で長い。1行に収まらないものが1つでもあれば、
  // 箱の高さと行間を広げて2行で見せる（切ってしまうと、どの表なのか読めなくなる）
  const srcLines = r.srcs.map(s => wrapText(s.label, RCP.SRC_W - 66, 12.5, 2));
  const dstLines = wrapText((r.dstIsOutput ? '★ ' : '') + r.dst, RCP.DST_W - 66, 12.5, 2);
  const twoLine = srcLines.some(l => l.length > 1) || dstLines.length > 1;
  const boxH = twoLine ? 46 : RCP.BOX_H;
  const rowH = twoLine ? RCP.ROW + 14 : RCP.ROW;
  /** 箱の中央にそろえて、1行なら中央・2行なら上下に振り分けて置く */
  const boxText = (x: number, mid: number, lines: string[], attrs: string): string =>
    `<text x="${x}" y="${(mid + (lines.length > 1 ? -3 : 4.5)).toFixed(1)}" ${attrs}>`
    + lines.map((ln, i) => `<tspan x="${x}" dy="${i === 0 ? 0 : 15}">${esc(ln)}</tspan>`).join('')
    + '</text>';

  const h = Math.max(96, r.srcs.length * rowH + 22);
  const cy = h / 2;
  const keyText = r.match === 'key' ? shortText(r.keys.join('・'), 26)
    : r.match === 'position' ? '同じ行どうしで対応'
      : '照合の列を読み取れず';
  const keyCaption = r.match === 'key' ? '突き合わせる列' : '対応のしかた';
  const keyW = Math.min(280, 26 + keyText.length * 12);
  const keyX = (RCP.W - keyW) / 2 + 30;
  const dstX = RCP.W - RCP.DST_W - 8;
  const p: string[] = [`<svg viewBox="0 0 ${RCP.W} ${h}" role="img" aria-label="${esc(r.dst)} のでき方">`];
  p.push('<defs><marker id="rcp-ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#7A8794"/></marker></defs>');
  // 箱の右肩に「シート」「表」と入れる。名前だけでは、それがシートなのか列なのか分からない
  const kindTag = (x: number, y: number, w: number, text: string) =>
    `<text x="${x + w - 12}" y="${y + 20}" font-size="10" fill="#7A8794" text-anchor="end">${esc(text)}</text>`;
  r.srcs.forEach((s, i) => {
    const y = 11 + i * rowH;
    const scy = y + boxH / 2;
    p.push(`<rect x="8" y="${y}" width="${RCP.SRC_W}" height="${boxH}" rx="9" fill="#fff" stroke="${GROUP_META[s.group].color}" stroke-opacity=".45"/>`);
    p.push(boxText(20, scy, srcLines[i], 'font-size="12.5" fill="#0E2A47"'));
    p.push(kindTag(8, y, RCP.SRC_W, s.kind));
    p.push(`<path d="M${8 + RCP.SRC_W},${scy} C${8 + RCP.SRC_W + 40},${scy} ${keyX - 40},${cy} ${keyX - 4},${cy}" fill="none" stroke="#B9C6D6" stroke-width="1.4"/>`);
  });
  p.push(`<text x="${keyX + keyW / 2}" y="${cy - 22}" font-size="10" fill="#7A8794" text-anchor="middle">${keyCaption}</text>`);
  p.push(`<rect x="${keyX}" y="${cy - 15}" width="${keyW}" height="30" rx="15" fill="#EAF2FB" stroke="#C9DEF4"/>`);
  p.push(`<text x="${keyX + keyW / 2}" y="${cy + 4.5}" font-size="12.5" font-weight="700" fill="#1F5FAE" text-anchor="middle">${esc(fitText(keyText, keyW - 18, 12.5))}</text>`);
  p.push(`<path d="M${keyX + keyW},${cy} L${dstX - 8},${cy}" fill="none" stroke="#7A8794" stroke-width="1.6" marker-end="url(#rcp-ar)"/>`);
  p.push(`<rect x="${dstX}" y="${cy - boxH / 2}" width="${RCP.DST_W}" height="${boxH}" rx="9" fill="#FBEFEF" stroke="#C0392B" stroke-opacity=".5"/>`);
  p.push(boxText(dstX + 14, cy, dstLines, 'font-size="12.5" font-weight="700" fill="#0E2A47"'));
  p.push(kindTag(dstX, cy - boxH / 2, RCP.DST_W, r.dstKind));
  // できるものが列なら、その列名を行き先の箱の下に出す（何ができるのかが箱だけでは分からない）
  const made = r.dstCols.length > 0 ? `できる列: ${r.dstCols.join('・')}` : 'この中の数値ができます';
  p.push(`<text x="${dstX + 14}" y="${cy + boxH / 2 + 16}" font-size="10.5" fill="#7A8794">${esc(fitText(made, RCP.DST_W - 20, 10.5))}</text>`);
  p.push('</svg>');
  return p.join('');
}

function buildDetailRows(
  pairs: PairAgg[], labels: Map<string, string>, pairKeys: Map<string, string>,
  copyQuestionByPair: Map<string, string>, regions: Region[],
): { rows: string[]; omitted: number } {
  const byId = new Map(regions.map(r => [r.id, r]));
  const endLabel = (key: string) => {
    const rid = regionIdOf(key);
    const col = prettyColumn(byId.get(rid), colNameOf(key));
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
      // キーが取れない理由は2通り。引き当て・集計の式なら読み取れなかっただけ、
    // ただのセル参照ならそもそもキーで突き合わせていない。同じ言い方にすると取り違える。
    `<td class="mono">${key ? esc(key)
      : LOOKUP_FN.test(e.evidence)
        ? '<span class="dl-none">（照合列を読み取れず）</span>'
        : '<span class="dl-none">（キーなし・同じ行の位置で対応）</span>'}</td>` +
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
    graph.sharedTemplates ?? [], buildCopyInfo(regions, (graph.edges ?? []) as Edge[]),
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
  const declaredRels = input.declaredFileRels ?? [];
  const declaredOut = buildDeclaredOutputIndex(input.artifacts ?? []);
  // ご登録いただいたのに数式・値のどちらからも検出できなかった関係を、図に描ける形で足す。
  // 貼り付け元と貼り付け先で行数がずれている（別時点のエクスポート）と手修正推定は成立せず、
  // 検出0本になる。それを落とすと「全ファイルが独立」という、担当者の説明と食い違う図になる。
  const detectedPairKeys = new Set(filePairs.map(p => filePairKey(p.from, p.to)));
  const declaredOnlyPairs: FilePair[] = [];
  for (const d of declaredRels) {
    const k = filePairKey(d.fromFile, d.toFile);
    if (detectedPairKeys.has(k) || declaredOnlyPairs.some(p => filePairKey(p.from, p.to) === k)) continue;
    // 線の色は、ご登録いただいた種別をそのまま使う。全部を同じ灰色にすると、
    // 「マスタを引き当てている」のか「集計している」のかが図から消えて、扇形の線が並ぶだけになる。
    declaredOnlyPairs.push({
      from: d.fromFile, to: d.toFile, counts: {}, total: 0,
      declaredOnly: true, declaredGroup: DECLARED_REL_GROUP[d.relType],
    });
  }
  // 役割判定・段の計算・全体関係図は「検出＋ご登録」の両方を見る。ロジックブロックや
  // 詳細は根拠のある関係だけを扱うので filePairs のまま（ここで混ぜると根拠の無い説明が出る）。
  const flowPairs = [...filePairs, ...declaredOnlyPairs];
  const fileStats = buildFileStats(regions, flowPairs, input.artifacts ?? [], declaredOut);
  const { labels: outputLabels, declared: outputsDeclared } = resolveOutputFiles(fileStats);
  const outputFiles = new Set(outputLabels);
  const masterFiles = buildMasterFileIndex(input.artifacts ?? []);
  assignFileRoles(fileStats, outputFiles, outputsDeclared, masterFiles);
  const fileNameOf = (label: string) => fileStats.get(label)?.filename ?? label;
  promoteDeclaredOutputRegions(regions, pairs, roles, declaredOut, outputFiles, outputsDeclared);
  // 最終アウトプットのブックの中で「貼り付けただけ」のシートを、受領ファイルへ結び直す。
  // 帳票ごとの関係図に点線で足して、マスタや実績がどこから来たのかを図の中で切らさない。
  const pasteOrigins = buildPasteOrigins(regions, pairs, outputFiles, fileStats, declaredRels, roles);

  const audit = input.fileRelAudit ?? [];
  // 値一致（手修正推定）は「どこの話か」で意味がまるで違うので、性質と列名を引ける形で渡す。
  // 同じシートの中の一致まで1件ずつ設問にすると、拠点別に同じ様式が並ぶブックでは数千件になる。
  const copyInfo = buildCopyInfo(regions, edges);
  const questions = buildQuestions(
    regions, pairs, warnings, labels, roles, audit, fileNameOf, declaredOut, graph.sharedTemplates ?? [],
    copyInfo,
  );
  const copyQuestionByPair = new Map<string, string>();
  for (const q of questions) if (q.refPair) copyQuestionByPair.set(q.refPair, q.id);
  // 「元データが辿れない最終アウトプット」を 03 の該当設問へ結ぶ。番号を書かないと
  // 図に「つながり未検出」とだけ出て、どこで確認すればよいのか読み手に伝わらない。
  const srcQuestionRef = questions.find(q => q.kind === '最終帳票の元データ')?.id ?? '';
  // 伺った手順のステップが登録されていれば、全体関係図はステップ帯で描く。
  // 手順が無い案件（大半）はこれまでどおり流れの段で描く。
  const stepFlow = buildStepFlow(fileStats, declaredRels, outputFiles, detectedPairKeys);
  const fileFlow = stepFlow?.svg ?? buildFileFlow(fileStats, flowPairs, outputFiles);
  // 全体関係図の凡例は、実際にその図へ描かれた種類だけを出す。4種すべてを並べると、
  // 1種類しか使われていない図の下に無関係な3行が残り、どれがこの図の線なのか分からなくなる。
  const fileFlowGroups = GROUP_ORDER.filter(g => filePairs.some(p => dominantFileGroup(p) === g)
    || declaredOnlyPairs.some(p => p.declaredGroup === g));
  const hasOrphanOutput = [...fileStats.values()].some(s => outputFiles.has(s.label) && s.inFiles.size === 0);

  // ---- 何を載せるか（アウトプット相談の指定）----
  // 未指定なら全部出す＝従来と同じ。関係図（ノード形式）は指定対象に無く、常に出る。
  const spec = input.spec ?? DEFAULT_REPORT_SPEC;
  // 保存済みの指定には overview が無いことがある（項目を後から足したため）
  const overview = spec.overview ?? [];

  // ---- 02 全体（ブック間）→ 詳細（シート・表間）の2段構え ----
  // 全体はファイル単位のフロー図、詳細は表単位のノード図（ER＋関係マップ＋操作版）。
  // 複数ファイルのときだけ「全体」を挟む。1ファイル案件ではブック間の図が1箱で意味を持たないので、
  // 従来どおり表単位の関係図から入る。
  const multiFile = fileStats.size > 1;
  const pairKeys = buildPairKeyIndex(graph.keyLinks ?? []);
  const map = buildMap('r', regions, pairs, labels, copyQuestionByPair, roles, [], pairKeys);
  // ER はロジック別ブロックの結論として各ブロック内に出す（1枚の巨大な図としては出さない）。
  // 「ER を出さない」指定はブロック側へ渡して尊重する — ここで図を作らないだけでは効かない。
  const showEr = spec.items.erDiagram;
  const { rows: detailRows, omitted: detailOmitted } = buildDetailRows(pairs, labels, pairKeys, copyQuestionByPair, regions);
  // 「何と何を、何で突き合わせて、何ができるか」を行き先ごとに1文＋1枚の図で示す
  const { list: recipes, total: recipeTotal } = buildRecipes(edges, pairs, regions, pairKeys, roles);
  // 省いた分は性質が2つある。混ぜて1つの数にすると「6か所を載せています」と出るのに
  // 4件しか無いような食い違いになるので分けて数える。
  //   truncated … 数式で作られている行き先のうち、上限で載せきれなかったぶん
  //   valueOnly … 値の一致だけで見えている行き先（2-4 は言い切る場所なので最初から載せない）
  const recipeTruncated = Math.max(0, recipeTotal - recipes.length);
  const recipeValueOnly = Math.max(0, new Set(pairs.map(p => p.to)).size - recipeTotal);
  // 担当者が登録したブック関係。全体図の直下に、根拠の有無と突合キーの候補を添えて並べる。
  // 説明文だけを並べていたときは「で、それはどの列で突き合わせているのか」が読み取れず、
  // 自動検出できなかった関係については読み合わせで毎回そこから聞き直しになっていた。
  const fileCols = buildFileColumnIndex(regions);
  // 並びは 01 のファイル一覧と同じく、名前の先頭番号（①②…）順にする。
  // 登録した順に並べると、読み合わせで 01 と行き来したときに探す順序が変わってしまう。
  // 手順のステップが登録されている案件では、ステップ順が担当者の頭の中の順番になる。
  // その場合はステップ→ファイル番号の順に並べ、図の帯と同じ順序で読めるようにする。
  const declaredRows = declaredRels
    .map(d => ({ d, hints: joinKeyHints(fileCols.get(d.fromFile), fileCols.get(d.toFile)) }))
    .sort((a, b) => {
      const sa = a.d.step ?? 99; const sb = b.d.step ?? 99;
      const na = fileNameOf(a.d.fromFile); const nb = fileNameOf(b.d.fromFile);
      return (sa - sb) || (fileOrderNo(na) - fileOrderNo(nb)) || na.localeCompare(nb, 'ja');
    });
  const showFileFlow = multiFile && spec.items.fileFlow;

  // ---- 節番号 ----
  // 出さない節がある場合は繰り上げる（01 の次が 03 になると読み合わせで指示が噛み合わなくなる）。
  // 02「再現するアウトプットの確認」は、伺った作り方（再現するもの・作られ方・前提・指示メモ）が
  // 何かしらある案件だけ。何も無いまま節を作ると、見出しだけの空の節が読み合わせの先頭に来る。
  const reproduceItems = spec.reproduce.length > 0 ? spec.reproduce : spec.overview;
  const assumeItems = spec.assumptions.length > 0 ? spec.assumptions : spec.notes;
  const hasOutcome = reproduceItems.length > 0 || spec.howMade.length > 0
    || assumeItems.length > 0 || spec.sheetGuide.length > 0;
  const secOn = {
    inventory: spec.sections.inventory,
    outcome: hasOutcome,
    flow: spec.sections.flow,
    questions: spec.sections.questions,
    nextSteps: spec.sections.nextSteps,
  };
  let secCount = 0;
  const secNo = (on: boolean) => (on ? String(++secCount).padStart(2, '0') : '');
  const noInventory = secNo(secOn.inventory);
  const noOutcome = secNo(secOn.outcome);
  const noFlow = secNo(secOn.flow);
  const noQuestions = secNo(secOn.questions);
  const noNext = secNo(secOn.nextSteps);
  // 本文から他の節を指す言い方（節を出していないときは節番号で誘導しない）
  const refQuestions = noQuestions ? `詳しくは ${noQuestions} の確認事項をご覧ください。` : '';

  // 03 の小見出しは連番。1ファイル案件では「全体（ブック間）」が無い分だけ番号が繰り上がる。
  // 小見出しの番号は「3-1」の形（節番号の 0 詰めは外す）。
  const flowNo = noFlow.replace(/^0/, '') || '3';
  let subNo = 0;
  // 03 の各節は同じつながりを別の切り口から見たもの。切り口を札で添えないと、
  // 読む側は節ごとに「前と同じ話か」を判断しながら読むことになる。
  const subH = (title: string, lens = '') =>
    `<h3 class="sub-h"><span class="n">${flowNo}-${++subNo}</span>　${esc(title)}`
    + `${lens ? `<span class="lens">切り口：${esc(lens)}</span>` : ''}</h3>`;
  // 02 の小見出しも同じ形。節番号が違うだけなので採番だけ別に持つ
  const outcomeNo = noOutcome.replace(/^0/, '') || '2';
  let subNoOut = 0;
  const subHOut = (title: string, lens = '') =>
    `<h3 class="sub-h"><span class="n">${outcomeNo}-${++subNoOut}</span>　${esc(title)}`
    + `${lens ? `<span class="lens">切り口：${esc(lens)}</span>` : ''}</h3>`;

  const dateStr = input.generatedAt.toISOString().slice(0, 10);
  // 本文（ヘッダ）は和暦式の表記にする。フッタの生成日時は機械可読のまま dateStr を使う
  const dateJa = `${input.generatedAt.getFullYear()}年${input.generatedAt.getMonth() + 1}月${input.generatedAt.getDate()}日`;
  const customer = input.customerName ? `${input.customerName}様` : 'ご担当者様';

  const sheetTotal = new Set(regions.map(r => `${r.file}\u0000${r.sheet}`)).size;
  const outStats = outputLabels.map(l => fileStats.get(l)!).filter(Boolean);
  // 冒頭のタイルは「受領 → インプット → 最終アウトプット → 確認事項」の順で読ませる。
  // 以前は「検出した表 465表」「表どうしの関係 423,321件」を出していたが、これは解析の規模で
  // あって顧客の関心事ではない（「とても複雑そう」という印象だけが残る）。表数・関係数は
  // まとめ文と 02 の図の中で、文脈が付いた形で触れる。
  const srcFileCount = [...fileStats.values()].filter(s => s.role === '元データ').length;
  const midFileCount = [...fileStats.values()].filter(s => s.role === '中間ファイル').length;
  const masterFileCount = [...fileStats.values()].filter(s => s.role === 'マスタ').length;
  // 02 を「ロジック別ブロック」で説明するための分割。ER はブロックの結論として各ブロック内に出す。
  const logicBlocks = buildLogicBlocks(regions, pairs, filePairs, outputFiles);
  const isolatedFiles = [...fileStats.values()].filter(s => s.role === '独立');
  // 03 は最終アウトプットごとに「読み方 → でき方 → 確認欄」を1セットで並べる
  const outputSections = buildOutputSections(
    regions, pairs, roles, outputFiles, logicBlocks, declaredOut, fileNameOf,
  );
  // 確認欄の記号（03-A…）は本文に出てくる順に振る。表紙の道案内から「03-A・03-B」と
  // 先に呼ぶため、節を組み立てる前にここで決めておく。
  const checkMark = new Map<ReportOutputBlock, string>();
  for (const sec of outputSections) {
    for (const b of planFor(spec.outputPlans, sec.filename)?.blocks ?? []) {
      if (b.kind === 'check' && checkMark.size < CHECK_MARKS.length) {
        checkMark.set(b, `${noFlow || '03'}-${CHECK_MARKS[checkMark.size]}`);
      }
    }
  }
  const checkMarks = [...checkMark.values()];
  // 2つまでは並べて、3つ以上は範囲で言う（「03-A〜03-D」）
  const checkRange = checkMarks.length === 0 ? ''
    : checkMarks.length <= 2 ? checkMarks.join('・')
      : `${checkMarks[0]}〜${checkMarks[checkMarks.length - 1]}`;
  // 取込時に指定されたシート役割（ファイルラベル → シート名 → 役割）
  const sheetRoleOf = new Map<string, Record<string, string> | undefined>();
  const kindOfFile = new Map<string, string | undefined>();
  for (const a of input.artifacts ?? []) {
    sheetRoleOf.set(fileLabelOf(a.filename), a.sheetRoles);
    kindOfFile.set(fileLabelOf(a.filename), a.kind);
  }
  // 貼り付けで受け渡しているタブ＝最終アウトプットのブックの中で、そのブックのどの表からも
  // 作られていないタブ（＝外から値が入ってきているタブ）。Excel に根拠が残らないのはここなので、
  // 本数を表紙のタイルに出して「ここはご説明が根拠です」と先に伝える。
  const pastedInto = new Set<string>();
  for (const sec of outputSections) {
    for (const r of regions.filter(x => x.file === sec.file)) {
      if (declaredOut.hasSheet(r.file, r.sheet)) continue;  // 帳票そのものは除く
      // インプットとして指定されたタブだけを数える。中間シート（作業用・メモ）は受け渡しではない
      if ((sheetRoleOf.get(r.file) ?? {})[r.sheet] !== 'input_data') continue;
      if (pairs.some(pr => pr.to === r.id)) continue;       // ブックの中で計算されている
      pastedInto.add(`${r.file} ${r.sheet}`);
    }
  }
  const pasteTabCount = pastedInto.size;
  // 01 のタイルに出す「再現するアウトプット」のシート名（最終帳票として指定されたもの）
  const finalSheetNames = [...new Set(outputSections.flatMap(s => s.finalSheets))];

  // ---- 01 の「まとめ」で使っていた数字 ----
  // まとめの箇条書きは廃止した。受領ファイル数・シート数・最終アウトプットはすぐ上のタイルに、
  // 内訳はすぐ下のファイル一覧に同じ数字が出ており、同じ内容を三度読ませていたため。
  // 残す価値があるのは「数式で追跡できた分と、追跡できず推定に留まる分の割合」だけなので、
  // それは 02 の導入文（これから何を説明するのか）と全体関係図の下へ文脈付きで移す。
  // ご登録の受け渡しで説明がつく（matched）ファイル対は、値一致の件数からも外す。
  // 03 の設問と同じ数え方にしないと、導入文と設問の件数が食い違って読み手が混乱する。
  const matchedFilePairs = new Set(
    audit.filter(a => a.verdict === 'matched').map(a => filePairKey(a.fromFile, a.toFile)),
  );
  const fileOfR = new Map(regions.map(r => [r.id, r.file]));
  const copyAll = pairs.filter(p => {
    if ((p.counts.copy ?? 0) === 0) return false;
    const f = fileOfR.get(p.from); const t = fileOfR.get(p.to);
    if (!f || !t || f === t) return true;
    // 向きは値の一致からは決められないので、逆向きの登録でも説明がついたものとして外す
    return !(matchedFilePairs.has(filePairKey(f, t)) || matchedFilePairs.has(filePairKey(t, f)));
  });
  const copyCount = copyAll.filter(p => copyInfo.kindOf(p) === 'cross').length;   // ブックをまたぐ＝本当の論点
  const formulaCount = pairs.length - copyAll.length;
  const matchedRels = audit.filter(a => a.verdict === 'matched').length;
  // 案件固有の前提（アウトプット相談で足したメモ）だけは自動生成の要約ではないので 01 に残す
  const premises = spec.notes;

  // ---- 01 ファイルごとの役割と中身 ----
  // 以前は「役割の一覧表」と「中身の開閉ブロック」を別々に2度並べていた。同じ17ファイルを
  // 二度読ませるうえ、表は役割順・ブロックは行数順で並びが違い、突き合わせられなかった。
  // 一覧の各行をそのまま開閉見出しにして1つにまとめ、役割ごとの区切りで並べる。
  // シートの役割は取込時に人が指定・確認した情報なので、自動推定の役割とは分けて見せる。
  const ROLE_GROUPS: { role: FileRole; cls: string; label: string }[] = [
    { role: '元データ', cls: 'src', label: '元データ' },
    { role: 'マスタ', cls: 'mst', label: 'マスタ' },
    { role: '中間ファイル', cls: 'mid', label: '中間ファイル' },
    { role: '最終アウトプット', cls: 'out', label: '最終アウトプット' },
    { role: '独立', cls: 'iso', label: 'つながりが見つからなかったファイル' },
  ];
  const REGION_CAP_PER_FILE = 8;
  const renderFileBlock = (s: FileStat): string => {
    {
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
        // 見出しの読めなかった列は、意味の分かる呼び方（東京の売上）へ直してから並べる。
        // 直しようが無いものだけが残った表は、列記号（A列 B列 …）を並べても読めないので出さない。
        // 何が並ぶ表なのかは、下の軸の説明で伝わる。
        const shown = r.columns.slice(0, 24)
          .map(c => ({ ...c, disp: prettyColumn(r, c.name) }))
          .filter(c => !/^[A-Z]{1,3}列$/.test(c.disp));
        const chips = shown.map(c => {
          const cls = keyCols.has(c.name) ? 'colchip key'
            : c.mixedFormula ? 'colchip manual'
            : c.hasFormula ? 'colchip formula'
            : c.manualNumeric > 0 ? 'colchip manual' : 'colchip';
          const mark = c.mixedFormula ? ' ⚠' : '';
          return `<span class="${cls}">${esc(c.disp)}${mark}</span>`;
        }).join('');
        const more = chips !== '' && r.columns.length > 24 ? `<span class="colchip">…他${r.columns.length - 24}列</span>` : '';
        const keyNote = r.keys?.grain
          ? `<p class="key-note">セルは <b>${esc(prettyText(r, r.keys.grain))}</b> の組合せで決まります。</p>`
          : r.keys?.axisNote
          ? `<p class="key-note">${esc(prettyText(r, r.keys.axisNote))}</p>`
          : keyCols.size > 0
            ? `<p class="key-note"><b>${esc(prettyText(r, keySummary(r)))}</b> が1行を決めるキーと推定しております。</p>`
            : '';
        const mixedCols = r.columns.filter(c => c.mixedFormula).map(c => prettyColumn(r, c.name));
        const mixedNote = mixedCols.length > 0
          ? `<p class="rnote">⚠ ${esc(mixedCols.slice(0, 3).join('、'))} で数式と手入力の混在があります。</p>` : '';
        // 縦横に何が並ぶ表なのか。1シートが複数の表に割れているとき、番地だけでは区別が付かない
        const axisNote = axisDetail(r) === '' ? '' : `<p class="key-note">${esc(axisDetail(r))}</p>`;
        return `<div class="rblock">
          <div class="rhead"><b>${esc(r.sheet)}</b><span class="loc">${esc(rangeOf(r))}</span>` +
          `<span class="rows">${r.dataRowCount.toLocaleString()}行 × ${r.columns.length}列</span>` +
          `<span class="rrole">${esc(roles.get(r.id) ?? '')}</span></div>
          <div class="colchips">${chips}${more}</div>${axisNote}${keyNote}${mixedNote}
        </div>`;
      }).join('\n');
      const moreRegions = myRegions.length > REGION_CAP_PER_FILE
        ? `<p class="tbl-note">※ 行数の多い上位 ${REGION_CAP_PER_FILE} 表を掲載しております。このファイルには全 ${myRegions.length} 表あります。</p>` : '';
      // 旧一覧表にしか無かった補足（どのシートが対象か／つながり未検出）を見出しへ引き継ぐ
      const finalSheets = s.sheets.filter(sh => declaredOut.hasSheet(s.label, sh));
      const isOut = s.role === '最終アウトプット';
      const note = isOut && finalSheets.length > 0
        ? `<span class="rnote">対象シート: ${esc(shortText(finalSheets.join('、'), 56))}</span>`
        : s.role === '独立' ? '<span class="rnote">他のファイルとのつながりが見つかっていません</span>' : '';
      // 表数・行数は解析の規模であって読み手の関心事ではないので、シート数だけを見出しに出す
      const head = `<span class="fname"><b>${esc(s.filename)}</b>${note}</span>`
        + `<span class="rows">${s.sheets.length}シート</span>`;
      if (!isOut && !spec.items.sheetDetails && s.sheets.length === 0) {
        return `    <div class="fileblk"><div class="fbrow">${head}</div></div>`;
      }
      // 最終アウトプットのブックは「タブごとの役割と中身」の表で見せる。どのタブが帳票で、
      // 何が並び、どこから来るのかが1行で並ぶと、開いたまま読み合わせができる。
      const guide = spec.sheetGuide.find(g => g.file === s.filename);
      const sourceOf = new Map((guide?.rows ?? []).map(r => [r.tab, r.source]));
      const tabTable = !isOut ? '' : `<p class="sub-lede">タブごとの役割と中身</p>
        <div style="overflow-x:auto">
          <table class="ot">
            <tr><th>タブ</th><th>役割</th><th>何が並ぶタブか</th>${sourceOf.size > 0 ? '<th>入手元（伺った内容）</th>' : ''}</tr>
            ${s.sheets.map(name => {
              const role = roleMap?.[name] ?? (kind && kind !== 'mixed' ? kind : undefined);
              const label = declaredOut.hasSheet(s.label, name) ? '最終帳票'
                : role ? (SHEET_ROLE_LABELS[role] ?? role) : '未指定';
              const axis = tabAxisText(regions, s.label, name);
              return `<tr${declaredOut.hasSheet(s.label, name) ? ' class="out"' : ''}>`
                + `<td><b>${esc(name)}</b></td><td>${esc(label)}</td>`
                + `<td>${axis === '' ? '<span class="dl-none">—</span>' : esc(axis)}</td>`
                + `${sourceOf.size > 0 ? `<td>${sourceOf.get(name) === undefined ? '<span class="dl-none">—</span>' : esc(sourceOf.get(name)!)}</td>` : ''}</tr>`;
            }).join('\n            ')}
          </table>
        </div>
        <p class="tbl-note">「何が並ぶタブか」は、いただいたファイルの見出しから読み取った内容です。${sourceOf.size > 0 ? `「入手元」は ${esc(spec.howMadeSource || '指示メモ')}に書かれている内容です。` : ''}</p>`;
      // ブックの中だけで完結している集計（月別の表を SUMIF でまとめる等）は、そのブックの
      // 話なのでここに置く。関係の一覧は行数が多いので既定は閉じておく。
      const ownPairs = pairs.filter(p =>
        fileOfR.get(p.from) === s.label && fileOfR.get(p.to) === s.label);
      const fileNote = spec.fileNotes.find(n => n.file === s.filename)?.note ?? '';
      // 一覧を添えるのは、そのブックの中の集計について一言いただいているファイルだけ。
      // 全ファイルに 30 行の表を付けると、01 が関係表の束になって読み合わせで開けなくなる。
      const inner = ownPairs.length === 0 || fileNote === '' || !spec.items.detailLogic ? '' : (() => {
        const { rows, omitted } = buildDetailRows(ownPairs, labels, pairKeys, copyQuestionByPair, regions);
        return `<p class="sub-lede">シートの中の集計（付録）</p>
        <p class="graph-guide">${sentences(
          fileNote,
          `数式でつながっている箇所は、このファイルの中で <b>${ownPairs.length}</b> 件ございました。`,
          omitted > 0 ? `そのうち流れの順に上位 ${rows.length} 件を下に載せております。` : '',
        )}</p>
        <details class="fileblk">
          <summary><b>関係の一覧を開く</b><span class="rows">${rows.length} 件</span></summary>
          <div style="overflow-x:auto">
            <table class="ot dl">
              <tr><th>元の表・列</th><th>キー</th><th>処理</th><th>先の表・列</th><th>根拠</th><th>確度</th></tr>
              ${rows.join('\n              ')}
            </table>
          </div>
        </details>`;
      })();
      return `    <details class="fileblk${isOut ? ' out' : ''}">
      <summary>${head}</summary>
      <div class="rbody">
        <!-- そのブックについて伺っている一言は、中身より先に置く（何のブックかが分かってから中身を読む） -->
        ${fileNote !== '' && inner === '' ? `<p class="graph-guide">${fileNote}</p>` : ''}
        ${isOut ? tabTable : `<p class="sub-lede">取込時にご指定・ご確認いただいたシートの役割</p>
        <div class="srchips">${roleChips || '<span class="dl-none">シート情報なし</span>'}</div>`}
        ${inner}
      </div>
      ${spec.items.sheetDetails ? `<details class="fileblk">
        <summary><b>表と列の構成を開く</b><span class="rows">${s.regionCount}表 ／ ${s.rowTotal.toLocaleString()}行</span></summary>
        <div class="rbody">
          ${regionBlocks || '<p class="dl-none">表を検出できませんでした。</p>'}
          ${moreRegions}
        </div>
      </details>` : ''}
    </details>`;
    }
  };
  const fileList = ROLE_GROUPS.map(g => {
    const list = [...fileStats.values()].filter(s => s.role === g.role)
      .sort((a, b) => (fileOrderNo(a.filename) - fileOrderNo(b.filename)) || (b.rowTotal - a.rowTotal));
    if (list.length === 0) return '';
    return `    <div class="grp-h"><span class="nrole ${g.cls}"></span>${g.label}<span class="grp-n">${list.length} ファイル</span></div>\n`
      + list.map(renderFileBlock).join('\n');
  }).filter(Boolean).join('\n');

  // ご登録の関係と自動検出の突き合わせは、専用の表を置かず 02 の全体関係図の下に一行で出す。
  // 食い違った関係（向きが逆・自動検出できず・ご登録なし）は buildQuestions が 03 の設問にしており、
  // 表に残るのは「一致」の行だけ＝読み手が何もしなくてよい行だけになっていたため。

  // ---- 質問カード ----
  // 見出しは「分析結果／伺いたいこと」ではなく「分かったこと／ご教示ください」。前者は資料が
  // 自分の処理を報告する言い方で、担当者が相手に尋ねている文章に読めない。
  // 回答欄は textarea。画面でそのまま書き込め、内容はブラウザに保存される（下部スクリプト）。
  const qCards = questions.map(q => {
    const anchor = q.id.toLowerCase();
    // 1行でも箇条書きのままにする（編集で行を足したり消したりできるようにするため）
    const askItems = Array.isArray(q.ask) ? q.ask : [q.ask];
    const ask = `<ul class="qlist">${askItems.map(a => `<li>${esc(a)}</li>`).join('')}</ul>`;
    const noAnalysis = (q.analysis ?? '').trim() === '';
    const noWhere = (q.detail ?? []).length === 0;
    // data-* は編集機能が読み書きする値。表示に使う文字列と同じものを属性にも持たせておく
    return `
    <div class="qcard${q.priority === 'high' ? ' p-high' : ''}" data-qid="${q.id}" data-priority="${q.priority}">
      <div class="qhead"><span class="qid" id="${anchor}">${q.id}</span><span class="qtag ${q.priority === 'high' ? 'high' : 'mid'}" data-role="priority">優先度 ${q.priority === 'high' ? '高' : '中'}</span><span class="qtag kind" data-role="kind">${esc(q.kind)}</span><span class="qcard-tools" hidden><button type="button" class="qdel" title="この設問を消す">削除</button></span></div>
      <div class="qtitle" data-role="title">${esc(q.title)}</div>
      <dl class="qgrid">
        <dt data-for="analysis"${noAnalysis ? ' hidden' : ''}>分かったこと</dt><dd data-role="analysis"${noAnalysis ? ' hidden' : ''}>${esc(q.analysis ?? '')}</dd>
        <dt data-for="where"${noWhere ? ' hidden' : ''}>どこか</dt><dd data-role="where"${noWhere ? ' hidden' : ''}><ul class="qwhere">${(q.detail ?? []).map(d => `<li>${esc(d)}</li>`).join('')}</ul></dd>
        <dt>ご教示ください</dt><dd data-role="ask">${ask}</dd>
      </dl>
      <label class="ans-h" for="ans-${anchor}">ご回答メモ</label>
      <textarea class="ansbox" id="ans-${anchor}" placeholder="この場でご入力いただけます"></textarea>
    </div>`;
  }).join('\n');

  // 02-1 の締め。どこまで数式で追えて、どこから追えないのかを先に伝えておくと、
  // 03 の「見つけられませんでした」が解析漏れではなく、資料の作り方の話として読める。
  const howMadeNext = [
    formulaCount > 0 ? 'ブックの中の計算は数式が残っており、そのまま読み取れました。' : '',
    copyCount > 0 || declaredOnlyPairs.length > 0
      ? '一方<b>ブックをまたぐ受け渡しは値を貼る形</b>のため数式が残らず、ファイルだけでは追いきれませんでした。' : '',
    secOn.flow ? `そこは上のご説明を基に、${noFlow} で1つずつ確認させていただけますでしょうか。` : '',
  ].filter(Boolean).join('');

  // 表紙のすぐ下に置く道案内。節の並びと、それぞれで何をするかを1行ずつ。
  // 「はじめに（全体像）」はここではなく 02-1「再現するもの」で読ませる（結論と根拠を同じ節に置く）。
  const roadmap: { no: string; title: string; text: string }[] = [
    secOn.inventory ? { no: noInventory, title: '受領データ一覧',
      text: 'いただいたファイルと、その中のタブがそれぞれ何のためのものかを確認します。' } : null,
    secOn.outcome ? { no: noOutcome, title: '再現するアウトプットの確認',
      text: `kpiee で<b>何を再現するのか</b>と、伺っている作り方・今回の前提をご確認いただきます。`
        + `以降の内容はここを前提に組み立てておりますので、はじめに置いております。` } : null,
    secOn.flow ? { no: noFlow, title: 'ロジックの確認',
      text: `<b>再現するアウトプットを1つずつ</b>、何から・何を突き合わせて作られているかを図で確認します。`
        + `相違する点は図の下の欄にご記入いただけますと幸いです。`
        + `${checkRange ? `あわせて、その場で伺いたい点を <b>${checkRange}</b> として図のそばに置いております。` : ''}` } : null,
    secOn.questions ? { no: noQuestions, title: 'ご確認いただきたい点',
      text: `${secOn.flow ? `${noFlow} で伺う内容のほかに、` : ''}いただいたファイルからは判断がつかなかった点をまとめています。` } : null,
    secOn.nextSteps ? { no: noNext, title: '今後の進め方',
      text: 'この読み合わせのあと、どのように進めるかをご説明します。' } : null,
  ].filter((r): r is { no: string; title: string; text: string } => r !== null);

  // 表題。冒頭に節の並び（01→02→…）は書かない。すぐ下に節そのものが続くため重複になる。
  const reportTitle = spec.title || 'ご提供データの構造分析レポート';
  // 「」で囲まれた案件名（例:「収支報告・4本グラフ」）だけを色で立てる。宛名は表題の上に置く
  const titleHtml = spec.title
    ? esc(spec.title).replace(/「[^」]+」/, m => `<span class="em">${m}</span>`)
    : 'ご提供データの<span class="em">構造分析</span>レポート';
  const heroH1 = `<h1>${input.customerName ? `${esc(customer)}<br>` : ''}${titleHtml}</h1>`;

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(input.customerName ? customer : '')}${esc(reportTitle)}｜dataX</title>
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
      <div class="brand">kpiee 導入支援｜dataX株式会社</div>
      ${heroH1}
      <p class="lede">${sentences(
        'kpiee で再現するアウトプットと、その作り方について、弊社の理解をまとめました。',
        '本日の読み合わせでは、<b style="color:#fff">弊社の理解と相違する点</b>をその場でお聞かせいただけますと幸いです。',
        'ご確認いただいた内容を基に、kpiee への取込設定を進めてまいります。',
        spec.focus ? `今回は特に <b style="color:#fff">${esc(spec.focus)}</b> を確認したいと考えております。` : '',
      )}</p>
      <div class="hero-meta">
        <span>宛先：<b>${esc(customer)}</b></span>
        <span>作成日：<b>${dateJa}</b></span>
        <span>作成：dataX カスタマーサクセス</span>
      </div>
    </div>
  </div>
</header>

${roadmap.length > 1 ? `
<section class="sum-sec">
  <div class="wrap">
    <div class="sumcard">
      <div class="sum-h">この資料の進め方</div>
      <p class="sum-sub">再現するアウトプットと、その作り方について、この順で読み合わせをさせていただきます。</p>
      <ul class="sumlist">
        ${roadmap.map(r => `<li><span class="sk"><span class="skn">${r.no}</span>${esc(r.title)}</span><span class="sv">${r.text}</span></li>`).join('\n        ')}
      </ul>
    </div>
  </div>
</section>` : ''}

${secOn.inventory ? `
<section class="alt">
  <div class="wrap">
    <div class="sec-head">
      <h2><span class="secno">${noInventory}</span>受領データ一覧</h2>
      <p class="sec-lede">${sentences(
        'いただいたファイルと、その中の各シートがどういう役割かの一覧です。',
        finalSheetNames.length > 0
          ? 'kpiee で再現する最終アウトプットのブックと、その中の最終帳票のシートは<b style="color:var(--red)">赤</b>で示しています。' : '',
      )}</p>
    </div>
    <div class="tiles">
      <!-- 数えているものを、読み手の関心の順（何を作るのか → 何をもらったか → どこが
           Excel から追えないか → 何を確認するか）に並べる。解析の規模（表数・関係数）は出さない -->
      ${finalSheetNames.length > 0 ? `<div class="tile out"><div class="tl">再現するアウトプット</div><div class="tv">${finalSheetNames.length}<small>シート</small></div>
        <div class="tsub">${esc(shortText(finalSheetNames.join(' ／ '), 80))}</div></div>` : `<div class="tile out"><div class="tl">最終アウトプット</div><div class="tv">${outStats.length}<small>ファイル</small></div>
        <div class="tsub">${outStats.length > 0 ? esc(shortText(outStats.map(s => s.filename).join('、'), 38)) : '未特定'}</div></div>`}
      <div class="tile"><div class="tl">いただいたファイル</div><div class="tv">${input.fileCount}<small>ファイル</small></div>
        <div class="tsub">${[srcFileCount > 0 ? `元データ ${srcFileCount}` : '', masterFileCount > 0 ? `マスタ ${masterFileCount}` : '',
          midFileCount > 0 ? `中間ファイル ${midFileCount}` : '', outStats.length > 0 ? `最終アウトプット ${outStats.length}` : '',
        ].filter(Boolean).join(' ／ ') || `${sheetTotal} シート`}</div></div>
      ${pasteTabCount > 0 ? `<div class="tile"><div class="tl">貼り付けで受け渡している箇所</div><div class="tv">${pasteTabCount}<small>タブ</small></div>
        <div class="tsub">Excel に根拠が残らないため、${secOn.outcome ? `${noOutcome} のご説明で補っています` : 'ご説明で補っています'}</div></div>` : `<div class="tile"><div class="tl">受領ファイルのシート</div><div class="tv">${sheetTotal}<small>シート</small></div>
        <div class="tsub">この中から再現の対象を選んでいます</div></div>`}
      <div class="tile warn"><div class="tl">ご確認いただきたい点</div><div class="tv">${questions.length}<small>件</small></div>
        <div class="tsub">${checkRange ? `このほか、各アウトプットについては ${noFlow} の中で直接伺います` : noQuestions ? `${noQuestions} をご覧ください` : 'お打ち合わせでご相談'}</div></div>
    </div>
    ${spec.items.fileTable ? `
    <h3 class="sub-h">ファイルごとの役割と中身</h3>
    <p class="graph-guide">各行をクリックすると、そのファイルの<b>タブごとの役割と中身</b>が開きます。「何が並ぶタブか」は、いただいたファイルの見出しから読み取った内容です。</p>
${fileList}` : ''}
  </div>
</section>` : ''}

${secOn.outcome ? `
<section>
  <div class="wrap">
    <div class="sec-head">
      <h2><span class="secno">${noOutcome}</span>再現するアウトプットの確認</h2>
      <p class="sec-lede">${sentences(
        'kpiee で再現する対象と、その作られ方について、弊社の理解をまとめました。',
        'ここが出発点になりますので、はじめにご確認いただけますでしょうか。',
      )}</p>
    </div>
    ${reproduceItems.length > 0 || spec.howMade.length > 0 ? `
    ${subHOut('伺っている作り方', '貴社のご説明')}
    <p class="graph-guide">${sentences(
      // 出典名に「A と B」が入ることがあるので、ファイルの中身との間は読点で切る
      // （「要件定義シートと試算手順とファイルの中身から」のように「と」が並ぶのを防ぐ）
      `${spec.howMadeSource === '' ? 'いただいた資料' : `いただいた${esc(spec.howMadeSource)}`}と、ファイルの中身から、弊社はこのように理解しております。`,
      secOn.flow ? `${noFlow} 以降もこの理解を前提に整理しておりますので、まずはこちらをご確認いただけますでしょうか。` : 'まずはこちらをご確認いただけますでしょうか。',
      '補うべき点がございましたら、その場でお聞かせいただけますと幸いです。',
    )}</p>
    ${reproduceItems.length > 0 ? `
    <div class="summary">
      <div class="stitle">再現するもの</div>
      <ul>
        ${reproduceItems.map(o => `<li><b>${esc(o.label)}</b>${o.text.startsWith('（') ? '' : '　'}${o.text}</li>`).join('\n        ')}
      </ul>
    </div>` : ''}
    ${spec.howMade.length > 0 ? `
    <div class="summary">
      <div class="stitle">作られ方</div>
      <ul>
        ${spec.howMade.map(n => `<li>${n}</li>`).join('\n        ')}
      </ul>
    </div>` : ''}
    ${howMadeNext ? `<p class="graph-guide">${howMadeNext}</p>` : ''}` : ''}
    ${assumeItems.length > 0 ? `
    ${subHOut('今回の前提', 'kpiee 側の作り')}
    <p class="graph-guide">kpiee 側の作りとして、今回は次の前提で考えております。ここもあわせてご確認いただけますでしょうか。</p>
    <div class="summary">
      <ul>
        ${assumeItems.map(n => `<li>${n}</li>`).join('\n        ')}
      </ul>
    </div>` : ''}
    ${spec.sheetGuide.length > 0 ? `
    <!-- 指示メモの写しは、読み合わせで頭から読む内容ではない（01 と 03 に同じ話が出る）。
         出典として残しておきたいので、既定は閉じた開閉ブロックに入れる -->
    <details class="fileblk">
      <summary><b>いただいた${esc(spec.howMadeSource || '指示メモ')}の内容を開く</b><span class="rows">タブごとの摘要とデータ元</span></summary>
      <div class="rbody">
    ${spec.sheetGuideNote === '' ? '' : `<p class="graph-guide">${esc(spec.sheetGuideNote)}</p>`}
    ${spec.sheetGuide.map(g => `
    <p class="sub-lede">${esc(g.file)}</p>
    <div style="overflow-x:auto">
      <table class="ot dl">
        <tr><th>タブ</th><th>摘要</th><th>データ元</th></tr>
        ${g.rows.map(r => `<tr><td>${esc(r.tab)}</td><td>${esc(r.note)}</td><td>${esc(r.source)}</td></tr>`).join('\n        ')}
      </table>
    </div>
    ${g.note === '' ? '' : `<p class="tbl-note">${g.note}</p>`}`).join('\n')}
      </div>
    </details>` : ''}
  </div>
</section>` : ''}

${secOn.flow ? `
<section class="alt">
  <div class="wrap">
    <div class="sec-head">
      <h2><span class="secno">${noFlow}</span>ロジックの確認</h2>
      <p class="sec-lede">${sentences(
        outStats.length > 0
          ? '再現するアウトプットが、<b>何から、どうやって作られているか</b>を確認します。'
          : 'いただいたファイルが、どのシートから、どんな計算でつながっているかを確認します。',
        '図の下の欄に、相違点や補足をご記入いただけます。',
      )}</p>
    </div>
    ${showFileFlow ? (fileFlow ? `
    ${subH(stepFlow ? 'ファイルどうしの全体関係図（伺った作成手順）' : 'ファイルどうしの全体関係図', 'ファイル単位')}
    ${stepFlow ? `<ul class="graph-guide">
      <li>各ステップの右端にある ${esc(stepFlow.backbone)} が<b>土台</b>です。左の丸が、そのステップで突き合わせる受領ファイルです。</li>
      <li><b>＋</b> は、そのステップで土台の表に足される列です。上から順に足していき、最後に${stepFlow.output === '' ? '' : ` ${esc(stepFlow.output)} `}になります。</li>
      <li>この順番と、足される列がこれで合っているかをご覧ください。</li>
    </ul>` : ''}
    <div class="map-scroll">${fileFlow}</div>
    <div class="legend">
      <span class="lg-h">丸＝ファイル</span>
      <span class="li"><span class="nrole src"></span>元データ</span>
      ${masterFileCount > 0 ? '<span class="li"><span class="nrole mst"></span>マスタ</span>' : ''}
      <span class="li"><span class="nrole mid"></span>中間ファイル</span>
      <span class="li"><span class="nrole out"></span>最終アウトプット</span>
      ${stepFlow ? '<span class="li">各段の右端＝土台のファイル（同じファイルが毎段に出ます）</span>'
        : '<span class="li"><span class="nrole iso"></span>つながり未検出</span>'}
      ${hasOrphanOutput && !stepFlow ? '<span class="li"><span class="nrole" style="border-color:#C0392B;border-style:dashed;background:#FBEFEF"></span>つながり未検出の最終アウトプット</span>' : ''}
    </div>
    ${fileFlowGroups.length > 0 || declaredOnlyPairs.length > 0 ? `<div class="legend">
      <span class="lg-h">線</span>
      ${fileFlowGroups.map(g => `<span class="li"><span class="sw${GROUP_META[g].dashed ? ' dash' : ''}" style="border-color:${GROUP_META[g].color}"></span>${esc(GROUP_META[g].label)}</span>`).join('\n      ')}
      ${declaredOnlyPairs.length > 0 ? `<span class="li"><span class="sw dot" style="border-color:${DECLARED_ONLY.color}"></span>${esc(DECLARED_ONLY.label)}</span>` : ''}
    </div>` : ''}
    ${spec.items.declaredAudit && declaredRels.length > 0 ? `<p class="tbl-note">ファイルどうしの受け渡しは、伺った内容を基に ${declaredRels.length} 件として整理しております。うち ${matchedRels} 件は、いただいたファイルの中でも同じつながりを確認できました。${matchedRels < declaredRels.length ? `確認できなかった ${declaredRels.length - matchedRels} 件は${noQuestions ? ` ${noQuestions} ` : 'お打ち合わせ'}で伺います。` : ''}</p>` : ''}
    <!-- 「ファイル間の受け渡しと、突合キーの候補」の表は置かない。受け渡し自体は上の図と
         その下の1行で伝わり、突合キーは取込設定の作業メモであって読み合わせの議題ではない。
         キーが決められない表は 04 の設問（キーの確認）で個別に伺う。 -->` : `
    <p class="sec-lede">ファイルをまたぐつながりは見つかりませんでした。各ファイルが独立して管理されている可能性があります。${refQuestions}</p>`) : ''}

    ${map ? `
    ${outputSections.map((sec, si) => {
      const secRegionOf = (k: string) => k.slice(0, k.lastIndexOf(':'));
      // 貼り付け元の受領ファイルを、この帳票の図へ点線のノードとして足す。
      // ノードはファイル1つにつき1個（受領ブックの何番目のシートかまでは図では問わない）。
      const secPastes = [...pasteOrigins].filter(([rid]) => sec.regionIds.has(rid));
      // 入手元も上流も分からないまま残った表。黙って図に置くと「起点のデータ」に見えてしまうので、
      // 図の下で名指しして確認事項にする。
      // シート単位で1回だけ挙げる（1シートが複数の表に分かれていると同じ名前が何度も並ぶ）
      const secOrphans = regions.filter(r => sec.regionIds.has(r.id)
        && !pasteOrigins.has(r.id) && !pairs.some(p => p.to === r.id))
        .filter((r, i, arr) => arr.findIndex(x => x.file === r.file && x.sheet === r.sheet) === i);
      const pasteRegions: Region[] = [];
      const pastePairs: PairAgg[] = [];
      for (const [rid, o] of secPastes) {
        // region.id は ':' を含まない約束（列名との区切りに使っている）ので '@' で作る
        const pid = `paste-origin@${o.file}`;
        if (!pasteRegions.some(x => x.id === pid)) {
          const st = fileStats.get(o.file);
          pasteRegions.push({
            id: pid, file: o.file, sheet: st?.filename ?? o.file,
            r0: 0, r1: 0, c0: 0, c1: 0, headerRow: null, columns: [], dataRowCount: st?.rowTotal ?? 0,
          });
          labels.set(pid, st?.filename ?? o.file);
          roles.set(pid, st?.role === 'マスタ' ? 'マスタ' : '元データ');
        }
        pastePairs.push({
          from: pid, to: rid, counts: {}, best: {}, total: 0,
          declaredOnly: true, declaredLabel: '貼り付けと推定', declaredNote: o.note,
        });
      }
      const secMap = buildMap(`o${si}`,
        [...regions.filter(r => sec.regionIds.has(r.id)), ...pasteRegions],
        [...pairs.filter(p => sec.regionIds.has(p.from) && sec.regionIds.has(p.to)), ...pastePairs],
        labels, copyQuestionByPair, roles,
        edges.filter(e => sec.regionIds.has(secRegionOf(e.from)) && sec.regionIds.has(secRegionOf(e.to))), pairKeys);
      // この帳票の読み方（伺った内容）。指定があれば、その並びどおりに置いていく
      const plan = planFor(spec.outputPlans, sec.filename);
      return `
    ${subH(`最終アウトプット${OUT_NO[si] ?? `(${si + 1})`}　${sec.filename}`, 'ブックの中')}
    <div class="colchips tsheets"><span class="tsh">この中で再現する対象のシート</span>${sec.finalSheets.map(sh => `<span class="colchip">${esc(sh)}</span>`).join('')}</div>
    ${plan?.blocks.some(b => 'title' in b && b.title.includes('帳票の形')) ? '' : (() => {
      // 再現する帳票が「縦に何・横に何が並び、どれが合計か」を先に置く。ここが合っていないと
      // ダッシュボードの軸がずれるので、関係図より前に読んでいただく。
      // 帳票の形を言葉でいただいている場合（同名のブロックがある）は、そちらを使う
      const shapes = sec.finalSheets.slice(0, SHAPE_SHEET_CAP)
        .map(sh => buildSheetShape(regions, sec.file, sh))
        .filter((s): s is SheetShape => s !== null);
      if (shapes.length === 0) return '';
      return `<p class="sub-lede">この帳票の形</p>\n    `
        + shapes.map(s => renderSheetShape(s, shapes.length > 1 || s.sheet !== sec.filename)).join('\n    ');
    })()}
    ${sec.blocks.length === 0 ? `<p class="sec-lede"><b>ほかのファイルからこの帳票への受け渡しは、数式の形では見つけられませんでした。</b>`
      + `${srcQuestionRef ? `確認事項の <b>${srcQuestionRef}</b> に記載しております。` : 'お打ち合わせでご確認をお願いいたします。'}`
      + 'ブックの中での計算は、下の図でご覧いただけます。</p>' : ''}
    ${secPastes.length > 0 ? `<p class="graph-guide">ブックの中の ${secPastes.length} シートは、受領ファイルを貼り付けたものと見ております。その入手元を図の<b>点線</b>で結んでいます（列の見出しの一致、または伺った内容が根拠です）。読み合わせでこの対応が合っているかをご確認ください。</p>` : ''}
    ${(() => {
      // 数式に残らない受け渡しは、伺った内容が唯一の根拠になる。それを教えていただいて
      // いるファイルでは、「分かりません」ではなく「こう理解しております」の形で出す
      const og = spec.sheetOrigins.find(o => o.file === sec.filename);
      if (og) {
        return `<p class="graph-guide">数式・列見出しからは入手元を特定できなかったシートが ${secOrphans.length} 枚ありましたが、`
          + `いただいた内容${noOutcome ? `（${noOutcome}）` : ''}で判明しております。この理解で合っているかをご確認ください。</p>\n`
          + `<ul class="graph-guide">${og.items.map(it => `\n      <li><b>${esc(it.sheets)}</b> ＝ ${esc(it.from)}</li>`).join('')}\n    </ul>`;
      }
      if (secOrphans.length === 0) return '';
      return `<p class="graph-guide">入手元を特定できなかったシートが ${secOrphans.length} 枚あります：`
        + `${secOrphans.slice(0, 6).map(r => `<b>${esc(r.sheet)}</b>`).join('・')}`
        + `${secOrphans.length > 6 ? ` ほか ${secOrphans.length - 6} 枚` : ''}。何から作っていらっしゃるかをご教示ください。</p>`;
    })()}
    ${(() => {
      // 表単位の関係図は、経路を追うときに開く付録。読み合わせでは帳票の読み方を先に見て、
      // 細かい線は必要になったときだけ開く（開いたままだと図が本文より大きくなる）
      const graphBody = secMap === null ? '' : `<div class="map-static map-scroll" data-graph="-o${si}">${secMap.svg}</div>
      ${spec.items.interactiveGraph ? `<div class="map-interactive relgraph-wrap" id="relgraph-wrap-o${si}" data-relgraph="-o${si}">
        <figure class="relgraph-stage lightmode" id="relgraph-o${si}" aria-label="表どうしの関係グラフ（操作可能）"></figure>
        <aside class="relgraph-panel">
          <div class="relgraph-crumbs" id="relgraph-crumbs-o${si}"><span class="cur">表を選択</span></div>
          <div class="relgraph-pbody" id="relgraph-pbody-o${si}"><div class="empty">左のグラフで<b>表</b>をクリックすると、上流・下流の表と<b>最終アウトプットまでの経路</b>がここに表示され、そのまま詳しくご覧いただけます。</div></div>
        </aside>
      </div>
      <script type="application/json" id="relgraph-data-o${si}">${JSON.stringify(secMap.data).replace(/</g, '\\u003c')}</script>` : ''}
      ${secMap.omittedNodes > 0 ? `<p class="tbl-note">※ つながりの多い表を優先して表示しております。ほか ${secMap.omittedNodes} 表は省略しております。</p>` : ''}
      <div class="legend">
        <span class="lg-h">丸＝表</span>
        <span class="li"><span class="nrole src"></span>元データ</span>
        <span class="li"><span class="nrole mst"></span>マスタ</span>
        <span class="li"><span class="nrole mid"></span>中間集計</span>
        <span class="li"><span class="nrole out"></span>最終アウトプット</span>
        <span class="li"><span class="nrole iso"></span>独立</span>
      </div>
      <div class="legend">
        <span class="lg-h">線</span>
        ${GROUP_ORDER.map(g => `<span class="li"><span class="sw${GROUP_META[g].dashed ? ' dash' : ''}" style="border-color:${GROUP_META[g].color}"></span>${esc(GROUP_META[g].label)}</span>`).join('\n        ')}
        ${secPastes.length > 0 ? `<span class="li"><span class="sw dot" style="border-color:${DECLARED_ONLY.color}"></span>点線＝貼り付け元と見ている受領ファイル</span>` : ''}
      </div>
      ${spec.items.interactiveGraph ? '<p class="tbl-note only-print">※ 印刷では静止画になります。表をクリックすると計算ロジックが開きますので、詳しくはブラウザでご覧ください。</p>' : ''}`;
      const auto: AutoBlocks = {
        recipes: sec.blocks.map((b, i) =>
          renderLogicBlock(b, i + 1, regions, graph.keyLinks ?? [], labels, fileNameOf, showEr)).join('\n'),
        graph: graphBody === '' ? '' : `<details class="fileblk">
      <summary><b>表どうしの関係図（クリックで開く・付録）</b><span class="rows">細かい経路を追うとき用</span></summary>
      ${graphBody}
    </details>`,
      };
      if (!plan) return `${auto.graph}\n    ${auto.recipes}`;
      return plan.blocks
        .map((b, i) => renderOutputBlock(b, checkMark.get(b) ?? '', `o${si}-${i}`, auto))
        .join('\n    ');
    })()}`;
    }).join('\n')}

    ${isolatedFiles.length > 0 ? `
    ${subH('つながりが検出できなかったファイル', 'つながり未検出')}
    <div class="lb iso">
      <div class="lb-head"><span class="lb-no">—</span>
        <div><b>${isolatedFiles.map(s => esc(s.filename)).join('、')}</b></div>
      </div>
      <div class="lb-step"><span class="lb-st">状況</span>
        <p>これらのファイルは、他のどのファイルとも数式でも値でもつながっていませんでした。${isolatedFiles.some(s => s.regionCount > 0) ? 'システムからの出力をそのまま貼ったファイルの場合、' : ''}どこへどうやって取り込まれているかが Excel 上に根拠として残りません。${refQuestions}</p>
      </div>
    </div>` : ''}

    <!-- 「何と何を、何で突き合わせて、何ができるか」の節は置かない。同じ内容を帳票ごとの
         節（レシピ図と関係図）で見ているため、ここで全案件ぶんを並べると三度目の説明になる。 -->
` : `
    <p class="sec-lede">表どうしをつなぐ数式も、値の一致も見つかりませんでした。各表が独立して管理されている可能性があります。${refQuestions}</p>`}
  </div>
</section>` : ''}

${secOn.questions ? `
<!-- 節番号は案件で変わるため、「はじめに」からのリンク先は番号ではなく固定の id で指す -->
<section class="alt" id="sec-questions">
  <div class="wrap">
    <div class="sec-head">
      <h2><span class="secno">${noQuestions}</span>ご確認いただきたい点　<span id="qcount">${questions.length}</span>件</h2>
      <p class="sec-lede" id="qlede">${sentences(
        `${secOn.flow ? `${noFlow} で伺う内容のほかに、` : ''}以下の <span id="qcount2">${questions.length}</span> 点は、いただいたファイルからは判断がつきませんでした。`,
        'お打ち合わせの場で結構ですので、分かる範囲でお聞かせください。',
        'メモ欄はこの画面に直接ご入力いただけます。入力内容はこのブラウザに保存され、印刷してもそのまま残ります。',
      )}</p>
      <!-- 読み合わせの前に、こちらで文面を直したり、要らない設問を消したりするための道具。
           編集内容はブラウザに保存され、「HTMLとして保存」で配布用のファイルにも焼き込める。 -->
      <div class="qedit-bar" id="qedit-bar" hidden>
        <button type="button" id="qedit-toggle">設問を編集する</button>
        <span class="qedit-tools" hidden>
          <button type="button" id="qedit-add">＋ 設問を追加</button>
          <button type="button" id="qedit-export">HTML として保存</button>
          <button type="button" id="qedit-reset">元に戻す</button>
          <span class="qedit-note">文章はクリックして直接書き換えられます。番号は本文からの参照を保つため振り直しません。</span>
        </span>
      </div>
    </div>
    <div id="qcards">${qCards}</div>
  </div>
</section>` : ''}

${secOn.nextSteps ? `
<section>
  <div class="wrap">
    <div class="sec-head">
      <h2><span class="secno">${noNext}</span>今後の進め方</h2>
    </div>
    <div class="steps">
      <div class="step"><div class="no">1</div>
        <h3>本資料の読み合わせ<span class="who">貴社 × 弊社</span></h3>
        <p>30〜60分のお打ち合わせで、${[checkRange ? `${noFlow} の図のそばにある確認欄（<b>${checkRange}</b>）` : '', noQuestions && questions.length > 0 ? `${noQuestions} の確認事項（<b>Q-01〜${questions[questions.length - 1].id}</b>）` : ''].filter(Boolean).join('と、') || '確認事項'}についてご回答をお願いできますと幸いです。分かる範囲で結構です。</p>
      </div>
      <div class="step"><div class="no">2</div>
        <h3>定義の確定・追加データのご提供<span class="who">貴社 × 弊社</span></h3>
        <p>ご回答を基にデータ定義を確定いたします。不足データがあればご提供をお願いいたします。</p>
      </div>
      <div class="step"><div class="no">3</div>
        <h3>kpiee への取込設定・KPI ツリー構築<span class="who">弊社主導</span></h3>
        <p>確定した構造に基づき、kpiee のデータ取込と KPI の紐付けを設定いたします。手転記いただいていた箇所は自動化されます。</p>
      </div>
      <div class="step"><div class="no">4</div>
        <h3>数値検証・運用開始<span class="who">貴社 × 弊社</span></h3>
        <p>既存の Excel 報告と kpiee の数値を突き合わせ、一致を確認してから運用に切り替えます。</p>
      </div>
    </div>
    <div class="callout warn">
      <span>本資料には、いただいたデータの数値そのものは含めておりません。列名・数式・行数などの構成のみを記載しております。役割やキーの表記には弊社の理解が含まれますので、読み合わせでのご指摘を反映して更新版をお渡しいたします。</span>
    </div>
  </div>
</section>` : ''}

<footer>
  <div class="wrap">© dataX Inc.　|　kpiee データ構造分析レポート　${dateStr} 生成　|　本資料は貴社との確認用資料であり、社外への共有はお控えください。</div>
</footer>
<script>${REPORT_PRINT_JS}</script>
${secOn.questions ? `<script>${REPORT_QEDIT_JS}</script>` : ''}
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
/* ---- 日本語の折り返し ----
   既定では文節を無視した位置で改行されるため、読点・助詞の途中で切れて読みにくい。
   auto-phrase で文節境界に寄せ、pretty で最終行に1〜2文字だけ残るのを防ぐ。
   未対応ブラウザは値を無視するだけなので、従来どおりの折り返しに戻る。 */
p,li,dd,dt,td,th,summary,.lede,.sec-lede,.tsub,.rnote,.tbl-note,.qtitle,.callout span,.seg-list p{word-break:auto-phrase;text-wrap:pretty}
/* 文を1つの塊として扱う。入る文はまるごと1行に収まり、長い文だけが内部で折り返す。
   未対応ブラウザでも inline-block は効くので、従来どおりの折り返しに戻るだけ。 */
.s{display:inline-block}
h1,h2,h3,h4,.sub-h,.stitle,.lb-head,.grp-h{word-break:auto-phrase;text-wrap:balance}
.wrap{max-width:1060px;margin:0 auto;padding:0 28px}
header{background:var(--ink);color:#fff;position:relative;overflow:hidden}
header::after{content:'';position:absolute;right:-120px;top:-120px;width:420px;height:420px;border-radius:50%;background:radial-gradient(circle,rgba(61,155,233,.25),transparent 70%);pointer-events:none}
.hero{padding:64px 0 52px;position:relative;z-index:1;max-width:940px}
.brand{font-size:12px;letter-spacing:.04em;color:var(--sky);margin-bottom:20px}
h1{font-family:var(--disp);font-weight:900;font-size:34px;line-height:1.5;letter-spacing:.02em;margin-bottom:16px}
h1 .em{color:var(--sky)}
.lede{color:#C6D6E8;font-size:15px}
.hero-meta{display:flex;gap:10px;margin-top:24px;flex-wrap:wrap}
.hero-meta span{font-size:12px;border:1px solid rgba(255,255,255,.28);border-radius:999px;padding:4px 14px;color:#D8E4F2}
.hero-meta span b{color:#fff;font-weight:500}
section{padding:60px 0}
section.alt{background:#fff}
.sec-head{margin-bottom:32px}
/* 節番号は読み合わせで「02 の話です」と口頭で指す目印。小さく薄いと目印にならないので、
   番号だけを大きな数字として立てる。英字の飾り（FLOW &amp; LOGIC 等）は情報が無いので廃止 */
h2{display:flex;align-items:center;gap:13px;flex-wrap:wrap}
.secno{font-family:var(--disp);font-size:30px;font-weight:900;line-height:1;color:var(--blue);letter-spacing:.02em;flex:none;position:relative;padding-right:16px}
.secno::after{content:'';position:absolute;right:0;top:1px;bottom:1px;width:1px;background:var(--line)}
h2{font-family:var(--disp);font-weight:700;font-size:26px;color:var(--ink);line-height:1.5}
/* 本文の幅は図や表と同じにする。ここだけ 46em で止めると、右側が大きく空いた状態で
   行が折り返り、「なぜここで切れたのか」が分からない見え方になる */
.sec-lede{margin-top:12px;color:var(--text)}
.tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:18px}
.tile{background:#fff;border:1px solid var(--line);border-radius:16px;padding:20px 22px}
.tile .tl{font-size:12px;color:var(--sub);letter-spacing:.04em}
.tile .tv{font-family:var(--mono);font-size:30px;color:var(--ink);line-height:1.4;margin-top:2px}
.tile .tv small{font-size:14px;color:var(--sub);margin-left:2px}
/* タイルの補足行。数字だけでは「で、それが何なのか」が伝わらないので、対象名や参照先を1行添える */
.tile .tsub{font-size:11.5px;color:var(--sub);line-height:1.5;margin-top:4px;overflow-wrap:anywhere}
.tile.warn{border-top:4px solid var(--amber)}
.tile.warn .tv{color:var(--amber)}
/* 最終アウトプット＝kpiee で再現する対象。読み合わせの目的地なので色で際立たせる */
.tile.out{border-top:4px solid var(--red)}
.tile.out .tv{color:var(--red)}
/* ---- 表紙直後の「はじめに」----
   結論を 02 の導入に置くと、読む側は 01 のファイル一覧を通り過ぎるまで全体像に出会えない。
   先に「何が何から作られているか」の答えを置き、01 以降をその根拠として読ませる */
.sum-sec{padding:44px 0}
.sumcard{background:#fff;border:1px solid var(--line);border-top:4px solid var(--blue);border-radius:16px;padding:26px 30px}
.sum-h{font-family:var(--disp);font-weight:700;font-size:19px;color:var(--ink)}
.sum-sub{font-size:12px;color:var(--sub);margin-top:2px}
.sumlist{list-style:none;display:flex;flex-direction:column;gap:13px;margin-top:18px}
/* 左の見出しは番号＋節名で必ず2行になる。本文が1行の行を上端でそろえると番号の横だけに
   文字が来て上に寄って見えるので、中央でそろえて番号と節名の間に置く */
.sumlist li{display:flex;gap:16px;align-items:center}
/* 左の見出し語は、読み合わせで「ここの話です」と指すための目印 */
/* 節番号と節名を自動折り返しに任せると、節名の中に句切り（「の」など）がある行だけ
   「02 ロジックの」／「確認」のように途中で折れて、行ごとに見え方が変わってしまう。
   番号を必ず1行目、節名を必ず2行目に固定し、幅は最も長い節名が1行に収まるまで広げる。
   行送りは倍率ではなく実寸をそろえる（12px×2.1＝25.2px＝右の 14px×1.8） */
.sumlist .sk{flex:0 0 136px;font-size:12px;font-weight:700;color:var(--blue);letter-spacing:.04em;line-height:2.1}
.sumlist .sk .skn{display:block}
.sumlist .sv{flex:1;min-width:0;font-size:14px;line-height:1.8}
.sum-next{margin-top:18px;padding-top:15px;border-top:1px solid var(--line);font-size:13px}
.sum-next a{color:var(--blue);text-decoration:none;border-bottom:1px solid #A9C8E8;font-weight:700}
.sum-next a:hover{border-bottom-color:var(--blue)}
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
/* 伺った内容だけが根拠の線。値一致の破線ともう一段違う点線にする */
.legend .sw.dot{border-top-style:dotted}
/* 折りたたみブロック（01 のブック別）。三角は自前で描く */
details.fileblk>summary{list-style:none}
details.fileblk>summary::-webkit-details-marker{display:none}
details.fileblk>summary::before{content:'▸';color:var(--blue);transition:transform .2s}
details.fileblk[open]>summary::before{transform:rotate(90deg)}
.loc{font-family:var(--mono);font-size:11px;color:var(--sub)}
.rows{font-family:var(--mono);font-size:11px;color:var(--sub);margin-left:auto}
.rbody{padding:14px 20px 18px}
.colchips{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0 4px}
/* 対象シートの一覧。文中に並べると折り返しが崩れるため、チップとして独立させる */
.tsheets{align-items:center;gap:6px;margin:10px 0 16px}
.tsh{font-size:11.5px;font-weight:700;color:var(--sub);letter-spacing:.04em;margin-right:4px}
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
/* 「どこか」の内訳。ファイル名・シート名・列名が縦に揃うと、読み合わせで指しながら追える */
.qwhere{list-style:none;padding:0;margin:0;font-size:12.5px}
.qwhere li{padding-left:14px;position:relative;line-height:1.7}
.qwhere li+li{border-top:1px dotted var(--line)}
.qwhere li::before{content:'・';position:absolute;left:0;color:var(--sub)}
/* ご回答メモ。画面上でそのまま入力でき、内容はブラウザに保存される。印刷にもそのまま出る */
/* ---- 03 設問の編集（読み合わせ前に文面を直す・要らない設問を消す）---- */
.qedit-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:14px}
.qedit-bar button{font-family:var(--body);font-size:12.5px;border:1px solid var(--line);background:#fff;
  color:var(--ink);border-radius:8px;padding:5px 12px;cursor:pointer}
.qedit-bar button:hover{border-color:var(--blue);color:var(--blue)}
.qedit-tools{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
/* display を指定した要素は hidden 属性（UA の display:none）に勝ってしまうので明示する。
   これが無いと JS 無効の環境で編集の道具立てだけが出る */
.qedit-bar[hidden],.qedit-tools[hidden],.qcard-tools[hidden]{display:none}
.qedit-note{font-size:11.5px;color:var(--sub)}
.qcard-tools{margin-left:auto}
.qcard-tools .qdel{font-family:var(--body);font-size:11.5px;border:1px solid #E8C9C9;background:#fff;color:var(--red);
  border-radius:8px;padding:3px 10px;cursor:pointer}
.qaddrow{display:block;margin-top:6px;font-family:var(--body);font-size:11.5px;border:1px dashed var(--line);
  background:#fff;color:var(--sub);border-radius:8px;padding:3px 10px;cursor:pointer}
/* 編集中だけ、書き換えられる場所が分かるようにする */
#qcards.editing [contenteditable]{outline:1px dashed #C9DEF4;outline-offset:2px;border-radius:4px}
#qcards.editing [contenteditable]:focus{outline:2px solid var(--blue);background:#fff}
#qcards.editing [data-role=priority]{cursor:pointer}
.ansbox{margin-top:12px;display:block;width:100%;border:1.5px dashed var(--line);border-radius:10px;min-height:76px;padding:10px 12px;font-family:var(--body);font-size:13px;line-height:1.75;color:var(--text);background:#FCFDFE;resize:vertical}
.ansbox::placeholder{color:var(--sub)}
.ansbox:focus{outline:none;border-color:var(--blue);border-style:solid;background:#fff}
.ans-h{display:block;font-size:11.5px;font-weight:700;color:var(--sub);letter-spacing:.04em;margin-top:14px}
.qlist{margin:0;padding-left:1.15em}
.qlist li{margin-top:3px}
.qlist li:first-child{margin-top:0}
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
  /* 幅が狭いと見出し語と本文が同じ行に並びきらず、本文が数文字ずつに折り返される */
  .sumlist li{flex-direction:column;gap:2px}
  .sumlist .sk{flex:none;line-height:1.6}
}
.via{font-family:var(--mono);font-size:10.5px;color:var(--sub);margin-left:8px;white-space:nowrap}

/* ---- 01 ブックの中身（シート役割＋列構成）---- */
.fileblk{background:#fff;border:1px solid var(--line);border-radius:14px;margin-bottom:10px;overflow:hidden}
.fileblk>summary{cursor:pointer;padding:13px 18px;display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;font-size:14px}
.fileblk>summary:hover{background:var(--blue-bg)}
.fileblk[open]>summary{border-bottom:1px solid var(--line)}
.fileblk>summary b{overflow-wrap:anywhere}
/* 中身を出さない指定のときの行。開閉しないので summary と同じ見た目だけを持たせる */
.fileblk>.fbrow{padding:13px 18px;display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;font-size:14px}
.fileblk>.fbrow b{overflow-wrap:anywhere}
/* ファイル名と補足を1列にまとめ、規模は右端に寄せる */
.fname{display:flex;flex-direction:column;gap:3px;flex:1 1 auto;min-width:240px}
.fileblk>summary .rnote{font-size:11.5px;line-height:1.5}
/* details の余白は .rbody が持っているが、包んでいない箇所（入れ子の開閉ブロックなど）では
   文字や表が枠線に貼りついて見える。直下の要素にも同じ左右の余白を入れてそろえる。
   関係図（map-*）は枠いっぱいに見せたいので左右の余白からは外す */
.fileblk>*:not(summary):not(.rbody):not([class*="map-"]){padding-left:20px;padding-right:20px}
.fileblk>summary+*:not(.rbody){margin-top:14px}
.fileblk>*:not(summary):not(.rbody):last-child{padding-bottom:16px}
/* 最終アウトプット＝kpiee で再現する目的地。01 はファイルとタブの一覧なので、
   どのブックのどのタブが目的地なのかを、開かなくても色で分かるようにする。
   色は表紙のタイル（.tile.out）と関係図の凡例で使っている赤にそろえる */
.fileblk.out{border-left:4px solid var(--red)}
.fileblk.out>summary .rnote{color:var(--red)}
.ot tr.out td{background:var(--red-bg)}
.ot tr.out td:first-child b{color:var(--red)}
.ot tr.out td:nth-child(2){color:var(--red);font-weight:700}
/* 役割ごとの区切り見出し。ファイル一覧を役割別にまとめるため */
.grp-h{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:700;margin:24px 0 8px}
.grp-h:first-of-type{margin-top:14px}
.grp-n{font-family:var(--mono);font-size:11px;font-weight:400;color:var(--sub);margin-left:auto}
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

/* ---- 02 伺った受け渡しの一覧（全体関係図の直下）---- */
.seg-list{font-size:12.5px;line-height:1.8}
.seg-list p{margin:0}
.seg-list p+p{margin-top:7px;padding-top:7px;border-top:1px dashed var(--line)}
/* 伺った手順のステップ番号。図の帯と一覧を同じ番号で行き来できるようにする */
.stepchip{display:inline-block;font-size:10.5px;font-weight:700;color:var(--blue);background:var(--blue-bg);
  border:1px solid #C9DEF4;border-radius:6px;padding:1px 7px;margin-bottom:3px}
/* 突合キーの候補。列名とその根拠（何をもってキーと見たか）を1行で並べる */
.kh{line-height:1.5}
.kh+.kh{margin-top:4px}
.kh b{font-size:12px}
.kh span{display:block;font-size:10.5px;color:var(--sub)}
/* ---- 02「何と何を、何で突き合わせて、何ができるか」---- */
.rcp{border:1px solid var(--line);border-radius:14px;padding:14px 16px 8px;margin-top:14px;background:#fff}
.rcp-f{font-size:11.5px;font-weight:700;color:var(--sub);letter-spacing:.04em;margin-bottom:4px}
.rcp-t{font-size:13.5px;line-height:1.9;margin-bottom:6px}
.rcp-t b{color:var(--ink)}
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
/* 小見出しの番号（2-1 など）も口頭で指す。本文と同じ濃さでは埋もれる */
.sub-h .n{color:var(--blue);margin-right:2px}
/* 各節は同じ関係を別の切り口で見ている。切り口を書かないと、
   読む側は節ごとに「前と同じ話か」を判断しながら読むことになる */
.sub-h .lens{font-family:var(--body);font-size:11.5px;font-weight:700;letter-spacing:.04em;
  color:var(--blue);background:var(--blue-bg);border-radius:999px;padding:3px 11px;
  margin-left:10px;vertical-align:2px;white-space:nowrap}
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
.node .lbl{fill:var(--glbl);font-size:13.5px;font-weight:600;text-anchor:middle;paint-order:stroke;stroke:var(--gbg);stroke-width:3.4px;stroke-linejoin:round;pointer-events:none}
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
.pname{font-size:15px;font-weight:800;color:var(--ink);line-height:1.35;margin:0 0 3px}
/* どのファイルの、シートなのか表なのか。名前だけでは分からないので必ず添える */
.p-where{font-size:11px;color:var(--sub);line-height:1.5;margin:0 0 8px;overflow-wrap:anywhere}
/* どこから、どんな処理で作られているかの一文 */
.p-how{font-size:12px;line-height:1.75;color:var(--text);background:var(--blue-bg);border:1px solid #C9DEF4;border-radius:8px;padding:8px 10px}
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
/* 「この表の項目はどう作られるか」。列ごとに 項目名／種別 → 元 → 代表の数式 を1枚で読ませる。
   売上・費用のような指標を選んだとき、その1行がどこから来たのかを図から離れずに追えるようにする */
.p-items{display:flex;flex-direction:column;gap:6px}
.p-item{border:1px solid var(--line);border-radius:10px;padding:7px 10px;background:#fff}
.pi-h{display:flex;align-items:baseline;gap:8px}
.pi-col{font-size:12px;font-weight:700;color:var(--ink);overflow-wrap:anywhere}
.pi-how{margin-left:auto;font-size:10px;color:var(--sub);white-space:nowrap}
.pi-src{font-size:11px;color:var(--sub);margin-top:3px;overflow-wrap:anywhere}
.pi-fx{font-family:var(--mono);font-size:10.5px;color:var(--blue);margin-top:3px;overflow-wrap:anywhere;line-height:1.6}
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
  /* 編集の道具は紙に出さない */
  .qedit-bar,.qcard-tools,.qaddrow{display:none !important}
  #qcards.editing [contenteditable]{outline:none}
  /* 印刷時は折りたたみを全て開いて紙に載せる（details[open] は JS で付ける） */
  .fileblk{page-break-inside:avoid}
  .fileblk>summary{list-style:none}
  /* 操作版は紙に出せないので静的SVGへ差し替える */
  .map-interactive{display:none!important}
  .map-static{display:block!important}
  .only-print{display:inline}
  .only-screen{display:none}
  /* ご回答メモは入力済みの内容をそのまま紙に出す。空欄なら手書き用の枠として残す */
  .ansbox{border-color:#B9C6D6;background:#fff;color:#000;overflow:hidden}
  .ansbox::placeholder{color:transparent}
}

/* ---- 03 の確認欄（図のそばで、その場で答えていただく箱）----
   04 の設問カードと違い、こちらは図の直後に置いて「この図のここ」を尋ねる。
   青枠にして、本文（白）とも設問カード（橙の左線）とも見分けが付くようにする */
.chk{margin:16px 0 6px;border:2px solid #1F5FAE;border-radius:12px;background:#F2F7FD;padding:12px 14px}
.chk-h{display:inline-block;background:#1F5FAE;color:#fff;font-size:11px;font-weight:700;border-radius:999px;padding:3px 11px;letter-spacing:.05em}
.chk-q{margin:9px 0 0;font-size:14.5px;font-weight:700;color:#0E2A47;line-height:1.6}
.chk-a{margin:6px 0 0;font-size:12.5px;color:#4b5563;line-height:1.7}
.chk .ansbox{margin-top:9px;background:#fff;border-color:#9FC0E4}
@media print{.chk{break-inside:avoid}}
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

// ご回答メモの保存と高さ調整は REPORT_QEDIT_JS 側で面倒を見る（設問の作り直しと同じ場所に置く。
// ここで別に束ねると、設問を編集して作り直した後のカードにイベントが付かない）。
`;

/**
 * 03「ご確認いただきたい点」の編集。
 *
 * なぜ必要か:
 *   自動で出した設問は、そのまま顧客へ出せるものと、こちらの言い方に直したいもの、
 *   案件では論点にならないものが混ざる。これまではレポートを再生成しないと直せなかったため、
 *   読み合わせの直前に文面を整えることができなかった。
 *
 * できること: 文章の書き換え／行の追加・削除／設問の追加・削除／優先度と種別の切り替え。
 * 保存は2段構え —
 *   ・自動保存（localStorage）… 同じブラウザで開き直しても消えない
 *   ・HTML として保存      … 編集後の状態を焼き込んだファイルを書き出す（配布・添付用）
 * 番号は振り直さない。本文（02 の説明文や図のラベル）から Q-01 のように参照しているため、
 * 振り直すと参照だけが古い番号を指す。
 * ※テンプレートリテラルに埋めるためバッククォート/${ は使わない。
 */
const REPORT_QEDIT_JS = `
(function(){
  var wrap = document.getElementById('qcards');
  var bar = document.getElementById('qedit-bar');
  if (!wrap || !bar) return;
  var KEY = 'kpiee-qedit:' + location.pathname;
  var MEMO = 'kpiee-ansmemo:' + location.pathname + ':';
  var tools = bar.querySelector('.qedit-tools');
  var editing = false;

  function txt(el){ return el ? (el.textContent || '').replace(/\\s+$/, '') : ''; }
  function items(dd){
    var out = [], lis = dd ? dd.querySelectorAll('li') : [];
    for (var i = 0; i < lis.length; i++) { var t = txt(lis[i]).trim(); if (t) out.push(t); }
    return out;
  }
  /** 画面のカードから状態を読む。表示中の DOM がそのまま保存対象になる */
  function readState(){
    var out = [], cards = wrap.querySelectorAll('.qcard');
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i];
      out.push({
        id: c.getAttribute('data-qid') || '',
        priority: c.getAttribute('data-priority') === 'high' ? 'high' : 'mid',
        kind: txt(c.querySelector('[data-role=kind]')).trim(),
        title: txt(c.querySelector('[data-role=title]')).trim(),
        analysis: txt(c.querySelector('[data-role=analysis]')).trim(),
        where: items(c.querySelector('[data-role=where]')),
        ask: items(c.querySelector('[data-role=ask]'))
      });
    }
    return out;
  }
  function esc(s){
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function liList(cls, arr){
    var h = '';
    for (var i = 0; i < arr.length; i++) h += '<li>' + esc(arr[i]) + '</li>';
    return '<ul class="' + cls + '">' + h + '</ul>';
  }
  function cardHtml(q){
    var anchor = q.id.toLowerCase();
    var hiA = q.analysis ? '' : ' hidden';
    var hiW = q.where.length ? '' : ' hidden';
    return '<div class="qcard' + (q.priority === 'high' ? ' p-high' : '') + '" data-qid="' + esc(q.id) + '" data-priority="' + q.priority + '">'
      + '<div class="qhead"><span class="qid" id="' + anchor + '">' + esc(q.id) + '</span>'
      + '<span class="qtag ' + q.priority + '" data-role="priority">優先度 ' + (q.priority === 'high' ? '高' : '中') + '</span>'
      + '<span class="qtag kind" data-role="kind">' + esc(q.kind) + '</span>'
      + '<span class="qcard-tools"' + (editing ? '' : ' hidden') + '><button type="button" class="qdel" title="この設問を消す">削除</button></span></div>'
      + '<div class="qtitle" data-role="title">' + esc(q.title) + '</div>'
      + '<dl class="qgrid">'
      + '<dt data-for="analysis"' + hiA + '>分かったこと</dt><dd data-role="analysis"' + hiA + '>' + esc(q.analysis) + '</dd>'
      + '<dt data-for="where"' + hiW + '>どこか</dt><dd data-role="where"' + hiW + '>' + liList('qwhere', q.where) + '</dd>'
      + '<dt>ご教示ください</dt><dd data-role="ask">' + liList('qlist', q.ask) + '</dd>'
      + '</dl>'
      + '<label class="ans-h" for="ans-' + anchor + '">ご回答メモ</label>'
      + '<textarea class="ansbox" id="ans-' + anchor + '" placeholder="この場でご入力いただけます"></textarea>'
      + '</div>';
  }
  function render(state){
    var h = '';
    for (var i = 0; i < state.length; i++) h += cardHtml(state[i]);
    wrap.innerHTML = h;
    restoreMemos();
    if (editing) applyEditable(true);
    count(state.length);
  }
  function restoreMemos(){
    var boxes = wrap.querySelectorAll('textarea.ansbox');
    for (var i = 0; i < boxes.length; i++) {
      var t = boxes[i];
      try { var v = localStorage.getItem(MEMO + t.id); if (v) t.value = v; } catch (e) {}
      t.style.height = 'auto';
      t.style.height = Math.max(76, t.scrollHeight + 2) + 'px';
    }
  }
  function count(n){
    var a = document.getElementById('qcount'); if (a) a.textContent = n;
    var b = document.getElementById('qcount2'); if (b) b.textContent = n;
  }
  function save(){
    try { localStorage.setItem(KEY, JSON.stringify(readState())); } catch (e) {}
    count(wrap.querySelectorAll('.qcard').length);
  }

  /** 編集モードの ON/OFF。文章は contenteditable、行と設問はボタンで足し引きする */
  function applyEditable(on){
    var sel = '[data-role=title],[data-role=analysis],.qwhere li,[data-role=ask] li,[data-role=kind]';
    var els = wrap.querySelectorAll(sel);
    for (var i = 0; i < els.length; i++) {
      if (on) els[i].setAttribute('contenteditable', 'true');
      else els[i].removeAttribute('contenteditable');
    }
    var t = wrap.querySelectorAll('.qcard-tools');
    for (var j = 0; j < t.length; j++) t[j].hidden = !on;
    // 空の「分かったこと」「どこか」も編集中だけ出す（普段は見出しだけ残っても意味が無い）
    var hid = wrap.querySelectorAll('dt[data-for],dd[data-role=analysis],dd[data-role=where]');
    for (var k = 0; k < hid.length; k++) {
      if (on) { hid[k].dataset.washidden = hid[k].hidden ? '1' : ''; hid[k].hidden = false; }
      else if (hid[k].dataset.washidden === '1') hid[k].hidden = true;
    }
    // 行を足すボタン
    var lists = wrap.querySelectorAll('[data-role=where],[data-role=ask]');
    for (var m = 0; m < lists.length; m++) {
      var dd = lists[m];
      var b = dd.querySelector('.qaddrow');
      if (on && !b) {
        b = document.createElement('button');
        b.type = 'button'; b.className = 'qaddrow'; b.textContent = '＋ 行を追加';
        dd.appendChild(b);
      } else if (!on && b) { b.parentNode.removeChild(b); }
    }
    wrap.classList.toggle('editing', on);
  }

  // 節の導入文も直せるようにする（件数の言い方や依頼の書き方は、お客様ごとに変わる）
  var lede = document.getElementById('qlede');
  var LKEY = KEY + ':lede';
  function bindLede(on){
    if (!lede) return;
    if (on) lede.setAttribute('contenteditable', 'true');
    else lede.removeAttribute('contenteditable');
  }
  if (lede) {
    try { var lv = localStorage.getItem(LKEY); if (lv) lede.innerHTML = lv; } catch (e) {}
    lede.addEventListener('input', function(){
      try { localStorage.setItem(LKEY, lede.innerHTML); } catch (e) {}
    });
  }

  bar.hidden = false;
  bar.querySelector('#qedit-toggle').addEventListener('click', function(){
    editing = !editing;
    this.textContent = editing ? '編集を終える' : '設問を編集する';
    tools.hidden = !editing;
    applyEditable(editing);
    bindLede(editing);
    if (!editing) save();
  });

  wrap.addEventListener('input', function(e){
    if (e.target && e.target.classList && e.target.classList.contains('ansbox')) {
      var t = e.target;
      t.style.height = 'auto'; t.style.height = Math.max(76, t.scrollHeight + 2) + 'px';
      try { localStorage.setItem(MEMO + t.id, t.value); } catch (err) {}
      return;
    }
    save();
  });
  wrap.addEventListener('click', function(e){
    var el = e.target;
    if (!el || !el.classList) return;
    if (el.classList.contains('qdel')) {
      var card = el.closest('.qcard');
      if (card && confirm('この設問を消します。よろしいですか？')) { card.parentNode.removeChild(card); save(); }
      return;
    }
    if (el.classList.contains('qaddrow')) {
      var dd = el.closest('dd');
      var ul = dd.querySelector('ul');
      var li = document.createElement('li');
      li.setAttribute('contenteditable', 'true');
      li.textContent = '（ここに書いてください）';
      ul.appendChild(li);
      li.focus();
      save();
      return;
    }
    // 優先度は札を押すだけで切り替える
    if (el.getAttribute && el.getAttribute('data-role') === 'priority' && editing) {
      var c = el.closest('.qcard');
      var high = c.getAttribute('data-priority') !== 'high';
      c.setAttribute('data-priority', high ? 'high' : 'mid');
      c.classList.toggle('p-high', high);
      el.className = 'qtag ' + (high ? 'high' : 'mid');
      el.textContent = '優先度 ' + (high ? '高' : '中');
      save();
    }
  });

  bar.querySelector('#qedit-add').addEventListener('click', function(){
    var state = readState();
    // 番号は既にある最大値の次。振り直さないので本文からの参照が生きたまま残る
    var max = 0;
    for (var i = 0; i < state.length; i++) {
      var m = /Q-(\\d+)/.exec(state[i].id);
      if (m && Number(m[1]) > max) max = Number(m[1]);
    }
    var id = 'Q-' + (max + 1 < 10 ? '0' : '') + (max + 1);
    state.push({
      id: id, priority: 'mid', kind: 'ご確認事項',
      title: '（ここに確認したいことを書いてください）',
      analysis: '', where: [], ask: ['（教えていただきたいことを書いてください）']
    });
    render(state);
    save();
    var last = wrap.querySelector('.qcard:last-child [data-role=title]');
    if (last) { last.focus(); }
  });

  bar.querySelector('#qedit-export').addEventListener('click', function(){
    // 編集の跡（contenteditable・ボタン・編集バー）を落としてから書き出す。
    // textarea の入力値は outerHTML に出ないので、中身へ写してから複製する。
    var wasEditing = editing;
    if (wasEditing) { applyEditable(false); bindLede(false); }
    var boxes = document.querySelectorAll('textarea.ansbox');
    for (var i = 0; i < boxes.length; i++) boxes[i].textContent = boxes[i].value;
    var html = '<!DOCTYPE html>\\n' + document.documentElement.outerHTML;
    if (wasEditing) { applyEditable(true); bindLede(true); }
    var blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    var base = (document.title || 'report').replace(/[\\\\\\/:*?"<>|]/g, '_');
    a.download = base + '（編集済み）.html';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function(){ URL.revokeObjectURL(a.href); }, 1000);
  });

  bar.querySelector('#qedit-reset').addEventListener('click', function(){
    if (!confirm('編集内容を消して、生成時の設問に戻します。よろしいですか？')) return;
    try { localStorage.removeItem(KEY); localStorage.removeItem(LKEY); } catch (e) {}
    location.reload();
  });

  // 保存済みの編集があれば、それで置き換える（無ければ生成時のまま）
  var saved = null;
  try { saved = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) {}
  if (saved && saved.length >= 0 && Object.prototype.toString.call(saved) === '[object Array]') render(saved);
  else restoreMemos();
})();
`;

// 関係グラフ（Obsidian 風の力学配置＋階層レイアウト）。#relgraph-data(JSON) を読み、円ノードで各表を描く。
// 円の大きさ＝つながりの本数、縦位置＝最終アウトプットまでの距離（上=元データ→下=最終）。ホバーで一時強調、
// クリックで固定し、右パネル（パンくず＋経路＋上流/下流）から掘り下げる。右上ボタンで拡大・レイアウト切替
// （階層⇔力学）・配色切替（ライト⇔ダーク）・全画面・リセット。
// 初期化に失敗したら静的SVG（.map-static）へ戻す。※テンプレートリテラルに埋めるためバッククォート/${ は使わない。
const REPORT_GRAPH_JS = `
(function(){
  // 最終アウトプットごとに図を出すので、1ページに複数のインスタンスが並ぶ。
  // id は sfx（data-relgraph の値）で分ける。描画ロジックは元のまま。
  function initGraph(sfx){
  try{
    var wrap=document.getElementById('relgraph-wrap'+sfx);
    var host=document.getElementById('relgraph'+sfx);
    var dataEl=document.getElementById('relgraph-data'+sfx);
    var pbody=document.getElementById('relgraph-pbody'+sfx);
    var crumbsEl=document.getElementById('relgraph-crumbs'+sfx);
    if(!wrap||!host||!dataEl) return;
    var data=JSON.parse(dataEl.textContent);
    if(!data||!data.nodes||!data.nodes.length) return;
    var staticEl=document.querySelector('.map-static[data-graph="'+sfx+'"]'); if(staticEl) staticEl.style.display='none';
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
    function renderPanel(){ if(!selId){ pbody.innerHTML='<div class="empty">左のグラフで<b>表</b>をクリックすると、上流・下流の表と<b>最終アウトプットまでの経路</b>がここに出て、そのまま掘り下げられます。</div>'; return; } var n=byId[selId]; pbody.innerHTML=''; var nm=document.createElement('div'); nm.className='pname'; nm.textContent=n.label; pbody.appendChild(nm);
      if(n.file||n.kind){ var wh=document.createElement('div'); wh.className='p-where'; wh.textContent=(n.file?n.file+' の ':'')+(n.kind||''); pbody.appendChild(wh); }
      var rc=document.createElement('span'); rc.className='rolechip rc-'+roleClass(n.role); rc.textContent=n.role; pbody.appendChild(rc);
      if(n.how){ var hm=document.createElement('div'); hm.className='p-meta'; hm.textContent='どう作られるか'; pbody.appendChild(hm); var hb=document.createElement('div'); hb.className='p-how'; hb.textContent=n.how; pbody.appendChild(hb); }
      if(n.sub){ var mt=document.createElement('div'); mt.className='p-meta'; mt.textContent='規模 / キー'; pbody.appendChild(mt); var kb=document.createElement('div'); kb.className='p-keys'; kb.textContent=n.sub; pbody.appendChild(kb); }
      var mt2=document.createElement('div'); mt2.className='p-meta'; mt2.textContent='つながりの数'; pbody.appendChild(mt2); var kb2=document.createElement('div'); kb2.className='p-keys'; kb2.textContent='上流 '+inAdj[selId].length+' ／ 下流 '+outAdj[selId].length+'（計 '+n._d+'）'; pbody.appendChild(kb2);
      if(n.items&&n.items.length){ var gi=document.createElement('div'); gi.className='p-grp'; gi.innerHTML='<h4>この表の項目はどう作られるか</h4>'; var ib=document.createElement('div'); ib.className='p-items'; n.items.forEach(function(it){ var d=document.createElement('div'); d.className='p-item'; var h='<div class="pi-h"><span class="pi-col">'+esc(it.col)+'</span><span class="pi-how">'+esc(it.how)+'</span></div>'; if(it.from&&it.from.length) h+='<div class="pi-src">← '+esc(it.from.join('、'))+'</div>'; if(it.formula) h+='<div class="pi-fx">'+esc(it.formula)+'</div>'; d.innerHTML=h; ib.appendChild(d); }); gi.appendChild(ib); pbody.appendChild(gi); }
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
    var w=document.getElementById('relgraph-wrap'+sfx); if(w) w.style.display='none';
    var st=document.querySelector('.map-static[data-graph="'+sfx+'"]'); if(st) st.style.display='';
  }
  }
  // data-relgraph を持つ要素ぶん初期化する（最終アウトプットごとに1つ）
  var hosts=document.querySelectorAll('[data-relgraph]');
  for(var gi=0;gi<hosts.length;gi++) initGraph(hosts[gi].getAttribute('data-relgraph'));
})();
`;

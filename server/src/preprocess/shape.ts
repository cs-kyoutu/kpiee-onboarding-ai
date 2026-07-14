// プロンプト用ペイロード整形（413 / 1M トークン超過 対策 + GAS 数式の充実）。
//
// 顧客ファイルは形が様々（縦長の仕訳29,348行 / 横長259列 / 同一テンプレ16シート…）。
// 各シートを ヘッダ行 / 数式パターン（署名で重複排除） / データ行サンプル / omitted件数 へ圧縮する。
//
// 「必要な分だけ」当てる方針（シート単位の適応）:
//   - シートの性格で基準 caps を変える。数式シート=ロジックを厚く・データ標本は薄く /
//     データシート=標本を確保・数式系は最小。
//   - 予算超過時の縮小は「情報価値の低い順」に1次元ずつ。数式パターン数・数式長（=ロジック）は
//     高い下限(floor)で最後まで守る。ロジック保全のためなら予算を多少超えても可（保守的）。
//   - 予算は合計固定でなく「1ファイルあたり × ファイル数」を総量キャップで頭打ち（ファイル数比例）。
import { formulaSignature, type ParsedArtifact, type ParsedCell, type ParsedRow } from './parse.js';

/** 整形の上限値。予算に収まらない場合は情報価値の低い順に段階的に縮小される */
export interface ShapeCaps {
  headerRows: number;    // ヘッダ候補行
  sampleRows: number;    // データ行サンプル
  patterns: number;      // 1シートの数式パターン上限（=ロジック。高 floor で保護）
  patternCells: number;  // 1パターンに含める数式セル上限（横長対策）
  rowCells: number;      // ヘッダ/サンプル行のセル上限（横長対策）
  formulaLen: number;    // 数式原文の最大長（=ロジック。高 floor で保護）
}

// 予算（文字数）。ファイル数比例＋総量キャップ（日本語 ~2.5字/token 目安、コメントは概算トークン）。
// 主な削減は「同形セルの重複畳み込み＋シート別 caps」で達成するため、この予算は“暴走防止のバックストップ”。
// 通常規模ではこの予算に達せず縮小が走らない＝ロジック（異なる数式の形）を落とさない、を狙って余裕を持たせる。
const PER_FILE_CHARS = 180_000;   // ≒ 72k tokens/ファイル
const MAX_TOTAL_CHARS = 900_000;  // ≒ 360k tokens。多数ファイル時の総量キャップ（超過時のみ縮小）

// シートの性格別・基準 caps（必要な分だけ当てる第一歩）
// 数式シート: ロジック（patterns/patternCells/formulaLen）を厚く、データ標本(sampleRows)は薄く。
// patternCells は「同一シグネチャ（＝同じ数式パターン）のセル例」を何個持つか。同じ数式なので
// 少数で十分（冗長）。パターン数(patterns)と数式長(formulaLen)＝ロジック本体は厚く保つ。
// patternCells は「1行内の“異なる数式の形”をいくつ残すか」（同形＝参照違いは畳み済み）。列固有ロジックを
// 落とさぬよう十分大きく取る。patterns（パターン行数）と formulaLen（数式長）＝ロジック本体は厚く保つ。
const FORMULA_SHEET_CAPS: ShapeCaps = { headerRows: 3, sampleRows: 2, patterns: 300, patternCells: 48, rowCells: 100, formulaLen: 800 };
// データシート: 数式が無い/少ない。構造(ヘッダ)＋標本を確保、数式系は小さく。
const DATA_SHEET_CAPS:    ShapeCaps = { headerRows: 3, sampleRows: 6, patterns: 30,  patternCells: 24, rowCells: 120, formulaLen: 300 };
// 縮小の下限。ロジック（patterns/formulaLen/異なる数式の形=patternCells）は高めの floor で守る。
const MIN_CAPS: ShapeCaps = { headerRows: 1, sampleRows: 1, patterns: 30, patternCells: 20, rowCells: 24, formulaLen: 300 };
const MAX_LEVEL = 30; // 全次元が floor に届くのに十分な段数

export interface FormulaPattern {
  representativeRef: string;
  appliesToRowCount: number;
  gas: boolean;
  cells: { ref: string; formula: string; value: ParsedCell['value'] }[];
  omittedCells?: number;
}

export interface ShapedSheet {
  name: string;
  role?: string;
  rowCount: number;
  columnCount: number;
  formulaCellCount: number;
  merges: string[];
  headerRows: ParsedRow[];
  formulaPatterns: FormulaPattern[];
  sampleDataRows: ParsedRow[];
  omitted: { dataRows: number; formulaPatterns: number };
}

export interface ShapedArtifact {
  filename: string;
  kind: string;
  fileType: 'xlsx' | 'csv';
  sheets: ShapedSheet[];
}

const rowRepeatCount = (row: ParsedRow): number => row.compressedRange?.count ?? 1;
const truncFormula = (f: string, max: number): string => (f.length > max ? f.slice(0, max) + '…' : f);
// 数式の「形」を取り出す（セル参照を # に潰す）。参照だけ違う同形の数式を1つに畳むために使う。
// 構造が異なる数式（SUM と IF、列ごとに違うロジック等）は別の形になるので必ず残る。
const columnShapeOf = (f: string): string => f.replace(/\$?[A-Za-z]{1,3}\$?\d+/g, '#');
const trimRow = (row: ParsedRow, maxCells: number): ParsedRow =>
  row.cells.length <= maxCells ? row : { ...row, cells: row.cells.slice(0, maxCells) };

function shapeSheet(sheet: ParsedArtifact['sheets'][number], role: string | undefined, caps: ShapeCaps): ShapedSheet {
  const rows = sheet.rows;
  const headerRows = rows.slice(0, caps.headerRows).map(r => trimRow(r, caps.rowCells));

  const patternMap = new Map<string, FormulaPattern>();
  const dataRows: ParsedRow[] = [];
  for (const row of rows) {
    const formulaCells = row.cells.filter(c => c.formula);
    if (formulaCells.length === 0) { dataRows.push(row); continue; }
    const sig = formulaSignature(row.cells);
    const existing = patternMap.get(sig);
    if (existing) {
      existing.appliesToRowCount += rowRepeatCount(row);
    } else {
      // 同一パターン行内でも列ごとに数式が違うことがある。参照だけ違う「同形」セルは1つに畳み、
      // 構造が異なる数式は全て残す（＝必要な分だけ）。冗長セルだけ削り、列固有のロジックは保全する。
      const seen = new Set<string>();
      const distinct: typeof formulaCells = [];
      for (const c of formulaCells) {
        const shape = columnShapeOf(c.formula!);
        if (seen.has(shape)) continue;
        seen.add(shape);
        distinct.push(c);
      }
      const kept = distinct.slice(0, caps.patternCells);
      patternMap.set(sig, {
        representativeRef: formulaCells[0].ref,
        appliesToRowCount: rowRepeatCount(row),
        gas: formulaCells.some(c => c.gas),
        cells: kept.map(c => ({ ref: c.ref, formula: truncFormula(c.formula!, caps.formulaLen), value: c.value })),
        // 落としたのは主に「参照だけ違う同形セル」（冗長）。異なる形が cap を超えた分のみ真の省略。
        ...(formulaCells.length > kept.length ? { omittedCells: formulaCells.length - kept.length } : {}),
      });
    }
  }
  const allPatterns = [...patternMap.values()];
  const formulaPatterns = allPatterns.slice(0, caps.patterns);

  const headerRefs = new Set(headerRows.map(r => r.rowNumber));
  const pureData = dataRows.filter(r => !headerRefs.has(r.rowNumber));
  const sampleDataRows = pureData.slice(0, caps.sampleRows).map(r => trimRow(r, caps.rowCells));

  return {
    name: sheet.name, role,
    rowCount: sheet.rowCount, columnCount: sheet.columnCount, formulaCellCount: sheet.formulaCellCount,
    merges: sheet.merges, headerRows, formulaPatterns, sampleDataRows,
    omitted: {
      dataRows: Math.max(0, pureData.length - sampleDataRows.length),
      formulaPatterns: Math.max(0, allPatterns.length - formulaPatterns.length),
    },
  };
}

/** シートの性格から基準 caps を選ぶ（数式の有無で厚みを変える＝必要な分だけ） */
function baseCapsForSheet(sheet: ParsedArtifact['sheets'][number]): ShapeCaps {
  return sheet.formulaCellCount > 0 ? FORMULA_SHEET_CAPS : DATA_SHEET_CAPS;
}

// 縮小は「情報価値の低い順」に1次元ずつ。ロジック（patterns/formulaLen）は最後に回す＝保守的。
function shrinkOne(c: ShapeCaps): ShapeCaps {
  const n = { ...c };
  if (n.sampleRows   > MIN_CAPS.sampleRows)   { n.sampleRows   = Math.max(MIN_CAPS.sampleRows, n.sampleRows - 1); return n; }
  if (n.rowCells     > MIN_CAPS.rowCells)     { n.rowCells     = Math.max(MIN_CAPS.rowCells, Math.floor(n.rowCells * 0.6)); return n; }
  if (n.headerRows   > MIN_CAPS.headerRows)   { n.headerRows   = Math.max(MIN_CAPS.headerRows, n.headerRows - 1); return n; }
  if (n.patternCells > MIN_CAPS.patternCells) { n.patternCells = Math.max(MIN_CAPS.patternCells, Math.floor(n.patternCells * 0.6)); return n; }
  if (n.patterns     > MIN_CAPS.patterns)     { n.patterns     = Math.max(MIN_CAPS.patterns, Math.floor(n.patterns * 0.75)); return n; }
  if (n.formulaLen   > MIN_CAPS.formulaLen)   { n.formulaLen   = Math.max(MIN_CAPS.formulaLen, Math.floor(n.formulaLen * 0.8)); return n; }
  return n;
}
function applyLevel(c: ShapeCaps, level: number): ShapeCaps {
  let caps = c;
  for (let i = 0; i < level; i++) caps = shrinkOne(caps);
  return caps;
}
const isMin = (c: ShapeCaps): boolean =>
  c.sampleRows <= MIN_CAPS.sampleRows && c.rowCells <= MIN_CAPS.rowCells && c.headerRows <= MIN_CAPS.headerRows &&
  c.patternCells <= MIN_CAPS.patternCells && c.patterns <= MIN_CAPS.patterns && c.formulaLen <= MIN_CAPS.formulaLen;

/** パース済みアーティファクトを（シート別の基準 caps ＋ 縮小レベルで）整形する */
export function shapeArtifact(
  parsed: ParsedArtifact, roles: Record<string, string>, kind: string, filename: string, level = 0,
): ShapedArtifact {
  return {
    filename, kind, fileType: parsed.fileType,
    sheets: parsed.sheets.map(s => shapeSheet(s, roles[s.name], applyLevel(baseCapsForSheet(s), level))),
  };
}

export interface ShapeInput { parsed: ParsedArtifact; roles: Record<string, string>; kind: string; filename: string }

/**
 * プロジェクト内の全アーティファクトを、合計が予算内に収まるよう適応的に整形する。
 * シート別の基準 caps から始め、超過していれば「情報価値の低い順」に縮小レベルを上げる。
 * 全シートが floor に達したらそこで打ち切る（ロジック保全のため予算を多少超えることを許容）。
 */
export function shapeArtifactsToBudget(items: ShapeInput[], budget?: number): ShapedArtifact[] {
  const effectiveBudget = budget ?? Math.min(PER_FILE_CHARS * Math.max(1, items.length), MAX_TOTAL_CHARS);
  let level = 0;
  let shaped = items.map(i => shapeArtifact(i.parsed, i.roles, i.kind, i.filename, level));
  while (level < MAX_LEVEL && JSON.stringify(shaped).length > effectiveBudget) {
    // 全シートが floor に達していたら、これ以上縮めても変わらないので打ち切る
    const allMin = items.every(i => i.parsed.sheets.every(s => isMin(applyLevel(baseCapsForSheet(s), level))));
    if (allMin) break;
    level++;
    shaped = items.map(i => shapeArtifact(i.parsed, i.roles, i.kind, i.filename, level));
  }
  return shaped;
}

// プロンプト用ペイロード整形（413 / 1M トークン超過 対策 + GAS 数式の充実）。
//
// 顧客ファイルは形が様々（縦長の仕訳29,348行 / 横長259列 / 同一テンプレ16シート…）。
// シート毎に手調整しなくて済むよう、各シートを
//   - ヘッダ行 / 数式パターン（署名で重複排除） / データ行サンプル / omitted件数
// へ圧縮したうえで、プロジェクト全体の合計が「予算(文字数)」内に収まるまで
// 上限を自動で段階的に絞る（shapeArtifactsToBudget）。小さいファイルは詳細に、
// 巨大ファイルは自動でより圧縮され、ファイルごとの設定変更は不要。
import { formulaSignature, type ParsedArtifact, type ParsedCell, type ParsedRow } from './parse.js';

/** 整形の上限値。予算に収まらない場合は段階的に縮小される */
export interface ShapeCaps {
  headerRows: number;    // ヘッダ候補行
  sampleRows: number;    // データ行サンプル
  patterns: number;      // 1シートの数式パターン上限
  patternCells: number;  // 1パターンに含める数式セル上限（横長対策）
  rowCells: number;      // ヘッダ/サンプル行のセル上限（横長対策）
  formulaLen: number;    // 数式原文の最大長
}

// 既定（小さいファイルはこの詳細さで通る）
const DEFAULT_CAPS: ShapeCaps = { headerRows: 3, sampleRows: 5, patterns: 60, patternCells: 40, rowCells: 80, formulaLen: 400 };
// 最小（これ以上は縮めない）
const MIN_CAPS: ShapeCaps = { headerRows: 1, sampleRows: 1, patterns: 8, patternCells: 8, rowCells: 24, formulaLen: 120 };
// 予算（文字数）。合計固定ではなく「1ファイルあたり予算 × ファイル数」を上限とし、総量キャップで頭打ちにする。
// 合計固定だとファイル数が増えるほど1ファイルあたりが薄くなる（例: 5ファイルで合計20万は1ファイル≒4万相当）。
// ファイル数比例にすれば、ファイルが増えても各ファイルの詳細さを一定に保てる。
// 日本語比率が高いと文字/token 比が下がる（最悪 ≒2.5文字/token）。下記は概算トークンをコメント併記。
const PER_FILE_CHARS = 120_000;   // ≒ 48k tokens/ファイル（各ファイルが保つ詳細さ）
const MAX_TOTAL_CHARS = 600_000;  // ≒ 240k tokens。多数ファイル時の総量キャップ（コスト暴走防止）
const MAX_SHRINK_ATTEMPTS = 8;

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
      const kept = formulaCells.slice(0, caps.patternCells);
      patternMap.set(sig, {
        representativeRef: formulaCells[0].ref,
        appliesToRowCount: rowRepeatCount(row),
        gas: formulaCells.some(c => c.gas),
        cells: kept.map(c => ({ ref: c.ref, formula: truncFormula(c.formula!, caps.formulaLen), value: c.value })),
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

/** パース済みアーティファクトを整形する（caps 未指定なら既定の詳細さ） */
export function shapeArtifact(
  parsed: ParsedArtifact, roles: Record<string, string>, kind: string, filename: string,
  caps: ShapeCaps = DEFAULT_CAPS,
): ShapedArtifact {
  return { filename, kind, fileType: parsed.fileType, sheets: parsed.sheets.map(s => shapeSheet(s, roles[s.name], caps)) };
}

const capsAtMin = (c: ShapeCaps): boolean =>
  c.headerRows <= MIN_CAPS.headerRows && c.sampleRows <= MIN_CAPS.sampleRows && c.patterns <= MIN_CAPS.patterns &&
  c.patternCells <= MIN_CAPS.patternCells && c.rowCells <= MIN_CAPS.rowCells && c.formulaLen <= MIN_CAPS.formulaLen;

function shrink(c: ShapeCaps): ShapeCaps {
  const f = (v: number, min: number) => Math.max(min, Math.floor(v * 0.6));
  return {
    headerRows: Math.max(MIN_CAPS.headerRows, c.headerRows - 1),
    sampleRows: Math.max(MIN_CAPS.sampleRows, c.sampleRows - 1),
    patterns: f(c.patterns, MIN_CAPS.patterns),
    patternCells: f(c.patternCells, MIN_CAPS.patternCells),
    rowCells: f(c.rowCells, MIN_CAPS.rowCells),
    formulaLen: f(c.formulaLen, MIN_CAPS.formulaLen),
  };
}

export interface ShapeInput { parsed: ParsedArtifact; roles: Record<string, string>; kind: string; filename: string }

/**
 * プロジェクト内の全アーティファクトを、合計が予算内に収まるよう適応的に整形する。
 * 既定の詳細さで一度整形し、超過していれば上限を段階的に縮めて再整形（シート毎の手調整不要）。
 */
export function shapeArtifactsToBudget(items: ShapeInput[], budget?: number): ShapedArtifact[] {
  // 予算は「1ファイルあたり × ファイル数」を総量キャップで頭打ちにする（明示指定があればそれを優先）。
  const effectiveBudget = budget ?? Math.min(PER_FILE_CHARS * Math.max(1, items.length), MAX_TOTAL_CHARS);
  let caps = DEFAULT_CAPS;
  let shaped = items.map(i => shapeArtifact(i.parsed, i.roles, i.kind, i.filename, caps));
  for (let attempt = 0; attempt < MAX_SHRINK_ATTEMPTS; attempt++) {
    if (JSON.stringify(shaped).length <= effectiveBudget || capsAtMin(caps)) break;
    caps = shrink(caps);
    shaped = items.map(i => shapeArtifact(i.parsed, i.roles, i.kind, i.filename, caps));
  }
  return shaped;
}

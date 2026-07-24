// ファイル前処理モジュール（設計書 §6.1）。
// xlsx / CSV を AI が解読可能な構造化 JSON に変換する。
// 必須要件: セル値だけでなく数式の原文（=VLOOKUP(...) など）を保持すること。
import ExcelJS from 'exceljs';
import * as XLSX from 'xlsx';

/** 解析済みセル。数式セルは value と formula の両方を保持する */
export interface ParsedCell {
  ref: string;          // セル参照（例: B2）
  value: string | number | null;
  formula?: string;     // 数式原文（= は付けない。ExcelJS の生値）
  gas?: boolean;        // Google スプレッドシート関数（__xludf.DUMMYFUNCTION）をアンラップした数式
}

export interface ParsedRow {
  rowNumber: number;
  cells: ParsedCell[];
  /** 同一数式パターンの連続行を圧縮した場合の代表行フラグと範囲 */
  compressedRange?: { from: number; to: number; count: number };
}

export interface ParsedSheet {
  name: string;
  rowCount: number;
  columnCount: number;
  formulaCellCount: number;
  merges: string[];     // 結合セル範囲（例: A1:C1）
  rows: ParsedRow[];
}

export interface ParsedArtifact {
  fileType: 'xlsx' | 'csv';
  sheets: ParsedSheet[];
}

/**
 * Google スプレッドシートが xlsx 出力時に非Excel関数（QUERY/IMPORTRANGE/ARRAYFORMULA/INDIRECT 等）を
 * 包む `__xludf.DUMMYFUNCTION("…原文…")` をアンラップして GAS 数式の原文を取り出す。
 * 配列数式のスピル先セルは `"COMPUTED_VALUE"` プレースホルダになるため isPlaceholder=true で返す
 * （実ロジックはアンカーセル1個のみが保持する）。
 */
function unwrapGasFormula(formula: string): { formula: string; isPlaceholder: boolean } | null {
  const marker = '__xludf.DUMMYFUNCTION(';
  const idx = formula.indexOf(marker);
  if (idx === -1) return null;
  let i = idx + marker.length;
  if (formula[i] !== '"') return null;
  i++;
  // xlsx 文字列リテラル内の "" を " にアンエスケープしつつ閉じ引用符まで読む
  let inner = '';
  for (; i < formula.length; i++) {
    const ch = formula[i];
    if (ch === '"') {
      if (formula[i + 1] === '"') { inner += '"'; i++; continue; }
      break;
    }
    inner += ch;
  }
  const trimmed = inner.trim().replace(/^"+|"+$/g, '');
  if (trimmed === 'COMPUTED_VALUE' || trimmed === '') return { formula: inner, isPlaceholder: true };
  return { formula: inner, isPlaceholder: false };
}

/** セル値を JSON 化可能なプリミティブへ正規化する */
function normalizeValue(v: ExcelJS.CellValue): string | number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' || typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    // 数式セル: result を値として使う。result が無い（計算結果キャッシュ未保存の）数式セルは
    // 値なしとして null にする — String(v) に落とすと "[object Object]" が値になり、
    // 照合の CREATE TABLE で列名が衝突する（Catalog Error）などの事故になる
    if ('result' in v && v.result !== undefined) return normalizeValue(v.result as ExcelJS.CellValue);
    if ('formula' in v || 'sharedFormula' in v) return null;
    // リッチテキスト等は文字列へ畳み込む
    if ('richText' in v) return (v.richText as { text: string }[]).map(r => r.text).join('');
    if ('text' in v) return String((v as { text: unknown }).text);
    if ('error' in v) return String((v as { error: unknown }).error);
  }
  return String(v);
}

/** 行の数式パターン署名。セル参照の行番号を除去して同一パターン行を検出する */
export function formulaSignature(cells: ParsedCell[]): string {
  return cells
    .map(c => `${c.ref.replace(/\d+/g, '')}:${(c.formula ?? '').replace(/(?<=[A-Z$])\d+/g, 'N')}`)
    .join('|');
}

/**
 * xlsx をシートごとに構造化 JSON へ変換する。
 * トークン削減のため、同一数式パターンが連続する行は代表行＋行範囲に圧縮する（設計書 §6.1）。
 */
/**
 * バッファ先頭のマジックナンバーで「そもそも .xlsx として読めるか」を判定する。
 * exceljs の生エラー（例: Cannot read properties of undefined (reading 'sheets')）は原因が伝わらないため、
 * ここで利用者向けの具体的な案内文へ置き換える。読めそうなら null を返して exceljs に委ねる。
 */
function xlsxLoadHint(buffer: Buffer): string | null {
  // 正常な .xlsx/.xlsm は ZIP（PK\x03\x04）。PK\x05\x06 は空アーカイブ。
  if (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b) {
    if (buffer[2] === 0x05 && buffer[3] === 0x06) return '空の Excel ファイル（中身が無い）のようです。データの入ったファイルをアップロードしてください。';
    return null; // ZIP とみなして exceljs に委ねる
  }
  // 旧 .xls（BIFF）や、パスワード保護／暗号化された .xlsx は CFB/OLE 複合ファイル（D0 CF 11 E0 A1 B1 1A E1）。
  if (buffer.length >= 4 && buffer[0] === 0xd0 && buffer[1] === 0xcf && buffer[2] === 0x11 && buffer[3] === 0xe0) {
    return '旧形式の Excel（.xls）か、パスワード保護／暗号化された Excel の可能性があります。Excel で開き「Excel ブック（.xlsx）」として保存し直すか、保護を解除してからアップロードしてください。';
  }
  return 'このファイルは有効な .xlsx（Excel ブック）として読み取れませんでした。拡張子だけ .xlsx にした別形式・破損・ダウンロード不完全などが考えられます。Excel で開き「.xlsx」として保存し直すか、CSV で書き出してからアップロードしてください。';
}

/** 同一数式パターンの連続行を圧縮する（数式を持つ行のみ対象、3行以上で代表行＋範囲メタに畳む）。
 *  exceljs 経路・SheetJS 経路の両方で同じ結果になるよう共通化する。 */
function compressFormulaRows(rows: ParsedRow[]): ParsedRow[] {
  const compressed: ParsedRow[] = [];
  let i = 0;
  while (i < rows.length) {
    const cur = rows[i];
    const hasFormula = cur.cells.some(c => c.formula);
    if (!hasFormula) { compressed.push(cur); i++; continue; }
    const sig = formulaSignature(cur.cells);
    let j = i + 1;
    while (j < rows.length && rows[j].rowNumber === rows[j - 1].rowNumber + 1 && formulaSignature(rows[j].cells) === sig) j++;
    const count = j - i;
    if (count >= 3) compressed.push({ ...cur, compressedRange: { from: cur.rowNumber, to: rows[j - 1].rowNumber, count } });
    else for (let k = i; k < j; k++) compressed.push(rows[k]);
    i = j;
  }
  return compressed;
}

/** SheetJS のセル値を ParsedCell.value 相当（JSON 化可能なプリミティブ）へ正規化する */
function sheetjsValue(cell: XLSX.CellObject): string | number | null {
  if (cell.v === null || cell.v === undefined) return null;
  switch (cell.t) {
    case 'n': return typeof cell.v === 'number' ? cell.v : Number(cell.v);
    case 'b': return cell.v ? 1 : 0;
    case 'd': { const d = cell.v as Date; return d instanceof Date && !isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : null; }
    case 'e': return String(cell.w ?? cell.v);
    default: return String(cell.v);
  }
}

/**
 * exceljs が読めない非標準 xlsx を SheetJS で読み、exceljs 経路と同じ ParsedArtifact に変換するフォールバック。
 * 実ファイルで確認した非対応パターン: 主名前空間が接頭辞付き（<x:worksheet>…）、セルに r 属性（A1）が無く
 * 出現順依存、sharedStrings 無しの inlineStr のみ、[trash]/ エントリ入り —— 一部の業務システム/ライブラリ出力。
 * 値・数式・GAS アンラップ・結合・数式行圧縮は exceljs 経路と同じ扱いに揃える。
 */
function parseXlsxWithSheetJS(buffer: Buffer): ParsedArtifact {
  const wb = XLSX.read(buffer, { cellFormula: true, cellDates: true, cellNF: false, cellHTML: false, cellStyles: false });
  const sheets: ParsedSheet[] = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws || !ws['!ref']) { sheets.push({ name, rowCount: 0, columnCount: 0, formulaCellCount: 0, merges: [], rows: [] }); continue; }
    const range = XLSX.utils.decode_range(ws['!ref']);
    const rows: ParsedRow[] = [];
    let formulaCellCount = 0;
    for (let R = range.s.r; R <= range.e.r; R++) {
      const cells: ParsedCell[] = [];
      for (let C = range.s.c; C <= range.e.c; C++) {
        const ref = XLSX.utils.encode_cell({ r: R, c: C });
        const cell = ws[ref] as XLSX.CellObject | undefined;
        if (!cell) continue;
        const c: ParsedCell = { ref, value: sheetjsValue(cell) };
        if (cell.f) {
          const gas = unwrapGasFormula(String(cell.f));
          if (gas?.isPlaceholder) {
            // Google 配列数式のスピル先。実ロジックは無いのでデータ値セル扱い
          } else if (gas) {
            c.formula = gas.formula; c.gas = true; formulaCellCount++;
          } else {
            c.formula = String(cell.f); formulaCellCount++;
          }
        }
        cells.push(c);
      }
      if (cells.length > 0) rows.push({ rowNumber: R + 1, cells });
    }
    const merges = (ws['!merges'] ?? []).map(m => XLSX.utils.encode_range(m));
    sheets.push({
      name,
      rowCount: range.e.r + 1,
      columnCount: range.e.c + 1,
      formulaCellCount,
      merges,
      rows: compressFormulaRows(rows),
    });
  }
  return { fileType: 'xlsx', sheets };
}

export async function parseXlsx(buffer: Buffer): Promise<ParsedArtifact> {
  const hint = xlsxLoadHint(buffer);
  if (hint) throw new Error(hint);
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch (e) {
    // exceljs が読めない非標準 xlsx（名前空間接頭辞・セルの r 属性欠落など）は SheetJS で再挑戦する。
    try {
      const viaSheetJs = parseXlsxWithSheetJS(buffer);
      if (viaSheetJs.sheets.some(s => s.rows.length > 0)) return viaSheetJs;
    } catch { /* SheetJS でも読めない → 下の案内を返す */ }
    // ZIP だが中身が壊れている／未対応構造で両パーサとも落ちるケース。詳細は末尾に残す。
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error(`Excel ファイルの解析に失敗しました。ファイルの破損、または未対応の形式・暗号化の可能性があります。Excel で開き「.xlsx」として保存し直すか、CSV で書き出してからアップロードしてください。（詳細: ${detail}）`);
  }

  const sheets: ParsedSheet[] = [];
  wb.eachSheet(ws => {
    const rows: ParsedRow[] = [];
    let formulaCellCount = 0;

    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      const cells: ParsedCell[] = [];
      row.eachCell({ includeEmpty: false }, cell => {
        const c: ParsedCell = { ref: String(cell.address), value: normalizeValue(cell.value) };
        const fv = cell.value as { formula?: string; sharedFormula?: string } | null;
        const rawFormula = cell.formula || fv?.formula || fv?.sharedFormula;
        if (rawFormula) {
          const gas = unwrapGasFormula(String(rawFormula));
          if (gas?.isPlaceholder) {
            // Google 配列数式のスピル先（COMPUTED_VALUE）。実ロジックは無いのでデータ値セルとして扱う
          } else if (gas) {
            c.formula = gas.formula; // __xludf.DUMMYFUNCTION をアンラップした GAS 原文
            c.gas = true;
            formulaCellCount++;
          } else {
            c.formula = String(rawFormula);
            formulaCellCount++;
          }
        }
        cells.push(c);
      });
      if (cells.length > 0) rows.push({ rowNumber, cells });
    });

    // 同一数式パターンの連続行を圧縮（数式を持つ行のみ対象）
    const compressed = compressFormulaRows(rows);

    const merges = (ws.model as { merges?: string[] }).merges ?? [];
    sheets.push({
      name: ws.name,
      rowCount: ws.rowCount,
      columnCount: ws.columnCount,
      formulaCellCount,
      merges,
      rows: compressed,
    });
  });

  return { fileType: 'xlsx', sheets };
}

/** 簡易 CSV パーサ（引用符・改行対応）。依存を増やさないため自前実装 */
function parseCsvText(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else field += ch;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => c !== ''));
}

/** Shift_JIS / UTF-8 を判別してデコードする（設計書 §6.1: エンコーディング判別） */
function decodeCsvBuffer(buffer: Buffer): string {
  // BOM 付き UTF-8
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString('utf-8');
  }
  const utf8 = buffer.toString('utf-8');
  // 置換文字が出る場合は UTF-8 でない可能性が高いので SJIS で再試行
  if (utf8.includes('�')) {
    try {
      return new TextDecoder('shift_jis').decode(buffer);
    } catch {
      return utf8;
    }
  }
  return utf8;
}

/** 数値らしき文字列を number 化する（カンマ区切り対応） */
function coerce(v: string): string | number {
  const cleaned = v.replace(/,/g, '');
  if (cleaned !== '' && !isNaN(Number(cleaned))) return Number(cleaned);
  return v;
}

export function parseCsv(buffer: Buffer): ParsedArtifact {
  const grid = parseCsvText(decodeCsvBuffer(buffer));
  const rows: ParsedRow[] = grid.map((r, idx) => ({
    rowNumber: idx + 1,
    cells: r.map((v, colIdx) => ({
      ref: `${columnLetter(colIdx + 1)}${idx + 1}`,
      value: idx === 0 ? v : coerce(v), // ヘッダー行は文字列のまま
    })),
  }));
  return {
    fileType: 'csv',
    sheets: [{
      name: 'csv',
      rowCount: rows.length,
      columnCount: grid[0]?.length ?? 0,
      formulaCellCount: 0,
      merges: [],
      rows,
    }],
  };
}

/** 列番号 → 列記号（1 → A, 27 → AA） */
export function columnLetter(n: number): string {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export async function parseArtifact(filename: string, buffer: Buffer): Promise<ParsedArtifact> {
  if (/\.(xlsx|xlsm)$/i.test(filename)) return parseXlsx(buffer);
  if (/\.csv$/i.test(filename)) return parseCsv(buffer);
  throw new Error(`unsupported file type: ${filename}（xlsx / csv のみ対応）`);
}

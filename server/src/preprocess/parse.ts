// ファイル前処理モジュール（設計書 §6.1）。
// xlsx / CSV を AI が解読可能な構造化 JSON に変換する。
// 必須要件: セル値だけでなく数式の原文（=VLOOKUP(...) など）を保持すること。
import ExcelJS from 'exceljs';

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
    // 数式セル: result を値として使う
    if ('result' in v && v.result !== undefined) return normalizeValue(v.result as ExcelJS.CellValue);
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
export async function parseXlsx(buffer: Buffer): Promise<ParsedArtifact> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);

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
    const compressed: ParsedRow[] = [];
    let i = 0;
    while (i < rows.length) {
      const cur = rows[i];
      const hasFormula = cur.cells.some(c => c.formula);
      if (!hasFormula) {
        compressed.push(cur);
        i++;
        continue;
      }
      const sig = formulaSignature(cur.cells);
      let j = i + 1;
      while (
        j < rows.length &&
        rows[j].rowNumber === rows[j - 1].rowNumber + 1 &&
        formulaSignature(rows[j].cells) === sig
      ) j++;
      const count = j - i;
      if (count >= 3) {
        // 代表行1行 + 範囲メタ情報に置換
        compressed.push({ ...cur, compressedRange: { from: cur.rowNumber, to: rows[j - 1].rowNumber, count } });
      } else {
        for (let k = i; k < j; k++) compressed.push(rows[k]);
      }
      i = j;
    }

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

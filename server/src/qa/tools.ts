// Q&A エージェント用のセル・ドリルダウン道具一式。
//
// 設計上の要点（重要）:
//  - parse.ts は同一パターン行を圧縮（compressedRange）するため、セル単位の質疑には使えない。
//    本モジュールは artifacts.storage_key の「元 xlsx」を ExcelJS で直接読み、全セル忠実に参照する。
//  - 集計シートは `SUM(top:end!E6)` 形式の 3-D 参照を多用する。これはタブ並び順で top〜end の間に
//    挟まった全シートの合算を意味するため、ワークシートの並び順を使って実シートへ展開する。
//  - ワークブックはプロジェクト単位でキャッシュし、1 質問内の多数のツール呼び出しを高速化する。
import ExcelJS from 'exceljs';
import { db } from '../db.js';
import { materializeBuffer } from '../artifacts.js';

/** セル値を JSON 化可能なプリミティブへ正規化する（parse.ts と同方針） */
function normalize(v: ExcelJS.CellValue): string | number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' || typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('result' in v && (v as { result?: unknown }).result !== undefined) {
      return normalize((v as { result: ExcelJS.CellValue }).result);
    }
    if ('richText' in v) return (v as { richText: { text: string }[] }).richText.map(r => r.text).join('');
    if ('text' in v) return String((v as { text: unknown }).text);
    if ('error' in v) return String((v as { error: unknown }).error);
  }
  return String(v);
}

/** セルの数式原文を取り出す（無ければ undefined） */
function formulaOf(cell: ExcelJS.Cell): string | undefined {
  const fv = cell.value as { formula?: string; sharedFormula?: string } | null;
  return cell.formula || fv?.formula || fv?.sharedFormula || undefined;
}

interface ArtifactRow { id: number; original_filename: string; storage_key: string }

/** プロジェクト配下の xlsx ワークブック群（キャッシュ付き）。シート名 → 所属ワークブックも引ける */
interface ProjectBook {
  /** artifactId → 読み込み済みワークブック */
  books: Map<number, { filename: string; wb: ExcelJS.Workbook }>;
  /** シート名 → そのシートを持つ artifactId（重複時は最初に見つかったもの） */
  sheetIndex: Map<string, number>;
}

const cache = new Map<number, Promise<ProjectBook>>();

async function loadProjectBooks(projectId: number): Promise<ProjectBook> {
  const rows = await db.prepare(
    `SELECT id, original_filename, storage_key FROM artifacts WHERE project_id = ?`,
  ).all(projectId) as ArtifactRow[];

  const books: ProjectBook['books'] = new Map();
  const sheetIndex: ProjectBook['sheetIndex'] = new Map();

  for (const r of rows) {
    if (!/\.(xlsx|xlsm)$/i.test(r.original_filename)) continue; // CSV はセル参照対象外
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await materializeBuffer(r.storage_key)) as unknown as ArrayBuffer);
    books.set(r.id, { filename: r.original_filename, wb });
    wb.eachSheet(ws => { if (!sheetIndex.has(ws.name)) sheetIndex.set(ws.name, r.id); });
  }
  return { books, sheetIndex };
}

function getBooks(projectId: number): Promise<ProjectBook> {
  if (!cache.has(projectId)) cache.set(projectId, loadProjectBooks(projectId));
  return cache.get(projectId)!;
}

/** プロジェクトのワークブックキャッシュを破棄する（アーティファクト変更時に呼ぶ） */
export function invalidateBooks(projectId: number): void {
  cache.delete(projectId);
}

/** シート名からワークシートを解決する。見つからなければ null */
function resolveSheet(pb: ProjectBook, sheet: string): ExcelJS.Worksheet | null {
  const artId = pb.sheetIndex.get(sheet);
  if (artId === undefined) return null;
  return pb.books.get(artId)!.wb.getWorksheet(sheet) ?? null;
}

// ───────────────────────── 各ツール実装 ─────────────────────────

/** 全シートの一覧（寸法・数式セル数）。質問対象シートの当たりをつけるための地図 */
async function getSheetMap(projectId: number) {
  const pb = await getBooks(projectId);
  const out: unknown[] = [];
  for (const { filename, wb } of pb.books.values()) {
    wb.eachSheet(ws => {
      let fc = 0;
      ws.eachRow({ includeEmpty: false }, row => row.eachCell({ includeEmpty: false }, c => { if (formulaOf(c)) fc++; }));
      out.push({ file: filename, sheet: ws.name, tabIndex: ws.id, rows: ws.rowCount, cols: ws.columnCount, formulaCells: fc });
    });
  }
  return { sheets: out };
}

/** 単一セルの値と数式原文 */
async function getCell(projectId: number, sheet: string, ref: string) {
  const pb = await getBooks(projectId);
  const ws = resolveSheet(pb, sheet);
  if (!ws) return { error: `シート「${sheet}」が見つかりません` };
  const cell = ws.getCell(ref);
  return { sheet, ref, value: normalize(cell.value), formula: formulaOf(cell) ?? null };
}

/** 矩形範囲の値・数式（セル数は安全のため上限 400） */
async function getRange(projectId: number, sheet: string, range: string) {
  const pb = await getBooks(projectId);
  const ws = resolveSheet(pb, sheet);
  if (!ws) return { error: `シート「${sheet}」が見つかりません` };
  const m = range.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i);
  if (!m) return { error: `範囲指定が不正です（例: E6:H48）: ${range}` };
  const c1 = ws.getCell(`${m[1]}${m[2]}`).fullAddress.col, r1 = Number(m[2]);
  const c2 = ws.getCell(`${m[3]}${m[4]}`).fullAddress.col, r2 = Number(m[4]);
  const [cl, ch] = [Math.min(c1, c2), Math.max(c1, c2)];
  const [rl, rh] = [Math.min(r1, r2), Math.max(r1, r2)];
  if ((ch - cl + 1) * (rh - rl + 1) > 400) return { error: 'セル数が多すぎます（上限400）。範囲を狭めてください' };
  const cells: unknown[] = [];
  for (let r = rl; r <= rh; r++) for (let c = cl; c <= ch; c++) {
    const cell = ws.getCell(r, c);
    const f = formulaOf(cell), v = normalize(cell.value);
    if (f != null || (v != null && v !== '')) cells.push({ ref: cell.address, value: v, formula: f ?? null });
  }
  return { sheet, range, cells };
}

/** ラベル列(A〜E)に語句を含む行を探す（行番号と各列ラベルを返す）。行の意味＝勘定科目の特定に使う */
async function findRows(projectId: number, sheet: string, query: string) {
  const pb = await getBooks(projectId);
  const ws = resolveSheet(pb, sheet);
  if (!ws) return { error: `シート「${sheet}」が見つかりません` };
  const hits: unknown[] = [];
  for (let r = 1; r <= ws.rowCount && hits.length < 50; r++) {
    const labels: Record<string, string> = {};
    let matched = false;
    for (let c = 1; c <= 5; c++) {
      const v = normalize(ws.getCell(r, c).value);
      if (typeof v === 'string' && v.trim() !== '') {
        labels[ws.getCell(r, c).address] = v;
        if (v.includes(query)) matched = true;
      }
    }
    if (matched) hits.push({ row: r, labels });
  }
  return { sheet, query, hits };
}

/** 数式から参照（A1 / Sheet!A1 / top:end!A1 / 範囲）を抽出する */
function extractRefs(formula: string): { raw: string; sheetRange?: [string, string]; sheet?: string; cellOrRange: string }[] {
  // 例: SUM(top:end!E6) / FY!E6 / E66+E82 / SUM(E6:E47)
  const re = /(?:'([^']+)'|([A-Za-z0-9_ ]+?))(?::(?:'([^']+)'|([A-Za-z0-9_ ]+?)))?!(\$?[A-Z]+\$?\d+(?::\$?[A-Z]+\$?\d+)?)|(\$?[A-Z]+\$?\d+(?::\$?[A-Z]+\$?\d+)?)/g;
  const refs: ReturnType<typeof extractRefs> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(formula))) {
    if (m[5]) {
      // シート修飾あり
      const s1 = m[1] ?? m[2], s2 = m[3] ?? m[4];
      if (s2) refs.push({ raw: m[0], sheetRange: [s1.trim(), s2.trim()], cellOrRange: m[5] });
      else refs.push({ raw: m[0], sheet: s1.trim(), cellOrRange: m[5] });
    } else if (m[6]) {
      refs.push({ raw: m[0], cellOrRange: m[6] });
    }
  }
  return refs;
}

/** 列記号 → 番号（A=1, AA=27）。範囲展開用 */
function colToNum(s: string): number {
  let n = 0;
  for (const ch of s.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}
/** 番号 → 列記号（1=A） */
function numToCol(n: number): string {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/** A1:B3 形式の範囲をセル参照配列へ展開する。総数が cap を超える場合は null（展開しない） */
function enumerateRange(range: string, cap: number): string[] | null {
  const m = range.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i);
  if (!m) return null;
  const c1 = colToNum(m[1]), r1 = Number(m[2]), c2 = colToNum(m[3]), r2 = Number(m[4]);
  const [cl, ch] = [Math.min(c1, c2), Math.max(c1, c2)];
  const [rl, rh] = [Math.min(r1, r2), Math.max(r1, r2)];
  if ((ch - cl + 1) * (rh - rl + 1) > cap) return null;
  const out: string[] = [];
  for (let r = rl; r <= rh; r++) for (let c = cl; c <= ch; c++) out.push(`${numToCol(c)}${r}`);
  return out;
}

/** タブ並び順で top〜end の間（両端含む）のシート名を返す（3-D 参照展開） */
function expandSheetRange(pb: ProjectBook, from: string, to: string): string[] {
  for (const { wb } of pb.books.values()) {
    const names = wb.worksheets.map(w => w.name);
    const i = names.indexOf(from), j = names.indexOf(to);
    if (i !== -1 && j !== -1) return names.slice(Math.min(i, j), Math.max(i, j) + 1);
  }
  return [];
}

/**
 * 数式の出所（precedents）を再帰的に辿る。
 * - 同シート参照・他シート参照・3-D 参照(top:end!)を展開して各セルの値/数式を返す。
 * - depth は既定 1（直接の参照先のみ）。深掘りしたい時のみ増やす。トークン保護のため上限 3。
 */
async function traceFormula(projectId: number, sheet: string, ref: string, depth = 1) {
  const pb = await getBooks(projectId);
  const cap = Math.min(Math.max(depth, 0), 3);

  async function walk(sh: string, rf: string, d: number): Promise<unknown> {
    const ws = resolveSheet(pb, sh);
    if (!ws) return { sheet: sh, ref: rf, error: 'シートなし' };
    const cell = ws.getCell(rf);
    const formula = formulaOf(cell);
    const node: Record<string, unknown> = { sheet: sh, ref: rf, value: normalize(cell.value), formula: formula ?? null };
    if (!formula || d >= cap) return node;

    const precedents: unknown[] = [];
    for (const r of extractRefs(formula)) {
      const targets = r.sheetRange ? expandSheetRange(pb, r.sheetRange[0], r.sheetRange[1])
        : r.sheet ? [r.sheet] : [sh];
      const clean = r.cellOrRange.replace(/\$/g, '');
      const single = !/:/.test(clean);
      for (const t of targets) {
        if (single) {
          precedents.push(await walk(t, clean, d + 1));
        } else {
          // 小さい範囲（≤16セル）は各セルへ展開して出所を辿る（AS99:AS103 等の集計行に有効）。
          // 大きい範囲は肥大化防止のため要約ノードのまま残す。
          const cells = enumerateRange(clean, 16);
          if (cells) {
            for (const cref of cells) precedents.push(await walk(t, cref, d + 1));
          } else {
            precedents.push({ sheet: t, range: clean, note: '範囲が大きいため未展開（get_range で個別取得可）' });
          }
        }
      }
    }
    node.precedents = precedents;
    return node;
  }

  return walk(sheet, ref, 0);
}

// ───────────────────────── ツール定義（Anthropic tools 形式） ─────────────────────────

export const QA_TOOL_DEFS = [
  { name: 'get_sheet_map', description: '全シートの一覧（寸法・数式セル数）。質問対象シートの特定に使う。', input_schema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'get_cell', description: '単一セルの値と数式原文を取得する。', input_schema: { type: 'object', properties: { sheet: { type: 'string' }, ref: { type: 'string', description: '例: AS250' } }, required: ['sheet', 'ref'], additionalProperties: false } },
  { name: 'get_range', description: '矩形範囲の値・数式を取得する（最大400セル）。', input_schema: { type: 'object', properties: { sheet: { type: 'string' }, range: { type: 'string', description: '例: E6:H48' } }, required: ['sheet', 'range'], additionalProperties: false } },
  { name: 'find_rows', description: 'ラベル列(A〜E)に語句を含む行を探す。勘定科目など行の意味の特定に使う。', input_schema: { type: 'object', properties: { sheet: { type: 'string' }, query: { type: 'string' } }, required: ['sheet', 'query'], additionalProperties: false } },
  { name: 'trace_formula', description: 'セルの数式が参照する元セル（3-D参照 top:end! を含む）を再帰的に辿り、出所を示す。', input_schema: { type: 'object', properties: { sheet: { type: 'string' }, ref: { type: 'string' }, depth: { type: 'integer', description: '辿る深さ。既定1・最大3' } }, required: ['sheet', 'ref'], additionalProperties: false } },
] as const;

/** ツール名 → 実行関数のディスパッチ */
export async function runQaTool(projectId: number, name: string, input: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'get_sheet_map': return getSheetMap(projectId);
    case 'get_cell': return getCell(projectId, String(input.sheet), String(input.ref));
    case 'get_range': return getRange(projectId, String(input.sheet), String(input.range));
    case 'find_rows': return findRows(projectId, String(input.sheet), String(input.query));
    case 'trace_formula': return traceFormula(projectId, String(input.sheet), String(input.ref), Number(input.depth ?? 1));
    default: return { error: `未知のツール: ${name}` };
  }
}

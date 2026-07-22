// シート関係性分析モジュール（設計書の §6.1 前処理を「関係把握」方向に拡張）。
//
// classify.ts は「シート単位」の役割推定だが、本モジュールは現場の難所2点に対応する:
//   (1) 1シート内に複数の表 → 「表領域(region)」単位で捉える
//   (2) 手コピー(値貼り付け=数式なし) → 参照グラフが切れる箇所を値の一致から逆推定する
//
// 出力は「ノード=表領域の列 / 辺=関係(集計・参照・コピー等)」のグラフ。
// 数式由来の辺は確定的・高確信、値由来(手コピー推定)の辺は確率的でノイズ抑制ゲートを掛ける。
import ExcelJS from 'exceljs';
import { parseCsv } from './parse.js';

// ============================================================
// 生グリッド（領域検出には行圧縮しない生の格子が要る）
// ============================================================
export interface RawCell { r: number; c: number; value: string | number | null; formula?: string }
// file: どのファイル由来か（複数ファイル横断解析でシート名衝突・ファイル間関係を扱うため）
export interface RawGrid { file: string; name: string; cells: RawCell[]; maxR: number; maxC: number }

function normalizeValue(v: ExcelJS.CellValue): string | number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' || typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    const o = v as unknown as Record<string, unknown>;
    if ('result' in o && o.result !== undefined && o.result !== null) return normalizeValue(o.result as ExcelJS.CellValue);
    if ('richText' in o) return (o.richText as { text: string }[]).map(t => t.text).join('');
    if ('text' in o) return String(o.text);
    if ('error' in o) return String(o.error);
    // 結果が未キャッシュの数式セル等は値として扱わない（[object Object] 化を防ぐ）
    if ('formula' in o || 'sharedFormula' in o) return null;
  }
  return String(v);
}

export async function buildGridsFromBuffer(buffer: Buffer, file = ''): Promise<RawGrid[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const grids: RawGrid[] = [];
  wb.eachSheet(ws => {
    const cells: RawCell[] = [];
    let maxR = 0, maxC = 0;
    ws.eachRow({ includeEmpty: false }, (row, r) => {
      row.eachCell({ includeEmpty: false }, (cell, c) => {
        const value = normalizeValue(cell.value);
        const fv = cell.value as { formula?: string; sharedFormula?: string } | null;
        const formula = cell.formula || fv?.formula || fv?.sharedFormula;
        if (value === null && !formula) return;
        cells.push({ r, c, value, formula: formula ? String(formula) : undefined });
        if (r > maxR) maxR = r;
        if (c > maxC) maxC = c;
      });
    });
    grids.push({ file, name: ws.name, cells, maxR, maxC });
  });
  return grids;
}

/** CSV を 1 グリッドに変換（数式なし・単表）。クロスファイルで raw CSV → xlsx へのコピーを拾うため */
function gridFromCsv(buffer: Buffer, file: string): RawGrid {
  const parsed = parseCsv(buffer);
  const sheet = parsed.sheets[0];
  const cells: RawCell[] = [];
  let maxR = 0, maxC = 0;
  for (const row of sheet.rows) {
    for (const cell of row.cells) {
      if (cell.value === null) continue;
      const m = /^([A-Za-z]+)(\d+)$/.exec(cell.ref);
      if (!m) continue;
      const c = colNum(m[1]), r = Number(m[2]);
      cells.push({ r, c, value: cell.value });
      if (r > maxR) maxR = r;
      if (c > maxC) maxC = c;
    }
  }
  return { file, name: 'データ', cells, maxR, maxC };
}

/** ファイル名から拡張子を除いた表示ラベル */
function fileLabelOf(filename: string): string {
  return filename.replace(/\.[^.]+$/, '') || filename;
}

/** 1 アーティファクト（xlsx/csv）→ グリッド群（file ラベル付き） */
export async function gridsFromArtifact(filename: string, buffer: Buffer): Promise<RawGrid[]> {
  const label = fileLabelOf(filename);
  if (/\.(xlsx|xlsm)$/i.test(filename)) return buildGridsFromBuffer(buffer, label);
  if (/\.csv$/i.test(filename)) return [gridFromCsv(buffer, label)];
  return [];
}

export function colLetter(n: number): string {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
function colNum(s: string): number { let n = 0; for (const ch of s.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64); return n; }

/** 「1,200,000」「-3.5」「85%」「1000円」等、数値として保存されがちな文字列か */
function looksNumeric(s: string): boolean {
  const t = s.trim().replace(/[,\s¥$%円]/g, '');
  return t !== '' && /^-?\d+(\.\d+)?$/.test(t);
}

// ============================================================
// (1) 表領域(region)検出
// ============================================================
// 列の値統計（キー・軸検出の材料）。filled=非空値数 / uniq=一意値数 / text=非数値文字列数
export interface ColumnStats { filled: number; uniq: number; text: number }
export interface RegionColumn { c: number; name: string; hasFormula: boolean; mixedFormula: boolean; manualNumeric: number; stats?: ColumnStats }

// ---- キー・軸（この表は何を軸に1行が決まるか） ----
// role: primary=単独で行を一意に定める列 / axis=複合軸の構成列（例: 部署 × 月）
export interface RegionKey { column: string; c: number; role: 'primary' | 'axis'; confidence: number; evidence: string[] }
export interface RegionKeys {
  keys: RegionKey[];
  axisNote?: string;  // 「部署 × 月 の組合せで1行が決まる」等の要約
  colAxis?: string;   // 列方向の軸（月次系列ヘッダー等）の要約
}

export interface Region {
  id: string; file: string; sheet: string;
  r0: number; r1: number; c0: number; c1: number;
  headerRow: number | null;
  columns: RegionColumn[];
  dataRowCount: number;
  keys?: RegionKeys;  // キー・軸の推定（構造的根拠 + 数式からのキー利用根拠を融合）
}

/** 1グリッドを空行/空列の run で矩形分割し、表領域を返す（縦積み・横並びの複数表に対応） */
export function detectRegions(g: RawGrid): Region[] {
  if (g.cells.length === 0) return [];

  // 行→セル の索引を1回だけ作る。旧実装は rowHas/colHas で 1..maxR×1..maxC を走査し、
  // さらに各列で cells.filter を回していたため O(セル×列) で大規模・横長シートで凍結していた。
  // 索引化＋「データのある行/列だけ」を走査することで全体を O(セル) 程度に抑える。
  const byRow = new Map<number, RawCell[]>();
  for (const c of g.cells) {
    let arr = byRow.get(c.r);
    if (!arr) { arr = []; byRow.set(c.r, arr); }
    arr.push(c);
  }
  // 実データのある行を昇順に並べ、連続する行（空行で途切れない範囲）を1バンドとする
  const occRows = [...byRow.keys()].sort((a, b) => a - b);
  const bands: [number, number][] = [];
  for (let i = 0; i < occRows.length; i++) {
    const start = occRows[i];
    while (i + 1 < occRows.length && occRows[i + 1] === occRows[i] + 1) i++;
    bands.push([start, occRows[i]]);
  }

  const regions: Region[] = [];
  let idx = 0;
  for (const [r0, r1] of bands) {
    // バンド内セルを列で索引化（空列で途切れない連続列を1グループ＝表とする）
    const bandByCol = new Map<number, RawCell[]>();
    for (let r = r0; r <= r1; r++) {
      const rowCells = byRow.get(r);
      if (!rowCells) continue;
      for (const cell of rowCells) {
        let arr = bandByCol.get(cell.c);
        if (!arr) { arr = []; bandByCol.set(cell.c, arr); }
        arr.push(cell);
      }
    }
    const occCols = [...bandByCol.keys()].sort((a, b) => a - b);
    const groups: [number, number][] = [];
    for (let i = 0; i < occCols.length; i++) {
      const cs = occCols[i];
      while (i + 1 < occCols.length && occCols[i + 1] === occCols[i] + 1) i++;
      groups.push([cs, occCols[i]]);
    }

    for (const [c0, c1] of groups) {
      // この表のセルを集約し、ヘッダー検出用に行索引も作る
      const cellsIn: RawCell[] = [];
      const inByRow = new Map<number, RawCell[]>();
      for (let c = c0; c <= c1; c++) {
        const colCells = bandByCol.get(c);
        if (!colCells) continue;
        for (const cell of colCells) {
          cellsIn.push(cell);
          let arr = inByRow.get(cell.r);
          if (!arr) { arr = []; inByRow.set(cell.r, arr); }
          arr.push(cell);
        }
      }

      // ヘッダー行検出: 数式なし・非数値文字列主体の行で、直下にデータ(数値/数式/数値型文字列)がある。
      // 実務シートは「1,200,000」「令和6年1月」等 数値が文字列保存されることが多いので数値型文字列も信号にする。
      let headerRow: number | null = null;
      for (let r = r0; r <= Math.min(r1, r0 + 3); r++) {
        const rowCells = inByRow.get(r) ?? [];
        if (rowCells.some(x => x.formula)) continue; // ヘッダー行は数式を持たない
        const labels = rowCells.filter(x => typeof x.value === 'string' && !looksNumeric(x.value)).length;
        const nextSignal = (inByRow.get(r + 1) ?? []).filter(x =>
          (typeof x.value === 'number' || !!x.formula || (typeof x.value === 'string' && looksNumeric(x.value)))).length;
        if (rowCells.length >= 2 && labels >= rowCells.length / 2 && nextSignal > 0) { headerRow = r; break; }
      }
      // フォールバック: 全列が文字列の表（社員マスタ等）は「直下に数値・数式がある」条件を
      // 満たせずヘッダー未検出になる。先頭行が数式なし・全て非数値文字列で、
      // 下に2行以上データがあれば見出し行とみなす（キー・軸の列名表示に効く）
      if (headerRow === null) {
        const rowCells = inByRow.get(r0) ?? [];
        const labels = rowCells.filter(x => typeof x.value === 'string' && !looksNumeric(x.value)).length;
        const rowsBelow = [...inByRow.keys()].filter(r => r > r0).length;
        if (rowCells.length >= 2 && labels === rowCells.length && !rowCells.some(x => x.formula) && rowsBelow >= 2) {
          headerRow = r0;
        }
      }

      // 1パス目: 列ごとの本体セルと数式セル数（ヘッダー行は除く）
      const colStats = new Map<number, { body: RawCell[]; withF: number }>();
      for (let c = c0; c <= c1; c++) {
        const colCells = bandByCol.get(c);
        if (!colCells || colCells.length === 0) continue;
        const body = headerRow === null ? colCells : colCells.filter(x => x.r !== headerRow);
        colStats.set(c, { body, withF: body.filter(x => x.formula).length });
      }
      // 2パス目: 「行ぐるみで数式なし」の構造的な手入力行を検出する。
      // 業績管理表のように入力行（数値手打ち）と計算行（数式）が縦に交互に並ぶ表では、
      // 列方向で見るとほぼ全列が数式+手入力の混在になり誤検出だらけになる。
      // 設計上の入力行は上書きではないので、数式を持つ列群（候補列）の中で半数以上が数式なしの行を除外し、
      // 「その行では他列は数式なのに自分だけ数式が消えている」孤立セルだけを上書き疑いとして残す。
      const candidateCols = new Set([...colStats].filter(([, s]) => s.withF >= 2).map(([c]) => c));
      const rowNoF = new Map<number, number>();
      const rowTotal = new Map<number, number>();
      for (const c of candidateCols) {
        for (const x of colStats.get(c)!.body) {
          rowTotal.set(x.r, (rowTotal.get(x.r) ?? 0) + 1);
          if (!x.formula) rowNoF.set(x.r, (rowNoF.get(x.r) ?? 0) + 1);
        }
      }
      const isManualRow = (r: number) => {
        const n = rowNoF.get(r) ?? 0;
        return n >= 2 && n * 2 >= (rowTotal.get(r) ?? 0);
      };

      const columns: RegionColumn[] = [];
      for (let c = c0; c <= c1; c++) {
        const st = colStats.get(c);
        if (!st) continue;
        const { body, withF } = st;
        const headerCell = headerRow !== null ? bandByCol.get(c)?.find(x => x.r === headerRow) : undefined;
        const name = headerCell && typeof headerCell.value === 'string' ? headerCell.value : `${colLetter(c)}列`;
        const hasFormula = withF > 0;
        // 手入力上書き疑い（S4）: 手入力行を除いた本体（=数式であるべき側）で再判定する。
        // 対象は「数式なしの数値セル」のみ — 見出し・小計ラベル・注記などの文字列セルは
        // 数式を持たないのが当然でノイズになるため数えない。除外後も数式が主体（>=2 かつ多数派）で
        // ある列に数値セルが残る場合だけを上書き疑いとする。手入力列の末尾に合計数式が1つある形も
        // 「数式 > 手入力数値」を満たさず自然に除外される。
        const bodyEff = body.filter(x => !isManualRow(x.r));
        const withFEff = bodyEff.filter(x => x.formula).length;
        const manualNumeric = bodyEff.filter(x => !x.formula &&
          (typeof x.value === 'number' || (typeof x.value === 'string' && looksNumeric(x.value)))).length;
        const mixedFormula = withFEff >= 2 && manualNumeric > 0 && withFEff > manualNumeric;
        // キー・軸検出用の値統計（本体セルのみ、ヘッダー除外済み）
        const vals = body.filter(x => x.value !== null).map(x => x.value as string | number);
        const stats: ColumnStats = {
          filled: vals.length,
          uniq: new Set(vals.map(fpVal)).size,
          text: vals.filter(v => typeof v === 'string' && !looksNumeric(v)).length,
        };
        columns.push({ c, name, hasFormula, mixedFormula, manualNumeric, stats });
      }

      const rowsSet = new Set<number>();
      for (const x of cellsIn) if (headerRow === null || x.r !== headerRow) rowsSet.add(x.r);
      const dataRowCount = rowsSet.size;
      // 最小サイズゲート: 列1つ以下 or データ行0は「表」でない（タイトル・メモ）として除外
      if (columns.length < 2 && dataRowCount < 2) continue;
      // ヘッダー検出できず実データ1行以下は結合タイトル等。表でないので除外
      if (headerRow === null && dataRowCount < 2) continue;

      // キー・軸の構造的検出（値の一意性・複合軸・時系列ヘッダー）。数式からのキー利用根拠は
      // 辺の確定後に enrichKeysWithUsage で融合する（ここでは値だけから分かることを出す）
      const keys = detectStructuralKeys(columns, c => bandByCol.get(c), headerRow, dataRowCount);

      // id はファイルを含めて一意化（複数ファイルで同名シートがあっても衝突しない）。Excel のシート名・ファイル名は ':' を含めないので ':' を列区切りに使える
      regions.push({ id: `${g.file}／${g.name}#${++idx}`, file: g.file, sheet: g.name, r0, r1, c0, c1, headerRow, columns, dataRowCount, keys });
    }
  }
  return regions;
}

// ============================================================
// (1b) キー・軸検出（この表は何を軸に1行が決まるか）
// ============================================================
// 「4月」「2024/4」「2024年4月」「Q1」「第1四半期」等、時系列ヘッダーらしい列名
const SERIES_HEADER = /(^|[^0-9])\d{1,2}月|^\d{4}[年\/.\-]\s*\d{1,2}|^\d{1,2}\/\d{1,2}$|^(Q[1-4]|第[1-4]四半期)/;

/**
 * 値だけから分かる構造的なキー・軸を検出する。
 *  (a) 単独一意列 = 主キー候補。ただし右側の数値列（金額等）は「たまたま全行違う」ことが多いので、
 *      文字列主体 or 先頭側の列に限る（それ以外は数式からキー利用の根拠が出た時のみ昇格）。
 *  (b) 主キーが無い表は、左から次元列（低カディナリティ・文字列主体）を重ねて
 *      行が一意になる最小の組を探す（例: 部署 × 月 のクロス集計表）。
 *  (c) 列方向の軸: 月次などの反復ヘッダーが並ぶ場合は「列方向は時系列」と要約する。
 */
function detectStructuralKeys(
  columns: RegionColumn[],
  cellsOf: (c: number) => RawCell[] | undefined,
  headerRow: number | null,
  dataRowCount: number,
): RegionKeys | undefined {
  if (dataRowCount < 3 || columns.length < 2) return undefined;
  // 列ごとの 行→正規化値。複合軸のタプル判定に使う（ヘッダー行・空値は除外）
  const valByCol = new Map<number, Map<number, string>>();
  for (const col of columns) {
    const m = new Map<number, string>();
    for (const x of cellsOf(col.c) ?? []) {
      if (x.r === headerRow || x.value === null) continue;
      m.set(x.r, fpVal(x.value));
    }
    valByCol.set(col.c, m);
  }

  const keys: RegionKey[] = [];
  // (a) 単独一意列（主キー候補）。数値主体の一意列は「金額がたまたま全行違う」だけのことが
  // 多いので、最左列（ID が置かれる定位置）に限る。それ以外の一意列は文字列主体のみ。
  for (const col of columns) {
    const st = col.stats!;
    if (st.filled >= Math.max(3, dataRowCount * 0.9) && st.uniq === st.filled && st.uniq >= 3
      && (st.text * 2 >= st.filled || col.c === columns[0].c)) {
      keys.push({
        column: col.name, c: col.c, role: 'primary', confidence: 0.85,
        evidence: [`全${st.filled}行で値がすべて異なる（重複なし）`],
      });
    }
  }

  // (b) 複合軸（主キーが無い場合のみ。例: 部署 × 月）
  // 軸列は左端に置かれるのが通例なので候補は左から12列まで。超大規模表はタプル生成が
  // 支配的コストになる（凍結の温床）ため打ち切り、主キー・キー利用の根拠だけに頼る
  let axisNote: string | undefined;
  if (keys.length === 0 && dataRowCount <= 200_000) {
    const dims = columns.filter(col => {
      const st = col.stats!;
      return !col.hasFormula && st.filled >= dataRowCount * 0.5 && st.uniq >= 2 && st.uniq < st.filled
        && (st.text * 2 >= st.filled || st.uniq <= Math.max(24, st.filled * 0.3));
    }).slice(0, 12);
    const combo: RegionColumn[] = [];
    let bestDistinct = 0;
    for (const col of dims) {
      if (combo.length >= 4) break;
      const tentative = [...combo, col];
      // 組の全列が値を持つ行だけでタプルを作る（合計行などキー欠損行は自然に除外される）
      const rows = [...(valByCol.get(tentative[0].c)?.keys() ?? [])];
      const tuples: string[] = [];
      for (const r of rows) {
        const parts = tentative.map(t => valByCol.get(t.c)?.get(r));
        if (parts.some(p => p === undefined)) continue;
        tuples.push(parts.join('\u0001'));
      }
      if (tuples.length < dataRowCount * 0.6) continue; // カバー率が低すぎる組は不採用
      const distinct = new Set(tuples).size;
      if (distinct <= bestDistinct) continue; // 足しても行を区別できるようにならない列はスキップ
      combo.push(col);
      bestDistinct = distinct;
      if (distinct === tuples.length) {
        axisNote = `${combo.map(c => `「${c.name}」`).join(' × ')} の組合せで1行が決まる（${tuples.length}行で重複なし）`;
        for (const c of combo) keys.push({ column: c.name, c: c.c, role: 'axis', confidence: 0.8, evidence: [axisNote] });
        break;
      }
    }
  }

  // (c) 列方向の軸（自動命名 "AB列" は除外し、実ヘッダー名だけを見る）
  const seriesCols = columns.filter(c => !/^[A-Z]+列$/.test(c.name) && SERIES_HEADER.test(c.name));
  const colAxis = seriesCols.length >= 4
    ? `列方向は時系列（${seriesCols.slice(0, 3).map(c => c.name).join('・')} … 全${seriesCols.length}列）を軸に展開`
    : undefined;

  if (keys.length === 0 && !colAxis) return undefined;
  return { keys, axisNote, colAxis };
}

// ============================================================
// (2a) 数式参照 → 列レベルのリネージュ辺（引数位置で関係種別を判定）
// ============================================================
export type RelType =
  | 'lookup-join'    // VLOOKUP 等のテーブル参照（値の引き当て）
  | 'filter-key'     // SUMIF の条件範囲 / VLOOKUP の検索キー（データ源でなく結合キー）
  | 'filtered-agg'   // SUMIF 等の集計対象範囲
  | 'aggregation'    // SUM 等の単純集計
  | 'passthrough'    // 単一セルの転記リンク
  | 'derived'        // 四則演算による派生
  | 'copy';          // 値一致による手コピー推定（数式由来でない）

export interface Edge {
  from: string; to: string; type: RelType;
  evidence: string; confidence: number;
  needsConfirmation?: boolean;
}

interface Ref { sheet: string; c0: number; c1: number; r0: number | null; r1: number | null; argIndex: number }

/** 数式から参照を抽出。SUMIF/SUMIFS/VLOOKUP は引数位置(argIndex)も付ける */
function extractRefs(formula: string, curSheet: string): Ref[] {
  const refs: Ref[] = [];
  const reRef = /(?:(?:'([^']+)'|([A-Za-z0-9_À-鿿぀-ヿ＀-￯]+))!)?\$?([A-Za-z]{1,3})\$?(\d+)?(?::\$?([A-Za-z]{1,3})\$?(\d+)?)?/g;

  // トップレベル関数名と、各参照が何番目の引数にあるかを把握するため、
  // 括弧深度1のカンマ位置を見て argIndex を割り当てる簡易パーサ
  const fname = (formula.match(/^([A-Za-z]+)\s*\(/) ?? [])[1]?.toUpperCase();
  // 引数境界（深度1のカンマ）のインデックス列
  const commaPos: number[] = [];
  let depth = 0;
  for (let i = 0; i < formula.length; i++) {
    const ch = formula[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 1) commaPos.push(i);
  }
  const argIndexAt = (pos: number): number => {
    let a = 0;
    for (const cp of commaPos) { if (pos > cp) a++; else break; }
    return a;
  };

  let m: RegExpExecArray | null;
  while ((m = reRef.exec(formula)) !== null) {
    if (!m[0]) { reRef.lastIndex++; continue; }
    const cA = m[3];
    if (!cA) continue;
    const after = formula[m.index + m[0].length];
    if (after === '(') continue; // 関数名を列参照と誤認しない
    // 直後が '!' のトークンはセルでなくシート名。`top:end!E6`（シート範囲の3D参照）を
    // 「TOP列〜END列」という巨大列範囲と誤認していた（実測 1万列幅×62万件→数十億反復で凍結）。
    // ここでスキップすれば、続く本物のセル参照 E6 は次の照合で正しく拾われる。
    if (after === '!') continue;
    const sheet = m[1] ?? m[2] ?? curSheet;
    const c0 = colNum(cA), c1 = m[5] ? colNum(m[5]) : c0;
    const r0 = m[4] ? Number(m[4]) : null;
    const r1 = m[6] ? Number(m[6]) : (m[4] ? Number(m[4]) : null);
    // 防御策: 異常に広い列範囲（誤パース疑い）は辺を作らない。実表で1参照が数百列を超えることは稀。
    if (Math.abs(c1 - c0) > 1024) continue;
    refs.push({ sheet, c0: Math.min(c0, c1), c1: Math.max(c0, c1), r0, r1, argIndex: fname ? argIndexAt(m.index) : -1 });
  }
  return refs;
}

function topFunc(formula: string): string | undefined {
  return (formula.match(/^\s*([A-Za-z]+)\s*\(/) ?? [])[1]?.toUpperCase();
}

/** 数式 + 参照の引数位置から関係種別を決める */
function classifyRef(formula: string, ref: Ref): RelType {
  const f = topFunc(formula);
  const F = formula.toUpperCase();
  if (f === 'SUMIF' || f === 'AVERAGEIF' || f === 'COUNTIF') {
    // SUMIF(範囲=key, 条件, 合計範囲=source). 引数0=key, 引数2=source
    if (ref.argIndex === 0) return 'filter-key';
    if (ref.argIndex === 2) return 'filtered-agg';
    return 'filter-key';
  }
  if (f === 'SUMIFS' || f === 'AVERAGEIFS' || f === 'COUNTIFS') {
    // SUMIFS(合計範囲=source, 条件範囲1=key, 条件1, ...). 引数0=source, 偶数引数(>=1)=key
    if (ref.argIndex === 0) return 'filtered-agg';
    return 'filter-key';
  }
  if (f === 'VLOOKUP' || f === 'HLOOKUP') {
    // VLOOKUP(検索値=key, テーブル=source, 列番号, ...). 引数0=key, 引数1=source(table)
    if (ref.argIndex === 0) return 'filter-key';
    return 'lookup-join';
  }
  if (f === 'XLOOKUP') {
    // XLOOKUP(検索値=key, 検索範囲=key, 戻り範囲=source, ...). 引数0,1=key, 引数2=source
    return ref.argIndex <= 1 ? 'filter-key' : 'lookup-join';
  }
  // MATCH(検索値, 検索範囲, 型) は位置を返すだけでデータ源でない。両引数とも結合キー
  if (f === 'MATCH') return 'filter-key';
  if (/\b(XLOOKUP|INDEX|MATCH)\b/.test(F)) return 'lookup-join';
  if (/\b(SUM|AVERAGE|MAX|MIN|COUNT|PRODUCT)\b/.test(F)) return 'aggregation';
  // 単一セルの転記（=Sheet!A1 / =A1 のみ）
  if (/^\s*=?\s*(?:'[^']+'|[^!=()]+)?!?\$?[A-Za-z]+\$?\d+\s*$/.test(formula)) return 'passthrough';
  return 'derived';
}

type LocateFn = (file: string, sheet: string, c: number, r: number | null) => { region: Region; colName: string } | null;

/**
 * (file,sheet,col,row) → region/column を引く関数を、事前インデックス付きで構築する。
 * 元実装は呼び出しごとに全 region を線形探索していた（数式セル × 参照範囲の列数ぶん呼ばれ、
 * 大規模ワークブックで支配的コストになる）。シート単位に region をまとめ、列名も c で引ける
 * マップを前計算することで、1回の探索を「そのシートの region 数（通常ごく少数）」に縮小する。
 * 判定ロジック（行内一致を優先し、無ければ列範囲一致）は元実装と同一。
 */
function buildLocator(regions: Region[]): LocateFn {
  const bySheet = new Map<string, Region[]>();
  const colNames = new Map<string, Map<number, string>>(); // region.id → (列番号 → 列名)
  for (const reg of regions) {
    const k = `${reg.file} ${reg.sheet}`;
    let arr = bySheet.get(k);
    if (!arr) { arr = []; bySheet.set(k, arr); }
    arr.push(reg);
    const cm = new Map<number, string>();
    for (const col of reg.columns) cm.set(col.c, col.name);
    colNames.set(reg.id, cm);
  }
  return (file, sheet, c, r) => {
    const arr = bySheet.get(`${file} ${sheet}`);
    if (!arr) return null;
    let reg = arr.find(g => c >= g.c0 && c <= g.c1 && (r === null || (r >= g.r0 && r <= g.r1)));
    if (!reg) reg = arr.find(g => c >= g.c0 && c <= g.c1);
    if (!reg) return null;
    return { region: reg, colName: colNames.get(reg.id)!.get(c) ?? `${colLetter(c)}列` };
  };
}

/**
 * 数式の「行番号を除いた形」= ドラッグ複製の指紋。セル行番号だけを # に潰し、
 * シート名の末尾数字（`!` の直前）は保存する（`Sheet1!` と `Sheet2!` を混同しない）。
 * 定数（1.08 等）は # 化されるが、定数は辺を生まないので列レベル辺の出力は不変。
 * 同一(ファイル,シート,列,この指紋)のセルは同じ列レベル辺を生む（=フィルダウン）ため、
 * 代表1セルだけ処理すれば足りる。実測: 業績管理表で数式セル40万→一意指紋1.6万(4%)、約24倍削減。
 */
function formulaShape(f: string): string {
  return f.replace(/\d+/g, (m, off: number, s: string) => s[off + m.length] === '!' ? m : '#');
}

// ---- 表と表を結ぶ「キーの対応」 ----
// a=数式側（ローカル）のキー列, b=参照される側（リモート）のキー列, via=引き当て先（数式が書かれた列）
// 例: 売上明細.商品ID(a) ⇔ 商品マスタ.商品ID(b) via 売上明細.単価 (VLOOKUP)
export interface KeyLink { a: string; b: string; via: string; fn: string; evidence: string; count: number }

/**
 * 関数の引数位置から「(ローカルキー引数, リモートキー範囲引数)」の対を返す。
 * VLOOKUP(検索値, テーブル, …) / XLOOKUP(検索値, 検索範囲, …) / MATCH(検索値, 検索範囲, …) → (0,1)
 * SUMIF(範囲, 条件, …) → 条件(1) がローカル・範囲(0) がリモート
 * SUMIFS(合計範囲, 条件範囲1, 条件1, …) → (条件k+1, 条件範囲k) の対の列
 * ※ 条件が定数（"承認済" 等）ならローカル側の参照が無く対は生まれない（filter-key 辺のみ残る）
 * ※ IFERROR 等で包まれた数式は引数位置が取れないため対象外（トップレベル関数のみ）
 */
function keyPairArgs(f: string | undefined, maxArg: number): [number, number][] {
  if (f === 'VLOOKUP' || f === 'XLOOKUP' || f === 'MATCH') return [[0, 1]];
  if (f === 'SUMIF' || f === 'AVERAGEIF' || f === 'COUNTIF') return [[1, 0]];
  if (f === 'SUMIFS' || f === 'AVERAGEIFS') {
    const out: [number, number][] = [];
    for (let k = 1; k + 1 <= maxArg; k += 2) out.push([k + 1, k]);
    return out;
  }
  if (f === 'COUNTIFS') {
    const out: [number, number][] = [];
    for (let k = 0; k + 1 <= maxArg; k += 2) out.push([k + 1, k]);
    return out;
  }
  return [];
}

const KEY_LINK_CAP = 800;

export function formulaLineage(grids: RawGrid[], regions: Region[]): { edges: Edge[]; keyLinks: KeyLink[] } {
  const edges = new Map<string, Edge>();
  const keyLinks = new Map<string, KeyLink>();
  const locate = buildLocator(regions); // region をシート単位に索引化（呼び出しごとの全件探索を回避）
  // フィルダウンで構造的に同一な数式セルの重複処理を避けるための既処理指紋集合。
  const seen = new Set<string>();
  for (const g of grids) {
    for (const cell of g.cells) {
      if (!cell.formula) continue;
      const dst = locate(g.file, g.name, cell.c, cell.r);
      if (!dst) continue;
      const shapeKey = `${dst.region.id} ${dst.colName} ${formulaShape(cell.formula)}`;
      if (seen.has(shapeKey)) continue;
      seen.add(shapeKey);
      const fname = topFunc(cell.formula);
      const refs = extractRefs(cell.formula, g.name);
      for (const ref of refs) {
        const baseType = classifyRef(cell.formula, ref);
        for (let c = ref.c0; c <= ref.c1; c++) {
          // VLOOKUP のテーブル参照の先頭列は「照合されるキー列」なので lookup-join でなく filter-key
          //（テーブルが1列だけなら、キー自身が戻り値なので lookup-join のまま）
          const type: RelType = (fname === 'VLOOKUP' && ref.argIndex === 1 && c === ref.c0 && ref.c1 > ref.c0)
            ? 'filter-key' : baseType;
          // 数式参照は同一ファイル内で解決（Excel 数式はファイルをまたがない）
          const src = locate(g.file, ref.sheet, c, ref.r0);
          if (!src) continue;
          if (src.region.id === dst.region.id && src.colName === dst.colName) continue;
          const from = `${src.region.id}:${src.colName}`;
          const to = `${dst.region.id}:${dst.colName}`;
          const key = `${from}->${to}:${type}`;
          if (!edges.has(key)) {
            // filter-key はデータフローでなく結合キーなので確信度を下げて区別
            const confidence = type === 'filter-key' ? 0.6 : 0.95;
            edges.set(key, { from, to, type, evidence: cell.formula, confidence });
          }
        }
      }
      // キーの対応: ローカルキー引数 × リモートキー範囲引数を突き合わせ、表どうしを結ぶキー列の対を作る
      // extractRefs は関数名の断片（"VLO" 等）も参照として拾うことがあるため、
      // 同じ引数位置の参照のうち「実在の表に解決できた最初のもの」を採用する
      const resolveArg = (ai: number) => {
        for (const r of refs) {
          if (r.argIndex !== ai) continue;
          // 範囲は先頭列＝キー列（VLOOKUP テーブル・SUMIFS 条件範囲とも先頭列が照合対象）
          const loc = locate(g.file, r.sheet, r.c0, r.r0);
          if (loc) return loc;
        }
        return null;
      };
      const maxArg = refs.reduce((m, r) => Math.max(m, r.argIndex), -1);
      for (const [la, ra] of keyPairArgs(fname, maxArg)) {
        const local = resolveArg(la);
        const remote = resolveArg(ra);
        if (!local || !remote) continue;
        if (local.region.id === remote.region.id) continue; // 同一表内の照合は表間キーでない
        const a = `${local.region.id}:${local.colName}`;
        const b = `${remote.region.id}:${remote.colName}`;
        const lk = `${a}|${b}|${fname}`;
        const cur = keyLinks.get(lk);
        if (cur) cur.count++;
        else keyLinks.set(lk, {
          a, b, via: `${dst.region.id}:${dst.colName}`,
          fn: fname ?? '', evidence: cell.formula, count: 1,
        });
      }
    }
  }
  // 病的に多い場合は利用回数の多い対だけ残す（表示・転送とも上位で十分）
  const links = [...keyLinks.values()].sort((x, y) => y.count - x.count);
  return { edges: [...edges.values()], keyLinks: links.length > KEY_LINK_CAP ? links.slice(0, KEY_LINK_CAP) : links };
}

/** 後方互換ラッパ（既存スクリプト・検証ツール用）。新規コードは formulaLineage を使う */
export function formulaEdges(grids: RawGrid[], regions: Region[]): Edge[] {
  return formulaLineage(grids, regions).edges;
}

// ============================================================
// (2b) 値フィンガープリント → 手コピー推定（ノイズ抑制ゲート付き）
// ============================================================
interface ColVals { key: string; region: Region; col: RegionColumn; values: (string | number)[] }

function collectColumns(grids: RawGrid[], regions: Region[]): ColVals[] {
  // シート単位に「列→セル」を1回だけ索引化する。旧実装は列ごとに全セルを filter していたため
  // O(セル×列) となり、横長シートが多数あると凍結の原因になっていた（索引化で O(セル) へ）。
  const byKeyCol = new Map<string, Map<number, RawCell[]>>();
  for (const g of grids) {
    const colMap = new Map<number, RawCell[]>();
    for (const cell of g.cells) {
      let arr = colMap.get(cell.c);
      if (!arr) { arr = []; colMap.set(cell.c, arr); }
      arr.push(cell);
    }
    byKeyCol.set(`${g.file} ${g.name}`, colMap);
  }
  const out: ColVals[] = [];
  for (const reg of regions) {
    const colMap = byKeyCol.get(`${reg.file} ${reg.sheet}`)!;
    for (const col of reg.columns) {
      const colCells = colMap.get(col.c);
      if (!colCells) continue;
      const values = colCells
        .filter(x => (reg.headerRow === null || x.r !== reg.headerRow) && x.value !== null)
        .sort((a, b) => a.r - b.r)
        .map(x => x.value as string | number);
      if (values.length > 0) out.push({ key: `${reg.id}:${col.name}`, region: reg, col, values });
    }
  }
  return out;
}
const fpVal = (x: string | number) => typeof x === 'number' ? x.toFixed(4) : String(x).trim();
const uniqRatio = (v: (string | number)[]) => new Set(v.map(fpVal)).size / v.length;
const numericRatio = (v: (string | number)[]) => v.filter(x => typeof x === 'number').length / v.length;

/**
 * 情報量ゲート: コピー推定の照合価値がある列か。
 * 低カディナリティの分類ラベル(東京/大阪…)や定数列は誤検出の温床なので除外する。
 */
function isInformative(v: (string | number)[]): boolean {
  if (v.length < 3) return false;
  if (new Set(v.map(fpVal)).size <= 1) return false;
  // 数値主体ならカディナリティ要件を緩める / 文字列主体なら高ユニークを要求
  if (numericRatio(v) >= 0.5) return uniqRatio(v) >= 0.4;
  return uniqRatio(v) >= 0.8;
}

// 列の「指紋」レコード。手コピー推定に必要なのは値の完全一致判定だけなので、
// 生の値配列ではなく (指紋文字列 + メタ情報) だけを保持する。これにより
// ファイル単位解析で「そのファイルの指紋」だけを次ファイルへ持ち越せる
// （＝原本グリッドをファイル境界で捨ててもクロスファイルのコピー辺を失わない）。
export interface ColFingerprint {
  key: string;        // `${region.id}:${col.name}`（辺の from/to になる）
  regionId: string;   // 同一表内ペアの除外に使う
  hasFormula: boolean;// 向き判定（数式列=source）に使う
  length: number;     // 一致件数（evidence 表示用）
  fp: string;         // 長さ + 値連結。完全一致判定の鍵（元実装のバケット鍵と同一）
}

/** グリッド群から「情報量のある列」の指紋レコードを作る。値配列はここで捨てる。 */
export function fingerprintColumns(grids: RawGrid[], regions: Region[]): ColFingerprint[] {
  return collectColumns(grids, regions)
    .filter(c => isInformative(c.values))
    .map(c => ({
      key: c.key,
      regionId: c.region.id,
      hasFormula: c.col.hasFormula,
      length: c.values.length,
      // 長さも鍵に含めることで、区切り文字の衝突等による誤一致を元実装と同様に防ぐ
      fp: `${c.values.length}#${c.values.map(fpVal).join('|')}`,
    }));
}

/**
 * 指紋レコード群から手コピー辺を作る。
 * 採用条件は「値列が完全一致（順序・長さ込み）」のみ。同一指紋の列だけをバケットに
 * まとめて比較すればよく、元実装の全列ペア総当たり O(列^2) を ≈O(列) に削減する。
 * 方向: 数式列(=計算)を source、値のみ列を dst とする。両方とも値のみなら needsConfirmation。
 * 指紋の入力順を保てば辺の向き・src/dst は元実装と一致する。
 */
export function valueCopyEdgesFromFingerprints(fps: ColFingerprint[], formulaLinked: Set<string>): Edge[] {
  const buckets = new Map<string, ColFingerprint[]>();
  for (const c of fps) {
    let arr = buckets.get(c.fp);
    if (!arr) { arr = []; buckets.set(c.fp, arr); }
    arr.push(c); // 入力順を保つ（src/dst を元実装と一致させる）
  }

  const edges: Edge[] = [];
  for (const group of buckets.values()) {
    if (group.length < 2) continue; // 完全一致の相手がいない列はコピー候補にならない
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i], b = group[j];
        if (a.regionId === b.regionId) continue;
        // 既に数式で連結済みの列ペアは、その数式が本当の関係。コピー辺は重複ノイズなので出さない
        if (formulaLinked.has(unorderedPair(a.key, b.key))) continue;
        // ここに来た時点で「長さ・値列が完全一致」は保証済み（バケット化済み）

        // 方向: 数式列があればそれを source（計算結果を手で貼った）。両方値のみなら確認要。
        let src = a, dst = b, needsConfirmation = false;
        if (a.hasFormula && !b.hasFormula) { src = a; dst = b; }
        else if (b.hasFormula && !a.hasFormula) { src = b; dst = a; }
        else if (!a.hasFormula && !b.hasFormula) { needsConfirmation = true; }
        else continue; // 両方数式列 = それぞれ自前計算。コピーでない

        edges.push({
          from: src.key, to: dst.key, type: 'copy',
          evidence: `値完全一致(${dst.length}件, 手コピー疑い)`,
          confidence: needsConfirmation ? 0.55 : 0.9,
          needsConfirmation,
        });
      }
    }
  }
  return edges;
}

/**
 * 数式を持たない情報量のある列が、他列(計算結果含む)と値一致 → 手コピー辺。
 * 単一パス（全グリッドを同時保持できる小規模）向けの薄いラッパ。
 * 大規模はファイル単位で指紋を貯める analyzeArtifacts を使う。
 */
export function valueCopyEdges(grids: RawGrid[], regions: Region[], formulaLinked: Set<string>): Edge[] {
  return valueCopyEdgesFromFingerprints(fingerprintColumns(grids, regions), formulaLinked);
}

const unorderedPair = (a: string, b: string) => a < b ? `${a}::${b}` : `${b}::${a}`;

// ============================================================
// 統合エントリ
// ============================================================
export interface RelationWarning { kind: 'mixed_formula_column' | 'unknown_region'; ref: string; message: string }

// ============================================================
// シート内部構造（階層フロー）: 1シートを「入力→計算→出力」の段で要約する。
// 列レベルの辺をそのまま並べると数万件になり構造が見えないため、
//  (1) 列を依存の深さ(layer)で段に割り、(2) 同じ段・同じ「入力種別の集合」の列を
//  グループに畳む（反復する月別列などを1ノードに）ことで一目で構造を掴めるようにする。
// ============================================================
export interface SheetStructNode { id: string; layer: number; label: string; colCount: number; cols: string[]; samples: { col: string; formula: string }[] }
export interface SheetStructEdge { from: string; to: string; types: RelType[] }
export interface SheetStructure { regionId: string; layerCount: number; nodes: SheetStructNode[]; edges: SheetStructEdge[]; truncated: boolean }

const STRUCT_MAX_NODES = 30;

// グループの「役割」を入力種別から日本語ラベルにする（列記号 IK 等より遥かに分かりやすい）
function structRole(layer: number, types: RelType[]): string {
  if (layer === 0 || types.length === 0) return '入力';
  if (types.includes('filtered-agg') || types.includes('aggregation')) return '集計';
  if (types.includes('lookup-join')) return '引き当て';
  if (types.includes('passthrough')) return '転記';
  if (types.includes('copy')) return '手コピー';
  return '計算';
}

function buildSheetStructures(regions: Region[], edges: Edge[]): SheetStructure[] {
  const regionIdOf = (k: string) => k.slice(0, k.indexOf(':'));
  const colOf = (k: string) => k.slice(k.indexOf(':') + 1);

  // シート内(同一 region)の列→列辺だけ集める（filter-key は補助線なので構造図から除外）
  const intraByRegion = new Map<string, { from: string; to: string; type: RelType; evidence: string }[]>();
  for (const e of edges) {
    const fr = regionIdOf(e.from);
    if (fr !== regionIdOf(e.to) || e.type === 'filter-key') continue;
    const f = colOf(e.from), t = colOf(e.to);
    if (f === t) continue;
    if (!intraByRegion.has(fr)) intraByRegion.set(fr, []);
    intraByRegion.get(fr)!.push({ from: f, to: t, type: e.type, evidence: e.evidence });
  }

  const structures: SheetStructure[] = [];
  for (const reg of regions) {
    const intra = intraByRegion.get(reg.id);
    if (!intra || intra.length === 0) continue;

    const involved = new Set<string>();
    const incoming = new Map<string, { src: string; type: RelType }[]>();
    for (const e of intra) {
      involved.add(e.from); involved.add(e.to);
      if (!incoming.has(e.to)) incoming.set(e.to, []);
      incoming.get(e.to)!.push({ src: e.from, type: e.type });
    }

    // 依存の深さで層を決める（入力=0、循環は0で打ち切り、最大5段）
    const layer = new Map<string, number>();
    const calcLayer = (c: string, seen: Set<string>): number => {
      const cached = layer.get(c);
      if (cached !== undefined) return cached;
      if (seen.has(c)) return 0;
      seen.add(c);
      const ins = incoming.get(c) ?? [];
      const l = ins.length === 0 ? 0 : Math.min(5, Math.max(...ins.map(i => calcLayer(i.src, seen) + 1)));
      seen.delete(c);
      layer.set(c, l);
      return l;
    };
    for (const c of involved) calcLayer(c, new Set());

    // 同層・同「入力種別の集合」でグループ化（反復列を1ノードへ畳む）
    const typeSet = (c: string) => [...new Set((incoming.get(c) ?? []).map(i => i.type))].sort().join(',');
    const isLetterName = (s: string) => /^[A-Za-z]+列$/.test(s);
    const nodeIdOf = (c: string) => isLetterName(c) ? `g:${layer.get(c) ?? 0}|${typeSet(c)}` : `n:${c}`;
    const members = new Map<string, string[]>();
    for (const c of involved) {
      if (!members.has(nodeIdOf(c))) members.set(nodeIdOf(c), []);
      members.get(nodeIdOf(c))!.push(c);
    }

    // 列ごとの代表数式（最初に現れたもの）。クリック詳細で「どの列がどんな式か」を示すため
    const formulaByCol = new Map<string, string>();
    for (const e of intra) if (e.evidence && !formulaByCol.has(e.to)) formulaByCol.set(e.to, e.evidence);
    const sampleOf = (cs: string[]) =>
      cs.map(c => ({ col: c, formula: formulaByCol.get(c) ?? '' })).filter(s => s.formula).slice(0, 6);

    let nodes: SheetStructNode[] = [...members.entries()].map(([id, cols]) => {
      if (id.startsWith('n:')) {
        const name = id.slice(2);
        return { id, layer: layer.get(name) ?? 0, label: name, colCount: 1, cols: [name], samples: sampleOf([name]) };
      }
      const body = id.slice(2); // "layer|typeSet"
      const lyr = Number(body.split('|')[0]);
      const types = (body.split('|')[1] || '').split(',').filter(Boolean) as RelType[];
      return { id, layer: lyr, label: structRole(lyr, types), colCount: cols.length, cols: cols.slice(0, 12), samples: sampleOf(cols) };
    });
    let truncated = false;
    if (nodes.length > STRUCT_MAX_NODES) {
      // 実名ノードを優先的に残す（無名の役割グループより情報価値が高い）
      nodes = nodes.sort((a, b) => {
        const an = a.id.startsWith('n:') ? 1 : 0, bn = b.id.startsWith('n:') ? 1 : 0;
        return an !== bn ? bn - an : b.colCount - a.colCount;
      }).slice(0, STRUCT_MAX_NODES);
      truncated = true;
    }
    const nodeIds = new Set(nodes.map(n => n.id));

    const edgeMap = new Map<string, Set<RelType>>();
    for (const e of intra) {
      const fg = nodeIdOf(e.from), tg = nodeIdOf(e.to);
      if (fg === tg || !nodeIds.has(fg) || !nodeIds.has(tg)) continue;
      const k = `${fg} ${tg}`;
      if (!edgeMap.has(k)) edgeMap.set(k, new Set());
      edgeMap.get(k)!.add(e.type);
    }
    const sEdges: SheetStructEdge[] = [...edgeMap.entries()].map(([k, types]) => {
      const [from, to] = k.split(' ');
      return { from, to, types: [...types] };
    });

    structures.push({
      regionId: reg.id,
      layerCount: Math.max(0, ...nodes.map(n => n.layer)) + 1,
      nodes, edges: sEdges, truncated,
    });
  }
  return structures;
}

export interface RelationGraph {
  regions: Region[];
  edges: Edge[];
  warnings: RelationWarning[];
  sheetStructures: SheetStructure[];
  keyLinks?: KeyLink[]; // 表と表を結ぶキー列の対応（VLOOKUP/SUMIFS 等の引数位置から抽出）
  // 巨大グラフでは保存前に辺を領域ペア単位へ集約する（メイン側の JSON.parse / 集約コストを抑えるため）。
  // その際に元の総辺数と集約済みフラグを添える（UI 表示・キャッシュ再利用の双方で使う）。
  edgeTotal?: number;
  edgeCollapsed?: boolean;
}

/** 根拠表示用に数式を短縮する（長大な SUMIFS 等をそのまま出さない） */
const shortFormula = (f: string, max = 70) => f.length <= max ? f : `${f.slice(0, max)}…`;

/**
 * 構造的に検出したキー（値の一意性由来）へ、数式からの「キー利用」根拠を融合する。
 *  - keyLinks の a 側（数式側）: 「この列をキーに ○○ の表から引き当て/集計している」
 *  - keyLinks の b 側（参照される側）: 「○○ の数式がこの列を照合キーとして参照」
 *  - 加えて cross-region の filter-key 辺の from 側（条件が定数で対が作れなかったケースの補完）
 * 一意な列が右側の数値列などで構造検出から漏れていても、キー利用の根拠があれば昇格させる。
 */
function enrichKeysWithUsage(regions: Region[], edges: Edge[], keyLinks: KeyLink[]): void {
  const byId = new Map(regions.map(r => [r.id, r]));
  const regionIdOf = (k: string) => k.slice(0, k.indexOf(':'));
  const colOf = (k: string) => k.slice(k.indexOf(':') + 1);
  const sheetOf = (rid: string) => byId.get(rid)?.sheet ?? rid;

  // 列キー → 追加根拠メッセージ（重複防止のため kind ごとに1つ）
  const usage = new Map<string, Map<string, string>>();
  const addUsage = (key: string, kind: string, msg: string) => {
    let m = usage.get(key);
    if (!m) { m = new Map(); usage.set(key, m); }
    if (!m.has(kind)) m.set(kind, msg);
  };
  for (const l of keyLinks) {
    addUsage(l.a, `out:${regionIdOf(l.b)}`,
      `この列をキーに「${sheetOf(regionIdOf(l.b))}」の表と照合（${l.fn}、例: ${shortFormula(l.evidence)}）`);
    addUsage(l.b, `in:${regionIdOf(l.a)}`,
      `「${sheetOf(regionIdOf(l.a))}」の数式がこの列を照合キーとして参照（${l.fn}）`);
  }
  for (const e of edges) {
    if (e.type !== 'filter-key') continue;
    const fr = regionIdOf(e.from), to = regionIdOf(e.to);
    if (fr === to) continue;
    addUsage(e.from, `in:${to}`,
      `「${sheetOf(to)}」の数式がこの列を条件キーとして参照（例: ${shortFormula(e.evidence)}）`);
  }

  for (const [key, msgs] of usage) {
    const reg = byId.get(regionIdOf(key));
    if (!reg) continue;
    const colName = colOf(key);
    const col = reg.columns.find(c => c.name === colName);
    if (!col) continue;
    if (!reg.keys) reg.keys = { keys: [] };
    let k = reg.keys.keys.find(x => x.column === colName);
    if (!k) {
      // 構造検出に無かった列でも、キー利用の根拠があれば追加する。
      // 値が全行一意なら主キー、そうでなければ軸（結合キー）として登録
      const st = col.stats;
      const uniquePrimary = !!st && st.uniq === st.filled && st.filled >= 3;
      k = {
        column: colName, c: col.c, role: uniquePrimary ? 'primary' : 'axis',
        confidence: uniquePrimary ? 0.9 : 0.7,
        evidence: uniquePrimary ? [`全${st!.filled}行で値がすべて異なる（重複なし）`] : [],
      };
      reg.keys.keys.push(k);
    } else {
      k.confidence = Math.max(k.confidence, 0.9); // 構造＋利用の両根拠が揃った
    }
    k.evidence.push(...msgs.values());
  }
  for (const reg of regions) {
    const ks = reg.keys?.keys;
    if (!ks) continue;
    // 一意列が複数ある場合（社員ID と 氏名 が両方一意 等）は、最左の列と
    // 数式からキー利用の根拠がある列だけを主キーとして残す（候補キーの羅列はノイズ）
    const primaries = ks.filter(k => k.role === 'primary');
    if (primaries.length > 1) {
      const leftmost = Math.min(...primaries.map(k => k.c));
      reg.keys!.keys = ks.filter(k => k.role !== 'primary' || k.c === leftmost || k.evidence.length > 1);
    }
    // 列順で安定表示（主キー→軸、左の列から）
    reg.keys!.keys.sort((a, b) => (a.role === b.role ? a.c - b.c : a.role === 'primary' ? -1 : 1));
  }
}

/**
 * 領域・数式辺・コピー辺からグラフを組み立てる共通処理。
 * analyzeGrids（単一パス）と analyzeArtifacts（ファイル単位）で結果を一致させるため共通化する。
 */
function assembleGraph(regions: Region[], fEdges: Edge[], copyEdges: Edge[], keyLinks: KeyLink[] = []): RelationGraph {
  const edges = [...fEdges, ...copyEdges];
  enrichKeysWithUsage(regions, edges, keyLinks);
  const warnings: RelationWarning[] = [];
  for (const reg of regions) {
    for (const col of reg.columns) {
      if (col.mixedFormula) {
        warnings.push({
          kind: 'mixed_formula_column',
          ref: `${reg.id}:${col.name}`,
          message: `列「${col.name}」は数式列だが ${col.manualNumeric} セルが数式なしの数値（手入力上書きの可能性、特別値引き等の例外処理疑い）`,
        });
      }
    }
  }
  // シート内部の階層フロー構造（一目で構造把握用）。既算出の辺からの後処理なので軽い
  const sheetStructures = buildSheetStructures(regions, edges);
  return { regions, edges, warnings, sheetStructures, keyLinks };
}

export function analyzeGrids(grids: RawGrid[]): RelationGraph {
  const regions = grids.flatMap(detectRegions);
  const { edges: fEdges, keyLinks } = formulaLineage(grids, regions);
  // 数式で連結済みの列ペア（無向）。コピー推定の重複ノイズ抑制に使う
  const formulaLinked = new Set(fEdges.map(e => unorderedPair(e.from, e.to)));
  const copyEdges = valueCopyEdges(grids, regions, formulaLinked);
  return assembleGraph(regions, fEdges, copyEdges, keyLinks);
}

export async function analyzeBuffer(buffer: Buffer): Promise<RelationGraph> {
  return analyzeGrids(await buildGridsFromBuffer(buffer));
}

/**
 * 複数アーティファクト（xlsx/csv）をファイル単位で処理する。
 * 表領域検出・数式リネージュはファイル内で完結するので1ファイルずつ計算し、
 * ファイルをまたぐ手コピー推定は「列の指紋」だけを貯めて最後にまとめて突き合わせる。
 *
 * これにより同時にメモリへ載る原本グリッドは常に1ファイル分だけになり、
 * ピークメモリが「全ファイルの合計」ではなく「最も大きい単一ファイル」に抑えられる
 * （シート数が増えても破綻しない）。クロスファイルのコピー辺は指紋比較で保持されるため、
 * 出力グラフは全グリッドを同時保持する analyzeGrids と一致する（scripts の diff テストで検証）。
 * ファイルが 1 つなら自然にそのファイル単体の解析になる。
 */
// イベントループへ制御を返す。関係分析は同期CPUが連続するため、これを挟まないと
// 単一プロセスの Node がリクエスト（/api/projects・/healthz 等）を長時間さばけず、
// 一覧表示の遅延や ALB ヘルスチェック失敗→タスク再起動の悪循環を招く（2026-07-15 の全体遅延）。
// ファイル間・重処理ステップ間で毎回譲ることで、最大連続ブロックを「単一ステップ（exceljs 読込 ~数秒）」に抑える。
const yieldToEventLoop = () => new Promise<void>(resolve => setImmediate(resolve));

export async function analyzeArtifacts(arts: { filename: string; load: () => Promise<Buffer> }[]): Promise<RelationGraph> {
  const regionsAll: Region[] = [];
  const fEdgesAll: Edge[] = [];
  const keyLinksAll: KeyLink[] = [];
  const fpsAll: ColFingerprint[] = [];
  for (const a of arts) {
    // バッファはここで初めて取得する（Drive 等からの遅延ロード）。前ファイルの原本を保持したまま
    // 全ファイルをメモリに載せないため、ピークを最大単一ファイルに抑える設計を fetch 経路でも保つ。
    const buffer = await a.load();
    // このファイルのグリッドはこのブロック内でのみ生存し、次ファイルへ進む際に GC される
    const grids = await gridsFromArtifact(a.filename, buffer);
    if (grids.length === 0) continue;
    await yieldToEventLoop(); // exceljs 読込（同期CPU重）直後に一度譲る
    const regions = grids.flatMap(detectRegions);
    regionsAll.push(...regions);
    await yieldToEventLoop();
    // 数式参照はファイル内で解決するのでファイル単位で確定（キーの対応も同様にファイル内で閉じる）
    const lineage = formulaLineage(grids, regions);
    fEdgesAll.push(...lineage.edges);
    keyLinksAll.push(...lineage.keyLinks);
    await yieldToEventLoop();
    fpsAll.push(...fingerprintColumns(grids, regions)); // 生の値は捨て、指紋だけ持ち越す
    await yieldToEventLoop(); // 次ファイルへ進む前に譲る
  }
  // 数式で連結済みの列ペア（無向）。コピー推定の重複ノイズ抑制に使う
  const formulaLinked = new Set(fEdgesAll.map(e => unorderedPair(e.from, e.to)));
  const copyEdges = valueCopyEdgesFromFingerprints(fpsAll, formulaLinked);
  return assembleGraph(regionsAll, fEdgesAll, copyEdges, keyLinksAll);
}

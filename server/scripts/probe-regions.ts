// 関係性分析の「ロジック実現可能性」検証プローブ（UI なし）。
// 検証したい難所は2つ:
//   (1) 1シート内に表が複数あるケース → シート単位でなく「表領域(region)」単位で捉えられるか
//   (2) 手コピー(値貼り付け=数式なし)シート → 参照グラフが切れる。値そのものから関係を逆推定できるか
//
// ここでは production コードに触れず、自己完結のアルゴリズムを実装して
// 複雑ワークブック（多表シート＋手コピー列）に対して関係辺が取れるかを実証する。
import ExcelJS from 'exceljs';

// ---------- 生グリッド読み込み（parse.ts は行圧縮するので領域検出用に生で読む） ----------
interface Cell { r: number; c: number; value: string | number | null; formula?: string }
interface Grid { name: string; cells: Cell[]; maxR: number; maxC: number }

function norm(v: ExcelJS.CellValue): string | number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' || typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('result' in v && (v as any).result !== undefined) return norm((v as any).result);
    if ('richText' in v) return (v as any).richText.map((t: any) => t.text).join('');
    if ('text' in v) return String((v as any).text);
  }
  return String(v);
}

async function readGrids(buf: Buffer): Promise<Grid[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as any);
  const grids: Grid[] = [];
  wb.eachSheet(ws => {
    const cells: Cell[] = [];
    let maxR = 0, maxC = 0;
    ws.eachRow({ includeEmpty: false }, (row, r) => {
      row.eachCell({ includeEmpty: false }, (cell, c) => {
        const value = norm(cell.value);
        const fv = cell.value as any;
        const formula = cell.formula || fv?.formula || fv?.sharedFormula;
        if (value === null && !formula) return;
        cells.push({ r, c, value, formula: formula ? String(formula) : undefined });
        if (r > maxR) maxR = r; if (c > maxC) maxC = c;
      });
    });
    grids.push({ name: ws.name, cells, maxR, maxC });
  });
  return grids;
}

// ---------- (1) 表領域(region)検出 ----------
// 空行/空列の「runs」で矩形に分割する。縦積み2表(空行区切り)・横並び2表(空列区切り)を捌く。
interface Region {
  id: string; sheet: string;
  r0: number; r1: number; c0: number; c1: number;
  headerRow: number | null;
  columns: { c: number; name: string; hasFormula: boolean }[];
}

function colLetter(n: number): string { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }

function detectRegions(g: Grid): Region[] {
  if (g.cells.length === 0) return [];
  const occ = new Set<string>();
  for (const c of g.cells) occ.add(`${c.r},${c.c}`);
  const rowHas = (r: number) => { for (let c = 1; c <= g.maxC; c++) if (occ.has(`${r},${c}`)) return true; return false; };
  // まず空行で縦バンド分割
  const bands: [number, number][] = [];
  let start: number | null = null;
  for (let r = 1; r <= g.maxR; r++) {
    if (rowHas(r)) { if (start === null) start = r; }
    else { if (start !== null) { bands.push([start, r - 1]); start = null; } }
  }
  if (start !== null) bands.push([start, g.maxR]);

  const regions: Region[] = [];
  let idx = 0;
  for (const [r0, r1] of bands) {
    // バンド内で空列分割（横並び表対応）
    const colHas = (c: number) => { for (let r = r0; r <= r1; r++) if (occ.has(`${r},${c}`)) return true; return false; };
    const colGroups: [number, number][] = [];
    let cs: number | null = null;
    for (let c = 1; c <= g.maxC; c++) {
      if (colHas(c)) { if (cs === null) cs = c; }
      else { if (cs !== null) { colGroups.push([cs, c - 1]); cs = null; } }
    }
    if (cs !== null) colGroups.push([cs, g.maxC]);

    for (const [c0, c1] of colGroups) {
      const cellsIn = g.cells.filter(x => x.r >= r0 && x.r <= r1 && x.c >= c0 && x.c <= c1);
      // ヘッダー行検出: その行が文字列主体 & 次行が数値を含む
      let headerRow: number | null = null;
      for (let r = r0; r <= Math.min(r1, r0 + 2); r++) {
        const rowCells = cellsIn.filter(x => x.r === r);
        const strs = rowCells.filter(x => typeof x.value === 'string').length;
        const nextNums = cellsIn.filter(x => x.r === r + 1 && typeof x.value === 'number').length;
        if (rowCells.length > 0 && strs >= rowCells.length / 2 && nextNums > 0) { headerRow = r; break; }
      }
      // 列メタ
      const columns: Region['columns'] = [];
      for (let c = c0; c <= c1; c++) {
        const colCells = cellsIn.filter(x => x.c === c);
        if (colCells.length === 0) continue;
        const headerCell = headerRow !== null ? colCells.find(x => x.r === headerRow) : undefined;
        const name = headerCell && typeof headerCell.value === 'string' ? headerCell.value : `${colLetter(c)}列`;
        const hasFormula = colCells.some(x => x.formula && x.r !== headerRow);
        columns.push({ c, name, hasFormula });
      }
      regions.push({ id: `${g.name}#${++idx}`, sheet: g.name, r0, r1, c0, c1, headerRow, columns });
    }
  }
  return regions;
}

// ---------- (2a) 数式参照 → 列レベルのリネージュ辺 ----------
type RelType = 'lookup-join' | 'filtered-agg' | 'aggregation' | 'passthrough' | 'derived';
interface Edge { from: string; to: string; type: RelType; evidence: string; confidence: number }

// 参照を {sheet, col, row?} 群へ分解（A1 / $A$1 / A1:B9 / sheet!A:A / 'My Sheet'!A1）
interface Ref { sheet: string | null; c0: number; c1: number; r0: number | null; r1: number | null }
function colNum(s: string): number { let n = 0; for (const ch of s.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64); return n; }

function extractRefs(formula: string, curSheet: string): Ref[] {
  const refs: Ref[] = [];
  // sheet 修飾子（任意） + セル or 範囲（A1 / $A$1 / A1:B9 / sheet!A:A / 'My Sheet'!A1）
  const re2 = /(?:(?:'([^']+)'|([A-Za-z0-9_À-鿿぀-ヿ＀-￯]+))!)?\$?([A-Za-z]{1,3})\$?(\d+)?(?::\$?([A-Za-z]{1,3})\$?(\d+)?)?/g;
  let m: RegExpExecArray | null;
  while ((m = re2.exec(formula)) !== null) {
    if (!m[0] || m[0].length === 0) { re2.lastIndex++; continue; }
    const sheet = m[1] ?? m[2] ?? null;
    const cA = m[3], rA = m[4], cB = m[5], rB = m[6];
    if (!cA) continue;
    // 関数名(SUMIF 等)を列参照と誤認しないよう、直後が '(' なら除外
    const after = formula[m.index + m[0].length];
    if (after === '(') continue;
    const c0 = colNum(cA), c1 = cB ? colNum(cB) : colNum(cA);
    const r0 = rA ? Number(rA) : null, r1 = rB ? Number(rB) : (rA ? Number(rA) : null);
    refs.push({ sheet: sheet ?? curSheet, c0: Math.min(c0, c1), c1: Math.max(c0, c1), r0, r1 });
  }
  return refs;
}

function funcType(formula: string): RelType {
  const f = formula.toUpperCase();
  if (/\b(VLOOKUP|HLOOKUP|XLOOKUP|INDEX|MATCH)\b/.test(f)) return 'lookup-join';
  if (/\b(SUMIFS?|COUNTIFS?|AVERAGEIFS?)\b/.test(f)) return 'filtered-agg';
  if (/\b(SUM|AVERAGE|MAX|MIN|COUNT)\b/.test(f)) return 'aggregation';
  if (/^[^A-Za-z]*(?:'[^']+'|[^!]+)![A-Za-z]+\d+[^A-Za-z]*$/.test(formula)) return 'passthrough';
  return 'derived';
}

// ある (sheet,col,row) がどの region/column に属するか
function locate(regions: Region[], sheet: string, c: number, r: number | null): { region: Region; colName: string } | null {
  for (const reg of regions) {
    if (reg.sheet !== sheet) continue;
    if (c < reg.c0 || c > reg.c1) continue;
    if (r !== null && (r < reg.r0 || r > reg.r1)) {
      // 範囲が region をまたぐ列参照(A:A 等)は行 null 扱いで許容
      continue;
    }
    const col = reg.columns.find(x => x.c === c);
    return { region: reg, colName: col?.name ?? `${colLetter(c)}列` };
  }
  // 列全体参照など行不明 → 列だけで照合
  for (const reg of regions) {
    if (reg.sheet === sheet && c >= reg.c0 && c <= reg.c1) {
      const col = reg.columns.find(x => x.c === c);
      return { region: reg, colName: col?.name ?? `${colLetter(c)}列` };
    }
  }
  return null;
}

function formulaEdges(grids: Grid[], regions: Region[]): Edge[] {
  const edges = new Map<string, Edge>();
  for (const g of grids) {
    for (const cell of g.cells) {
      if (!cell.formula) continue;
      const dst = locate(regions, g.name, cell.c, cell.r);
      if (!dst) continue;
      const type = funcType(cell.formula);
      for (const ref of extractRefs(cell.formula, g.name)) {
        for (let c = ref.c0; c <= ref.c1; c++) {
          const src = locate(regions, ref.sheet!, c, ref.r0);
          if (!src) continue;
          if (src.region.id === dst.region.id && src.colName === dst.colName) continue;
          const fromK = `${src.region.id}:${src.colName}`;
          const toK = `${dst.region.id}:${dst.colName}`;
          const key = `${fromK}->${toK}:${type}`;
          if (!edges.has(key)) edges.set(key, { from: fromK, to: toK, type, evidence: cell.formula, confidence: 0.95 });
        }
      }
    }
  }
  return [...edges.values()];
}

// ---------- (2b) 値フィンガープリント → 手コピー リニージュ推定 ----------
interface ColVals { key: string; region: Region; name: string; values: (string | number)[]; hasFormula: boolean }

function collectColumns(grids: Grid[], regions: Region[]): ColVals[] {
  const out: ColVals[] = [];
  const bySheet = new Map<string, Cell[]>();
  for (const g of grids) bySheet.set(g.name, g.cells);
  for (const reg of regions) {
    const cells = bySheet.get(reg.sheet)!;
    for (const col of reg.columns) {
      const vals = cells
        .filter(x => x.c === col.c && (reg.headerRow === null || x.r !== reg.headerRow) && x.value !== null)
        .sort((a, b) => a.r - b.r)
        .map(x => x.value as string | number);
      if (vals.length === 0) continue;
      out.push({ key: `${reg.id}:${col.name}`, region: reg, name: col.name, values: vals, hasFormula: col.hasFormula });
    }
  }
  return out;
}

// 数式を持たない列が、別の(計算結果を含む)列と値一致 → 手コピー辺
function valueCopyEdges(cols: ColVals[]): Edge[] {
  const edges: Edge[] = [];
  const fp = (v: (string | number)[]) => v.map(x => typeof x === 'number' ? x.toFixed(4) : String(x).trim()).join('|');
  for (const dst of cols) {
    if (dst.hasFormula) continue;           // 手入力/貼り付け列のみが「コピー先」候補
    if (new Set(dst.values).size <= 1) continue; // 定数列は照合価値なし
    for (const src of cols) {
      if (src.key === dst.key) continue;
      if (src.region.id === dst.region.id) continue;
      // 完全一致（順序込み）
      if (dst.values.length === src.values.length && fp(dst.values) === fp(src.values)) {
        const direction = src.hasFormula ? 0.85 : 0.6; // 計算列→手コピーは方向確度が高い
        edges.push({ from: src.key, to: dst.key, type: 'passthrough',
          evidence: `値完全一致(${dst.values.length}件, 数式なし=手コピー疑い)`, confidence: direction });
        continue;
      }
      // 集合包含（順序違い/部分コピー）
      const sset = new Set(src.values.map(x => typeof x === 'number' ? x.toFixed(4) : String(x).trim()));
      const hit = dst.values.filter(x => sset.has(typeof x === 'number' ? x.toFixed(4) : String(x).trim())).length;
      const ratio = hit / dst.values.length;
      if (ratio >= 0.8 && dst.values.length >= 3) {
        edges.push({ from: src.key, to: dst.key, type: 'passthrough',
          evidence: `値包含一致 ${(ratio * 100).toFixed(0)}%(順序違い/部分コピー疑い)`, confidence: 0.5 * ratio });
      }
    }
  }
  return edges;
}

// ---------- テスト用の複雑ワークブック ----------
// ・"実績": 1シートに2つの表(売上表/費用表)を縦積み(空行区切り) → 多表検出
// ・"集計": SUMIF で実績の各表を集計 + 利益を四則演算 → 数式リニージュ(表またぎ)
// ・"報告": 集計の結果を手で貼り付け(数式なし) → 値フィンガープリントで手コピー検出
async function buildComplex(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();

  const jisseki = wb.addWorksheet('実績');
  jisseki.addRow(['拠点', '売上']);
  jisseki.addRow(['東京', 5000]);
  jisseki.addRow(['大阪', 3000]);
  jisseki.addRow([]); // ← 空行で表を分離
  jisseki.addRow(['拠点', '費用']);
  jisseki.addRow(['東京', 3200]);
  jisseki.addRow(['大阪', 2100]);

  const agg = wb.addWorksheet('集計');
  agg.addRow(['拠点', '売上', '費用', '利益']);
  // SUMIF は実績の「売上表(A1:B3)」「費用表(A5:B7)」をまたいで参照
  agg.addRow(['東京',
    { formula: 'SUMIF(実績!A2:A3,A2,実績!B2:B3)', result: 5000 },
    { formula: 'SUMIF(実績!A6:A7,A2,実績!B6:B7)', result: 3200 },
    { formula: 'B2-C2', result: 1800 }]);
  agg.addRow(['大阪',
    { formula: 'SUMIF(実績!A2:A3,A3,実績!B2:B3)', result: 3000 },
    { formula: 'SUMIF(実績!A6:A7,A3,実績!B6:B7)', result: 2100 },
    { formula: 'B3-C3', result: 900 }]);

  const report = wb.addWorksheet('報告');
  report.addRow(['拠点', '利益']); // 数式なし。集計!利益 を手で貼り付けた想定
  report.addRow(['東京', 1800]);
  report.addRow(['大阪', 900]);

  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ---------- 実行 ----------
async function analyze(label: string, buf: Buffer) {
  console.log(`\n${'='.repeat(70)}\n■ ${label}\n${'='.repeat(70)}`);
  const grids = await readGrids(buf);
  const regions = grids.flatMap(detectRegions);

  console.log(`\n[1] 表領域検出: ${grids.length}シート → ${regions.length}領域`);
  for (const r of regions) {
    const cols = r.columns.map(c => `${c.name}${c.hasFormula ? '(式)' : ''}`).join(', ');
    console.log(`  - ${r.id}  範囲 ${colLetter(r.c0)}${r.r0}:${colLetter(r.c1)}${r.r1}  列[${cols}]`);
  }

  const fe = formulaEdges(grids, regions);
  console.log(`\n[2] 数式リニージュ辺: ${fe.length}件`);
  for (const e of fe) console.log(`  ${e.from}  ──${e.type}──▶  ${e.to}   « ${e.evidence} »`);

  const cols = collectColumns(grids, regions);
  const ve = valueCopyEdges(cols);
  console.log(`\n[3] 値フィンガープリント(手コピー)推定辺: ${ve.length}件`);
  for (const e of ve) console.log(`  ${e.from}  ┄┄copy?(${(e.confidence * 100).toFixed(0)}%)┄┄▶  ${e.to}   « ${e.evidence} »`);
}

(async () => {
  await analyze('合成ケース: 多表シート + SUMIF表またぎ + 手コピー報告', await buildComplex());

  // 既存サンプル(混在ワークブック)でも実データ確認
  try {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const url = await import('node:url');
    const dir = path.dirname(url.fileURLToPath(import.meta.url));
    const p = path.resolve(dir, '../sample-data/予実管理_統合ワークブック.xlsx');
    if (fs.existsSync(p)) await analyze('既存サンプル: 予実管理_統合ワークブック.xlsx', fs.readFileSync(p));
    else console.log('\n(サンプル未生成: npx tsx scripts/make-sample-data.ts で生成可)');
  } catch (e) { console.log('サンプル読込スキップ:', String(e)); }
})();

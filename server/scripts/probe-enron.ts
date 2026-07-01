// 実データ(Enron 社の実際の業務スプレッドシート .xls)で関係性エンジンを叩くプローブ。
// 本番パーサ(ExcelJS)は .xlsx 専用なので、ここでは SheetJS で .xls を読み RawGrid に変換し、
// analyzeGrids にそのまま流す。「合成でない実物」で領域検出・数式リネージュがどこまで通るかを観測する。
//
// 使い方: scratchpad/enron/*.xls を置いて `npx tsx scripts/probe-enron.ts`
import * as XLSX from 'xlsx';
import fs from 'node:fs';
import path from 'node:path';
import { analyzeGrids, type RawGrid, type RawCell } from '../src/preprocess/relations.js';

const DIR = process.argv[2] || path.resolve(
  'C:/Users/SEONGJ~1.PAR/AppData/Local/Temp/claude/C--Users-seongjin-park-kpiee-research/33ce81b6-fde8-412f-ba71-ee16ee4dc336/scratchpad/enron',
);

function cellValue(cell: XLSX.CellObject): string | number | null {
  if (cell.v === undefined || cell.v === null) return null;
  if (cell.t === 'n') return cell.v as number;
  if (cell.t === 'b') return cell.v ? 1 : 0;
  if (cell.t === 'd') return (cell.v as Date).toISOString().slice(0, 10);
  return String(cell.v);
}

/** SheetJS ワークブック → RawGrid[]（シート毎、file=ファイル名） */
function gridsFromXls(file: string, buf: Buffer): RawGrid[] {
  const wb = XLSX.read(buf, { cellFormula: true, cellNF: false, cellText: false });
  const grids: RawGrid[] = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws || !ws['!ref']) continue;
    const range = XLSX.utils.decode_range(ws['!ref']);
    const cells: RawCell[] = [];
    let maxR = 0, maxC = 0;
    for (let R = range.s.r; R <= range.e.r; R++) {
      for (let C = range.s.c; C <= range.e.c; C++) {
        const cell = ws[XLSX.utils.encode_cell({ r: R, c: C })] as XLSX.CellObject | undefined;
        if (!cell) continue;
        const value = cellValue(cell);
        const formula = cell.f ? String(cell.f) : undefined;
        if (value === null && !formula) continue;
        const r = R + 1, c = C + 1; // RawCell は 1 始まり
        cells.push({ r, c, value, formula });
        if (r > maxR) maxR = r;
        if (c > maxC) maxC = c;
      }
    }
    if (cells.length > 0) grids.push({ file, name, cells, maxR, maxC });
  }
  return grids;
}

const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter(f => /\.(xls|xlsx)$/i.test(f)) : [];
if (files.length === 0) { console.log('no .xls files in', DIR); process.exit(0); }

console.log(`実データプローブ: ${files.length} ファイル @ ${DIR}\n`);

let totSheets = 0, totRegions = 0, totFormulaEdges = 0, totCopy = 0, totFormulaCells = 0, failed = 0;

for (const f of files) {
  const label = f.replace(/\.[^.]+$/, '');
  try {
    const grids = gridsFromXls(label, fs.readFileSync(path.join(DIR, f)));
    const formulaCells = grids.reduce((n, g) => n + g.cells.filter(c => c.formula).length, 0);
    const t0 = process.hrtime.bigint();
    const gr = analyzeGrids(grids);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;

    const fe = gr.edges.filter(e => e.type !== 'copy').length;
    const ce = gr.edges.filter(e => e.type === 'copy').length;
    // シートをまたぐ数式辺＝「シート間で連結された業務フロー」の指標（このツールの目的に直結）
    const sheetOf = (key: string) => { const id = key.slice(0, key.indexOf(':')); return id.slice(id.indexOf('／') + 1, id.lastIndexOf('#')); };
    const crossSheet = gr.edges.filter(e => e.type !== 'copy' && sheetOf(e.from) !== sheetOf(e.to)).length;
    const purposeFit = grids.length > 1 && crossSheet > 0;
    totSheets += grids.length; totRegions += gr.regions.length; totFormulaEdges += fe; totCopy += ce; totFormulaCells += formulaCells;

    console.log(`■ ${f}${purposeFit ? '   ★目的適合(シート間連結あり)' : ''}`);
    console.log(`  シート ${grids.length} / 表領域 ${gr.regions.length} / 数式セル ${formulaCells} → 数式辺 ${fe}(うちシート間 ${crossSheet}) / コピー推定 ${ce} / 警告 ${gr.warnings.length}  (${ms.toFixed(0)}ms)`);
    // 領域のサイズ感（大型シート把握）
    const big = grids.map(g => `${g.name}(${g.maxR}行x${g.maxC}列)`).slice(0, 6).join(', ');
    console.log(`  シート: ${big}${grids.length > 6 ? ' …' : ''}`);
    // 数式辺サンプル（最大4件）
    gr.edges.filter(e => e.type !== 'copy').slice(0, 4).forEach(e =>
      console.log(`    ${e.type}: ${e.from.split('／').pop()} → ${e.to.split('／').pop()}  « ${e.evidence.slice(0, 60)} »`));
    console.log('');
  } catch (e) {
    failed++;
    console.log(`■ ${f}\n  ✗ 解析失敗: ${String(e).slice(0, 160)}\n`);
  }
}

console.log('='.repeat(60));
console.log(`合計: ${files.length}ファイル(失敗${failed}) / シート${totSheets} / 表領域${totRegions} / 数式セル${totFormulaCells} → 数式辺${totFormulaEdges} / コピー推定${totCopy}`);

// xlsx の各シートを値グリッドで表示する一時スクリプト（最終帳票の形を確認する用）
import ExcelJS from 'exceljs';

const path = process.argv[2];
if (!path) { console.error('usage: tsx scripts/dump-xlsx.ts <path>'); process.exit(1); }

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(path);
for (const ws of wb.worksheets) {
  console.log(`\n===== sheet: ${ws.name} (${ws.rowCount}x${ws.columnCount}) =====`);
  const rows: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const cells: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell) => {
      const v = cell.value;
      const s = v && typeof v === 'object' && 'result' in v ? String((v as { result: unknown }).result)
        : v === null || v === undefined ? '' : String(v);
      cells.push(s);
    });
    rows.push(cells);
  });
  for (const r of rows.slice(0, 15)) console.log(r.join(' | '));
}

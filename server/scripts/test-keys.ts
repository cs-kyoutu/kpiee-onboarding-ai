// キー・軸検出（region.keys）と表間キー対応（keyLinks）の回帰確認スクリプト。
// 期待: 社員マスタ=PK社員ID / 実績=部署×月の複合軸 / レポート=PK+外部キー / 月次推移=列方向時系列。
import ExcelJS from 'exceljs';
import { buildGridsFromBuffer, analyzeGrids } from '../src/preprocess/relations.js';

async function main() {
  const wb = new ExcelJS.Workbook();

  // 1) 社員マスタ: 社員ID が主キー（全行一意の文字列）
  const master = wb.addWorksheet('社員マスタ');
  master.addRow(['社員ID', '氏名', '部署']);
  const depts = ['営業部', '開発部', '管理部'];
  for (let i = 1; i <= 12; i++) master.addRow([`E${String(i).padStart(3, '0')}`, `社員${i}`, depts[i % 3]]);

  // 2) 実績: 部署 × 月 の複合軸（単独一意列なし）
  const jisseki = wb.addWorksheet('実績');
  jisseki.addRow(['部署', '月', '金額']);
  for (const d of depts) for (let m = 1; m <= 12; m++) jisseki.addRow([d, `${m}月`, 100000 + m * 1000 + depts.indexOf(d)]);

  // 3) レポート: VLOOKUP（社員マスタ）と SUMIFS（実績）でキーを突き合わせる
  const rep = wb.addWorksheet('レポート');
  rep.addRow(['社員ID', '氏名', '部署', '4月実績']);
  for (let i = 2; i <= 6; i++) {
    rep.addRow([`E${String(i - 1).padStart(3, '0')}`]);
    rep.getCell(`B${i}`).value = { formula: `VLOOKUP(A${i},社員マスタ!A:C,2,FALSE)` } as ExcelJS.CellValue;
    rep.getCell(`C${i}`).value = { formula: `VLOOKUP(A${i},社員マスタ!A:C,3,FALSE)` } as ExcelJS.CellValue;
    rep.getCell(`D${i}`).value = { formula: `SUMIFS(実績!C:C,実績!A:A,C${i},実績!B:B,"4月")` } as ExcelJS.CellValue;
  }

  // 4) 月次クロス集計: 列方向が月次系列
  const cross = wb.addWorksheet('月次推移');
  cross.addRow(['部署', '1月', '2月', '3月', '4月', '5月', '6月']);
  for (const d of depts) cross.addRow([d, 1, 2, 3, 4, 5, 6]);

  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  const grids = await buildGridsFromBuffer(buf, 'テスト');
  const graph = analyzeGrids(grids);

  for (const r of graph.regions) {
    console.log(`\n== ${r.sheet} (${r.dataRowCount}行) ==`);
    if (!r.keys) { console.log('  keys: なし'); continue; }
    for (const k of r.keys.keys) {
      console.log(`  [${k.role}] ${k.column} (conf=${k.confidence})`);
      for (const ev of k.evidence) console.log(`     - ${ev}`);
    }
    if (r.keys.axisNote) console.log(`  axisNote: ${r.keys.axisNote}`);
    if (r.keys.colAxis) console.log(`  colAxis: ${r.keys.colAxis}`);
  }
  console.log('\n== keyLinks ==');
  for (const l of graph.keyLinks ?? []) {
    console.log(`  ${l.a}  <->  ${l.b}  [${l.fn} x${l.count}] via ${l.via}`);
    console.log(`     ${l.evidence}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });

// R2 では VLOOKUP の第1引数が 計算!A を参照していたため、データ的には切れていても
// グラフの辺が「生き残って」しまった。ここでは 作業用 から 計算 への参照を完全に消す
// （部門名も粗利も値貼り付け）= 真の単絶を作り、グラフが壊れることを確認する。
import ExcelJS from 'exceljs';
import { parseXlsx } from '../src/preprocess/parse.js';
import { classifySheetRoles } from '../src/preprocess/classify.js';

const GT_ROLE: Record<string, string> = {
  Sheet1: 'input_data', Sheet2: 'input_data', tmp: 'input_data', マスタ: 'input_data',
  計算: 'working_sheet', 作業用: 'working_sheet', 出力: 'final_output',
};

async function build(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const s1 = wb.addWorksheet('Sheet1'); s1.addRow(['部門', '売上']); s1.addRow(['D1', 5000]); s1.addRow(['D2', 3000]);
  const s2 = wb.addWorksheet('Sheet2'); s2.addRow(['部門', '原価']); s2.addRow(['D1', 3200]); s2.addRow(['D2', 2100]);
  const tmp = wb.addWorksheet('tmp'); tmp.addRow(['通貨', 'レート']); tmp.addRow(['USD', 150]);
  const mst = wb.addWorksheet('マスタ'); mst.addRow(['コード', '部門名']); mst.addRow(['D1', '第一営業']); mst.addRow(['D2', '第二営業']);

  const calc = wb.addWorksheet('計算');
  calc.addRow(['部門', '粗利', '粗利USD']);
  for (let i = 0; i < 2; i++) {
    const r = i + 2;
    calc.addRow([{ formula: `Sheet1!A${r}` }, { formula: `Sheet1!B${r}-Sheet2!B${r}` }, { formula: `(Sheet1!B${r}-Sheet2!B${r})/tmp!B2` }]);
  }

  // 作業用: 完全に値貼り付け（計算へもマスタへも数式参照しない）
  const work = wb.addWorksheet('作業用');
  work.addRow(['部門名', '粗利']);
  work.addRow(['第一営業', 1800]);
  work.addRow(['第二営業', 900]);

  const out = wb.addWorksheet('出力');
  out.addRow(['指標', '値']); out.addRow(['粗利合計', { formula: `SUM(作業用!B2:B3)` }]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function main() {
  const parsed = await parseXlsx(await build());
  const c = classifySheetRoles(parsed) as Record<string, { role: string; references: string[]; reason: string }>;
  console.log('## R3: 作業用 を計算・マスタから完全単絶（真のリンク切れ）\n');
  let hit = 0;
  for (const [name, v] of Object.entries(c)) {
    const ok = v.role === GT_ROLE[name];
    if (ok) hit++;
    console.log(`  ${name.padEnd(8)} role=${v.role.padEnd(13)} refs=[${v.references.join(',')}]  ${ok ? 'OK' : `✗ 真=${GT_ROLE[name]}`}`);
    if (!ok) console.log(`     理由: ${v.reason}`);
  }
  console.log(`\n  役割正解: ${hit}/${Object.keys(GT_ROLE).length}`);
  console.log('\n  → 計算 は実際には中間シートだが、誰も参照しなくなり「帳票(final_output)」と誤判定される。');
  console.log('  → 作業用 は数式ゼロ・被参照ありで input_data 扱い、もしくは孤立。チェーンが2島に分断される。');
}
main().catch(e => { console.error(e); process.exit(1); });

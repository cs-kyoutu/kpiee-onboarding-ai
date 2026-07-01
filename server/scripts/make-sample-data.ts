// 動作確認用サンプルデータ生成スクリプト。
// 顧客資料3種（インプットCSV / 数式入り中間シート / 最終帳票）を sample-data/ に出力する。
// 実行: npx tsx scripts/make-sample-data.ts
import ExcelJS from 'exceljs';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, '../sample-data');
mkdirSync(OUT_DIR, { recursive: true });

// ---- ① インプットデータ（基幹システム出力 CSV を想定） ----
const branches = ['東京', '大阪', '名古屋', '福岡'];
const rows: string[] = ['拠点,売上,費用'];
let seed = 42;
// 乱数は再現性のため線形合同法で固定シード生成する
const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const totals = new Map<string, { sales: number; cost: number }>();
for (let month = 1; month <= 3; month++) {
  for (const b of branches) {
    const sales = Math.round(1000 + rand() * 9000);
    const cost = Math.round(sales * (0.5 + rand() * 0.3));
    rows.push(`${b},${sales},${cost}`);
    const t = totals.get(b) ?? { sales: 0, cost: 0 };
    t.sales += sales;
    t.cost += cost;
    totals.set(b, t);
  }
}
// BOM 付き UTF-8 で出力（Excel 由来 CSV の再現）
writeFileSync(path.join(OUT_DIR, '売上データ.csv'), '\u{FEFF}' + rows.join('\n'), 'utf-8');

// ---- ② 中間スプレッドシート（SUMIF・四則演算の数式入り） ----
async function makeWorkbooks() {
  const wb = new ExcelJS.Workbook();

  // 元データシート（CSV を貼り付けた想定）
  const wsData = wb.addWorksheet('元データ');
  wsData.addRow(['拠点', '売上', '費用']);
  for (const line of rows.slice(1)) {
    const [b, s, c] = line.split(',');
    wsData.addRow([b, Number(s), Number(c)]);
  }

  // 集計シート（SUMIF で拠点別に集計し、利益を四則演算で算出）
  const wsAgg = wb.addWorksheet('集計');
  wsAgg.addRow(['拠点', '売上', '費用', '利益']);
  branches.forEach((b, i) => {
    const r = i + 2;
    wsAgg.addRow([
      b,
      { formula: `SUMIF(元データ!A:A,A${r},元データ!B:B)`, result: totals.get(b)!.sales },
      { formula: `SUMIF(元データ!A:A,A${r},元データ!C:C)`, result: totals.get(b)!.cost },
      { formula: `B${r}-C${r}`, result: totals.get(b)!.sales - totals.get(b)!.cost },
    ]);
  });

  // 調整シート（数式なしの手入力値 → needs_customer_confirmation のデモ用）
  const wsAdj = wb.addWorksheet('調整');
  wsAdj.addRow(['拠点', '調整額', 'メモ']);
  wsAdj.addRow(['大阪', -500, '本社経費の按分（手入力）']);

  await wb.xlsx.writeFile(path.join(OUT_DIR, '中間集計シート.xlsx'));

  // ---- ③ 最終帳票（値のみ。大阪の利益には手入力調整 -500 が混入 → 不一致デモ） ----
  const wb2 = new ExcelJS.Workbook();
  const wsReport = wb2.addWorksheet('月次帳票');
  wsReport.addRow(['拠点', '売上', '費用', '利益']);
  for (const b of branches) {
    const t = totals.get(b)!;
    const adjustment = b === '大阪' ? -500 : 0;
    wsReport.addRow([b, t.sales, t.cost, t.sales - t.cost + adjustment]);
  }
  await wb2.xlsx.writeFile(path.join(OUT_DIR, '月次帳票.xlsx'));

  // ---- ④ 混在ワークブック（raw / 中間 / 帳票 が1ファイルに同居 → 自動分類のデモ用） ----
  // 参照グラフ: 帳票 → 集計 → 元データ（終着点=帳票、経由点=集計、出発点=元データ）
  const wb3 = new ExcelJS.Workbook();

  const wsRaw3 = wb3.addWorksheet('元データ');
  wsRaw3.addRow(['拠点', '売上', '費用']);
  for (const line of rows.slice(1)) {
    const [b, s, c] = line.split(',');
    wsRaw3.addRow([b, Number(s), Number(c)]);
  }

  const wsAgg3 = wb3.addWorksheet('集計');
  wsAgg3.addRow(['拠点', '売上', '費用', '利益']);
  branches.forEach((b, i) => {
    const r = i + 2;
    wsAgg3.addRow([
      b,
      { formula: `SUMIF(元データ!A:A,A${r},元データ!B:B)`, result: totals.get(b)!.sales },
      { formula: `SUMIF(元データ!A:A,A${r},元データ!C:C)`, result: totals.get(b)!.cost },
      { formula: `B${r}-C${r}`, result: totals.get(b)!.sales - totals.get(b)!.cost },
    ]);
  });

  const wsReport3 = wb3.addWorksheet('帳票');
  wsReport3.addRow(['拠点', '売上', '費用', '利益']);
  branches.forEach((b, i) => {
    const r = i + 2;
    const t = totals.get(b)!;
    const adjustment = b === '大阪' ? -500 : 0;
    wsReport3.addRow([
      { formula: `集計!A${r}`, result: b },
      { formula: `集計!B${r}`, result: t.sales },
      { formula: `集計!C${r}`, result: t.cost },
      // 大阪のみ手修正（-500）が混入している想定 → 照合不一致のデモ
      adjustment !== 0
        ? { formula: `集計!D${r}${adjustment}`, result: t.sales - t.cost + adjustment }
        : { formula: `集計!D${r}`, result: t.sales - t.cost },
    ]);
  });

  await wb3.xlsx.writeFile(path.join(OUT_DIR, '予実管理_統合ワークブック.xlsx'));

  console.log(`サンプルデータを出力しました: ${OUT_DIR}`);
  console.log('  売上データ.csv（input_data） / 中間集計シート.xlsx（working_sheet） / 月次帳票.xlsx（final_output）');
  console.log('  予実管理_統合ワークブック.xlsx（混在 → kind=auto でアップロードして自動分類を試す）');
}

await makeWorkbooks();

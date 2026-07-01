// relations.ts の関係性分析を、適対的フィクスチャ(test-scenarios の難所)＋合成＋実サンプルで一括検証する。
// AI 不要・API 不要。決定論ロジックのみ。ノイズ抑制が効いているかを目視確認する。
import ExcelJS from 'exceljs';
import { analyzeGrids, analyzeArtifacts, buildGridsFromBuffer, colLetter, type RelationGraph } from '../src/preprocess/relations.js';

const buf = async (wb: ExcelJS.Workbook) => Buffer.from(await wb.xlsx.writeBuffer());

// ---- 合成: 多表シート + SUMIF表またぎ + 手コピー報告 ----
async function complex(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const j = wb.addWorksheet('実績');
  j.addRow(['拠点', '売上']); j.addRow(['東京', 5000]); j.addRow(['大阪', 3000]); j.addRow(['名古屋', 4100]);
  j.addRow([]);
  j.addRow(['拠点', '費用']); j.addRow(['東京', 3200]); j.addRow(['大阪', 2100]); j.addRow(['名古屋', 2750]);
  const a = wb.addWorksheet('集計');
  a.addRow(['拠点', '売上', '費用', '利益']);
  ['東京', '大阪', '名古屋'].forEach((b, i) => {
    const r = i + 2;
    a.addRow([b,
      { formula: `SUMIF(実績!A2:A4,A${r},実績!B2:B4)`, result: [5000, 3000, 4100][i] },
      { formula: `SUMIF(実績!A6:A8,A${r},実績!B6:B8)`, result: [3200, 2100, 2750][i] },
      { formula: `B${r}-C${r}`, result: [1800, 900, 1350][i] }]);
  });
  const rep = wb.addWorksheet('報告');
  rep.addRow(['拠点', '利益']); rep.addRow(['東京', 1800]); rep.addRow(['大阪', 900]); rep.addRow(['名古屋', 1350]);
  return buf(wb);
}

// ---- S1 配賦按分 ----
async function s1(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const sales = wb.addWorksheet('部門売上');
  sales.addRow(['部門', '売上']); sales.addRow(['営業1部', 5000000]); sales.addRow(['営業2部', 3000000]); sales.addRow(['営業3部', 2000000]);
  const common = wb.addWorksheet('共通費');
  common.addRow(['項目', '金額']); common.addRow(['本社管理費', 1000000]);
  const alloc = wb.addWorksheet('配賦');
  alloc.addRow(['部門', '按分共通費', '部門損益']);
  for (let i = 0; i < 3; i++) {
    const r = i + 2;
    alloc.addRow([
      { formula: `部門売上!A${r}` },
      { formula: `共通費!B2*部門売上!B${r}/SUM(部門売上!B2:B4)` },
      { formula: `部門売上!B${r}-B${r}` },
    ]);
  }
  return buf(wb);
}

// ---- S3 汚い実務シート（結合タイトル・小計行混在・文字列数値） ----
async function s3(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('売上集計表');
  ws.mergeCells('A1:D1'); ws.getCell('A1').value = '令和6年度 売上集計（社外秘）';
  ws.addRow([]);
  ws.addRow(['年月', '部門', '商品', '売上']);
  ws.addRow(['令和6年1月', '東日本', 'テレビ', '1,200,000']);
  ws.addRow(['令和6年1月', '東日本', '冷蔵庫', '850,000']);
  ws.addRow(['', '東日本 小計', '', { formula: 'SUM(D4:D5)' }]);
  ws.addRow(['令和6年1月', '西日本', 'テレビ', '980,000']);
  ws.addRow(['', '西日本 小計', '', { formula: 'SUM(D7:D7)' }]);
  ws.addRow(['', '総合計', '', { formula: 'D6+D8' }]);
  return buf(wb);
}

// ---- S4 数式列の手入力混入 ----
async function s4(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const src = wb.addWorksheet('単価表');
  src.addRow(['商品', '単価']);
  [['A001', 1000], ['A002', 2000], ['A003', 1500], ['A004', 3000], ['A005', 800]].forEach(r => src.addRow(r));
  const calc = wb.addWorksheet('値引計算');
  calc.addRow(['商品', '値引後価格']);
  const rows = [{ f: true, v: null }, { f: true, v: null }, { f: false, v: 1200 }, { f: false, v: 2500 }, { f: true, v: null }];
  rows.forEach((row, i) => {
    const r = i + 2;
    calc.addRow([{ formula: `単価表!A${r}` }, row.f ? { formula: `単価表!B${r}*0.9` } : row.v]);
  });
  return buf(wb);
}

// ---- クロスファイル: 3つの別ファイル。raw→集計(コピー)→報告(コピー) がファイルをまたぐ ----
async function crossFiles(): Promise<{ filename: string; buffer: Buffer }[]> {
  // ① 元データ.xlsx（raw 値）
  const wbA = new ExcelJS.Workbook()
  const a = wbA.addWorksheet('元データ')
  a.addRow(['拠点', '売上', '費用'])
  ;[['東京', 5000, 3200], ['大阪', 3000, 2100], ['名古屋', 4100, 2750], ['福岡', 2600, 1800]].forEach(r => a.addRow(r))

  // ② 集計.xlsx（売上・費用は元データから手貼り＝値のみ、利益は数式）
  const wbB = new ExcelJS.Workbook()
  const b = wbB.addWorksheet('集計')
  b.addRow(['拠点', '売上', '費用', '利益'])
  ;[['東京', 5000, 3200], ['大阪', 3000, 2100], ['名古屋', 4100, 2750], ['福岡', 2600, 1800]].forEach((r, i) => {
    const row = i + 2
    b.addRow([r[0], r[1], r[2], { formula: `B${row}-C${row}`, result: (r[1] as number) - (r[2] as number) }])
  })

  // ③ 報告.xlsx（利益を集計から手貼り＝数式なし値）
  const wbC = new ExcelJS.Workbook()
  const c = wbC.addWorksheet('報告')
  c.addRow(['拠点', '利益'])
  ;[['東京', 1800], ['大阪', 900], ['名古屋', 1350], ['福岡', 800]].forEach(r => c.addRow(r))

  return [
    { filename: '元データ.xlsx', buffer: await buf(wbA) },
    { filename: '集計.xlsx', buffer: await buf(wbB) },
    { filename: '報告.xlsx', buffer: await buf(wbC) },
  ]
}

function dump(label: string, gr: RelationGraph) {
  console.log(`\n${'='.repeat(72)}\n■ ${label}\n${'='.repeat(72)}`);
  console.log(`\n[領域] ${gr.regions.length}件`);
  for (const r of gr.regions) {
    const cols = r.columns.map(c => `${c.name}${c.hasFormula ? '(式)' : ''}${c.mixedFormula ? '⚠混在' : ''}`).join(', ');
    console.log(`  ${r.id}  ${colLetter(r.c0)}${r.r0}:${colLetter(r.c1)}${r.r1}  行${r.dataRowCount}  [${cols}]`);
  }
  const fe = gr.edges.filter(e => e.type !== 'copy');
  console.log(`\n[数式リニージュ] ${fe.length}件`);
  for (const e of fe) console.log(`  ${e.from}  ──${e.type}(${(e.confidence * 100).toFixed(0)}%)──▶  ${e.to}   « ${e.evidence} »`);
  const ce = gr.edges.filter(e => e.type === 'copy');
  console.log(`\n[手コピー推定] ${ce.length}件`);
  for (const e of ce) console.log(`  ${e.from}  ┄copy(${(e.confidence * 100).toFixed(0)}%)${e.needsConfirmation ? '?要確認' : ''}┄▶  ${e.to}   « ${e.evidence} »`);
  if (gr.warnings.length) {
    console.log(`\n[警告] ${gr.warnings.length}件`);
    for (const w of gr.warnings) console.log(`  ⚠ [${w.kind}] ${w.ref}: ${w.message}`);
  }
}

(async () => {
  dump('クロスファイル: 元データ.xlsx → 集計.xlsx → 報告.xlsx（ファイル間コピー）', await analyzeArtifacts(await crossFiles()))
  dump('合成: 多表シート + SUMIF表またぎ + 手コピー報告', analyzeGrids(await buildGridsFromBuffer(await complex())));
  dump('S1 配賦按分', analyzeGrids(await buildGridsFromBuffer(await s1())));
  dump('S3 汚い実務シート', analyzeGrids(await buildGridsFromBuffer(await s3())));
  dump('S4 数式列の手入力混入', analyzeGrids(await buildGridsFromBuffer(await s4())));

  const fs = await import('node:fs');
  const path = await import('node:path');
  const url = await import('node:url');
  const dir = path.dirname(url.fileURLToPath(import.meta.url));
  const p = path.resolve(dir, '../sample-data/予実管理_統合ワークブック.xlsx');
  if (fs.existsSync(p)) dump('実サンプル: 予実管理_統合ワークブック.xlsx', analyzeGrids(await buildGridsFromBuffer(fs.readFileSync(p))));
})();

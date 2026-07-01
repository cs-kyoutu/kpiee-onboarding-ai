// 複数ファイル・異形式の連結シナリオで解読パイプラインを実テストするスクリプト。
// 子会社A/B/C（形式バラバラ）＋ 親会社の連結ワークブックを生成し、
// API 経由でプロジェクト作成 → アップロード → AI 解読 → findings/questions を取得して表示する。
import ExcelJS from 'exceljs';

const API = 'http://localhost:8787';

// ---- ファイル生成 ----

// 子会社A: きれいな日次 CSV。円建て。商品区分は「コード」(E01/F01)。
function makeSubsidiaryA(): Buffer {
  const lines = [
    '日付,店舗コード,商品区分,売上高,売上原価',
    '2026-01-15,T001,E01,1200000,800000',
    '2026-01-20,T001,F01,450000,300000',
    '2026-01-28,T002,E01,980000,640000',
    '2026-02-10,T002,F01,520000,350000',
    '2026-02-18,T001,E01,1100000,720000',
    '2026-03-05,T002,E01,1350000,900000',
    '2026-03-22,T001,F01,610000,410000',
  ];
  return Buffer.from('﻿' + lines.join('\n'), 'utf-8');
}

// 子会社B: 月別の横展開（ピボット）。単位は「千円」。商品は「名称」。原価なし。
async function makeSubsidiaryB(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('売上実績');
  ws.addRow(['※金額単位: 千円']);
  ws.addRow(['拠点', '商品', '1月', '2月', '3月']);
  ws.addRow(['大阪支店', '電化製品', 3200, 2800, 3100]);
  ws.addRow(['大阪支店', '食品', 1500, 1600, 1400]);
  ws.addRow(['神戸支店', '電化製品', 2100, 1900, 2400]);
  ws.addRow(['神戸支店', '食品', 880, 920, 1010]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// 子会社C: 結合セルのタイトル + 四半期 + 「手修正後」列（数式なしの上書き値）。
async function makeSubsidiaryC(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Q1報告');
  ws.mergeCells('A1:D1');
  ws.getCell('A1').value = '第1四半期 売上報告（名古屋事業部）';
  ws.addRow([]);
  ws.addRow(['部門', '区分', 'システム売上', '手修正後売上']);
  // 手修正後は数式ではなく手で書き換えた値（システム売上と微妙に違う = 手入力調整）
  ws.addRow(['名古屋本店', '電化製品', 4500000, 4480000]);
  ws.addRow(['名古屋本店', '食品', 1700000, 1700000]);
  ws.addRow(['岐阜営業所', '電化製品', 2200000, 2350000]); // 手で増額調整
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// 親会社: 連結ワークブック（kind=auto で役割自動分類させる）。
//   区分マスタ / 取込A / 取込B / 標準化(数式) / 連結帳票(数式)
async function makeParentWorkbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();

  // マスタ: コード ↔ 名称
  const mst = wb.addWorksheet('区分マスタ');
  mst.addRow(['コード', '名称']);
  mst.addRow(['E01', '電化製品']);
  mst.addRow(['F01', '食品']);

  // 取込A: 子会社Aを貼り付け（値のみ。外部ファイルへのリンクではない）
  const ta = wb.addWorksheet('取込A');
  ta.addRow(['日付', '店舗コード', '商品区分', '売上高']);
  ta.addRow(['2026-01-15', 'T001', 'E01', 1200000]);
  ta.addRow(['2026-02-10', 'T002', 'F01', 520000]);
  ta.addRow(['2026-03-05', 'T002', 'E01', 1350000]);

  // 取込B: 子会社Bを貼り付け（千円・名称のまま）
  const tb = wb.addWorksheet('取込B');
  tb.addRow(['拠点', '商品名称', '月', '金額_千円']);
  tb.addRow(['大阪支店', '電化製品', '2026-01', 3200]);
  tb.addRow(['大阪支店', '食品', '2026-01', 1500]);
  tb.addRow(['神戸支店', '電化製品', '2026-02', 1900]);

  // 標準化: 両者を共通スキーマ(コード・円)へ正規化する数式シート
  const std = wb.addWorksheet('標準化');
  std.addRow(['出所', '商品コード', '売上高_円']);
  // A は既にコード・円なのでそのまま参照
  std.addRow([{ formula: `"A:"&取込A!B2` }, { formula: `取込A!C2` }, { formula: `取込A!D2` }]);
  std.addRow([{ formula: `"A:"&取込A!B3` }, { formula: `取込A!C3` }, { formula: `取込A!D3` }]);
  // B は名称→コード変換(VLOOKUP) + 千円→円換算(*1000)
  std.addRow([
    { formula: `"B:"&取込B!A2` },
    { formula: `VLOOKUP(取込B!B2,区分マスタ!A:B,1,FALSE)` }, // 名称からコードを引く想定（逆引きは本来NG=要確認ポイント）
    { formula: `取込B!D2*1000` },
  ]);
  std.addRow([
    { formula: `"B:"&取込B!A3` },
    { formula: `VLOOKUP(取込B!B3,区分マスタ!A:B,1,FALSE)` },
    { formula: `取込B!D3*1000` },
  ]);

  // 連結帳票: 区分別の連結売上合計（SUMIF）
  const rep = wb.addWorksheet('連結帳票');
  rep.addRow(['商品コード', '連結売上高']);
  rep.addRow(['E01', { formula: `SUMIF(標準化!B:B,"E01",標準化!C:C)` }]);
  rep.addRow(['F01', { formula: `SUMIF(標準化!B:B,"F01",標準化!C:C)` }]);

  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ---- API ドライバ ----

async function uploadFile(projectId: number, kind: string, filename: string, buf: Buffer): Promise<any> {
  const fd = new FormData();
  fd.append('kind', kind);
  fd.append('file', new Blob([buf]), filename);
  const r = await fetch(`${API}/api/projects/${projectId}/artifacts`, { method: 'POST', body: fd });
  return r.json();
}

async function poll(projectId: number, stage: string): Promise<any> {
  for (let i = 0; i < 120; i++) {
    const p = await (await fetch(`${API}/api/projects/${projectId}`)).json();
    const run = (p.runs as any[]).find(r => r.stage === stage);
    if (run && run.status !== 'running') return run;
    await new Promise(res => setTimeout(res, 3000));
  }
  throw new Error('timeout');
}

async function main() {
  const health = await (await fetch(`${API}/api/health`)).json();
  console.log('AI mode:', health.aiMode);

  const project = await (await fetch(`${API}/api/projects`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customer_name: '連結テスト商事', description: '子会社3社・異形式の連結売上' }),
  })).json();
  console.log('project:', project.id);

  console.log('uploading...');
  console.log(' A:', (await uploadFile(project.id, 'input_data', '売上_子会社A.csv', makeSubsidiaryA())).parse_status);
  console.log(' B:', (await uploadFile(project.id, 'input_data', '売上_子会社B.xlsx', await makeSubsidiaryB())).parse_status);
  console.log(' C:', (await uploadFile(project.id, 'input_data', '子会社C_売上.xlsx', await makeSubsidiaryC())).parse_status);
  const parent = await uploadFile(project.id, 'auto', '連結売上集計.xlsx', await makeParentWorkbook());
  console.log(' 親(auto)役割分類:', JSON.stringify(parent.sheet_roles ? Object.fromEntries(
    Object.entries(JSON.parse(parent.sheet_roles)).map(([k, v]: any) => [k, v.role])) : null, null, 0));

  console.log('\n--- AI 解読開始 ---');
  await fetch(`${API}/api/projects/${project.id}/pipeline/decode`, { method: 'POST' });
  const run = await poll(project.id, 'decode');
  console.log('decode:', run.status, `in=${run.input_tokens} out=${run.output_tokens}`, run.error ?? '');

  const findings = await (await fetch(`${API}/api/projects/${project.id}/findings`)).json();
  console.log(`\n=== 解読項目 ${findings.length} 件 ===`);
  for (const f of findings) {
    console.log(`\n[${f.id}] ${f.source_ref}  (確信度:${f.confidence})`);
    if (f.formula_raw) console.log(`  数式: ${f.formula_raw}`);
    console.log(`  種別: ${f.logic_type} → ${f.kpiee_target}`);
    console.log(`  説明: ${f.explanation}`);
  }

  const questions = await (await fetch(`${API}/api/projects/${project.id}/questions`)).json();
  console.log(`\n=== 顧客確認事項 ${questions.length} 件 ===`);
  for (const q of questions) console.log(` - ${q.question}`);

  console.log(`\nブラウザ確認: http://localhost:5173 → プロジェクト「連結テスト商事」(id=${project.id})`);
}

main().catch(e => { console.error(e); process.exit(1); });

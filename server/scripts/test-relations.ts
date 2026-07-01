// 「シート間関係の把握」品質を分離して客観計測する実験。
// 関係把握は2エンジンに分かれる:
//   (A) classify.ts の決定論的参照グラフ（ワークブック内）
//   (B) AI 解読の意味的説明
// R1: 深い分岐チェーン + 紛らわしいシート名（名前に頼れない）→ グラフが純粋に参照方向だけで当てられるか
// R2: R1 のチェーン中間リンクを「値貼り付け」で切断 → リネージュが壊れるか（手コピー混入の最重要ケース）
import ExcelJS from 'exceljs';
import { parseXlsx } from '../src/preprocess/parse.js';
import { classifySheetRoles } from '../src/preprocess/classify.js';

const API = 'http://localhost:8787';
const bufOf = async (wb: ExcelJS.Workbook) => Buffer.from(await wb.xlsx.writeBuffer());

// 真の役割（ground truth）。シート名はわざと汎用・紛らわしくしてある。
const GROUND_TRUTH_ROLE: Record<string, string> = {
  Sheet1: 'input_data',   // 実体: 売上RAW
  Sheet2: 'input_data',   // 実体: 原価RAW
  tmp: 'input_data',      // 実体: 為替レート
  マスタ: 'input_data',   // 実体: 部門マスタ
  計算: 'working_sheet',  // 実体: 正規化（Sheet1,Sheet2,tmp を参照）
  作業用: 'working_sheet', // 実体: 月次集計（計算, マスタ を参照）
  出力: 'final_output',    // 実体: 帳票（作業用 を参照）
};
// 真の参照辺（outbound）
const GROUND_TRUTH_REFS: Record<string, string[]> = {
  Sheet1: [], Sheet2: [], tmp: [], マスタ: [],
  計算: ['Sheet1', 'Sheet2', 'tmp'],
  作業用: ['計算', 'マスタ'],
  出力: ['作業用'],
};

// チェーン: Sheet1/Sheet2/tmp → 計算 → 作業用 → 出力 （マスタ は 作業用 に合流）
// breakLink=true で「計算→作業用」を値貼り付けに置換（formula を消す）
async function buildChainWorkbook(breakLink: boolean): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();

  const s1 = wb.addWorksheet('Sheet1'); // 売上
  s1.addRow(['部門', '売上']); s1.addRow(['D1', 5000]); s1.addRow(['D2', 3000]);
  const s2 = wb.addWorksheet('Sheet2'); // 原価
  s2.addRow(['部門', '原価']); s2.addRow(['D1', 3200]); s2.addRow(['D2', 2100]);
  const tmp = wb.addWorksheet('tmp');   // 為替
  tmp.addRow(['通貨', 'レート']); tmp.addRow(['USD', 150]);
  const mst = wb.addWorksheet('マスタ'); // 部門マスタ
  mst.addRow(['コード', '部門名']); mst.addRow(['D1', '第一営業']); mst.addRow(['D2', '第二営業']);

  // 計算: 売上-原価=粗利、×為替（正規化・中間）
  const calc = wb.addWorksheet('計算');
  calc.addRow(['部門', '粗利', '粗利USD']);
  for (let i = 0; i < 2; i++) {
    const r = i + 2;
    calc.addRow([
      { formula: `Sheet1!A${r}` },
      { formula: `Sheet1!B${r}-Sheet2!B${r}` },
      { formula: `(Sheet1!B${r}-Sheet2!B${r})/tmp!B2` },
    ]);
  }

  // 作業用: 計算 を部門名付きで集計（中間）。breakLink 時は値貼り付けにする
  const work = wb.addWorksheet('作業用');
  work.addRow(['部門名', '粗利']);
  const calcVals = [5000 - 3200, 3000 - 2100]; // 値貼り付け時の固定値
  for (let i = 0; i < 2; i++) {
    const r = i + 2;
    work.addRow([
      { formula: `VLOOKUP(計算!A${r},マスタ!A:B,2,FALSE)` }, // マスタ参照は維持
      breakLink ? calcVals[i] : { formula: `計算!B${r}` },   // ← ここが切断点
    ]);
  }

  // 出力: 作業用 の総計（帳票）
  const out = wb.addWorksheet('出力');
  out.addRow(['指標', '値']);
  out.addRow(['粗利合計', { formula: `SUM(作業用!B2:B3)` }]);

  return bufOf(wb);
}

// ---- 評価 ----
function scoreRoles(detected: Record<string, { role: string; references: string[] }>) {
  const names = Object.keys(GROUND_TRUTH_ROLE);
  let roleHit = 0;
  const roleDiffs: string[] = [];
  for (const n of names) {
    const d = detected[n]?.role ?? '(なし)';
    if (d === GROUND_TRUTH_ROLE[n]) roleHit++;
    else roleDiffs.push(`  ${n}: 真=${GROUND_TRUTH_ROLE[n]} / 検出=${d}`);
  }
  // 参照辺の precision/recall
  let tp = 0, fp = 0, fn = 0;
  for (const n of names) {
    const truth = new Set(GROUND_TRUTH_REFS[n] ?? []);
    const det = new Set(detected[n]?.references ?? []);
    for (const e of det) (truth.has(e) ? tp++ : fp++);
    for (const e of truth) if (!det.has(e)) fn++;
  }
  const prec = tp + fp === 0 ? 1 : tp / (tp + fp);
  const rec = tp + fn === 0 ? 1 : tp / (tp + fn);
  return { roleHit, total: names.length, roleDiffs, prec, rec, tp, fp, fn };
}

async function aiDecode(label: string, b: Buffer) {
  const project = await (await fetch(`${API}/api/projects`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customer_name: `関係実験_${label}`, description: label }),
  })).json();
  const fd = new FormData();
  fd.append('kind', 'auto');
  fd.append('file', new Blob([b]), 'chain.xlsx');
  await fetch(`${API}/api/projects/${project.id}/artifacts`, { method: 'POST', body: fd });
  await fetch(`${API}/api/projects/${project.id}/pipeline/decode`, { method: 'POST' });
  for (let i = 0; i < 120; i++) {
    const p = await (await fetch(`${API}/api/projects/${project.id}`)).json();
    const run = (p.runs as any[]).find(r => r.stage === 'decode');
    if (run && run.status !== 'running') break;
    await new Promise(r => setTimeout(r, 3000));
  }
  const findings = await (await fetch(`${API}/api/projects/${project.id}/findings`)).json();
  return { id: project.id, findings };
}

async function runCase(label: string, breakLink: boolean) {
  console.log(`\n${'#'.repeat(72)}\n## ${label}\n${'#'.repeat(72)}`);
  const b = await buildChainWorkbook(breakLink);

  // (A) 決定論的グラフを直接実行
  const parsed = await parseXlsx(b);
  const classified = classifySheetRoles(parsed) as Record<string, { role: string; references: string[]; reason: string }>;
  console.log('\n[A] 決定論的参照グラフ（classify.ts）');
  for (const [name, c] of Object.entries(classified)) {
    console.log(`  ${name.padEnd(8)} role=${c.role.padEnd(13)} refs=[${c.references.join(',')}]`);
  }
  const sc = scoreRoles(classified);
  console.log(`\n  役割正解: ${sc.roleHit}/${sc.total}`);
  if (sc.roleDiffs.length) console.log('  誤分類:\n' + sc.roleDiffs.join('\n'));
  console.log(`  参照辺 precision=${sc.prec.toFixed(2)} recall=${sc.rec.toFixed(2)} (tp=${sc.tp} fp=${sc.fp} fn=${sc.fn})`);

  // (B) AI 解読がリネージュを意味的に回復できるか
  const ai = await aiDecode(label, b);
  console.log(`\n[B] AI 解読 findings ${ai.findings.length}件 (project id=${ai.id})`);
  for (const f of ai.findings) {
    const flag = f.kpiee_target === 'needs_customer_confirmation' ? ' ⚠' : '';
    console.log(`  [${f.source_ref}] ${f.logic_type}→${f.kpiee_target}${flag} (${f.confidence})`);
    console.log(`    ${f.explanation.slice(0, 140)}`);
  }
}

async function main() {
  const h = await (await fetch(`${API}/api/health`)).json();
  console.log('AI mode:', h.aiMode);
  console.log('\n真の構造: Sheet1/Sheet2/tmp → 計算 → 作業用 ← マスタ ; 作業用 → 出力');
  await runCase('R1: チェーン正常（紛らわしい名前・リンク健全）', false);
  await runCase('R2: 計算→作業用 を値貼り付けで切断', true);
}
main().catch(e => { console.error(e); process.exit(1); });

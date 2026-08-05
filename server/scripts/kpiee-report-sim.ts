// KPIEE レポートのローカル再現テスト（PoC / 読み捨て可）。
// 目的: 生成物（SQLジョブ + report_config + master_csv）が KPIEE 上でどう「最終帳票」になるかを
//       ローカルで再現し、顧客の最終帳票と突き合わせて「実装される姿」と「実装漏れ・不可」を目視できるようにする。
//
// 流れ:
//   1. SQLジョブを DuckDB で実行 → これが KPIEE の「データファイル」に相当（列=SELECT別名）
//   2. report_config を KPIEE の集計規則（SUM 専用・master 行・calc_row/指標カスタム数式・値フィルタ）で
//      データファイルに適用 → KPIEE が描くであろうレポート表を再現
//   3. 顧客の最終帳票（final_output）とセル単位で突き合わせ、一致率・欠落列・実装不可を報告
//
// 限界（本物と違う点。设计上 Phase 2 の実 API 検証で担保する部分）:
//   - DuckDB 実行であり Snowflake ではない（型・丸め・NUMBER scale は近似）
//   - 会計年度開始月・週開始曜日など config 外の設定は未使用（期間バケットは扱わない）
//   - 集計は SUM のみ（KPIEE レポート層と同じ。count/avg/max/min は実装不可として警告）
//
// 使い方: cd server && npx tsx scripts/kpiee-report-sim.ts <projectId>
import { collectByRole } from '../src/pipeline/orchestrator.js';
import { runSqlSimulation } from '../src/match/simulate.js';
import { db } from '../src/db.js';
import type { ParsedArtifact } from '../src/preprocess/parse.js';

// ---- report_config 型（生成物 JSON の最小形） ----
interface Metric { name: string; source_column: string; aggregation?: string; custom_formula?: string }
interface Axis { type: string; label: string }
interface YObj { type: string; label: string; custom_formula?: string }
interface ValueFilter { column: string; operator: string; value: string }
interface ReportConfig {
  report_name: string;
  x_axis: Axis;
  y_axis: YObj[];
  metrics: Metric[];
  value_filters: ValueFilter[];
}

const NUM = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v));
  return Number.isNaN(n) ? null : n;
};

// ---- カスタム数式の評価（[指標名] 参照 + - * / ^ 括弧。KPIEE の AST 同等、eval 不使用） ----
function evalFormula(formula: string, vars: Record<string, number>): number | null {
  // [名前] → 数値へ置換したトークン列を再帰下降で評価
  let missing = false;
  const src = formula.replace(/\[([^\]]+)\]/g, (_, name: string) => {
    const v = vars[name.trim()];
    if (v === undefined) { missing = true; return '0'; }
    return `(${v})`;
  });
  if (missing) return null;
  let i = 0;
  const s = src.replace(/\s+/g, '');
  const peek = () => s[i];
  // expr = term (('+'|'-') term)*
  function expr(): number { let v = term(); while (peek() === '+' || peek() === '-') { const op = s[i++]; const r = term(); v = op === '+' ? v + r : v - r; } return v; }
  // term = factor (('*'|'/') factor)*
  function term(): number { let v = factor(); while (peek() === '*' || peek() === '/') { const op = s[i++]; const r = factor(); v = op === '*' ? v * r : v / r; } return v; }
  // factor = base ('^' factor)?  （右結合）
  function factor(): number { let v = base(); if (peek() === '^') { i++; v = Math.pow(v, factor()); } return v; }
  function base(): number {
    if (peek() === '(') { i++; const v = expr(); if (peek() === ')') i++; return v; }
    if (peek() === '-') { i++; return -base(); }
    if (peek() === '+') { i++; return base(); }
    let j = i; while (j < s.length && /[0-9.]/.test(s[j])) j++;
    const v = Number(s.slice(i, j)); i = j; return v;
  }
  const r = expr();
  return Number.isNaN(r) ? null : r;
}

function compare(op: string, a: number, b: number, b2?: number): boolean {
  switch (op) {
    case 'gte': return a >= b; case 'lte': return a <= b;
    case 'gt': return a > b; case 'lt': return a < b;
    case 'eq': return a === b; case 'neq': return a !== b;
    case 'btw': return b2 !== undefined && a >= b && a <= b2;
    case 'nbtw': return !(b2 !== undefined && a >= b && a <= b2);
    default: return true;
  }
}

// ---- SQLジョブ出力（データファイル）から KPIEE レポート表を再現 ----
interface Rendered { groupCol: string; metricNames: string[]; rows: { key: string; cells: Record<string, number | null> }[]; notes: string[] }

function renderKpieeReport(
  dataFile: { columns: string[]; rows: Record<string, unknown>[] },
  cfg: ReportConfig,
  masterMap: Map<string, string>,
): Rendered {
  const notes: string[] = [];
  const cols = new Set(dataFile.columns);

  // 行の集約キー（master 軸のうち、データファイルに実在する列）を決める
  const candidates = [cfg.x_axis?.label, ...(cfg.y_axis ?? []).filter(y => y.type === 'master').map(y => y.label)];
  const groupCol = candidates.find(c => c && cols.has(c)) ?? dataFile.columns[0];

  // 出力指標（＝帳票の列）。KPIEE は常に SUM。custom_formula は他指標参照で後計算。
  const baseMetrics = cfg.metrics.filter(m => !m.custom_formula);
  const formulaMetrics = cfg.metrics.filter(m => m.custom_formula);

  for (const m of baseMetrics) {
    if (m.aggregation && m.aggregation !== 'sum') {
      notes.push(`⚠ 指標「${m.name}」の集計 "${m.aggregation}" は KPIEE レポート層に存在しません（SUM 専用）→ 実装不可。SQLジョブ側で事前集計するか、実装できない旨を顧客確認`);
    }
    if (!cols.has(m.source_column)) {
      notes.push(`⚠ 指標「${m.name}」の source_column "${m.source_column}" がデータファイル列に無い（列: ${dataFile.columns.join(', ')}）`);
    }
  }

  // group → 指標 → SUM
  const groups = new Map<string, Record<string, number | null>>();
  for (const r of dataFile.rows) {
    const rawKey = String(r[groupCol] ?? '');
    const key = masterMap.get(rawKey) ?? rawKey;
    let cell = groups.get(key);
    if (!cell) { cell = {}; groups.set(key, cell); }
    for (const m of baseMetrics) {
      const v = NUM(r[m.source_column]);
      if (v !== null) cell[m.name] = (cell[m.name] ?? 0) + v;
    }
  }
  // custom_formula 指標を各行で後計算
  for (const [, cell] of groups) {
    for (const m of formulaMetrics) {
      const vars: Record<string, number> = {};
      for (const k of Object.keys(cell)) if (cell[k] !== null) vars[k] = cell[k] as number;
      cell[m.name] = evalFormula(m.custom_formula!, vars);
    }
  }

  const metricNames = cfg.metrics.map(m => m.name);
  let rows = [...groups.entries()].map(([key, cells]) => ({ key, cells })).sort((a, b) => a.key.localeCompare(b.key));

  // 値フィルタ（KPIEE は後処理。ここでは対象指標が閾値を満たさない行を落とす簡易実装）
  for (const f of cfg.value_filters ?? []) {
    const parts = String(f.value).split(/[,~]/).map(x => Number(x.trim()));
    rows = rows.filter(r => { const v = r.cells[f.column]; return v === null || v === undefined ? true : compare(f.operator, v, parts[0], parts[1]); });
    notes.push(`値フィルタ適用: ${f.column} ${f.operator} ${f.value}`);
  }

  return { groupCol, metricNames, rows, notes };
}

// ---- ParsedArtifact → グリッド（1行目ヘッダ, 1列目=行ラベル） ----
function toGrid(parsed: ParsedArtifact): { header: string[]; rows: (string | number | null)[][] } {
  const sheet = parsed.sheets[0];
  const colIdx = (ref: string): number => { const L = ref.replace(/\d+/g, ''); let n = 0; for (const c of L) n = n * 26 + (c.charCodeAt(0) - 64); return n - 1; };
  const width = Math.max(...sheet.rows.map(r => Math.max(0, ...r.cells.map(c => colIdx(c.ref) + 1))));
  const grid = sheet.rows.map(r => { const a = new Array(width).fill(null); for (const c of r.cells) { const i = colIdx(c.ref); if (i >= 0 && i < width) a[i] = c.value; } return a; });
  return { header: (grid[0] ?? []).map(x => String(x ?? '')), rows: grid.slice(1) };
}

function printTable(title: string, header: string[], rows: (string | number | null)[][]): void {
  console.log(`\n【${title}】`);
  const all = [header, ...rows.map(r => r.map(x => (x === null || x === undefined ? '' : String(x))))];
  const w = header.map((_, i) => Math.max(...all.map(r => (r[i] ?? '').length)));
  for (const r of all) console.log('  ' + r.map((c, i) => (c ?? '').padEnd(w[i])).join(' | '));
}

// ================= main =================
const projectId = Number(process.argv[2] ?? 1);
console.log(`\n############ KPIEE レポート ローカル再現テスト  (project ${projectId}) ############`);

const collections = await collectByRole(projectId);
const getDel = async (kind: string) => ((await db.prepare(`SELECT content FROM deliverables WHERE project_id=? AND kind=? ORDER BY version DESC LIMIT 1`).get(projectId, kind)) as { content: string } | undefined)?.content;

const sql = await getDel('sql');
const cfgJson = await getDel('report_config_json');
const masterCsv = (await getDel('master_csv')) ?? '';
if (!sql || !cfgJson) { console.error('この project には sql / report_config がありません（先に成果物生成が必要）'); process.exit(1); }
const cfg = JSON.parse(cfgJson) as ReportConfig;

// master_csv: 1列目 code → 2列目 name のマップ（表示用。値が code のときだけ効く）
const masterMap = new Map<string, string>();
{
  const lines = masterCsv.trim().split(/\r?\n/).filter(Boolean);
  for (const line of lines.slice(1)) { const [code, name] = line.split(','); if (code && name) masterMap.set(code.trim(), name.trim()); }
}

// 1) SQLジョブ実行 = KPIEE データファイル
console.log(`\n■ 生成 SQL（SQLジョブ）:\n${sql}`);
const dataFile = await runSqlSimulation(collections.inputs, sql);
printTable('① SQLジョブ出力 = KPIEE データファイル', dataFile.columns, dataFile.rows.map(r => dataFile.columns.map(c => (r[c] as string | number | null))));

// 2) KPIEE レポート再現
console.log(`\n■ report_config: ${cfg.report_name}  / X軸=${cfg.x_axis?.type}(${cfg.x_axis?.label})  指標=[${cfg.metrics.map(m => m.name + (m.custom_formula ? `=${m.custom_formula}` : `:${m.aggregation}`)).join(', ')}]`);
const rendered = renderKpieeReport(dataFile, cfg, masterMap);
printTable('② KPIEE が描くレポート（再現）', [rendered.groupCol, ...rendered.metricNames], rendered.rows.map(r => [r.key, ...rendered.metricNames.map(n => r.cells[n] ?? null)]));

// 3) 顧客の最終帳票
if (!collections.finalOutput) { console.log('\n（final_output 役割のシートが無いため突き合わせ不可）'); process.exit(0); }
const fin = toGrid(collections.finalOutput);
printTable('③ 顧客の最終帳票（正解）', fin.header, fin.rows.slice(0, 20));

// 4) 突き合わせ（帳票 vs 再現）
console.log('\n【④ 突き合わせ: 顧客帳票 ⟷ KPIEE 再現】');
const renderedByKey = new Map(rendered.rows.map(r => [r.key, r.cells]));
const finLabelCol = 0;
let total = 0, matched = 0;
const missCols = new Set<string>();
const mism: string[] = [];
for (let c = 1; c < fin.header.length; c++) {
  const colName = fin.header[c];
  const producedCol = rendered.metricNames.includes(colName);
  for (const row of fin.rows) {
    const label = String(row[finLabelCol] ?? ''); if (label === '') continue;
    const expected = NUM(row[c]); if (expected === null) continue;
    total++;
    if (!producedCol) { missCols.add(colName); continue; }
    const actual = renderedByKey.get(label)?.[colName] ?? null;
    if (actual !== null && Math.abs(actual - expected) <= Math.max(1e-6, Math.abs(expected) * 1e-6)) matched++;
    else mism.push(`  ✗ ${label} / ${colName}: 帳票=${expected}  再現=${actual ?? '（無し）'}`);
  }
}
console.log(`  一致: ${matched}/${total} セル (${total ? Math.round((matched / total) * 100) : 0}%)`);
if (missCols.size) console.log(`  ⛔ KPIEE 実装時に欠落する列（report_config が生成していない）: ${[...missCols].join(', ')}`);
if (mism.length) { console.log('  不一致セル:'); mism.slice(0, 20).forEach(m => console.log(m)); }

if (rendered.notes.length) { console.log('\n【⑤ KPIEE 実装ノート（実装不可・注意）】'); rendered.notes.forEach(n => console.log('  ' + n)); }

console.log('\n※ 注意: DuckDB 実行のローカル近似です（Snowflake の型・丸め・期間バケット・会計設定は未反映）。厳密検証は実 API 投入（Phase 2）が必要。');
process.exit(0);

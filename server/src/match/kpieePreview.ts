// KPIEE 実装プレビュー（設計 §6.5 の拡張）。
// これまで照合は「生成 SQL を DuckDB で実行 → 帳票と突き合わせ」だけで、report_config 層
// （集計・カスタム数式・値フィルタ）が KPIEE 上でどう最終帳票になるかは検証していなかった。
// ここではその層をローカル再現し、二つの視点を返す:
//   Tier2 buildKpieePreview   … SQLジョブ出力(=データファイル) → KPIEE レポート再現 → 帳票と突き合わせ
//   Tier1 buildImplReport     … 各解読項目/指標が KPIEE でどう実装されるか・実装不可かの分類（実行なしの説明）
//
// 限界（本物と違う点。厳密検証は Phase 2 の実 API 投入で担保）:
//   - DuckDB 実行であり Snowflake ではない（型・丸め・NUMBER scale は近似）
//   - 会計年度開始月・週開始曜日など config 外の設定は未使用（期間バケットは扱わない）
//   - KPIEE レポート層の集計は SUM のみ。count/avg/max/min は実装不可として扱う
import { collectByRole } from '../pipeline/orchestrator.js';
import { runSqlSimulation } from './simulate.js';
import { db } from '../db.js';
import type { ParsedArtifact } from '../preprocess/parse.js';

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

type Cell = string | number | null;

const NUM = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v));
  return Number.isNaN(n) ? null : n;
};

/** カスタム数式の評価（[指標名] 参照 + - * / ^ 括弧。KPIEE の AST 同等、eval 不使用） */
function evalFormula(formula: string, vars: Record<string, number>): number | null {
  let missing = false;
  const src = formula.replace(/\[([^\]]+)\]/g, (_, name: string) => {
    const v = vars[name.trim()];
    if (v === undefined) { missing = true; return '0'; }
    return `(${v})`;
  });
  if (missing) return null;
  const s = src.replace(/\s+/g, '');
  let i = 0;
  const peek = () => s[i];
  function expr(): number { let v = term(); while (peek() === '+' || peek() === '-') { const op = s[i++]; const r = term(); v = op === '+' ? v + r : v - r; } return v; }
  function term(): number { let v = factor(); while (peek() === '*' || peek() === '/') { const op = s[i++]; const r = factor(); v = op === '*' ? v * r : v / r; } return v; }
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

function compareOp(op: string, a: number, b: number, b2?: number): boolean {
  switch (op) {
    case 'gte': return a >= b; case 'lte': return a <= b;
    case 'gt': return a > b; case 'lt': return a < b;
    case 'eq': return a === b; case 'neq': return a !== b;
    case 'btw': return b2 !== undefined && a >= b && a <= b2;
    case 'nbtw': return !(b2 !== undefined && a >= b && a <= b2);
    default: return true;
  }
}

/** ParsedArtifact の先頭シート → グリッド（1行目ヘッダ, 1列目=行ラベル） */
function toGrid(parsed: ParsedArtifact): { header: string[]; rows: Cell[][] } {
  const sheet = parsed.sheets[0];
  const colIdx = (ref: string): number => { const L = ref.replace(/\d+/g, ''); let n = 0; for (const c of L) n = n * 26 + (c.charCodeAt(0) - 64); return n - 1; };
  const width = Math.max(0, ...sheet.rows.map(r => Math.max(0, ...r.cells.map(c => colIdx(c.ref) + 1))));
  const grid = sheet.rows.map(r => { const a: Cell[] = new Array(width).fill(null); for (const c of r.cells) { const i = colIdx(c.ref); if (i >= 0 && i < width) a[i] = c.value as Cell; } return a; });
  return { header: (grid[0] ?? []).map(x => String(x ?? '')), rows: grid.slice(1) };
}

/** master_csv（1列目 code, 2列目 name）→ code→name マップ */
function masterMapOf(masterCsv: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of masterCsv.trim().split(/\r?\n/).filter(Boolean).slice(1)) {
    const [code, name] = line.split(',');
    if (code && name) m.set(code.trim(), name.trim());
  }
  return m;
}

async function latestDeliverable(projectId: number, kind: string): Promise<string | undefined> {
  const row = await db.prepare(
    `SELECT content FROM deliverables WHERE project_id = ? AND kind = ? ORDER BY version DESC LIMIT 1`,
  ).get(projectId, kind) as { content: string } | undefined;
  return row?.content;
}

export interface RenderedReport {
  groupCol: string;
  metricNames: string[];
  rows: { key: string; cells: (number | null)[] }[];
  notes: string[];
}

/** データファイル（SQLジョブ出力）に report_config を適用して KPIEE レポート表を再現する */
function renderKpieeReport(
  dataFile: { columns: string[]; rows: Record<string, unknown>[] },
  cfg: ReportConfig,
  masterMap: Map<string, string>,
): RenderedReport {
  const notes: string[] = [];
  const cols = new Set(dataFile.columns);

  const candidates = [cfg.x_axis?.label, ...(cfg.y_axis ?? []).filter(y => y.type === 'master').map(y => y.label)];
  const groupCol = candidates.find(c => c && cols.has(c)) ?? dataFile.columns[0];

  const baseMetrics = cfg.metrics.filter(m => !m.custom_formula);
  const formulaMetrics = cfg.metrics.filter(m => m.custom_formula);

  for (const m of baseMetrics) {
    if (m.aggregation && m.aggregation !== 'sum') {
      notes.push(`指標「${m.name}」の集計 "${m.aggregation}" は KPIEE レポート層に存在しません（SUM 専用）。SQLジョブ側で事前集計するか、実装不可として顧客確認が必要です。`);
    }
    if (!cols.has(m.source_column)) {
      notes.push(`指標「${m.name}」の source_column "${m.source_column}" がデータファイル列にありません（列: ${dataFile.columns.join(', ')}）。`);
    }
  }

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
  for (const [, cell] of groups) {
    for (const m of formulaMetrics) {
      const vars: Record<string, number> = {};
      for (const k of Object.keys(cell)) if (cell[k] !== null) vars[k] = cell[k] as number;
      cell[m.name] = evalFormula(m.custom_formula!, vars);
    }
  }

  const metricNames = cfg.metrics.map(m => m.name);
  let rows = [...groups.entries()]
    .map(([key, cells]) => ({ key, cells: metricNames.map(n => cells[n] ?? null) }))
    .sort((a, b) => a.key.localeCompare(b.key));

  for (const f of cfg.value_filters ?? []) {
    const idx = metricNames.indexOf(f.column);
    const parts = String(f.value).split(/[,~]/).map(x => Number(x.trim()));
    if (idx >= 0) rows = rows.filter(r => { const v = r.cells[idx]; return v === null ? true : compareOp(f.operator, v, parts[0], parts[1]); });
    notes.push(`値フィルタ適用: ${f.column} ${f.operator} ${f.value}`);
  }

  return { groupCol, metricNames, rows, notes };
}

export interface KpieePreview {
  available: boolean;
  message?: string;
  reportName?: string;
  sql?: string;
  dataFile?: { columns: string[]; rows: Cell[][] };
  rendered?: { groupCol: string; metricNames: string[]; rows: { key: string; cells: (number | null)[] }[] };
  finalOutput?: { header: string[]; rows: Cell[][] } | null;
  comparison?: {
    total: number; matched: number; matchRate: number;
    missingColumns: string[];
    mismatches: { label: string; column: string; expected: number; actual: number | null }[];
  } | null;
  notes?: string[];
}

/** Tier2: SQLジョブ出力 → KPIEE レポート再現 → 顧客帳票との突き合わせ */
export async function buildKpieePreview(projectId: number): Promise<KpieePreview> {
  const sql = await latestDeliverable(projectId, 'sql');
  const cfgJson = await latestDeliverable(projectId, 'report_config_json');
  if (!sql || !cfgJson) return { available: false, message: '生成 SQL / レポート設定がありません。先に成果物生成を実行してください。' };

  const cfg = JSON.parse(cfgJson) as ReportConfig;
  const masterMap = masterMapOf((await latestDeliverable(projectId, 'master_csv')) ?? '');
  const collections = await collectByRole(projectId);

  const dataFile = await runSqlSimulation(collections.inputs, sql);
  const rendered = renderKpieeReport(dataFile, cfg, masterMap);

  const preview: KpieePreview = {
    available: true,
    reportName: cfg.report_name,
    sql,
    dataFile: { columns: dataFile.columns, rows: dataFile.rows.map(r => dataFile.columns.map(c => r[c] as Cell)) },
    rendered: { groupCol: rendered.groupCol, metricNames: rendered.metricNames, rows: rendered.rows },
    finalOutput: null,
    comparison: null,
    notes: rendered.notes,
  };

  if (collections.finalOutput) {
    const fin = toGrid(collections.finalOutput);
    preview.finalOutput = { header: fin.header, rows: fin.rows.slice(0, 50) };

    const renderedByKey = new Map(rendered.rows.map(r => [r.key, r.cells]));
    let total = 0, matched = 0;
    const missingColumns = new Set<string>();
    const mismatches: { label: string; column: string; expected: number; actual: number | null }[] = [];
    for (let c = 1; c < fin.header.length; c++) {
      const colName = fin.header[c];
      const colIdx = rendered.metricNames.indexOf(colName);
      for (const row of fin.rows) {
        const label = String(row[0] ?? ''); if (label === '') continue;
        const expected = NUM(row[c]); if (expected === null) continue;
        total++;
        if (colIdx < 0) { missingColumns.add(colName); continue; }
        const actual = renderedByKey.get(label)?.[colIdx] ?? null;
        if (actual !== null && Math.abs(actual - expected) <= Math.max(1e-6, Math.abs(expected) * 1e-6)) matched++;
        else mismatches.push({ label, column: colName, expected, actual });
      }
    }
    preview.comparison = {
      total, matched, matchRate: total === 0 ? 0 : matched / total,
      missingColumns: [...missingColumns], mismatches: mismatches.slice(0, 50),
    };
  }

  return preview;
}

// ---- Tier1: KPIEE 実装可否レポート ----
interface FindingRow { source_ref: string; logic_type: string; kpiee_target: string; explanation: string; review_status: string | null }

export interface ImplItem { source: string; kpieeTarget: string; status: 'ok' | 'warn' | 'blocked'; how: string }
export interface ImplReport {
  available: boolean;
  message?: string;
  items: ImplItem[];
  summary: { ok: number; warn: number; blocked: number };
  markdown: string;
}

const TARGET_LABEL: Record<string, string> = {
  sql_job: 'SQLジョブ（前処理 SQL）で実装',
  report_metric: 'レポート指標（SUM）で実装',
  report_axis: 'レポート軸で実装',
  master: 'マスタ（軸）で実装',
  custom_row: 'レポート計算行（カスタム数式）で実装',
  allocation: '配賦ロジックで実装',
  needs_customer_confirmation: '出所不明 → 顧客確認が必要',
};

/** Tier1: 各解読項目と指標が KPIEE でどう実装されるか（不可なら理由）を分類して返す */
export async function buildImplReport(projectId: number): Promise<ImplReport> {
  const findings = await db.prepare(
    `SELECT source_ref, logic_type, kpiee_target, explanation, review_status FROM findings WHERE project_id = ? ORDER BY id`,
  ).all(projectId) as FindingRow[];
  const cfgJson = await latestDeliverable(projectId, 'report_config_json');

  if (findings.length === 0 && !cfgJson) {
    return { available: false, message: '解読結果・レポート設定がありません。先に AI 解読／成果物生成を実行してください。', items: [], summary: { ok: 0, warn: 0, blocked: 0 }, markdown: '' };
  }

  const items: ImplItem[] = [];

  for (const f of findings) {
    const target = f.kpiee_target;
    let status: ImplItem['status'] = 'ok';
    let how = TARGET_LABEL[target] ?? target;
    if (target === 'needs_customer_confirmation') { status = 'blocked'; how = '出所・ロジック不明のため実装不可。顧客に確認が必要です。'; }
    else if (target === 'allocation') { status = 'warn'; how = '配賦ロジック。KPIEE の配賦機能または SQLジョブでの事前計算が必要です。'; }
    items.push({ source: f.source_ref, kpieeTarget: target, status, how });
  }

  // report_config の指標を検査（非 SUM 集計は KPIEE レポート層で実装不可）
  if (cfgJson) {
    const cfg = JSON.parse(cfgJson) as ReportConfig;
    for (const m of cfg.metrics) {
      if (m.custom_formula) {
        items.push({ source: `指標「${m.name}」`, kpieeTarget: 'custom_formula', status: 'ok', how: `カスタム数式（${m.custom_formula}）で実装可能。` });
      } else if (m.aggregation && m.aggregation !== 'sum') {
        items.push({ source: `指標「${m.name}」`, kpieeTarget: `aggregation=${m.aggregation}`, status: 'blocked', how: `KPIEE レポートの集計は SUM 専用です。${m.aggregation} はレポート層で実装不可 → SQLジョブ側で事前集計してください。` });
      } else {
        items.push({ source: `指標「${m.name}」`, kpieeTarget: 'report_metric', status: 'ok', how: 'レポート指標（SUM）で実装可能。' });
      }
    }
  }

  // 帳票の列が report_config で生成されているか（欠落列 = 実装漏れ）
  const preview = await buildKpieePreview(projectId).catch(() => null);
  if (preview?.comparison?.missingColumns?.length) {
    for (const col of preview.comparison.missingColumns) {
      items.push({ source: `帳票の列「${col}」`, kpieeTarget: '（未生成）', status: 'blocked', how: 'この列を作る指標/計算行が report_config にありません。このままだと KPIEE 上で列が欠落します。' });
    }
  }

  const summary = {
    ok: items.filter(i => i.status === 'ok').length,
    warn: items.filter(i => i.status === 'warn').length,
    blocked: items.filter(i => i.status === 'blocked').length,
  };

  const mark = (s: ImplItem['status']) => (s === 'ok' ? '✅ 実装可' : s === 'warn' ? '⚠ 要注意' : '⛔ 実装不可/欠落');
  const markdown = [
    `# KPIEE 実装可否レポート`,
    '',
    `実装可: ${summary.ok} 件 / 要注意: ${summary.warn} 件 / 実装不可・欠落: ${summary.blocked} 件`,
    '',
    '| 対象 | 判定 | KPIEE 実装方法 / 理由 |',
    '|---|---|---|',
    ...items.map(i => `| ${i.source.replace(/\|/g, '\\|')} | ${mark(i.status)} | ${i.how.replace(/\|/g, '\\|')} |`),
  ].join('\n');

  return { available: true, items, summary, markdown };
}

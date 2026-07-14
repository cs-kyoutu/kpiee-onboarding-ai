// AI パイプラインオーケストレーター（設計書 §6.2, §7.2）。
// ローカル動作のため Sidekiq の代わりにインプロセスの逐次ジョブ実行を採用。
// 各段階は analysis_runs に記録され、失敗しても該当段階から再実行できる（冪等）。
import { db, setProjectStatus } from '../db.js';
import { materializeParsed } from '../artifacts.js';
import type { ParsedArtifact } from '../preprocess/parse.js';
import { shapeArtifactsToBudget } from '../preprocess/shape.js';
import { aiAvailable, callStructured, MODEL } from '../ai/client.js';
import { decodeInstruction, generateInstruction, regenerateInstruction } from '../ai/prompts.js';
import {
  FINDINGS_SCHEMA, GENERATION_SCHEMA,
  type Finding, type GenerationResult, type ReportConfig, type StructureOverview,
} from '../ai/schemas.js';
import { mockDecode, mockGenerate, mockOverview } from '../ai/mock.js';
import { scanQuery } from '../validator/queryScanner.js';
import { matchAgainstFinalOutput } from '../match/simulate.js';

const MAX_REGENERATION = 3; // 検証 NG 時の自動再生成上限（設計書 §6.3）

interface ArtifactRow {
  id: number;
  kind: string;
  original_filename: string;
  storage_key: string;
  parsed_key: string | null;
  parse_status: string;
  sheet_roles: string | null;
}

/** ファイル名から SQL で参照可能なテーブル名（アセット名）を作る */
export function tableNameOf(filename: string): string {
  return filename
    .replace(/\.[^.]+$/, '')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase() || 'input';
}

interface ScriptRow { id: number; name: string; code: string }

/** プロジェクトに登録された Apps Script 等の変換ロジック原文を読み込む */
async function loadScripts(projectId: number): Promise<ScriptRow[]> {
  return await db.prepare(
    `SELECT id, name, code FROM project_scripts WHERE project_id = ? ORDER BY id`,
  ).all(projectId) as ScriptRow[];
}

/** AI メッセージへ添付する <apps_scripts> ブロックを組み立てる（無ければ空文字列） */
async function scriptsBlock(projectId: number): Promise<string> {
  const scripts = await loadScripts(projectId);
  if (scripts.length === 0) return '';
  const payload = scripts.map(s => ({ name: s.name, code: s.code }));
  return `\n\n<apps_scripts>\n${JSON.stringify(payload)}\n</apps_scripts>`;
}

async function loadArtifacts(projectId: number): Promise<{ row: ArtifactRow; parsed: ParsedArtifact }[]> {
  const rows = await db.prepare(
    `SELECT id, kind, original_filename, storage_key, parsed_key, parse_status, sheet_roles FROM artifacts WHERE project_id = ?`,
  ).all(projectId) as ArtifactRow[];
  // 無保存モードでは parsed_key が無いので materializeParsed が原本を Drive から取り直してパースする。
  // 逐次処理でメモリのピークを抑える（全ファイルのパース結果を同時展開しない）。
  const out: { row: ArtifactRow; parsed: ParsedArtifact }[] = [];
  for (const r of rows) {
    if (r.parse_status !== 'done') continue;
    out.push({ row: r, parsed: await materializeParsed(r) });
  }
  return out;
}

/** アーティファクトのシート役割マップを得る。sheet_roles 未設定時は kind を全シートに適用（従来動作） */
function rolesOf(row: ArtifactRow, parsed: ParsedArtifact): Record<string, string> {
  if (row.sheet_roles) {
    const classified = JSON.parse(row.sheet_roles) as Record<string, { role: string }>;
    return Object.fromEntries(Object.entries(classified).map(([name, c]) => [name, c.role]));
  }
  return Object.fromEntries(parsed.sheets.map(s => [s.name, row.kind]));
}

/** 役割別に整理したパイプライン入力。混在ワークブック（kind=mixed）はシート単位で振り分けられる */
interface RoleCollections {
  /** SQL/DuckDB のテーブルになるインプット（CSV はファイル名、xlsx シートはシート名がテーブル名） */
  inputs: { tableName: string; parsed: ParsedArtifact }[];
  /** 解読対象の中間シート群 */
  working: ParsedArtifact[];
  /** 照合対象の最終帳票（最初に見つかった1シート） */
  finalOutput: ParsedArtifact | null;
  /** 役割が判定できなかったシート（検収者への注意喚起用） */
  unknownSheets: string[];
  artifacts: { row: ArtifactRow; parsed: ParsedArtifact; roles: Record<string, string> }[];
}

export async function collectByRole(projectId: number): Promise<RoleCollections> {
  const artifacts = (await loadArtifacts(projectId)).map(a => ({ ...a, roles: rolesOf(a.row, a.parsed) }));
  const inputs: RoleCollections['inputs'] = [];
  const working: ParsedArtifact[] = [];
  let finalOutput: ParsedArtifact | null = null;
  const unknownSheets: string[] = [];

  for (const a of artifacts) {
    const pick = (role: string) => a.parsed.sheets.filter(s => a.roles[s.name] === role);

    for (const sheet of pick('input_data')) {
      // CSV は単一シートなのでファイル名、xlsx は各シート名をテーブル名にする
      const tableName = a.parsed.fileType === 'csv'
        ? tableNameOf(a.row.original_filename)
        : tableNameOf(sheet.name);
      inputs.push({ tableName, parsed: { fileType: a.parsed.fileType, sheets: [sheet] } });
    }

    const workingSheets = pick('working_sheet');
    if (workingSheets.length > 0) working.push({ fileType: a.parsed.fileType, sheets: workingSheets });

    const finalSheets = pick('final_output');
    if (!finalOutput && finalSheets.length > 0) {
      finalOutput = { fileType: a.parsed.fileType, sheets: [finalSheets[0]] };
    }

    unknownSheets.push(...pick('unknown').map(s => `${a.row.original_filename}!${s.name}`));
  }

  return { inputs, working, finalOutput, unknownSheets, artifacts };
}

async function startRun(projectId: number, stage: string): Promise<number> {
  const res = await db.prepare(
    `INSERT INTO analysis_runs (project_id, stage, status, model) VALUES (?, ?, 'running', ?)`,
  ).run(projectId, stage, aiAvailable() ? MODEL : 'mock');
  return Number(res.lastInsertRowid);
}

async function finishRun(runId: number, ok: boolean, error?: string, tokens?: { input: number; output: number }): Promise<void> {
  // datetime('now') は方言依存のため ISO 文字列を渡す（pg=TIMESTAMPTZ, sqlite=TEXT どちらも受理）
  await db.prepare(
    `UPDATE analysis_runs SET status = ?, error = ?, input_tokens = ?, output_tokens = ?, finished_at = ? WHERE id = ?`,
  ).run(ok ? 'done' : 'failed', error ?? null, tokens?.input ?? 0, tokens?.output ?? 0, new Date().toISOString(), runId);
}

/** P1 解読: アーティファクト → 解読項目リスト */
export async function runDecode(projectId: number): Promise<{ runId: number; findingCount: number }> {
  await setProjectStatus(projectId, 'analyzing');
  const runId = await startRun(projectId, 'decode');
  try {
    const collections = await collectByRole(projectId);
    if (collections.artifacts.length === 0) throw new Error('解析済みアーティファクトがありません。先にアップロードしてください');

    const assetNames = collections.inputs.map(i => i.tableName);

    let findings: Finding[];
    let overview: StructureOverview;
    let tokens = { input: 0, output: 0 };

    if (aiAvailable()) {
      // 全アーティファクトを予算内に収まるよう適応的に整形（縦長・横長・多シートを自動で吸収）
      const payload = shapeArtifactsToBudget(collections.artifacts.map(a =>
        ({ parsed: a.parsed, roles: a.roles, kind: a.row.kind, filename: a.row.original_filename })));
      const result = await callStructured<{ findings: Finding[]; overview: StructureOverview }>(
        projectId, 'decode',
        `${decodeInstruction(assetNames)}\n\n<artifacts>\n${JSON.stringify(payload)}\n</artifacts>${await scriptsBlock(projectId)}`,
        FINDINGS_SCHEMA as unknown as Record<string, unknown>,
      );
      findings = result.data.findings;
      overview = result.data.overview;
      tokens = { input: result.inputTokens, output: result.outputTokens };
    } else {
      findings = mockDecode(collections.working);
      overview = mockOverview(collections);
    }

    // 役割判定不能シートは顧客確認候補として finding に追加する
    for (const ref of collections.unknownSheets) {
      findings.push({
        id: `F-unknown-${findings.length + 1}`,
        source_ref: ref,
        logic_type: 'unknown',
        kpiee_target: 'needs_customer_confirmation',
        explanation: `シート「${ref}」の役割（raw/中間/帳票）が自動判定できませんでした。アップロード画面のプレビューで役割を指定するか、顧客に出所を確認してください`,
        confidence: 'low',
      });
    }

    await db.tx(async t => {
      // 再実行時は前回の解読結果を破棄する（冪等性確保）
      await t.prepare(`DELETE FROM customer_questions WHERE project_id = ? AND finding_id IS NOT NULL`).run(projectId);
      await t.prepare(`DELETE FROM findings WHERE project_id = ?`).run(projectId);
      // 全体構造サマリも最新の解読結果で置き換える（プロジェクトごとに1件）。
      // INSERT OR REPLACE(sqlite) の代わりに ON CONFLICT を使う（pg/sqlite 双方対応）。
      await t.prepare(
        `INSERT INTO project_overviews (project_id, content, created_at) VALUES (?, ?, ?)
         ON CONFLICT (project_id) DO UPDATE SET content = EXCLUDED.content, created_at = EXCLUDED.created_at`,
      ).run(projectId, JSON.stringify(overview), new Date().toISOString());
      const insert = t.prepare(`
        INSERT INTO findings
          (analysis_run_id, project_id, source_ref, formula_raw, logic_type, kpiee_target, explanation, confidence, needs_customer_confirmation)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertQuestion = t.prepare(`
        INSERT INTO customer_questions (project_id, finding_id, question) VALUES (?, ?, ?)
      `);
      for (const f of findings) {
        const needsConfirm = f.kpiee_target === 'needs_customer_confirmation' ? 1 : 0;
        const res = await insert.run(
          runId, projectId, f.source_ref, f.formula_raw ?? null,
          f.logic_type, f.kpiee_target, f.explanation, f.confidence, needsConfirm,
        );
        // ロジック化不能項目は顧客確認リストへ自動登録（UC-10）
        if (needsConfirm) {
          await insertQuestion.run(projectId, Number(res.lastInsertRowid),
            `${f.source_ref}: ${f.explanation}（この値・ロジックの出所をご教示ください）`);
        }
      }
    });

    await finishRun(runId, true, undefined, tokens);
    await setProjectStatus(projectId, 'reviewing');
    return { runId, findingCount: findings.length };
  } catch (e) {
    await finishRun(runId, false, String(e));
    await setProjectStatus(projectId, 'draft');
    throw e;
  }
}

/** レポート設定のガード検証（設計書 §6.4）: カスタム数式と値フィルタ演算子の範囲チェック */
function validateReportConfig(config: ReportConfig): string[] {
  const errors: string[] = [];
  const formulaOk = (f: string): boolean => {
    // [指標名] 参照を数値に置き換えた上で、+ - * / ^ 括弧 数値のみで構成されるか検査する
    const stripped = f.replace(/\[[^\]]+\]/g, '1');
    return /^[\d\s+\-*/^().]*$/.test(stripped);
  };
  for (const m of config.metrics) {
    if (m.custom_formula && !formulaOk(m.custom_formula)) {
      errors.push(`カスタム数式が表現可能範囲外です: ${m.custom_formula}（+ - * / ^ 括弧 数値 [指標名] のみ可）`);
    }
  }
  for (const y of config.y_axis) {
    if (y.custom_formula && !formulaOk(y.custom_formula)) {
      errors.push(`計算行の数式が表現可能範囲外です: ${y.custom_formula}`);
    }
  }
  const operators = new Set(['gte', 'lte', 'gt', 'lt', 'eq', 'neq', 'btw', 'nbtw']);
  for (const vf of config.value_filters) {
    if (!operators.has(vf.operator)) {
      errors.push(`値フィルタ演算子が不正です: ${vf.operator}`);
    }
  }
  return errors;
}

/** findings の承認済み内容（修正があれば修正後）を取得する */
async function approvedFindings(projectId: number): Promise<(Finding & { review_status: string })[]> {
  const rows = await db.prepare(
    `SELECT source_ref, formula_raw, logic_type, kpiee_target, explanation, confidence, review_status, modified_content
     FROM findings WHERE project_id = ? AND review_status IN ('approved', 'modified')`,
  ).all(projectId) as Record<string, string>[];
  return rows.map((r, i) => ({
    id: `F${i + 1}`,
    source_ref: r.source_ref,
    formula_raw: r.formula_raw ?? undefined,
    logic_type: r.logic_type as Finding['logic_type'],
    kpiee_target: r.kpiee_target as Finding['kpiee_target'],
    explanation: r.modified_content || r.explanation,
    confidence: r.confidence as Finding['confidence'],
    review_status: r.review_status,
  }));
}

/** P2 生成 + P3 静的検証（NG 時は最大3回まで自動再生成） */
export async function runGenerate(projectId: number): Promise<{ runId: number; version: number; validationOk: boolean }> {
  await setProjectStatus(projectId, 'generating');
  const runId = await startRun(projectId, 'generate');
  try {
    const collections = await collectByRole(projectId);
    const inputs = collections.inputs;
    const assetNames = inputs.map(i => i.tableName);
    const approved = await approvedFindings(projectId);
    if (approved.length === 0) throw new Error('承認済みの解読項目がありません。先に検収（SC-04）を行ってください');

    let generation: GenerationResult | null = null;
    let lastErrors: string[] = [];
    let totalTokens = { input: 0, output: 0 };

    // 試行間で不変の固定プロンプト（指示＋承認済み findings＋原本構造＋スクリプト）は一度だけ組み立てる。
    // callStructured の cachePrefix でこれをキャッシュ対象にし、再生成のエラー指摘だけを suffix で可変にする。
    // これで巨大な <artifacts> ブロックを再試行のたびに再課金せず cache_read（~0.1x）で読める（②コスト削減）。
    const stablePrompt = aiAvailable()
      ? `${generateInstruction(assetNames)}\n\n<approved_findings>\n${JSON.stringify(approved)}\n</approved_findings>\n\n<artifacts>\n${JSON.stringify(
          shapeArtifactsToBudget(collections.artifacts.map(a =>
            ({ parsed: a.parsed, roles: a.roles, kind: a.row.kind, filename: a.row.original_filename }))),
        )}\n</artifacts>${await scriptsBlock(projectId)}`
      : '';

    // P3 検証 NG → エラーをコンテキストへ追加して P2 を再実行（最大 MAX_REGENERATION 回）
    for (let attempt = 1; attempt <= MAX_REGENERATION; attempt++) {
      if (aiAvailable()) {
        const result = await callStructured<GenerationResult>(
          projectId, 'generate', stablePrompt,
          GENERATION_SCHEMA as unknown as Record<string, unknown>,
          { cachePrefix: true, suffix: lastErrors.length > 0 ? `\n\n${regenerateInstruction(lastErrors)}` : undefined },
        );
        generation = result.data;
        totalTokens.input += result.inputTokens;
        totalTokens.output += result.outputTokens;
      } else {
        generation = mockGenerate(inputs, lastErrors.length > 0 ? lastErrors : undefined);
      }

      // P3: SQL 静的検証（query_scanner 移植規則）＋レポート設定ガード
      const scan = scanQuery(generation.sql, assetNames);
      const configErrors = validateReportConfig(generation.report_config);
      lastErrors = [...scan.errors.map(e => `[${e.code}] ${e.message}`), ...configErrors];
      if (lastErrors.length === 0) break;
    }

    if (!generation) throw new Error('生成に失敗しました');
    const validationOk = lastErrors.length === 0;

    // 成果物の保存（version は再生成履歴として加算。設計書 §8）
    const prev = await db.prepare(`SELECT COALESCE(MAX(version), 0) AS v FROM deliverables WHERE project_id = ?`)
      .get(projectId) as { v: number };
    const version = prev.v + 1;

    const decodeReport = await buildDecodeReport(projectId, approved);
    const mappingTable = buildMappingTable(approved, generation.finding_outputs);
    const configTable = buildConfigTable(generation.report_config);

    const validationStatus = validationOk ? 'passed' : 'failed';
    const validationErrors = validationOk ? null : JSON.stringify(lastErrors);
    await db.tx(async t => {
      const insert = t.prepare(`
        INSERT INTO deliverables (project_id, kind, version, content, validation_status, validation_errors)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      await insert.run(projectId, 'decode_report', version, decodeReport, 'passed', null);
      await insert.run(projectId, 'mapping', version, mappingTable, 'passed', null);
      await insert.run(projectId, 'sql', version, generation!.sql, validationStatus, validationErrors);
      await insert.run(projectId, 'master_csv', version, generation!.master_csv, 'passed', null);
      await insert.run(projectId, 'report_config_table', version, configTable, 'passed', null);
      await insert.run(projectId, 'report_config_json', version, JSON.stringify(generation!.report_config, null, 2), validationStatus, validationErrors);
    });

    await finishRun(runId, true, validationOk ? undefined : `検証NG（${MAX_REGENERATION}回試行後）: ${lastErrors.join(' / ')}`, totalTokens);
    return { runId, version, validationOk };
  } catch (e) {
    await finishRun(runId, false, String(e));
    await setProjectStatus(projectId, 'reviewing');
    throw e;
  }
}

/** P4 照合: ローカルシミュレーション実行と帳票との突き合わせ */
export async function runMatch(projectId: number): Promise<{ runId: number; matchRate: number }> {
  await setProjectStatus(projectId, 'matching');
  const runId = await startRun(projectId, 'match');
  try {
    const collections = await collectByRole(projectId);
    const inputs = collections.inputs;
    const finalOutput = collections.finalOutput;
    if (!finalOutput) throw new Error('最終帳票（final_output 役割のシート）が見つかりません');

    const latestSql = await db.prepare(
      `SELECT content, version FROM deliverables WHERE project_id = ? AND kind = 'sql' ORDER BY version DESC LIMIT 1`,
    ).get(projectId) as { content: string; version: number } | undefined;
    if (!latestSql) throw new Error('生成済み SQL がありません。先に成果物生成を実行してください');

    const outcome = await matchAgainstFinalOutput(inputs, latestSql.content, finalOutput);

    await db.prepare(`
      INSERT INTO match_results (project_id, deliverable_version, total_cells, matched_cells, mismatches)
      VALUES (?, ?, ?, ?, ?)
    `).run(projectId, latestSql.version, outcome.totalCells, outcome.matchedCells, JSON.stringify(outcome.mismatches));

    await finishRun(runId, true);
    await setProjectStatus(projectId, 'completed');
    return {
      runId,
      matchRate: outcome.totalCells === 0 ? 0 : outcome.matchedCells / outcome.totalCells,
    };
  } catch (e) {
    await finishRun(runId, false, String(e));
    throw e;
  }
}

/** 解読リポート（Markdown）を組み立てる */
async function buildDecodeReport(projectId: number, findings: Finding[]): Promise<string> {
  const project = await db.prepare(`SELECT customer_name FROM projects WHERE id = ?`).get(projectId) as { customer_name: string };
  const lines = [
    `# 解読リポート — ${project.customer_name}`,
    '',
    `承認済み解読項目: ${findings.length} 件`,
    '',
  ];
  for (const f of findings) {
    lines.push(`## ${f.id}: ${f.source_ref}`);
    if (f.formula_raw) lines.push(`- 数式: \`${f.formula_raw}\``);
    lines.push(`- ロジック種別: ${f.logic_type}`);
    lines.push(`- KPIEE マッピング: ${f.kpiee_target}`);
    lines.push(`- 説明: ${f.explanation}`);
    lines.push(`- 確信度: ${f.confidence}`);
    lines.push('');
  }
  return lines.join('\n');
}

/** マッピング表（Markdown テーブル）を組み立てる */
function buildMappingTable(findings: Finding[], findingOutputs?: { finding_id: number; output: string }[]): string {
  // 「この項目が最終成果物のどこになったか」を人が追跡できるように、生成結果の finding_outputs を対応付ける
  const outputOf = new Map((findingOutputs ?? []).map(o => [o.finding_id, o.output]));
  const lines = [
    '| # | シート要素（元の場所） | 数式 | ロジック種別 | KPIEE 機能 | → 最終成果物での反映先 | 説明 |',
    '|---|---|---|---|---|---|---|',
  ];
  for (const f of findings) {
    lines.push(`| ${f.id} | ${f.source_ref} | ${f.formula_raw ?? ''} | ${f.logic_type} | ${f.kpiee_target} | ${(outputOf.get(Number(f.id)) ?? '—').replace(/\|/g, '\\|')} | ${f.explanation.replace(/\|/g, '\\|')} |`);
  }
  return lines.join('\n');
}

/** 人間用のレポート設定表（Markdown）を組み立てる（設計書 §6.4 (a)） */
function buildConfigTable(config: ReportConfig): string {
  const lines = [
    `# レポート設定表: ${config.report_name}`,
    '',
    `| 設定項目 | 値 |`,
    `|---|---|`,
    `| X軸 | ${config.x_axis.type}（${config.x_axis.label}） |`,
    ...config.y_axis.map((y, i) => `| Y軸${i + 1} | ${y.type}（${y.label}）${y.custom_formula ? ` 数式: ${y.custom_formula}` : ''} |`),
    ...config.metrics.map(m => `| 指標: ${m.name} | ${m.source_column} の ${m.aggregation}${m.custom_formula ? ` / 数式: ${m.custom_formula}` : ''} |`),
    ...config.value_filters.map(vf => `| 値フィルタ | ${vf.column} ${vf.operator} ${vf.value} |`),
  ];
  return lines.join('\n');
}

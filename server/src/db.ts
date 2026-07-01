// データモデル定義（設計書 §8 準拠）。
// ローカル動作のため MySQL の代わりに SQLite を採用。スキーマ構造は設計書と同一。
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.resolve(__dirname, '../data');
mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(path.join(DATA_DIR, 'app.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_name TEXT NOT NULL,
  description TEXT DEFAULT '',
  -- 進行ステータス: draft → analyzing → reviewing → generating → matching → completed
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  -- 種別: input_data（インプットデータ）/ final_output（最終帳票）/ working_sheet（中間スプレッドシート）
  kind TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  parsed_key TEXT,
  parse_status TEXT NOT NULL DEFAULT 'pending',
  parse_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS analysis_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  -- パイプライン段階: decode（P1解読）/ generate（P2生成）/ validate（P3静的検証）/ match（P4数値照合）/ package（P5パッケージング）
  stage TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  model TEXT,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  error TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  analysis_run_id INTEGER NOT NULL REFERENCES analysis_runs(id),
  project_id INTEGER NOT NULL REFERENCES projects(id),
  source_ref TEXT NOT NULL,
  formula_raw TEXT,
  logic_type TEXT NOT NULL,
  kpiee_target TEXT NOT NULL,
  explanation TEXT NOT NULL,
  confidence TEXT NOT NULL,
  -- レビュー状態: pending / approved / modified / rejected
  review_status TEXT NOT NULL DEFAULT 'pending',
  modified_content TEXT,
  needs_customer_confirmation INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS deliverables (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  -- 種別: decode_report / mapping / sql / master_csv / report_config_table / report_config_json
  kind TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  content TEXT NOT NULL,
  validation_status TEXT DEFAULT 'pending',
  validation_errors TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS match_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  deliverable_version INTEGER NOT NULL,
  total_cells INTEGER NOT NULL,
  matched_cells INTEGER NOT NULL,
  -- 不一致リスト: [{cell_ref, expected, actual, cause_category}] の JSON
  mismatches TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS customer_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  finding_id INTEGER REFERENCES findings(id),
  question TEXT NOT NULL,
  -- 状態: open / waiting / resolved
  status TEXT NOT NULL DEFAULT 'open',
  customer_answer TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS project_scripts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  -- Apps Script（.gs）等、xlsx に保存されないシート変換ロジックの原文
  name TEXT NOT NULL DEFAULT '',
  code TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS project_overviews (
  -- 全体構造の自然言語サマリ（decode 実行時に生成）。プロジェクトごとに最新1件のみ保持。
  project_id INTEGER PRIMARY KEY REFERENCES projects(id),
  content TEXT NOT NULL,  -- StructureOverview の JSON
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ai_usage_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER REFERENCES projects(id),
  stage TEXT,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chat_messages (
  -- 解読済みシートに対する運用担当者との対話Q&A履歴（プロジェクト単位の単一スレッド）。
  -- role=user/assistant。assistant メッセージはツール呼び出しでセル単位の根拠を辿った結果を含む。
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  -- AI がこの応答で辿ったツール呼び出しの記録（[{tool, input, summary}] の JSON）。根拠提示・監査用。
  tool_trace TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// 混在ファイル対応（シート単位の役割）: 既存 DB への後方互換マイグレーション。
// sheet_roles はシート名 → 役割（input_data / working_sheet / final_output / unknown）の JSON。
// NULL の場合はアーティファクトの kind を全シートに適用する（従来動作）。
try {
  db.exec(`ALTER TABLE artifacts ADD COLUMN sheet_roles TEXT`);
} catch {
  // カラムが既に存在する場合は何もしない
}

// 起動時の孤児ジョブ掃除: サーバー再起動で取り残された running 実行を failed に倒し、
// 進行中だったプロジェクトを実行前の安定状態へ戻す（⏳ が永久に残るのを防ぐ）。
{
  const orphans = db.prepare(
    `SELECT DISTINCT project_id, stage FROM analysis_runs WHERE status = 'running'`,
  ).all() as { project_id: number; stage: string }[];
  db.prepare(
    `UPDATE analysis_runs SET status = 'failed', error = 'サーバー再起動により中断されました', finished_at = datetime('now') WHERE status = 'running'`,
  ).run();
  const revertTo: Record<string, string> = { decode: 'draft', generate: 'reviewing', match: 'generating' };
  for (const o of orphans) {
    db.prepare(`UPDATE projects SET status = ? WHERE id = ?`).run(revertTo[o.stage] ?? 'draft', o.project_id);
  }
  if (orphans.length > 0) console.log(`[kpiee-onboarding-ai] 中断された実行を ${orphans.length} 件クリーンアップしました`);
}

export type ProjectStatus =
  | 'draft' | 'analyzing' | 'reviewing' | 'generating' | 'matching' | 'completed';

export function setProjectStatus(projectId: number, status: ProjectStatus): void {
  db.prepare('UPDATE projects SET status = ? WHERE id = ?').run(status, projectId);
}

export interface ProjectUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  request_count: number;
  by_stage: { stage: string; input_tokens: number; output_tokens: number; request_count: number }[];
}

/** プロジェクト単位の AI トークン使用量を ai_usage_logs から集計する（段階別内訳付き） */
export function getProjectUsage(projectId: number): ProjectUsage {
  const total = db.prepare(`
    SELECT
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(cache_read_input_tokens), 0) AS cache_read_tokens,
      COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_tokens,
      COUNT(*) AS request_count
    FROM ai_usage_logs WHERE project_id = ?
  `).get(projectId) as Omit<ProjectUsage, 'by_stage'>;
  const by_stage = db.prepare(`
    SELECT stage,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COUNT(*) AS request_count
    FROM ai_usage_logs WHERE project_id = ? GROUP BY stage ORDER BY stage
  `).all(projectId) as ProjectUsage['by_stage'];
  return { ...total, by_stage };
}

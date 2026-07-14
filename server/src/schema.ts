// スキーマ定義（設計書 §8）。SQLite / Postgres 両対応の DDL をドライバに応じて生成する。
// 方言差の吸収ポイント:
//   - 主キー自動採番:   SQLite = INTEGER PRIMARY KEY AUTOINCREMENT / pg = SERIAL PRIMARY KEY
//   - 作成日時デフォルト: SQLite = TEXT DEFAULT (datetime('now')) / pg = TIMESTAMPTZ DEFAULT now()
// これ以外の型（TEXT/INTEGER）と参照制約は両者共通。
import type { Db } from './database.js';

export async function initSchema(db: Db): Promise<void> {
  const isPg = db.driver === 'pg';
  const pk = isPg ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  const ts = isPg ? 'TIMESTAMPTZ NOT NULL DEFAULT now()' : "TEXT NOT NULL DEFAULT (datetime('now'))";
  const tsNull = isPg ? 'TIMESTAMPTZ' : 'TEXT'; // 既定なし・NULL 許容の日時

  await db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  id ${pk},
  customer_name TEXT NOT NULL,
  description TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',
  created_at ${ts}
);

CREATE TABLE IF NOT EXISTS artifacts (
  id ${pk},
  project_id INTEGER NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  parsed_key TEXT,
  parse_status TEXT NOT NULL DEFAULT 'pending',
  parse_error TEXT,
  sheet_roles TEXT,
  created_at ${ts}
);

CREATE TABLE IF NOT EXISTS analysis_runs (
  id ${pk},
  project_id INTEGER NOT NULL REFERENCES projects(id),
  stage TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  model TEXT,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  error TEXT,
  started_at ${ts},
  finished_at ${tsNull}
);

CREATE TABLE IF NOT EXISTS findings (
  id ${pk},
  analysis_run_id INTEGER NOT NULL REFERENCES analysis_runs(id),
  project_id INTEGER NOT NULL REFERENCES projects(id),
  source_ref TEXT NOT NULL,
  formula_raw TEXT,
  logic_type TEXT NOT NULL,
  kpiee_target TEXT NOT NULL,
  explanation TEXT NOT NULL,
  confidence TEXT NOT NULL,
  review_status TEXT NOT NULL DEFAULT 'pending',
  modified_content TEXT,
  needs_customer_confirmation INTEGER NOT NULL DEFAULT 0,
  created_at ${ts}
);

CREATE TABLE IF NOT EXISTS deliverables (
  id ${pk},
  project_id INTEGER NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  content TEXT NOT NULL,
  validation_status TEXT DEFAULT 'pending',
  validation_errors TEXT,
  created_at ${ts}
);

CREATE TABLE IF NOT EXISTS match_results (
  id ${pk},
  project_id INTEGER NOT NULL REFERENCES projects(id),
  deliverable_version INTEGER NOT NULL,
  total_cells INTEGER NOT NULL,
  matched_cells INTEGER NOT NULL,
  mismatches TEXT NOT NULL,
  created_at ${ts}
);

CREATE TABLE IF NOT EXISTS customer_questions (
  id ${pk},
  project_id INTEGER NOT NULL REFERENCES projects(id),
  finding_id INTEGER REFERENCES findings(id),
  question TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  customer_answer TEXT,
  created_at ${ts}
);

CREATE TABLE IF NOT EXISTS project_scripts (
  id ${pk},
  project_id INTEGER NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL DEFAULT '',
  code TEXT NOT NULL,
  created_at ${ts}
);

CREATE TABLE IF NOT EXISTS project_overviews (
  project_id INTEGER PRIMARY KEY REFERENCES projects(id),
  content TEXT NOT NULL,
  created_at ${ts}
);

CREATE TABLE IF NOT EXISTS relation_graphs (
  project_id INTEGER PRIMARY KEY REFERENCES projects(id),
  signature TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at ${ts}
);

CREATE TABLE IF NOT EXISTS ai_usage_logs (
  id ${pk},
  project_id INTEGER REFERENCES projects(id),
  stage TEXT,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
  created_at ${ts}
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id ${pk},
  project_id INTEGER NOT NULL REFERENCES projects(id),
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  tool_trace TEXT,
  created_at ${ts}
);
`);
}

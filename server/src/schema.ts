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

-- ブック（ファイル）どうしの関係。運用担当者が「この Excel はあの Excel へ集約されている」という
-- 業務知識を入れる場所で、シート単位の自動解析より上位の入力になる。
-- 自動検出（値の一致による手修正推定）は初期案として提示するだけで、確定するのは人。
-- ファイルの識別は artifact_id（FK）で持つ。関係グラフ側のキーである fileLabelOf(original_filename)
-- はラベルなのでリネームで壊れる。ラベルへの解決は読み出し時に行う。
-- step / step_title / adds は「作成手順」の層。手順書をいただけた案件では、受け渡しが
-- 何番目の作業で、そのとき先のファイルに何が足されるのかまで分かる。レポート 02 の全体関係図を
-- ステップの帯で描くために使う（未入力なら従来どおり流れの段で描く）。
CREATE TABLE IF NOT EXISTS file_relations (
  id ${pk},
  project_id INTEGER NOT NULL REFERENCES projects(id),
  from_artifact_id INTEGER NOT NULL REFERENCES artifacts(id),
  to_artifact_id INTEGER NOT NULL REFERENCES artifacts(id),
  rel_type TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  origin TEXT NOT NULL DEFAULT 'manual',
  step INTEGER,
  step_title TEXT NOT NULL DEFAULT '',
  adds TEXT NOT NULL DEFAULT '',
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

-- 業務資料（要件定義書・運用手順書・引継ぎメモ等）。データそのものではなく「データがどう作られるか」
-- を書いた文書を置く場所。artifacts（xlsx/csv）とは完全に別に持つ:
--   - 関係分析・シート役割判定の対象にしない（構造を持たないので混ぜると判定を汚す）
--   - 一方で内容は AI の解読・提案の前提として効かせたい
-- 例: 「末尾0の組織は局管理の課組織に読み替える。ただし 9970 は読み替えない」のような、
-- 数式からは絶対に読み取れない業務ルールがここに書かれている。
CREATE TABLE IF NOT EXISTS project_docs (
  id ${pk},
  project_id INTEGER NOT NULL REFERENCES projects(id),
  filename TEXT NOT NULL,
  -- 種別。doc=要件定義書・手順書（解読プロンプトに入る）／sql-columns=Redash の物理カラム一覧（SQL構築だけが読む）
  kind TEXT NOT NULL DEFAULT 'doc',
  -- 抽出した本文。抽出できない形式は空になり、その旨を extract_error に残す
  content TEXT NOT NULL DEFAULT '',
  extract_error TEXT,
  byte_size INTEGER NOT NULL DEFAULT 0,
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

-- 画面のステップ完了など「人が確認した」という事実の記録。
-- 例: roles_confirmed（シート分類を人が確定した）。自動分類の結果が入っているだけでは
-- 「人が見た」ことにならないため、自動処理では絶対に立たない印として別に持つ。
-- 取り込み内容が変わったら消し、再確認を促す。
CREATE TABLE IF NOT EXISTS project_flags (
  project_id INTEGER NOT NULL REFERENCES projects(id),
  flag TEXT NOT NULL,
  created_at ${ts},
  PRIMARY KEY (project_id, flag)
);

-- 顧客共有レポートの「何を載せるか」の指定（案件ごとに1件）。
-- 未登録なら既定（全部出す）＝従来と同じ内容になるので、既存プロジェクトは何もしなくてよい。
CREATE TABLE IF NOT EXISTS report_specs (
  project_id INTEGER PRIMARY KEY REFERENCES projects(id),
  spec TEXT NOT NULL,
  created_at ${ts}
);

-- アウトプット相談の会話。解読内容を答える Q&A（chat_messages）とは目的が別なので表を分ける。
-- 同じ表に混ぜると、どちらの履歴もお互いのプロンプトに混入して噛み合わなくなる。
CREATE TABLE IF NOT EXISTS report_chat_messages (
  id ${pk},
  project_id INTEGER NOT NULL REFERENCES projects(id),
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  spec_patch TEXT,
  created_at ${ts}
);

-- SQL構築の会話。目的が別の履歴（Q&A・レポート相談）とは表を分ける（上と同じ理由）。
-- tool_trace には run_sql / save_sql 等の呼び出しと結果の要約を残す。
-- 画面が「AI がどの SQL を流してどんな結果を見たか」を会話に沿って出すために使う。
CREATE TABLE IF NOT EXISTS sql_chat_messages (
  id ${pk},
  project_id INTEGER NOT NULL REFERENCES projects(id),
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  tool_trace TEXT,
  created_at ${ts}
);

-- 物理カラムの対応（SQL構築 ステップ1で人が確定したもの）。
-- Redash クエリ145 の書き出しから初期案を起こし、人が論理名を直して確定する。
-- 確定した対応だけが SQL構築チャットの前提（物理名の根拠）になる。
-- table_name は physical_column の先頭（IMPORT_30016_STRING_1 → IMPORT_30016）だが、
-- 突き合わせ・表示のたびに切り出すのは無駄なので列で持つ。
CREATE TABLE IF NOT EXISTS sql_column_maps (
  id ${pk},
  project_id INTEGER NOT NULL REFERENCES projects(id),
  table_name TEXT NOT NULL DEFAULT '',
  physical_column TEXT NOT NULL,
  logical_name TEXT NOT NULL DEFAULT '',
  asset_name TEXT NOT NULL DEFAULT '',
  -- 原本側の対応（取込済みデータのローカルテーブル・列）。突き合わせの結果を人が確認・修正して持つ。
  -- これが埋まっている行だけ、SQL構築で「原本の列 ↔ 物理名」の橋になる
  local_table TEXT NOT NULL DEFAULT '',
  local_column TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT ''
);

-- 業務資料の自動読み取りの下書き（案件ごとに1件）。
-- 資料を入れたら黙って読み始め、各ステップに着いたときには案ができているようにするための置き場。
-- requirements = 要件（reproduce / roleHints 等）、stepflow = 手順（ブック関係の案）。どちらも JSON。
-- signature は資料＋受領ファイルの構成。変わったら読み直す。
CREATE TABLE IF NOT EXISTS doc_drafts (
  project_id INTEGER PRIMARY KEY REFERENCES projects(id),
  signature TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  requirements TEXT,
  stepflow TEXT,
  -- 読み取り結果を既定値として登録まで済ませたか（0=未適用）。
  -- ステップ3を開かず素通りしても同じレポートが出るように、案では止めず登録までやる。
  -- 人が確定・編集済みのもの（分類の確定印・保存済みの spec・同じ向きの登録）は上書きしない。
  applied INTEGER NOT NULL DEFAULT 0,
  updated_at ${ts}
);

-- 構築した SQLジョブ（1案件に複数本。協和は STEP1〜4 ＋ 統合の5本）。
-- output_spec は出力仕様（順番 → 別名 → 予測物理名 → 原本の列 → 下流での用途）。
-- ジョブ登録で別名は物理名に変わるため、これが無いと下流の担当者が参照名を辿れない。
CREATE TABLE IF NOT EXISTS sql_jobs (
  id ${pk},
  project_id INTEGER NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  sql TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  output_spec TEXT NOT NULL DEFAULT '',
  updated_at ${ts}
);
`);

  // 既存 DB への列追加。CREATE TABLE IF NOT EXISTS は既存テーブルには効かないため、
  // 後から足した列はここで補う（新規 DB では上の DDL で既に存在するので何も起きない）。
  await addColumns(db, 'file_relations', [
    ['step', 'INTEGER'],
    ['step_title', "TEXT NOT NULL DEFAULT ''"],
    ['adds', "TEXT NOT NULL DEFAULT ''"],
  ]);
  // 業務資料の種別。doc=要件定義書・手順書（decode 等の <reference_docs> に入る）／
  // sql-columns=Redash の物理カラム一覧（クエリ145/147 の書き出し。SQL構築チャットだけが読む）。
  // 分けるのは、数百行の物理名 CSV を解読プロンプトへ混ぜても判定を汚すだけのため。
  await addColumns(db, 'project_docs', [
    ['kind', "TEXT NOT NULL DEFAULT 'doc'"],
  ]);
  // 原本側の対応（ローカルテーブル・列）。後から足した列
  await addColumns(db, 'sql_column_maps', [
    ['local_table', "TEXT NOT NULL DEFAULT ''"],
    ['local_column', "TEXT NOT NULL DEFAULT ''"],
  ]);
  await addColumns(db, 'doc_drafts', [
    ['applied', 'INTEGER NOT NULL DEFAULT 0'],
  ]);
}

/**
 * 足りない列だけを ALTER TABLE で追加する。
 * 既存列かどうかの判定は方言差が大きいので、実行して「既にある」系のエラーだけ飲む。
 * それ以外のエラーは投げ直す（起動時に気付けないと、書き込み時に初めて壊れる）。
 */
async function addColumns(db: Db, table: string, cols: [string, string][]): Promise<void> {
  for (const [name, type] of cols) {
    try {
      await db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    } catch (e) {
      const m = String(e).toLowerCase();
      if (m.includes('duplicate column') || m.includes('already exists')) continue;
      throw e;
    }
  }
}

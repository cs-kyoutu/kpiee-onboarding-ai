// データモデルのエントリ。ローカルは SQLite、本番/CI は Postgres（database.ts が env で切替）。
// スキーマ定義は schema.ts、接続・方言吸収（? → $n, RETURNING, tx）は database.ts に分離。
// 既存呼び出しは db.prepare(sql).get/all/run(...) をそのまま使えるが、全て非同期（await 必須）。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { createDb, type Db } from './database.js';
import { initSchema } from './schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '../data');
mkdirSync(DATA_DIR, { recursive: true });

export const db: Db = createDb();

export type ProjectStatus =
  | 'draft' | 'analyzing' | 'reviewing' | 'generating' | 'matching' | 'completed';

/**
 * スキーマ作成 + 起動時の孤児ジョブ掃除。app.listen する前に必ず await する。
 * 孤児掃除: サーバー再起動で取り残された running 実行を failed に倒し、進行中プロジェクトを安定状態へ戻す。
 */
export async function initDb(): Promise<void> {
  await initSchema(db);

  const orphans = await db.prepare(
    `SELECT DISTINCT project_id, stage FROM analysis_runs WHERE status = 'running'`,
  ).all<{ project_id: number; stage: string }>();
  await db.prepare(
    `UPDATE analysis_runs SET status = 'failed', error = ?, finished_at = ? WHERE status = 'running'`,
  ).run('サーバー再起動により中断されました', new Date().toISOString());
  const revertTo: Record<string, string> = { decode: 'draft', generate: 'reviewing', match: 'generating' };
  for (const o of orphans) {
    await db.prepare(`UPDATE projects SET status = ? WHERE id = ?`).run(revertTo[o.stage] ?? 'draft', o.project_id);
  }
  if (orphans.length > 0) console.log(`[kpiee-onboarding-ai] 中断された実行を ${orphans.length} 件クリーンアップしました`);
}

export async function setProjectStatus(projectId: number, status: ProjectStatus): Promise<void> {
  await db.prepare('UPDATE projects SET status = ? WHERE id = ?').run(status, projectId);
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
export async function getProjectUsage(projectId: number): Promise<ProjectUsage> {
  const total = await db.prepare(`
    SELECT
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(cache_read_input_tokens), 0) AS cache_read_tokens,
      COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_tokens,
      COUNT(*) AS request_count
    FROM ai_usage_logs WHERE project_id = ?
  `).get<Omit<ProjectUsage, 'by_stage'>>(projectId);
  const by_stage = await db.prepare(`
    SELECT stage,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COUNT(*) AS request_count
    FROM ai_usage_logs WHERE project_id = ? GROUP BY stage ORDER BY stage
  `).all<ProjectUsage['by_stage'][number]>(projectId);
  return { ...(total as Omit<ProjectUsage, 'by_stage'>), by_stage };
}

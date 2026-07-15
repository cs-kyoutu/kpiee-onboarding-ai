// シート関係グラフの永続キャッシュ。
//
// 関係グラフは「完成した派生結果物」であり、原本の数値そのものは含まない（辺の evidence は数式テキスト、
// 手コピー辺は一致件数、region は見出し・構造のみ）。findings / match_results と同じ「保存してよい派生結果」
// の等級なので DB に保存し、次回以降はアーティファクト集合が変わらない限り再計算せず即返す。
// 原本そのもの（raw バイト・全構造化 JSON）は保存しない方針（C3/C5）は不変で、キャッシュミス時に
// analyzeArtifacts が都度 Drive から取り直す。
import crypto from 'node:crypto';
import { db } from './db.js';
import type { RelationGraph } from './preprocess/relations.js';

export interface CacheableArtifact { id: number; storage_key: string; original_filename: string }

/** 解析ロジックの版。relations.ts の判定（警告・辺・領域）を変えたら +1 して旧キャッシュを自然失効させる */
const ANALYZER_VERSION = 2;

/**
 * アーティファクト集合の署名。追加・削除・再取込（storage_key 変化）に加え、
 * 解析ロジックの版（ANALYZER_VERSION）も含めるため、判定変更後は旧キャッシュが自動で無効になる。
 * 同じ集合なら同じ署名になるよう、正規化してソートしてからハッシュする。
 * 明示的な無効化（invalidateRelationGraph）と二重の安全網として働く。
 */
export function artifactSetSignature(arts: CacheableArtifact[]): string {
  const norm = arts
    .map(a => `${a.id}:${a.storage_key}:${a.original_filename}`)
    .sort()
    .join('|');
  return crypto.createHash('sha1').update(`v${ANALYZER_VERSION}|${norm}`).digest('hex');
}

/** 保存済み関係グラフを返す（署名一致時のみ。無い/古い/壊れている場合は null で再計算に回す）。 */
export async function getCachedRelationGraph(projectId: number, signature: string): Promise<RelationGraph | null> {
  const row = await db.prepare(`SELECT signature, content FROM relation_graphs WHERE project_id = ?`)
    .get(projectId) as { signature: string; content: string } | undefined;
  if (!row || row.signature !== signature) return null;
  try { return JSON.parse(row.content) as RelationGraph; } catch { return null; }
}

/** 関係グラフを project 単位で upsert 保存する。 */
export async function setCachedRelationGraph(projectId: number, signature: string, graph: RelationGraph): Promise<void> {
  await db.prepare(
    // INSERT OR REPLACE 相当を ON CONFLICT で（pg/sqlite 双方対応）。project_overviews と同じ形。
    `INSERT INTO relation_graphs (project_id, signature, content, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (project_id) DO UPDATE SET signature = EXCLUDED.signature, content = EXCLUDED.content, created_at = EXCLUDED.created_at`,
  ).run(projectId, signature, JSON.stringify(graph), new Date().toISOString());
}

/** 保存済み関係グラフを破棄する（アーティファクト変更時に呼ぶ）。 */
export async function invalidateRelationGraph(projectId: number): Promise<void> {
  await db.prepare(`DELETE FROM relation_graphs WHERE project_id = ?`).run(projectId);
}

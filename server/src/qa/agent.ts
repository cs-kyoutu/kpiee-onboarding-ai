// Q&A エージェント本体。
// 解読済みプロジェクトに対し、運用担当者の自由質問へセル単位の根拠付きで答える。
//
// コンテキスト戦略（重要）:
//  - 常時投入するのは「軽量な構造サマリ（StructureOverview）＋シート地図」のみ。
//  - 6万を超える数式セルはプロンプトに載せず、tools.ts のドリルダウン道具で都度取得させる。
//  - これにより、正確（セル単位の根拠）かつ低トークンな応答を両立する。
import { db } from '../db.js';
import { getJson } from '../storage.js';
import { aiAvailable, callWithTools } from '../ai/client.js';
import { QA_TOOL_DEFS, runQaTool } from './tools.js';
import type { StructureOverview } from '../ai/schemas.js';

interface ChatRow { role: 'user' | 'assistant'; content: string }

/** プロジェクトの会話履歴を取得する（古い順・表示用） */
export function getHistory(projectId: number): (ChatRow & { id: number; tool_trace: string | null; created_at: string })[] {
  return db.prepare(
    `SELECT id, role, content, tool_trace, created_at FROM chat_messages WHERE project_id = ? ORDER BY id`,
  ).all(projectId) as (ChatRow & { id: number; tool_trace: string | null; created_at: string })[];
}

/** 構造サマリ＋解読項目をシステムプロンプト用テキストに組み立てる */
function buildSystemText(projectId: number): string {
  const ov = db.prepare(`SELECT content FROM project_overviews WHERE project_id = ?`)
    .get(projectId) as { content: string } | undefined;
  const overview: StructureOverview | null = ov ? JSON.parse(ov.content) : null;

  const findings = db.prepare(
    `SELECT source_ref, logic_type, kpiee_target, explanation FROM findings WHERE project_id = ? LIMIT 200`,
  ).all(projectId) as { source_ref: string; logic_type: string; kpiee_target: string; explanation: string }[];

  return [
    'あなたは顧客の Excel/スプレッドシート（業績管理表など）の構造を熟知した解析アシスタントです。',
    '運用担当者の質問に、推測ではなく「実セルの値・数式」に基づいて日本語で簡潔に答えてください。',
    '数式の出所を問われたら trace_formula で 3-D 参照（top:end! 形式＝タブ並び順の合算）まで辿り、',
    'どのシート・どのセルからどう積み上がったかを段階的に示すこと。シート名や行の意味が曖昧なときは',
    'get_sheet_map / find_rows で必ず確認してから答えること。確証が無い点は「未確認」と明記する。',
    '回答は平易な文章で。装飾記号（** や # など）の多用は避け、強調は要所のみに留めること。',
    '',
    '## 解読済みの全体構造サマリ',
    overview ? JSON.stringify(overview, null, 2) : '（未解読。まず decode を実行してください）',
    '',
    '## 主な解読項目（抜粋）',
    findings.length ? JSON.stringify(findings) : '（なし）',
  ].join('\n');
}

export interface AskResult { answer: string; trace: { tool: string; input: Record<string, unknown> }[] }

/** 質問を1件処理し、回答と利用ツール記録を永続化して返す */
export async function ask(projectId: number, question: string): Promise<AskResult> {
  // ユーザー発話を先に記録
  db.prepare(`INSERT INTO chat_messages (project_id, role, content) VALUES (?, 'user', ?)`).run(projectId, question);

  if (!aiAvailable()) {
    const answer = '（モックモード: ANTHROPIC_API_KEY 未設定のため実回答はできません。サーバーに API キーを設定してください）';
    db.prepare(`INSERT INTO chat_messages (project_id, role, content) VALUES (?, 'assistant', ?)`).run(projectId, answer);
    return { answer, trace: [] };
  }

  const history = getHistoryForModel(projectId);
  const result = await callWithTools(
    projectId, buildSystemText(projectId), history, QA_TOOL_DEFS as unknown as Parameters<typeof callWithTools>[3],
    call => runQaTool(projectId, call.name, call.input),
  );

  db.prepare(`INSERT INTO chat_messages (project_id, role, content, tool_trace) VALUES (?, 'assistant', ?, ?)`)
    .run(projectId, result.text, JSON.stringify(result.trace));
  return { answer: result.text, trace: result.trace };
}

/** モデルへ渡す会話履歴（純テキストの user/assistant 交互列。末尾は今記録した user 質問） */
function getHistoryForModel(projectId: number): { role: 'user' | 'assistant'; content: string }[] {
  return db.prepare(
    `SELECT role, content FROM chat_messages WHERE project_id = ? ORDER BY id`,
  ).all(projectId) as { role: 'user' | 'assistant'; content: string }[];
}

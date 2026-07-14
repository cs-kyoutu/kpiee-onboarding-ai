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
import { QA_TOOL_DEFS, runQaTool, invalidateBooks } from './tools.js';
import type { StructureOverview } from '../ai/schemas.js';

interface ChatRow { role: 'user' | 'assistant'; content: string }

/** プロジェクトの会話履歴を取得する（古い順・表示用） */
export async function getHistory(projectId: number): Promise<(ChatRow & { id: number; tool_trace: string | null; created_at: string })[]> {
  return await db.prepare(
    `SELECT id, role, content, tool_trace, created_at FROM chat_messages WHERE project_id = ? ORDER BY id`,
  ).all(projectId) as (ChatRow & { id: number; tool_trace: string | null; created_at: string })[];
}

/** 構造サマリ＋解読項目をシステムプロンプト用テキストに組み立てる */
async function buildSystemText(projectId: number): Promise<string> {
  const ov = await db.prepare(`SELECT content FROM project_overviews WHERE project_id = ?`)
    .get(projectId) as { content: string } | undefined;
  const overview: StructureOverview | null = ov ? JSON.parse(ov.content) : null;

  const findings = await db.prepare(
    `SELECT source_ref, logic_type, kpiee_target, explanation FROM findings WHERE project_id = ? LIMIT 200`,
  ).all(projectId) as { source_ref: string; logic_type: string; kpiee_target: string; explanation: string }[];

  return [
    'あなたは顧客の Excel/スプレッドシート（業績管理表など）の構造を熟知した解析アシスタントです。',
    '運用担当者の質問に日本語で簡潔に答えてください。',
    '',
    '## 回答方針（最初に必ず判断すること）',
    '質問が「構造レベル」か「セルレベル」かをまず見極め、使い分けること:',
    '- 構造レベル（全体像・処理の流れ・シートの役割・どのシートに何があるか・ロジックの種類など）は、',
    '  下の構造サマリと解読項目から直接答える。**ドリルダウン道具は呼ばない**（呼ぶだけ遅く・高くなる）。',
    '- セルレベル（特定セルの値・数式の中身・「この数値はどこから来たか」の出所追跡・行/列の実データ確認）',
    '  のときだけ道具を使う。その場合も必要最小限の呼び出しに絞り、同じ情報を重複取得しない。',
    '- 構造サマリで答えつつ一部だけ実セル確認が要る質問は、まずサマリで骨子を答え、確認が要る箇所だけ道具で検証する。',
    '',
    'セルレベルの回答は推測ではなく「実セルの値・数式」に基づくこと。',
    '数式の出所を問われたら trace_formula で 3-D 参照（top:end! 形式＝タブ並び順の合算）まで辿り、',
    'どのシート・どのセルからどう積み上がったかを段階的に示すこと。シート名や行の意味が曖昧なときは',
    'get_sheet_map / find_rows で確認してから答えること。確証が無い点は「未確認」と明記する。',
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

// 処理中プロジェクトの集合。ALB のアイドルタイムアウト（60秒）内に応答を返すため、
// 質問処理は同期レスポンスでなくバックグラウンドで行い、フロントは GET /chat をポーリングして
// 完了（assistant メッセージ追記）を検知する。この集合は「処理中か」の表示用。
const pendingProjects = new Set<number>();
export function isAskPending(projectId: number): boolean {
  return pendingProjects.has(projectId);
}

/**
 * 質問を受け付け、バックグラウンドで処理を開始する（即 return）。
 * ツールループは数分かかることがあり、同期レスポンスだと ALB/プロキシのタイムアウトで
 * 「Request timed out」になるため、回答は chat_messages への追記で届ける。
 * 失敗時もエラー内容を assistant メッセージとして残す（ポーリング側が終端を検知できるように）。
 */
export async function startAsk(projectId: number, question: string): Promise<{ pending: boolean }> {
  if (pendingProjects.has(projectId)) {
    throw new Error('前の質問を処理中です。回答が表示されてから次の質問を送ってください');
  }
  // ユーザー発話を先に記録（ポーリングで即表示される）
  await db.prepare(`INSERT INTO chat_messages (project_id, role, content) VALUES (?, 'user', ?)`).run(projectId, question);

  if (!aiAvailable()) {
    const answer = '（モックモード: ANTHROPIC_API_KEY 未設定のため実回答はできません。サーバーに API キーを設定してください）';
    await db.prepare(`INSERT INTO chat_messages (project_id, role, content) VALUES (?, 'assistant', ?)`).run(projectId, answer);
    return { pending: false };
  }

  pendingProjects.add(projectId);
  void (async () => {
    try {
      const history = await getHistoryForModel(projectId);
      const result = await callWithTools(
        projectId, await buildSystemText(projectId), history, QA_TOOL_DEFS as unknown as Parameters<typeof callWithTools>[3],
        call => runQaTool(projectId, call.name, call.input),
      );
      await db.prepare(`INSERT INTO chat_messages (project_id, role, content, tool_trace) VALUES (?, 'assistant', ?, ?)`)
        .run(projectId, result.text, JSON.stringify(result.trace));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await db.prepare(`INSERT INTO chat_messages (project_id, role, content) VALUES (?, 'assistant', ?)`)
        .run(projectId, `（回答の生成中にエラーが発生しました: ${msg}。もう一度お試しください）`).catch(() => {});
    } finally {
      pendingProjects.delete(projectId);
      // 無保存モードでは、ドリルダウンで読み込んだワークブック（原本相当）をこの質問の処理終了時に破棄する。
      // ターン内の複数ツール呼び出しではキャッシュを共有し、ターンをまたいでは保持しない（デプロイ設計 C5）。
      if (process.env.ARTIFACT_EPHEMERAL === '1') invalidateBooks(projectId);
    }
  })();
  return { pending: true };
}

/** モデルへ渡す会話履歴（純テキストの user/assistant 交互列。末尾は今記録した user 質問） */
async function getHistoryForModel(projectId: number): Promise<{ role: 'user' | 'assistant'; content: string }[]> {
  return await db.prepare(
    `SELECT role, content FROM chat_messages WHERE project_id = ? ORDER BY id`,
  ).all(projectId) as { role: 'user' | 'assistant'; content: string }[];
}

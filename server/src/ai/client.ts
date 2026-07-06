// Anthropic Claude API クライアント（設計書 §7.1）。
// - モデル: claude-opus-4-8（数式解読・SQL生成は高難度推論のため）
// - thinking: adaptive（複雑な数式チェーン追跡に必須）
// - 構造化出力: output_config.format（json_schema）でパースエラー排除
// - ストリーミング: 長時間処理のタイムアウト回避（finalMessage で完全な応答を取得）
// - プロンプトキャッシュ: 固定の制約プロンプトに cache_control を付与
// - 使用量: usage を ai_usage_logs へ記録（§7.5 トークン・コスト管理）
//
// ANTHROPIC_API_KEY 未設定時はモック実装へフォールバックし、ローカルで全フローを動作確認できる。
import Anthropic from '@anthropic-ai/sdk';
import { db } from '../db.js';
import { KPIEE_CONSTRAINTS } from './prompts.js';

export const MODEL = 'claude-opus-4-8';

// claude-opus-4-8 の単価（per 1M tokens）: 入力 $5 / 出力 $25 / キャッシュ読取 ~$0.5
export const PRICING = { input: 5, output: 25, cacheRead: 0.5 };

/** トークン使用量から概算コスト（USD）を求める */
export function estimateCostUsd(u: {
  input_tokens: number; output_tokens: number; cache_read_tokens?: number;
}): number {
  return (
    Number(u.input_tokens) * PRICING.input +
    Number(u.output_tokens) * PRICING.output +
    Number(u.cache_read_tokens ?? 0) * PRICING.cacheRead
  ) / 1_000_000;
}

export function aiAvailable(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

const client = aiAvailable() ? new Anthropic() : null;

// prepare は同期（遅延コンパイル）。実行(.run)は非同期なので呼び出し側で await する。
const insertUsage = db.prepare(`
  INSERT INTO ai_usage_logs
    (project_id, stage, model, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

export interface StructuredCallResult<T> {
  data: T;
  inputTokens: number;
  outputTokens: number;
}

/**
 * 構造化出力付きで Claude を1回呼び出す。
 * @param projectId 使用量記録用のプロジェクトID
 * @param stage パイプライン段階名（記録用）
 * @param userContent ユーザーメッセージ（タスク指示＋データ）
 * @param schema JSON Schema（output_config.format で強制）
 */
export async function callStructured<T>(
  projectId: number,
  stage: string,
  userContent: string,
  schema: Record<string, unknown>,
): Promise<StructuredCallResult<T>> {
  if (!client) throw new Error('ANTHROPIC_API_KEY が未設定です（モックモードを使用してください）');

  // 長時間処理になり得るためストリーミングで呼び出し、finalMessage で完全な応答を得る
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 64000,
    thinking: { type: 'adaptive' },
    output_config: {
      effort: 'high',
      format: { type: 'json_schema', schema },
    },
    system: [
      {
        type: 'text',
        text: KPIEE_CONSTRAINTS,
        // 固定の制約プロンプトはプロジェクト内の多段呼び出しで再利用されるためキャッシュする
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content: userContent }],
  });

  const message = await stream.finalMessage();

  await insertUsage.run(
    projectId,
    stage,
    MODEL,
    message.usage.input_tokens,
    message.usage.output_tokens,
    message.usage.cache_read_input_tokens ?? 0,
    message.usage.cache_creation_input_tokens ?? 0,
  );

  // stop_reason ハンドリング（設計書 §9.3）
  if (message.stop_reason === 'refusal') {
    throw new Error('AI が安全上の理由で応答を拒否しました。管理者に連絡してください');
  }
  if (message.stop_reason === 'max_tokens') {
    throw new Error('AI 応答がトークン上限に達しました。入力を分割して再実行してください');
  }

  const text = message.content.find(b => b.type === 'text');
  if (!text || text.type !== 'text') throw new Error('AI 応答にテキストが含まれていません');

  return {
    data: JSON.parse(text.text) as T,
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
  };
}

export interface ToolDef { name: string; description: string; input_schema: Record<string, unknown> }
export interface ToolCall { id: string; name: string; input: Record<string, unknown> }
export interface ToolRunner { (call: ToolCall): Promise<unknown> }

export interface ToolLoopResult {
  text: string;
  trace: { tool: string; input: Record<string, unknown> }[];
  inputTokens: number;
  outputTokens: number;
}

/**
 * ツール利用ループで Claude を呼び出す（Q&A エージェント用）。
 * モデルが tool_use を返す限りツールを実行して tool_result を返し、最終テキストを得る。
 * @param systemText システムプロンプト（解読サマリ等を含む）
 * @param history これまでの会話（user/assistant の純テキスト）
 * @param tools ツール定義
 * @param runner tool_use を受け取り結果を返す実行関数
 */
export async function callWithTools(
  projectId: number,
  systemText: string,
  history: { role: 'user' | 'assistant'; content: string }[],
  tools: ToolDef[],
  runner: ToolRunner,
  maxTurns = 12,
): Promise<ToolLoopResult> {
  if (!client) throw new Error('ANTHROPIC_API_KEY が未設定です（モックモードを使用してください）');

  const messages: Anthropic.MessageParam[] = history.map(h => ({ role: h.role, content: h.content }));
  const trace: { tool: string; input: Record<string, unknown> }[] = [];
  let inTok = 0, outTok = 0;

  for (let turn = 0; turn < maxTurns; turn++) {
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      system: [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }],
      tools: tools as unknown as Anthropic.Tool[],
      messages,
    });
    const msg = await stream.finalMessage();
    inTok += msg.usage.input_tokens; outTok += msg.usage.output_tokens;
    await insertUsage.run(projectId, 'qa', MODEL, msg.usage.input_tokens, msg.usage.output_tokens,
      msg.usage.cache_read_input_tokens ?? 0, msg.usage.cache_creation_input_tokens ?? 0);

    if (msg.stop_reason === 'refusal') throw new Error('AI が安全上の理由で応答を拒否しました');

    const toolUses = msg.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (toolUses.length === 0) {
      const text = msg.content.filter(b => b.type === 'text').map(b => (b as Anthropic.TextBlock).text).join('\n').trim();
      return { text, trace, inputTokens: inTok, outputTokens: outTok };
    }

    // tool_use を実行し、tool_result をまとめて返す
    messages.push({ role: 'assistant', content: msg.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      trace.push({ tool: tu.name, input: tu.input as Record<string, unknown> });
      let out: unknown;
      try { out = await runner({ id: tu.id, name: tu.name, input: tu.input as Record<string, unknown> }); }
      catch (e) { out = { error: e instanceof Error ? e.message : String(e) }; }
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(out) });
    }
    messages.push({ role: 'user', content: results });
  }
  return { text: '（ツール呼び出しが上限に達しました。質問を具体化して再度お試しください）', trace, inputTokens: inTok, outputTokens: outTok };
}

/** 事前コスト見積（§7.5）: count_tokens API で入力トークン数を見積もる */
export async function estimateInputTokens(userContent: string): Promise<number | null> {
  if (!client) return null;
  const res = await client.messages.countTokens({
    model: MODEL,
    system: KPIEE_CONSTRAINTS,
    messages: [{ role: 'user', content: userContent }],
  });
  return res.input_tokens;
}

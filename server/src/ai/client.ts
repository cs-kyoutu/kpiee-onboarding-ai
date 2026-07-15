// Anthropic Claude API クライアント（設計書 §7.1）。
// - モデル: claude-sonnet-5（コスト重視。opus 比 約40%減で、コーディング・エージェント作業は Opus 級。
//   解読・生成の品質は match（照合）一致率で確認し、不足なら claude-opus-4-8 へ戻す）
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

export const MODEL = 'claude-sonnet-5';

// claude-sonnet-5 の単価（per 1M tokens）: 入力 $3 / 出力 $15 / キャッシュ読取 ~$0.3
// （2026-08-31 まで導入価格 $2/$10 だが、控えめに見積もるため標準価格で計上する。
//   注意: /usage のコスト概算は現行 PRICING で全履歴を再計算するため、opus 時代の過去分は不正確になる）
export const PRICING = { input: 3, output: 15, cacheRead: 0.3 };

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

// timeout: SDK 既定（10分）だと thinking 付きの長い応答やイベントループ渋滞時に
// 「Request timed out.」で Q&A が落ちるため 15 分へ延長。maxRetries は SDK の自動再試行
//（接続エラー・429/5xx、ストリーム開始前のみ）で、開始後の失敗は下の withTransientRetry が拾う。
const client = aiAvailable() ? new Anthropic({ timeout: 15 * 60 * 1000, maxRetries: 3 }) : null;

/** 一時的な接続・過負荷エラーか（呼び直しで回復が見込めるもの） */
function isTransientAiError(e: unknown): boolean {
  if (e instanceof Anthropic.APIConnectionError) return true; // タイムアウト含む
  if (e instanceof Anthropic.APIError) {
    const s = Number(e.status ?? 0);
    return s === 429 || s === 500 || s === 502 || s === 503 || s === 504 || s === 529;
  }
  return false;
}

/**
 * 一時エラーに限り指数バックオフで呼び直す。
 * Q&A のツールループ等で 1 ターンだけ落ちた場合に、ループ全体（＝それまでのツール結果）を
 * 捨てずにそのターンだけやり直すための包み。恒久エラー（400 系・refusal 等）は即座に投げ直す。
 */
async function withTransientRetry<T>(label: string, fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!isTransientAiError(e) || i === attempts) throw e;
      const waitMs = 2000 * i * i; // 2s → 8s
      console.warn(`[ai:${label}] 一時エラー（${i}/${attempts}）: ${e instanceof Error ? e.message : String(e)} — ${waitMs}ms 後に再試行`);
      await new Promise(r => setTimeout(r, waitMs));
    }
  }
  throw lastErr;
}

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
  // cachePrefix=true のとき userContent を「試行間で不変のキャッシュ対象ブロック」として扱い、
  // 変化する部分（再生成のエラー指摘など）は suffix に分離する。これで再試行は userContent 分を
  // cache_read（~0.1x）で読めるため、巨大な原本ブロックの再課金を避けられる。
  opts?: { cachePrefix?: boolean; suffix?: string },
): Promise<StructuredCallResult<T>> {
  if (!client) throw new Error('ANTHROPIC_API_KEY が未設定です（モックモードを使用してください）');

  const userMessage: Anthropic.MessageParam['content'] = opts?.cachePrefix
    ? [
        { type: 'text', text: userContent, cache_control: { type: 'ephemeral' } },
        ...(opts.suffix ? [{ type: 'text' as const, text: opts.suffix }] : []),
      ]
    : userContent;

  // 長時間処理になり得るためストリーミングで呼び出し、finalMessage で完全な応答を得る。
  // タイムアウト・過負荷などの一時エラーはこの呼び出し単位で再試行する（固定部はキャッシュ読取で再課金軽微）
  const message = await withTransientRetry(stage, async () => {
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
      messages: [{ role: 'user', content: userMessage }],
    });
    return await stream.finalMessage();
  });

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
    // 1 ターン単位で一時エラーを再試行する。ここで丸ごと投げ直すと、それまでのツール参照結果ごと
    // 会話が失われ「Request timed out.」がユーザーに露出していた（2026-07-15 の Q&A 頻発エラー）。
    const msg = await withTransientRetry('qa', async () => {
      const stream = client.messages.stream({
        model: MODEL,
        max_tokens: 16000,
        thinking: { type: 'adaptive' },
        system: [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }],
        tools: tools as unknown as Anthropic.Tool[],
        messages,
      });
      return await stream.finalMessage();
    });
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

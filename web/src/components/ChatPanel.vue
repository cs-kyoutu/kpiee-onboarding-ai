<script setup lang="ts">
// AI Q&A パネル。解読済みシートに対する自由質問へ、セル単位の根拠付きで答える。
// AI はバックエンドのドリルダウン道具（get_cell / trace_formula 等）を呼んで実データを参照するため、
// 「AS250 はどう作られている？」のような出所追跡にもセル根拠付きで回答できる。
import { nextTick, onMounted, ref } from 'vue'
import { getChat, askChat, type ChatMessage } from '../api'

const props = defineProps<{ projectId: number }>()

const messages = ref<ChatMessage[]>([])
const question = ref('')
const sending = ref(false)
const error = ref('')
const log = ref<HTMLElement | null>(null)

// ツール名 → 表示ラベル（辿った根拠を人にわかる言葉で示す）
const TOOL_LABELS: Record<string, string> = {
  get_sheet_map: 'シート一覧を確認',
  get_cell: 'セルを参照',
  get_range: '範囲を参照',
  find_rows: '行ラベルを検索',
  trace_formula: '数式の出所を追跡',
}

const SUGGESTIONS = [
  'このブックの全体構造を教えて',
  'FY 保育事業 の AS250 はどう作られている？',
  '集計シートはどの個別シートを合算している？',
]

function traceOf(m: ChatMessage): { tool: string; input: Record<string, unknown> }[] {
  if (!m.tool_trace) return []
  try { return JSON.parse(m.tool_trace) } catch { return [] }
}

// AI 応答に含まれる軽量マークダウン（**太字** / *斜体* / `コード`）を実際の装飾へ変換する。
// 記号がそのまま表示されて読みにくい問題への対処。まず HTML をエスケープしてから変換する（XSS 防止）。
function renderMd(text: string): string {
  const esc = text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return esc
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
    // 行頭の見出し記号(#) や箇条書きの素の記号は除去/整形
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^\s*[-*]\s+/gm, '・')
}

async function scrollToEnd() {
  await nextTick()
  if (log.value) log.value.scrollTop = log.value.scrollHeight
}

async function load() {
  messages.value = await getChat(props.projectId)
  await scrollToEnd()
}

async function send(text?: string) {
  const q = (text ?? question.value).trim()
  if (!q || sending.value) return
  error.value = ''
  question.value = ''
  // 楽観的にユーザー発話を表示
  messages.value.push({ id: -Date.now(), role: 'user', content: q, created_at: '' })
  sending.value = true
  await scrollToEnd()
  try {
    await askChat(props.projectId, q)
    await load() // 永続化された確定版（tool_trace 付き）で置き換える
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    sending.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="panel">
    <h2>🤖 AI Q&A（解読済みシートへの質問）</h2>
    <p class="muted">
      解読したシートの構造・数式・出所について自由に質問できます。AI は実際のセルと数式を辿って、根拠付きで回答します。
    </p>

    <div ref="log" class="chat-log">
      <div v-for="m in messages" :key="m.id" class="msg" :class="m.role">
        <div class="bubble">
          <div class="who">{{ m.role === 'user' ? 'あなた' : 'AI' }}</div>
          <div class="content" v-html="renderMd(m.content)"></div>
          <details v-if="traceOf(m).length" class="trace">
            <summary>根拠として参照した箇所（{{ traceOf(m).length }}件）</summary>
            <ul>
              <li v-for="(t, i) in traceOf(m)" :key="i">
                <span class="tool">{{ TOOL_LABELS[t.tool] ?? t.tool }}</span>
                <code>{{ JSON.stringify(t.input) }}</code>
              </li>
            </ul>
          </details>
        </div>
      </div>
      <div v-if="sending" class="msg assistant"><div class="bubble"><div class="who">AI</div><div class="content muted">考え中…（セルを参照しています）</div></div></div>
      <div v-if="messages.length === 0 && !sending" class="muted" style="padding: 1rem">
        まだ質問がありません。下の例から試せます。
      </div>
    </div>

    <div v-if="messages.length === 0" class="suggestions">
      <button v-for="s in SUGGESTIONS" :key="s" class="chip" @click="send(s)">{{ s }}</button>
    </div>

    <p v-if="error" class="error-box">{{ error }}</p>

    <div class="toolbar composer">
      <input
        v-model="question"
        type="text"
        placeholder="質問を入力（例: FY 保育事業 の AS250 はどう作られている？）"
        :disabled="sending"
        @keyup.enter="send()"
      />
      <button class="primary" :disabled="sending || !question.trim()" @click="send()">送信</button>
    </div>
  </div>
</template>

<style scoped>
.chat-log {
  max-height: 60vh;
  overflow-y: auto;
  border: 1px solid var(--border, #e2e2e2);
  border-radius: 8px;
  padding: 0.75rem;
  background: #fafafa;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.msg { display: flex; }
.msg.user { justify-content: flex-end; }
.msg.assistant { justify-content: flex-start; }
.bubble {
  max-width: 80%;
  padding: 0.5rem 0.75rem;
  border-radius: 10px;
  background: #fff;
  border: 1px solid #e2e2e2;
}
.msg.user .bubble { background: #e8f0fe; border-color: #c6dafc; }
.who { font-size: 0.7rem; color: #888; margin-bottom: 0.2rem; }
.content { white-space: pre-wrap; line-height: 1.5; }
.trace { margin-top: 0.4rem; font-size: 0.8rem; }
.trace summary { cursor: pointer; color: #666; }
.trace ul { margin: 0.3rem 0 0; padding-left: 1rem; }
.trace .tool { font-weight: 600; margin-right: 0.4rem; }
.trace code { font-size: 0.75rem; color: #555; }
.suggestions { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-top: 0.6rem; }
.chip { font-size: 0.85rem; padding: 0.3rem 0.6rem; border-radius: 999px; }
.composer { margin-top: 0.75rem; }
.composer input { flex: 1; }
</style>

<script setup lang="ts">
// ステップ5: SQL構築。レポートの読み合わせが終わった案件で、kpiee の SQLジョブを対話で組み立てる。
//
// 協和医科器械の構築の進み方をそのまま画面にする:
//   AI が復唱 → ロジックと質問 → 事前検証＋SQL＋検算 → 検算の突き合わせ、と進め、
//   検証クエリ・本体・検算は AI 自身が取込済みの実データで流す（人が kpiee へコピペして
//   結果を貼り戻す往復が要らない）。人がやるのは決定と、検算の正解値を渡すことだけ。
//
// 左=会話（AI が流した SQL と結果グリッドを、会話の流れの中に畳んで出す）、
// 右=保存済みの SQL 成果物（協和なら STEP1〜4＋統合の5本になる）。
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  getSqlChat, sendSqlChat, deleteSqlJob,
  type SqlChatMessage, type SqlJob, type SqlToolTrace,
} from '../../api'

const props = defineProps<{ projectId: number }>()

const messages = ref<SqlChatMessage[]>([])
const jobs = ref<SqlJob[]>([])
const pending = ref(false)
const input = ref('')
const sending = ref(false)
const echo = ref('')
const notice = ref('')
const error = ref('')
const logEl = ref<HTMLElement | null>(null)
const openedJob = ref<number | null>(null)

const busy = computed(() => sending.value || pending.value)

const KICKOFF = 'この案件のSQL構築を始めてください。まず取込データと解析結果を復唱して、突き合わせからお願いします。'

function traceOf(m: SqlChatMessage): SqlToolTrace[] {
  if (!m.tool_trace) return []
  try {
    return JSON.parse(m.tool_trace) as SqlToolTrace[]
  } catch {
    return []
  }
}

/** トレースの見出し。何をした呼び出しかが一覧で分かるようにする */
function traceTitle(t: SqlToolTrace): string {
  if (t.tool === 'run_sql') return `▶ 実行: ${t.label}`
  if (t.tool === 'save_sql') return `💾 保存: ${t.label}`
  if (t.tool === 'read_reference') return `📖 ナレッジ: ${t.label}`
  return t.tool
}

async function load() {
  try {
    const d = await getSqlChat(props.projectId)
    messages.value = d.messages
    pending.value = d.pending
    jobs.value = d.jobs
    if (echo.value && d.messages.some(m => m.role === 'user' && m.content === echo.value)) echo.value = ''
  } catch (e) {
    error.value = String(e)
  }
}

async function send(text?: string) {
  if (busy.value) return
  const message = (text ?? input.value).trim()
  if (!message) return
  error.value = ''
  sending.value = true
  echo.value = message
  input.value = ''
  notice.value = '送信中…'
  try {
    await sendSqlChat(props.projectId, message)
    pending.value = true
    notice.value = 'AI が検証・実行しています。SQL を流すため数分かかることがあります'
    await load()
  } catch (e) {
    const msg = String(e)
    if (/処理中/.test(msg)) {
      notice.value = '前のメッセージを処理中です。回答が出てから送ってください'
      pending.value = true
    } else {
      error.value = msg
      notice.value = ''
      input.value = message
    }
    echo.value = ''
  } finally {
    sending.value = false
  }
}

async function removeJob(j: SqlJob) {
  if (!window.confirm(`SQL「${j.name}」を削除します。よろしいですか？`)) return
  try {
    await deleteSqlJob(j.id)
    await load()
  } catch (e) {
    error.value = String(e)
  }
}

async function copyJob(j: SqlJob) {
  try {
    await navigator.clipboard.writeText(j.sql)
    notice.value = `「${j.name}」の SQL をコピーしました（kpiee の SQLジョブへ貼り付けてください）`
  } catch {
    openedJob.value = j.id // コピーできない環境では開いて選択してもらう
  }
}

watch([messages, echo, pending], async () => {
  await nextTick()
  if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight
})

let timer: ReturnType<typeof setInterval> | null = null
onMounted(async () => {
  await load()
  timer = setInterval(async () => {
    if (!pending.value) return
    await load()
    if (!pending.value) notice.value = ''
  }, 3000)
})
onUnmounted(() => { if (timer) clearInterval(timer) })
</script>

<template>
  <div class="wz-body">
    <p class="wz-lede">
      kpiee に貼る <b>SQLジョブ</b>を、構築ナレッジ（kpiee-sql-builder）の型で組み立てます。
      検証クエリ・本体・検算は <b>AI が取込済みの実データでその場で実行</b>します。
      決めるのはあなたです — 特に<b>検算の正解値</b>（合計がいくつになるべきか）は顧客帳票から拾って伝えてください。
    </p>

    <p v-if="error" class="error-box">{{ error }}</p>

    <div class="wz-studio">
      <!-- 会話 -->
      <div class="wz-card wz-chat wz-sqlchat">
        <h3 class="wz-h">構築の会話</h3>
        <div ref="logEl" class="wz-chat-log">
          <p v-if="messages.length === 0 && !echo" class="muted">
            「構築を始める」を押すと、AI が取込データと解析結果を復唱して、突き合わせから始めます
            （ナレッジの4ターン: 復唱 → ロジックと質問 → 検証＋SQL＋検算 → 突き合わせ）。
          </p>
          <div v-for="m in messages" :key="m.id" class="wz-msg" :class="m.role">
            <span class="who">{{ m.role === 'user' ? '担当者' : 'AI' }}</span>
            <!-- AI が流した SQL と結果。会話の流れの中に畳んで置く -->
            <details v-for="(t, i) in traceOf(m)" :key="i" class="wz-sqltrace" :class="{ err: t.error }">
              <summary>{{ traceTitle(t) }}<span v-if="t.error" class="badge ng">エラー</span></summary>
              <pre v-if="t.sql" class="wz-sql">{{ t.sql }}</pre>
              <p v-if="t.error" class="error-box">{{ t.error }}</p>
              <div v-else-if="t.result" class="wz-sqlresult">
                <table>
                  <thead><tr><th v-for="c in t.result.columns" :key="c">{{ c }}</th></tr></thead>
                  <tbody>
                    <tr v-for="(r, ri) in t.result.rows" :key="ri">
                      <td v-for="(v, ci) in r" :key="ci">{{ v }}</td>
                    </tr>
                  </tbody>
                </table>
                <p class="muted">
                  {{ t.result.totalRows.toLocaleString() }} 行{{ t.result.truncated ? '（先頭30行のみ表示）' : '' }}
                </p>
              </div>
            </details>
            <p class="wz-pre">{{ m.content }}</p>
          </div>
          <div v-if="echo" class="wz-msg user sending">
            <span class="who">担当者</span>
            <p class="wz-pre">{{ echo }}</p>
            <span class="badge info">{{ sending ? '送信中…' : '送信しました' }}</span>
          </div>
          <p v-if="pending" class="wz-thinking">
            <span class="dots"><i></i><i></i><i></i></span>AI が SQL を流しています…
          </p>
        </div>
        <div class="wz-chat-input">
          <textarea
            v-model="input" rows="2" :disabled="busy"
            placeholder="決定・訂正・検算の正解値などを書く（Ctrl+Enter で送信）"
            @keydown.ctrl.enter="send()"
          ></textarea>
          <div class="wz-actions">
            <button
              class="primary" :disabled="busy || (messages.length > 0 && !input.trim())"
              @click="messages.length === 0 ? send(KICKOFF) : send()"
            >
              {{ sending ? '送信中…' : pending ? 'AI が実行中…' : messages.length === 0 ? '構築を始める' : '送る' }}
            </button>
            <span v-if="notice" class="muted">{{ notice }}</span>
          </div>
        </div>
      </div>

      <!-- 保存済みの SQL 成果物 -->
      <div class="wz-studio-side">
        <div class="wz-card">
          <h3 class="wz-h">SQL 成果物（{{ jobs.length }} 本）</h3>
          <p v-if="jobs.length === 0" class="muted">
            検算まで通って合意した SQL がここに並びます（協和は STEP1〜4 ＋ 統合の5本でした）。
          </p>
          <div v-for="j in jobs" :key="j.id" class="wz-sqljob">
            <div class="wz-sqljob-head">
              <b>{{ j.name }}</b>
              <span class="muted">{{ j.updated_at?.slice(0, 16).replace('T', ' ') }}</span>
              <button class="link" @click="copyJob(j)">SQL をコピー</button>
              <button class="link" @click="openedJob = openedJob === j.id ? null : j.id">
                {{ openedJob === j.id ? '閉じる' : '開く' }}
              </button>
              <button class="link danger" @click="removeJob(j)">削除</button>
            </div>
            <p v-if="j.note" class="muted">{{ j.note }}</p>
            <template v-if="openedJob === j.id">
              <pre class="wz-sql">{{ j.sql }}</pre>
              <h4 v-if="j.output_spec" class="wz-h4">出力仕様</h4>
              <pre v-if="j.output_spec" class="wz-pre wz-spec-pre">{{ j.output_spec }}</pre>
            </template>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

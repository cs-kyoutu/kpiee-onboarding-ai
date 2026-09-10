<script setup lang="ts">
// ステップ5: SQL構築。中は2段階（他のステップと同じ「確認して確定 → 次へ」の型）。
//
//   段階1: 物理カラムの確認 — Redash の書き出し（クエリ145/147）をファイルで添付し、
//          物理カラム名（IMPORT_xxxxx）とカラム名（論理名）の対応を表で確認・修正して確定する。
//          分類確認（ステップ2）と同じ: 初期案は自動で起こし、確定するのは人。確定後はロック。
//   段階2: SQL構築の対話 — 確定した対応を前提に、検証クエリ・本体・検算を AI が
//          取込済みの実データで流しながら組み立てる。
//
// 大前提（サーバー側プロンプトで常時有効）: AI はデータの実数値を文章・SQL に書かない。
// 実額の確認は実行結果グリッド（このコンポーネントの表）に任せる。
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  getSqlChat, sendSqlChat, deleteSqlJob,
  getProjectDocs, uploadProjectDoc, deleteProjectDoc,
  parseSqlColumns, getSqlColumns, saveSqlColumns,
  setProjectFlag, clearProjectFlag,
  type ProjectDoc, type SqlChatMessage, type SqlColumnRow, type SqlJob, type SqlToolTrace,
} from '../../api'
import SqlTraceList from './SqlTraceList.vue'

const props = defineProps<{ projectId: number }>()

const error = ref('')

// ---- 段階の切り替え ----
type Phase = 1 | 2
const phase = ref<Phase>(1)
const columnsConfirmed = ref(false)
/** 確定済みは既定でロック。解除すると編集できる（ClassifyStep と同じ型） */
const unlocked = ref(false)
const locked = computed(() => columnsConfirmed.value && !unlocked.value)

// ---- 段階1: 物理カラムの確認 ----
const columnFiles = ref<ProjectDoc[]>([])
const colBusy = ref('')
const rows = ref<SqlColumnRow[]>([])
const parseNotes = ref<string[]>([])
const parsing = ref(false)
const savingColumns = ref(false)
/** 表が長いときの絞り込み（編集はフィルタ中も元の行に効く） */
const filter = ref('')
/** 原本にあって Redash 側に当たらなかった列（未取込か、論理名の言い換え） */
const unmatchedLocal = ref<string[]>([])
/** 取込済みデータのテーブルと列。修正時に datalist 候補として出す */
const localTables = ref<{ name: string; columns: string[] }[]>([])

/** 原本の列まで当たっている行数（確定前の見どころ。全行当たっている必要はない） */
const matchedCount = computed(() => rows.value.filter(r => r.local_table && r.local_column).length)
const localColumnOptions = computed(() =>
  localTables.value.flatMap(t => t.columns.map(c => `${t.name}.${c}`)))

const visibleRows = computed(() => {
  const f = filter.value.trim().toLowerCase()
  if (!f) return rows.value
  return rows.value.filter(r =>
    [r.table_name, r.physical_column, r.logical_name, r.asset_name, r.note]
      .some(v => (v ?? '').toLowerCase().includes(f)))
})

async function loadColumnFiles() {
  try {
    columnFiles.value = (await getProjectDocs(props.projectId)).filter(d => d.kind === 'sql-columns')
  } catch { /* 一覧が取れなくても段階2は使える */ }
}

async function loadColumns() {
  try {
    const d = await getSqlColumns(props.projectId)
    rows.value = d.rows
    columnsConfirmed.value = d.confirmed
  } catch (e) {
    error.value = String(e)
  }
}

async function pickColumnFile(ev: Event) {
  const input = ev.target as HTMLInputElement
  const picked = [...(input.files ?? [])]
  input.value = ''
  for (const f of picked) {
    colBusy.value = f.name
    try {
      await uploadProjectDoc(props.projectId, f, 'sql-columns')
    } catch (e) {
      error.value = `${f.name}: ${String(e)}`
    }
  }
  colBusy.value = ''
  await loadColumnFiles()
}

async function removeColumnFile(d: ProjectDoc) {
  if (!window.confirm(`「${d.filename}」を削除します。よろしいですか？`)) return
  try {
    await deleteProjectDoc(d.id)
    await loadColumnFiles()
  } catch (e) {
    error.value = String(e)
  }
}

/** 添付ファイルから対応表の初期案を起こす（保存はしない。表を直して「確定」で保存） */
async function readColumns() {
  parsing.value = true
  error.value = ''
  parseNotes.value = []
  try {
    const r = await parseSqlColumns(props.projectId)
    rows.value = r.rows
    localTables.value = r.tables
    unmatchedLocal.value = r.unmatchedLocal
    parseNotes.value = [
      ...r.notes,
      `原本の列と自動で突き合わせ: ${r.matched} / ${r.rows.length} 行が当たりました。外れた行（原本の列が空欄）を直してください。`,
    ]
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    parsing.value = false
  }
}

/** 「テーブル.列」で選ばれた候補を2列へ割る（datalist の選択を1入力で受けるため） */
function applyLocalPick(r: SqlColumnRow, v: string) {
  const i = v.indexOf('.')
  if (i > 0) {
    r.local_table = v.slice(0, i)
    r.local_column = v.slice(i + 1)
  } else {
    r.local_column = v
  }
}

/** 対応を確定して段階2へ。rows 空の確定＝物理名なしで進む（kpiee 取込前の案件） */
async function confirmColumns() {
  savingColumns.value = true
  error.value = ''
  try {
    const d = await saveSqlColumns(props.projectId, rows.value)
    rows.value = d.rows
    columnsConfirmed.value = true
    unlocked.value = false
    phase.value = 2
  } catch (e) {
    error.value = String(e)
  } finally {
    savingColumns.value = false
  }
}

/** 確定を解除して直す。以降のチャットは直した対応を前提にするため、印も外す */
async function unlockColumns() {
  error.value = ''
  try {
    await clearProjectFlag(props.projectId, 'sql_columns_confirmed')
    columnsConfirmed.value = false
    unlocked.value = true
    phase.value = 1
  } catch (e) {
    error.value = String(e)
  }
}

function removeRow(r: SqlColumnRow) {
  rows.value = rows.value.filter(x => x !== r)
}

function addRow() {
  rows.value.push({
    table_name: '', physical_column: '', logical_name: '', asset_name: '',
    local_table: '', local_column: '', note: '',
  })
}

// ---- 段階2: SQL構築の対話 ----
const messages = ref<SqlChatMessage[]>([])
const jobs = ref<SqlJob[]>([])
const pending = ref(false)
const input = ref('')
const sending = ref(false)
const echo = ref('')
const notice = ref('')
const logEl = ref<HTMLElement | null>(null)
const openedJob = ref<number | null>(null)
/** 処理中の途中経過（いま流している SQL とその結果）。完了すると空になり、会話側へ移る */
const progress = ref<SqlToolTrace[]>([])

const busy = computed(() => sending.value || pending.value)

// ---- 全画面（会話・成果物は縦に長い。狭い2カラムのまま読むのはつらいので広げられるようにする）----
type Panel = 'chat' | 'jobs'
const expanded = ref<Panel | null>(null)

function toggleExpand(p: Panel) {
  expanded.value = expanded.value === p ? null : p
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && expanded.value) expanded.value = null
}

// 全画面の裏がスクロールしないように止める（閉じたら戻す）
watch(expanded, async v => {
  document.body.style.overflow = v ? 'hidden' : ''
  if (v === 'chat') {
    await nextTick()
    if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight
  }
})

const KICKOFF = 'この案件のSQL構築を始めてください。まず取込データと確定済みの物理カラム対応を復唱して、突き合わせからお願いします。'

// ナレッジの ON/OFF（既定 OFF: 大前提＋契約だけの軽量運転。ON: 4ターンの型で進む）
const knowledgeOn = ref(false)
const knowledgeSaving = ref(false)

async function toggleKnowledge() {
  knowledgeSaving.value = true
  error.value = ''
  try {
    if (knowledgeOn.value) await clearProjectFlag(props.projectId, 'sql_knowledge')
    else await setProjectFlag(props.projectId, 'sql_knowledge')
    knowledgeOn.value = !knowledgeOn.value
  } catch (e) {
    error.value = String(e)
  } finally {
    knowledgeSaving.value = false
  }
}

function traceOf(m: SqlChatMessage): SqlToolTrace[] {
  if (!m.tool_trace) return []
  try {
    return JSON.parse(m.tool_trace) as SqlToolTrace[]
  } catch {
    return []
  }
}

async function load() {
  try {
    const d = await getSqlChat(props.projectId)
    messages.value = d.messages
    pending.value = d.pending
    progress.value = d.progress ?? []
    jobs.value = d.jobs
    knowledgeOn.value = d.knowledgeOn
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

watch([messages, echo, pending, progress], async () => {
  await nextTick()
  if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight
})

let timer: ReturnType<typeof setInterval> | null = null
onMounted(async () => {
  window.addEventListener('keydown', onKeydown)
  await Promise.all([load(), loadColumns(), loadColumnFiles()])
  // 確定済みなら対話から。未確定なら物理カラムの確認から始める
  phase.value = columnsConfirmed.value ? 2 : 1
  timer = setInterval(async () => {
    if (!pending.value) return
    await load()
    if (!pending.value) notice.value = ''
  }, 3000)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
  window.removeEventListener('keydown', onKeydown)
  document.body.style.overflow = '' // 全画面のまま離脱してもスクロールを戻す
})
</script>

<template>
  <div class="wz-body">
    <!-- 段階の見出し。ステップ全体の帯と同じ言語（番号＋ラベル＋完了印） -->
    <ol class="wz-steps wz-substeps">
      <li :class="{ active: phase === 1, done: columnsConfirmed }" @click="phase = 1">
        <span class="no">{{ columnsConfirmed ? '✓' : '1' }}</span>
        <span class="tx"><b>物理カラムの確認</b><em>Redash の書き出しを添付し、対応を確定する</em></span>
      </li>
      <li :class="{ active: phase === 2, locked: !columnsConfirmed && phase !== 2 }" @click="columnsConfirmed && (phase = 2)">
        <span class="no">2</span>
        <span class="tx"><b>SQL構築</b><em>対話で組み立て、実データで検証する</em></span>
      </li>
    </ol>

    <p v-if="error" class="error-box">{{ error }}</p>

    <!-- ============ 段階1: 物理カラムの確認 ============ -->
    <template v-if="phase === 1">
      <p class="wz-lede">
        <b>原本（取り込んだデータ）の列</b>と <b>kpiee の物理カラム名（IMPORT_xxxxx）</b>の突き合わせ表を作ります。
        Redash の書き出しを添付して「読み取る」を押すと<b>自動で突き合わせた表</b>が出るので、
        当たっているかを確認し、外れた行だけ直して確定してください。
        納品 SQL はこの対応だけを根拠に物理名を書きます（AI は物理名を推測しません）。
        まだ kpiee 取込前の案件は、空のまま「確定」して進めます。
      </p>

      <!-- 確定/編集中の状態（分類確認と同じ型） -->
      <div v-if="columnsConfirmed || unlocked" class="wz-lockbar" :class="locked ? 'is-locked' : 'is-open'">
        <span class="ico">{{ locked ? '🔒' : '✏️' }}</span>
        <span class="tx">
          <b>{{ locked ? '確定済み（編集ロック中）' : '編集中（未確定）' }}</b>
          <em>{{ locked
            ? 'この対応を前提に SQL を組み立てています。直すにはロックを解除してください。'
            : '直したら「この対応で確定する」を押してください。押すまでチャットは前の対応のままです。' }}</em>
        </span>
        <button v-if="locked" @click="unlockColumns">確定を解除して編集する</button>
      </div>

      <div class="wz-card">
        <h3 class="wz-h">Redash の書き出しを添付</h3>
        <p class="muted">
          kpiee Redash の<b>クエリ145（全物理カラム）／147（アセット一覧）</b>を CSV で書き出して添付し、
          「読み取る」で下の表へ起こします。読み取りは初期案です — カラム名の言い換え・欠けは表で直してください。
        </p>
        <div class="wz-actions">
          <label class="wz-filebtn">
            <input type="file" multiple accept=".csv,.tsv,.txt,.json" :disabled="locked" @change="pickColumnFile">
            <span>＋ CSV を添付</span>
          </label>
          <button :disabled="parsing || locked || columnFiles.length === 0" @click="readColumns">
            {{ parsing ? '読み取り中…' : 'ファイルから対応表を読み取る' }}
          </button>
          <span v-if="colBusy" class="muted">{{ colBusy }} を取り込み中…</span>
        </div>
        <ul v-if="columnFiles.length > 0" class="wz-list">
          <li v-for="d in columnFiles" :key="d.id">
            {{ d.filename }}
            <span v-if="d.text_length > 0" class="muted">（{{ d.text_length.toLocaleString() }} 字）</span>
            <span v-else class="badge ng">読み取れませんでした</span>
            <button class="link danger" :disabled="locked" @click="removeColumnFile(d)">削除</button>
          </li>
        </ul>
        <ul v-if="parseNotes.length > 0" class="wz-list">
          <li v-for="(n, i) in parseNotes" :key="i" class="muted">{{ n }}</li>
        </ul>
      </div>

      <div class="wz-card">
        <div class="wz-book-head">
          <h3 class="wz-h">原本の列 ↔ 物理カラムの対応（{{ rows.length.toLocaleString() }} 行）</h3>
          <span v-if="rows.length > 0" class="badge" :class="matchedCount === rows.length ? 'ok' : 'warn'">
            原本と当たった行 {{ matchedCount.toLocaleString() }} / {{ rows.length.toLocaleString() }}
          </span>
          <input v-model="filter" class="wz-colfilter" placeholder="絞り込み（表示だけ。編集は元の行に効きます）">
        </div>
        <p v-if="rows.length === 0" class="muted">
          まだありません。上の「読み取る」で自動突き合わせ表を起こすか、「＋ 行を足す」で手入力してください。
          取込前の案件は空のまま確定して構いません。
        </p>
        <div v-else class="wz-coltable">
          <table class="wz-table">
            <thead>
              <tr>
                <th>原本の列（取込データ）</th><th>物理カラム名</th><th>カラム名（論理名）</th>
                <th>アセット名</th><th>備考</th><th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(r, i) in visibleRows" :key="r.id ?? `n${i}`" :class="{ warn: !(r.local_table && r.local_column) }">
                <td>
                  <input
                    :value="r.local_table && r.local_column ? `${r.local_table}.${r.local_column}` : ''"
                    :disabled="locked" list="wz-local-cols" placeholder="（当たっていません。候補から選ぶ）"
                    @change="applyLocalPick(r, ($event.target as HTMLInputElement).value)"
                  >
                </td>
                <td><input v-model="r.physical_column" :disabled="locked" placeholder="IMPORT_30016_STRING_1"></td>
                <td><input v-model="r.logical_name" :disabled="locked" placeholder="集計得意先コード"></td>
                <td><input v-model="r.asset_name" :disabled="locked"></td>
                <td><input v-model="r.note" :disabled="locked"></td>
                <td><button class="link danger" :disabled="locked" @click="removeRow(r)">削除</button></td>
              </tr>
            </tbody>
          </table>
          <datalist id="wz-local-cols">
            <option v-for="o in localColumnOptions" :key="o" :value="o"></option>
          </datalist>
        </div>
        <details v-if="unmatchedLocal.length > 0" class="wz-more">
          <summary>原本にあって Redash 側に無かった列（{{ unmatchedLocal.length.toLocaleString() }} 件）</summary>
          <p class="muted">kpiee へ未取込か、論理名の言い換えの可能性があります。必要な列だけ確かめてください。</p>
          <ul class="wz-list">
            <li v-for="(u, i) in unmatchedLocal" :key="i" class="muted">{{ u }}</li>
          </ul>
        </details>
        <div class="wz-actions">
          <button class="link" :disabled="locked" @click="addRow">＋ 行を足す</button>
          <button v-if="!locked" class="primary" :disabled="savingColumns" @click="confirmColumns">
            {{ savingColumns ? '保存中…' : rows.length > 0 ? 'この対応で確定して SQL構築へ' : '物理名なしで確定して SQL構築へ' }}
          </button>
          <button v-else class="primary" @click="phase = 2">SQL構築へ →</button>
        </div>
      </div>
    </template>

    <!-- ============ 段階2: SQL構築の対話 ============ -->
    <template v-else>
      <p class="wz-lede">
        kpiee に貼る <b>SQLジョブ</b>を対話で組み立てます。
        検証クエリ・本体・検算は <b>AI が取込済みの実データでその場で実行</b>します。
        大前提として、<b>AI はデータの実数値を文章・SQL に書きません</b>（列名・構造は書きます）。
        実額は実行結果グリッドを自分で開いて確かめてください。
      </p>

      <div class="wz-actions">
        <label class="wz-check wz-knowledge">
          <input type="checkbox" :checked="knowledgeOn" :disabled="knowledgeSaving || busy" @change="toggleKnowledge">
          <span>
            <b>構築ナレッジをフルで使う</b>
            <em class="muted">
              {{ knowledgeOn
                ? ' ON: kpiee-sql-builder の4ターン運用（復唱→ロジック→検証＋SQL＋検算→突き合わせ）で進めます'
                : ' OFF（既定）: 大前提と SQLジョブ契約だけで軽く回します。ナレッジは AI 側からも参照しません（読む道具ごと外れます）' }}
            </em>
          </span>
        </label>
        <span class="muted">
          物理カラムの対応: {{ rows.length > 0 ? `${rows.length.toLocaleString()} 行を確定済み` : 'なしで進行中' }}
          <button class="link" @click="phase = 1">見直す</button>
        </span>
      </div>

      <!-- 全画面のときだけ敷く背幕。クリックで戻す（Esc でも戻る） -->
      <Teleport to="body">
        <div v-if="expanded" class="wz-fullback" @click="expanded = null"></div>
      </Teleport>

      <div class="wz-studio">
        <!-- 会話 -->
        <Teleport to="body" :disabled="expanded !== 'chat'">
          <div class="wz-card wz-chat wz-sqlchat" :class="{ 'is-full': expanded === 'chat' }">
            <div class="wz-h-row">
              <h3 class="wz-h">構築の会話</h3>
              <button class="link" @click="toggleExpand('chat')">
                {{ expanded === 'chat' ? '✕ 全画面を閉じる（Esc）' : '⛶ 全画面' }}
              </button>
            </div>
            <div ref="logEl" class="wz-chat-log">
              <p v-if="messages.length === 0 && !echo" class="muted">
                「構築を始める」を押すと、AI が取込データと物理カラムの対応を復唱して、突き合わせから始めます。
              </p>
              <div v-for="m in messages" :key="m.id" class="wz-msg" :class="m.role">
                <span class="who">{{ m.role === 'user' ? '担当者' : 'AI' }}</span>
                <!-- AI が流した SQL と結果。会話の流れの中に畳んで置く -->
                <SqlTraceList :traces="traceOf(m)" />
                <p class="wz-pre">{{ m.content }}</p>
              </div>
              <div v-if="echo" class="wz-msg user sending">
                <span class="who">担当者</span>
                <p class="wz-pre">{{ echo }}</p>
                <span class="badge info">{{ sending ? '送信中…' : '送信しました' }}</span>
              </div>
              <!-- 処理中の途中経過。1回の応答で検証〜検算まで何本も流すため、終わるまで無反応だと止まって見える -->
              <div v-if="pending" class="wz-msg assistant">
                <span class="who">AI</span>
                <SqlTraceList :traces="progress" />
                <p class="wz-thinking">
                  <span class="dots"><i></i><i></i><i></i></span>
                  {{ progress.length > 0 ? `SQL を流しています…（${progress.length} 本目）` : 'AI が考えています…' }}
                </p>
              </div>
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
        </Teleport>

        <!-- 保存済みの SQL 成果物 -->
        <div class="wz-studio-side">
          <Teleport to="body" :disabled="expanded !== 'jobs'">
            <div class="wz-card" :class="{ 'is-full': expanded === 'jobs' }">
              <div class="wz-h-row">
                <h3 class="wz-h">SQL 成果物（{{ jobs.length }} 本）</h3>
                <button v-if="jobs.length > 0" class="link" @click="toggleExpand('jobs')">
                  {{ expanded === 'jobs' ? '✕ 全画面を閉じる（Esc）' : '⛶ 全画面' }}
                </button>
              </div>
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
          </Teleport>
        </div>
      </div>
    </template>
  </div>
</template>

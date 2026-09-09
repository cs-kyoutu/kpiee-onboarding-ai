<script setup lang="ts">
// 新UI ステップ4（最終）: 「出来上がりを見ながら相談して直す」画面。
//
// 相談と確認を別ステップに分けていたが、何を直したいかは実物を見て初めて出てくる。
// なので左に実際のレポート（現行フォーマットそのまま）、右に相談チャットと構成チェックリストを置き、
// 直したらその場でプレビューが作り直される形にした。ダウンロードも同じ画面から。
//
// 生成は保存済みの解析結果＋構成指定から決定的に行う（AI 呼び出しなし）ので、
// 何度作り直しても内容は指定だけで決まる。
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  getReportChat, sendReportChat, getReportSpec, getReportFacts, saveReportSpec, reportUrl,
  extractRequirements,
  type ReportChatMessage, type ReportFacts, type ReportFileNote, type ReportOverviewItem,
  type ReportSpec, type ReportSpecItems, type ReportSpecSections,
} from '../../api'

const props = defineProps<{ projectId: number }>()
const emit = defineEmits<{ changed: [] }>()

const spec = ref<ReportSpec | null>(null)
const sectionLabels = ref<Record<string, string>>({})
const itemLabels = ref<Record<string, string>>({})
const facts = ref<ReportFacts | null>(null)
const messages = ref<ReportChatMessage[]>([])
const pending = ref(false)
const input = ref('')
const error = ref('')
// 送信の押した感。POST の往復と AI の生成はどちらも待ち時間があるため、
// 「送った」ことを即座に画面へ出さないと同じ内容を連打されてしまう（サーバーは 409 で弾くが体験が悪い）。
const sending = ref(false)
/** 送信直後だけ出す自分の発話（サーバーの履歴が返ってきたら消す） */
const echo = ref('')
const notice = ref('')
const logEl = ref<HTMLElement | null>(null)
const busy = computed(() => sending.value || pending.value)
const savingSpec = ref(false)
// プレビューを作り直すための連番。指定が変わるたびに増やす
const reloadKey = ref(0)
const previewOn = ref(true)
// レポート生成中の表示。サーバー側の生成（関係グラフ読み込み＋HTML組み立て）は数秒〜数十秒かかり、
// 無反応に見えると「壊れた」と思われるため、iframe が読み終わるまで回転を出す
const previewLoading = ref(true)
watch(reloadKey, () => { previewLoading.value = true })
watch(previewOn, on => { if (on) previewLoading.value = true })

const previewSrc = computed(() => `${reportUrl(props.projectId, true)}&v=${reloadKey.value}`)
const sectionKeys = computed(() => Object.keys(sectionLabels.value) as (keyof ReportSpecSections)[])
const itemKeys = computed(() => Object.keys(itemLabels.value) as (keyof ReportSpecItems)[])

const onSections = computed(() =>
  spec.value ? sectionKeys.value.filter(k => spec.value!.sections[k]).map(k => sectionLabels.value[k]) : [])
const offList = computed(() => {
  if (!spec.value) return []
  return [
    ...sectionKeys.value.filter(k => !spec.value!.sections[k]).map(k => sectionLabels.value[k]),
    ...itemKeys.value.filter(k => !spec.value!.items[k]).map(k => itemLabels.value[k]),
  ]
})

/** 1ブック案件では全体関係図（ブック間）が出ないため、指定しても効かないことを明示する */
function itemNote(key: keyof ReportSpecItems): string {
  if (key === 'fileFlow' && facts.value && !facts.value.multiFile) return '1ブックのため出ません'
  return ''
}

/**
 * AI の回答が実際に構成を変えたかを、回答ごとに日本語で並べる。
 * 「合意したのに反映されていない気がする」を無くすため、変わった項目を明示し、
 * 変わっていない回答には「構成は変更なし」と出す（AI がツールを呼ばずに同意した場合が見える）。
 */
function patchSummary(raw?: string | null): string[] {
  if (!raw) return []
  try {
    const p = JSON.parse(raw) as Partial<ReportSpec>
    const out: string[] = []
    if (p.title !== undefined) out.push(`表題「${p.title || '（既定）'}」`)
    if (p.focus !== undefined) out.push(`重点「${p.focus}」`)
    for (const [k, v] of Object.entries(p.sections ?? {})) {
      out.push(`${sectionLabels.value[k] ?? k}: ${v ? '出す' : '出さない'}`)
    }
    for (const [k, v] of Object.entries(p.items ?? {})) {
      out.push(`${itemLabels.value[k] ?? k}: ${v ? '出す' : '出さない'}`)
    }
    if (p.notes) out.push(`補足 ${p.notes.length} 件`)
    // 要件（伺った内容）側の変更。ここが変わるとレポートの 02 が変わるので必ず出す
    if (p.reproduce) out.push(`再現するもの ${p.reproduce.length} 件`)
    if (p.howMade) out.push(`作られ方 ${p.howMade.length} 件`)
    if (p.howMadeSource !== undefined) out.push(`出典「${p.howMadeSource}」`)
    if (p.assumptions) out.push(`前提 ${p.assumptions.length} 件`)
    if (p.fileNotes) out.push(`ファイルの備考 ${p.fileNotes.length} 件`)
    return out
  } catch {
    return ['構成を更新しました']
  }
}

async function loadSpec() {
  const d = await getReportSpec(props.projectId)
  spec.value = d.spec
  sectionLabels.value = d.sectionLabels
  itemLabels.value = d.itemLabels
  if (!reqDirty.value) syncRequirements(d.spec)
}

// ---- 要件定義（伺った内容）----
// 「何を再現するか」「作られ方」「前提」「ファイルごとの備考」は、要件定義書・手順書に
// 書かれている指定で、数式・値の一致からは一切出てこない。以前はここへ入れる経路が
// AI 相談かスクリプトへの転記しか無く、実際に協和案件はスクリプトへ書き写して作った。
// 資料から読み取って、この欄で確認・修正してから保存する形にする。
const reqBusy = ref(false)
const reqMsg = ref('')
const reqNotes = ref<string[]>([])
const reqSaving = ref(false)
/** 人が触った or 読み取った後は、ポーリングでの取り直しで上書きしない */
const reqDirty = ref(false)

const fReproduce = ref<ReportOverviewItem[]>([])
const fHowMade = ref('')
const fHowMadeSource = ref('')
const fAssumptions = ref('')
const fFileNotes = ref<ReportFileNote[]>([])

/** 保存済みの指定を編集欄へ写す（1行=1件のテキストへ落とす） */
function syncRequirements(s: ReportSpec) {
  fReproduce.value = s.reproduce.map(r => ({ ...r }))
  fHowMade.value = s.howMade.join('\n')
  fHowMadeSource.value = s.howMadeSource
  fAssumptions.value = s.assumptions.join('\n')
  fFileNotes.value = s.fileNotes.map(n => ({ ...n }))
}

const lines = (s: string): string[] => s.split('\n').map(t => t.trim()).filter(Boolean)

/** 業務資料から読み取って編集欄へ入れる。保存はしない（読み取り違いをそのまま載せないため） */
async function readRequirements() {
  reqBusy.value = true
  reqMsg.value = ''
  reqNotes.value = []
  error.value = ''
  try {
    const r = await extractRequirements(props.projectId)
    fReproduce.value = r.spec.reproduce
    fHowMade.value = r.spec.howMade.join('\n')
    fHowMadeSource.value = r.spec.howMadeSource
    fAssumptions.value = r.spec.assumptions.join('\n')
    fFileNotes.value = r.spec.fileNotes
    reqDirty.value = true
    const n = r.spec.reproduce.length + r.spec.howMade.length + r.spec.assumptions.length + r.spec.fileNotes.length
    reqMsg.value = n === 0
      ? `業務資料 ${r.docCount} 件からは要件を読み取れませんでした。`
      : `業務資料 ${r.docCount} 件（${r.docNames.join('、')}）から ${n} 件読み取りました。確かめてから保存してください。`
    if (r.unresolved.length > 0) {
      reqNotes.value.push(`受領ファイルに見当たらない名前: ${r.unresolved.join('、')} — 未受領の可能性があります`)
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    reqBusy.value = false
  }
}

async function saveRequirements() {
  reqSaving.value = true
  error.value = ''
  try {
    const res = await saveReportSpec(props.projectId, {
      reproduce: fReproduce.value.filter(r => r.label.trim() || r.text.trim()),
      howMade: lines(fHowMade.value),
      howMadeSource: fHowMadeSource.value.trim(),
      assumptions: lines(fAssumptions.value),
      fileNotes: fFileNotes.value.filter(n => n.file.trim() && n.note.trim()),
    })
    spec.value = res.spec
    syncRequirements(res.spec)
    reqDirty.value = false
    reqMsg.value = 'レポートへ反映しました。'
    reloadKey.value++
    emit('changed')
  } catch (e) {
    error.value = String(e)
  } finally {
    reqSaving.value = false
  }
}

/** 解析結果の要約。重いので画面を開いたときの1回だけ（構成の保存では取り直さない） */
async function loadFacts() {
  try {
    facts.value = (await getReportFacts(props.projectId)).facts
  } catch {
    facts.value = null // 取れなくても構成の編集は続けられる
  }
}

async function loadChat() {
  const d = await getReportChat(props.projectId)
  messages.value = d.messages
  pending.value = d.pending
  spec.value = d.spec
  // AI 相談が要件（前提・作られ方）を変えることもある。編集中でなければ欄へ写す
  if (!reqDirty.value) syncRequirements(d.spec)
  // サーバー側の履歴に自分の発話が入ったら、仮表示は用済み
  if (echo.value && d.messages.some(m => m.role === 'user' && m.content === echo.value)) echo.value = ''
}

async function send(text?: string) {
  if (busy.value) return // 連打しても二重送信しない
  const message = (text ?? input.value).trim()
  error.value = ''
  sending.value = true
  // 押した瞬間に自分の発話を出す（POST の応答待ちで無反応に見えるのを防ぐ）
  echo.value = message || '（提案から始める）'
  input.value = ''
  notice.value = '送信中…'
  try {
    await sendReportChat(props.projectId, message || undefined)
    pending.value = true
    notice.value = 'AI が考えています。回答は自動で表示されます（数十秒かかることがあります）'
    await loadChat()
  } catch (e) {
    // 409 = 前のメッセージの処理中。エラーではなく状況の案内として出す
    const msg = String(e)
    if (/処理中/.test(msg)) {
      notice.value = '前のメッセージを処理中です。回答が出てから送ってください'
      pending.value = true
    } else {
      error.value = msg
      notice.value = ''
      input.value = message // 送れなかった内容は戻す
    }
    echo.value = ''
  } finally {
    sending.value = false
  }
}

// 新しい発話が増えたら末尾へ寄せる（自分の発話も回答も見切れないように）
watch([messages, echo, pending], async () => {
  await nextTick()
  if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight
})

/** チェック操作を即保存し、プレビューを作り直す（部分指定。触った項目だけが変わる） */
async function patchSpec(patch: Partial<ReportSpec>) {
  savingSpec.value = true
  error.value = ''
  try {
    const res = await saveReportSpec(props.projectId, patch)
    spec.value = res.spec
    reloadKey.value++
    emit('changed')
  } catch (e) {
    error.value = String(e)
  } finally {
    savingSpec.value = false
  }
}

function toggleSection(key: keyof ReportSpecSections) {
  if (!spec.value) return
  void patchSpec({ sections: { ...spec.value.sections, [key]: !spec.value.sections[key] } })
}

function toggleItem(key: keyof ReportSpecItems) {
  if (!spec.value) return
  void patchSpec({ items: { ...spec.value.items, [key]: !spec.value.items[key] } })
}

function saveText(field: 'title' | 'focus', value: string) {
  void patchSpec({ [field]: value } as Partial<ReportSpec>)
}

function download() {
  window.open(reportUrl(props.projectId), '_blank')
}

// 応答は非同期に届く。届いたら指定を取り直し、AI が構成を変えていたらプレビューも作り直す
let timer: ReturnType<typeof setInterval> | null = null
onMounted(async () => {
  await loadSpec()
  await loadChat()
  void loadFacts() // 重いので待たない（届いたらタイルが埋まる）
  timer = setInterval(async () => {
    if (!pending.value) return
    const before = JSON.stringify(spec.value)
    await loadChat()
    if (pending.value) return
    await loadSpec()
    // AI が構成を変えたらプレビューを作り直し、作り直したことを一言出す
    if (JSON.stringify(spec.value) !== before) {
      reloadKey.value++
      notice.value = '構成が変わったのでレポートを作り直しました'
    } else {
      notice.value = ''
    }
    emit('changed')
  }, 2500)
})
onUnmounted(() => { if (timer) clearInterval(timer) })
</script>

<template>
  <div class="wz-body">
    <p class="wz-lede">
      左が<b>実際に出来上がるレポート</b>です。<b>デザインと骨格は固定</b>で、案件ごとに変えるのは
      <b>どの項目を載せるか</b>だけ。右で相談・変更すると、その場で作り直します。
      表どうしの関係図（ノード形式）は必ず載ります。
    </p>

    <div v-if="facts" class="wz-tiles">
      <div class="wz-tile"><span class="tl">対象ファイル</span><span class="tv">{{ facts.files.length }}</span></div>
      <div class="wz-tile"><span class="tl">表</span><span class="tv">{{ facts.regionCount }}</span></div>
      <div class="wz-tile"><span class="tl">表どうしの関係</span><span class="tv">{{ facts.edgeCount.toLocaleString() }}</span></div>
      <div class="wz-tile" :class="{ warn: facts.questionCount > 0 }">
        <span class="tl">ご確認いただきたい点</span><span class="tv">{{ facts.questionCount }}</span>
      </div>
    </div>

    <p v-if="error" class="error-box">{{ error }}</p>

    <div class="wz-actions">
      <button class="primary" @click="download">HTML をダウンロード</button>
      <button @click="reloadKey++">プレビューを作り直す</button>
      <button @click="previewOn = !previewOn">{{ previewOn ? 'プレビューを隠す' : 'プレビューを表示' }}</button>
      <span v-if="savingSpec" class="muted">保存中…</span>
      <span v-else-if="spec" class="muted">
        載せる節: {{ onSections.join(' / ') || '（なし）' }}{{ offList.length > 0 ? ` ／ 外したもの: ${offList.join(' / ')}` : '' }}
      </span>
    </div>

    <div class="wz-studio">
      <!-- 出来上がり（現行フォーマットそのまま） -->
      <div v-if="previewOn" class="wz-card wz-preview">
        <div v-if="previewLoading" class="wz-preview-loading">
          <span class="wz-spinner"></span>
          <span>レポートを作っています…</span>
        </div>
        <iframe
          :key="reloadKey" :src="previewSrc" title="レポートのプレビュー"
          @load="previewLoading = false"
        ></iframe>
      </div>

      <div class="wz-studio-side">
        <!-- 相談 -->
        <div class="wz-card wz-chat">
          <h3 class="wz-h">相談・修正</h3>
          <div ref="logEl" class="wz-chat-log">
            <p v-if="messages.length === 0 && !echo" class="muted">
              左のレポートを見て直したいところを書いてください（例:「列構成は細かすぎるので省く」
              「確認事項を主役にしたい」）。「提案から始める」を押すと、解析結果を踏まえた構成案と
              決めておきたい点を AI が出します。
            </p>
            <div v-for="m in messages" :key="m.id" class="wz-msg" :class="m.role">
              <span class="who">{{ m.role === 'user' ? '担当者' : 'AI' }}</span>
              <p class="wz-pre">{{ m.content }}</p>
              <!-- 実際に構成が変わったかを回答ごとに明示する（合意したのに反映されない、を防ぐ） -->
              <div v-if="m.role === 'assistant'" class="wz-applied">
                <template v-if="m.spec_patch">
                  <span class="badge ok">レポートに反映</span>
                  <span v-for="(c, i) in patchSummary(m.spec_patch)" :key="i" class="wz-tag">{{ c }}</span>
                </template>
                <span v-else class="badge">構成は変更なし</span>
              </div>
            </div>
            <!-- 押した瞬間の仮表示。サーバーの履歴に入り次第、上のリストへ置き換わる -->
            <div v-if="echo" class="wz-msg user sending">
              <span class="who">担当者</span>
              <p class="wz-pre">{{ echo }}</p>
              <span class="badge info">{{ sending ? '送信中…' : '送信しました' }}</span>
            </div>
            <p v-if="pending" class="wz-thinking"><span class="dots"><i></i><i></i><i></i></span>AI が考えています…</p>
          </div>
          <div class="wz-chat-input">
            <textarea
              v-model="input" rows="2" :disabled="busy"
              placeholder="直したいところ・載せたい/省きたい項目を書く（Ctrl+Enter で送信）"
              @keydown.ctrl.enter="send()"
            ></textarea>
            <div class="wz-actions">
              <button
                class="primary" :disabled="busy || (messages.length > 0 && !echo && !input.trim())"
                @click="send()"
              >
                {{ sending ? '送信中…' : pending ? 'AI が考えています…' : messages.length === 0 ? '提案から始める' : '送る' }}
              </button>
              <span v-if="notice" class="muted">{{ notice }}</span>
            </div>
          </div>
        </div>

        <!-- 要件定義（伺った内容）。数式からは出てこない指定を、資料から起こして確認する -->
        <details class="wz-card wz-spec" open>
          <summary class="wz-h">要件定義（伺った内容）</summary>
          <p class="muted">
            レポートの <b>02 再現するアウトプットの確認</b> になる部分です。
            数式には残らないため、<b>要件定義書・手順書が唯一の根拠</b>になります。
            資料から読み取って、言い回しを直してから保存してください。
          </p>

          <div class="wz-actions">
            <button :disabled="reqBusy || reqSaving" @click="readRequirements">
              {{ reqBusy ? '読み取り中…' : '業務資料から読み取る' }}
            </button>
            <button class="primary" :disabled="reqSaving || reqBusy" @click="saveRequirements">
              {{ reqSaving ? '保存中…' : 'この内容でレポートへ反映' }}
            </button>
            <span v-if="reqDirty" class="badge warn">未保存</span>
          </div>
          <p v-if="reqMsg" class="muted">{{ reqMsg }}</p>
          <ul v-if="reqNotes.length > 0" class="wz-list">
            <li v-for="(n, i) in reqNotes" :key="i" class="muted">{{ n }}</li>
          </ul>

          <h4 class="wz-h4">再現するもの（帳票）</h4>
          <div v-for="(r, i) in fReproduce" :key="`rp${i}`" class="wz-pair">
            <input v-model="r.label" placeholder="呼び名（例: 顧客別営業利益）" @input="reqDirty = true">
            <input v-model="r.text" placeholder="どのファイルのどのタブで、何を並べた表か" @input="reqDirty = true">
            <button class="link danger" @click="fReproduce.splice(i, 1); reqDirty = true">削除</button>
          </div>
          <button class="link" @click="fReproduce.push({ label: '', text: '' }); reqDirty = true">＋ 行を足す</button>

          <label class="wz-field">
            <span>作られ方（1行に1件。どのファイルから何を付与するか）</span>
            <textarea v-model="fHowMade" rows="4" @input="reqDirty = true"></textarea>
          </label>

          <label class="wz-field">
            <span>出典の呼び名（例: 要件定義シート（○○様_△△pjt）と試算手順）</span>
            <input v-model="fHowMadeSource" @input="reqDirty = true">
          </label>

          <label class="wz-field">
            <span>再現するうえでの前提（1行に1件。配賦の例外・未受領データの扱いなど）</span>
            <textarea v-model="fAssumptions" rows="4" @input="reqDirty = true"></textarea>
          </label>

          <h4 class="wz-h4">ファイルごとの備考（01 で開いた先頭に出ます）</h4>
          <div v-for="(n, i) in fFileNotes" :key="`fn${i}`" class="wz-pair">
            <select v-model="n.file" @change="reqDirty = true">
              <option value="">（ファイルを選ぶ）</option>
              <option v-for="f in facts?.files ?? []" :key="f.filename" :value="f.filename">{{ f.filename }}</option>
            </select>
            <input v-model="n.note" placeholder="例: アウトプット（月次）。対象タブは「メイン」" @input="reqDirty = true">
            <button class="link danger" @click="fFileNotes.splice(i, 1); reqDirty = true">削除</button>
          </div>
          <button class="link" @click="fFileNotes.push({ file: '', note: '' }); reqDirty = true">＋ 行を足す</button>
        </details>

        <!-- 構成の指定（手でも直せる） -->
        <details class="wz-card wz-spec" open>
          <summary class="wz-h">載せるものを直接選ぶ</summary>
          <template v-if="spec">
            <label class="wz-field">
              <span>表題（空なら既定）</span>
              <input :value="spec.title" placeholder="ご提供データの構造分析レポート" @change="saveText('title', ($event.target as HTMLInputElement).value)">
            </label>
            <label class="wz-field">
              <span>今回の重点（冒頭に出ます）</span>
              <input :value="spec.focus" placeholder="例: 手作業転記の洗い出し" @change="saveText('focus', ($event.target as HTMLInputElement).value)">
            </label>

            <h4 class="wz-h4">節</h4>
            <label v-for="k in sectionKeys" :key="k" class="wz-check">
              <input type="checkbox" :checked="spec.sections[k]" @change="toggleSection(k)">
              <span>{{ sectionLabels[k] }}</span>
            </label>

            <h4 class="wz-h4">項目</h4>
            <label v-for="k in itemKeys" :key="k" class="wz-check">
              <input type="checkbox" :checked="spec.items[k]" @change="toggleItem(k)">
              <span>{{ itemLabels[k] }}<em v-if="itemNote(k)" class="muted">（{{ itemNote(k) }}）</em></span>
            </label>

            <ul v-if="spec.notes.length > 0" class="wz-list">
              <li v-for="(n, i) in spec.notes" :key="i">補足: {{ n }}</li>
            </ul>

            <div class="wz-fixed-note">
              <b>固定（変更できません）</b>
              <ul>
                <li>表どうしの関係図（ノード形式）</li>
                <li>配色・レイアウト・書式</li>
                <li>原本のセル値は載せない</li>
              </ul>
            </div>
          </template>
        </details>
      </div>
    </div>
  </div>
</template>

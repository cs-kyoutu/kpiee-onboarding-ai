<script setup lang="ts">
// 新UI ステップ4: アウトプット相談。「このレポートに何を載せるか」を対話で決める。
//
// 案件ごとに顧客へ見せたい範囲が違うので、デザインと骨格は固定したまま構成だけを可変にする。
// 左が AI との相談、右が実際の指定（チェックリスト）。AI の提案はツール経由で右へ反映され、
// 担当者が右を直接触っても同じ場所に保存される（どちらが正でもよい形にする）。
//
// 関係図（ノード形式）はチェックリストに出さない。顧客と構造合意する本体なので外せない。
import { computed, onMounted, onUnmounted, ref } from 'vue'
import {
  getReportChat, sendReportChat, getReportSpec, saveReportSpec,
  type ReportChatMessage, type ReportFacts, type ReportSpec, type ReportSpecItems, type ReportSpecSections,
} from '../../api'

const props = defineProps<{ projectId: number }>()
const emit = defineEmits<{ changed: [] }>()

const messages = ref<ReportChatMessage[]>([])
const pending = ref(false)
const spec = ref<ReportSpec | null>(null)
const sectionLabels = ref<Record<string, string>>({})
const itemLabels = ref<Record<string, string>>({})
const facts = ref<ReportFacts | null>(null)
const input = ref('')
const error = ref('')
const savingSpec = ref(false)

const sectionKeys = computed(() => Object.keys(sectionLabels.value) as (keyof ReportSpecSections)[])
const itemKeys = computed(() => Object.keys(itemLabels.value) as (keyof ReportSpecItems)[])

/** 1ブック案件では全体関係図（ブック間）が出ないため、指定しても効かないことを明示する */
function itemDisabledNote(key: keyof ReportSpecItems): string {
  if (key === 'fileFlow' && facts.value && !facts.value.multiFile) return '1ブックのため出ません'
  return ''
}

async function loadSpec() {
  const d = await getReportSpec(props.projectId)
  spec.value = d.spec
  sectionLabels.value = d.sectionLabels
  itemLabels.value = d.itemLabels
  facts.value = d.facts
}

async function loadChat() {
  const d = await getReportChat(props.projectId)
  messages.value = d.messages
  pending.value = d.pending
  spec.value = d.spec
}

async function send(text?: string) {
  const message = (text ?? input.value).trim()
  error.value = ''
  try {
    await sendReportChat(props.projectId, message || undefined)
    input.value = ''
    pending.value = true
    await loadChat()
  } catch (e) {
    error.value = String(e)
  }
}

/** チェックリストの変更を即保存する（部分指定。押した項目だけが変わる） */
async function patchSpec(patch: Partial<ReportSpec>) {
  savingSpec.value = true
  error.value = ''
  try {
    const res = await saveReportSpec(props.projectId, patch)
    spec.value = res.spec
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

/** 相談を使わずに既定のまま進む場合も、指定として保存してステップを完了扱いにする */
function acceptDefaults() {
  if (!spec.value) return
  void patchSpec({ sections: spec.value.sections, items: spec.value.items })
}

// 応答は非同期に届くため、処理中だけポーリングする
let timer: ReturnType<typeof setInterval> | null = null
onMounted(async () => {
  await loadSpec()
  await loadChat()
  timer = setInterval(async () => {
    if (!pending.value) return
    await loadChat()
    if (!pending.value) await loadSpec() // 応答でツールが指定を書き替えている可能性がある
  }, 2500)
})
onUnmounted(() => { if (timer) clearInterval(timer) })
</script>

<template>
  <div class="wz-body">
    <p class="wz-lede">
      レポートの<b>デザインと骨格は固定</b>です。この案件で<b>どの項目を載せるか</b>を相談して決めます。
      表どうしの関係図（ノード形式）は必ず載ります。
    </p>
    <p v-if="error" class="error-box">{{ error }}</p>

    <div class="wz-chat-layout">
      <!-- 相談 -->
      <div class="wz-card wz-chat">
        <div class="wz-chat-log">
          <p v-if="messages.length === 0" class="muted">
            まだ相談していません。「提案から始める」を押すと、解析結果を踏まえた構成案と質問が出ます。
            相談せず既定（全項目）のまま進むこともできます。
          </p>
          <div v-for="m in messages" :key="m.id" class="wz-msg" :class="m.role">
            <span class="who">{{ m.role === 'user' ? '担当者' : 'AI' }}</span>
            <p class="wz-pre">{{ m.content }}</p>
            <span v-if="m.spec_patch" class="badge info">構成を更新しました</span>
          </div>
          <p v-if="pending" class="muted">AI が考えています…</p>
        </div>
        <div class="wz-chat-input">
          <textarea
            v-model="input" rows="2" :disabled="pending"
            placeholder="例: 列構成まで見せると細かすぎるので省きたい／確認事項を主役にしたい"
            @keydown.ctrl.enter="send()"
          ></textarea>
          <div class="wz-actions">
            <button v-if="messages.length === 0" class="primary" :disabled="pending" @click="send()">提案から始める</button>
            <button v-else class="primary" :disabled="pending || !input.trim()" @click="send()">送る（Ctrl+Enter）</button>
          </div>
        </div>
      </div>

      <!-- 指定（チェックリスト） -->
      <div class="wz-card wz-spec">
        <h3 class="wz-h">このレポートに載せるもの</h3>
        <p v-if="savingSpec" class="muted">保存中…</p>

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
            <span>{{ itemLabels[k] }}<em v-if="itemDisabledNote(k)" class="muted">（{{ itemDisabledNote(k) }}）</em></span>
          </label>

          <div class="wz-fixed-note">
            <b>固定（変更できません）</b>
            <ul>
              <li>表どうしの関係図（ノード形式）</li>
              <li>配色・レイアウト・書式</li>
              <li>原本のセル値は載せない</li>
            </ul>
          </div>

          <ul v-if="spec.notes.length > 0" class="wz-list">
            <li v-for="(n, i) in spec.notes" :key="i">補足: {{ n }}</li>
          </ul>

          <div class="wz-actions">
            <button @click="acceptDefaults">この構成で確定する</button>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

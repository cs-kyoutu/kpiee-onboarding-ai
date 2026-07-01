<script setup lang="ts">
// SC-02 プロジェクト詳細／進行ボード。
// ステッパー（アップロード→解読→検収→生成→照合→完了）と各画面のタブを持つ。
// パイプライン実行中は runs をポーリングして進捗を反映する。
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { get, post, type ProjectDetailData } from '../api'
import UploadPanel from '../components/UploadPanel.vue'
import ScriptsPanel from '../components/ScriptsPanel.vue'
import RelationsPanel from '../components/RelationsPanel.vue'
import ReviewPanel from '../components/ReviewPanel.vue'
import DeliverablesPanel from '../components/DeliverablesPanel.vue'
import MatchPanel from '../components/MatchPanel.vue'
import QuestionsPanel from '../components/QuestionsPanel.vue'
import ChatPanel from '../components/ChatPanel.vue'

const route = useRoute()
const projectId = Number(route.params.id)

const project = ref<ProjectDetailData | null>(null)
const tab = ref<'upload' | 'scripts' | 'relations' | 'review' | 'deliverables' | 'match' | 'questions' | 'chat'>('upload')
const error = ref('')
const refreshKey = ref(0) // 子パネルへ再読込を伝えるためのキー

const STEPS = [
  { key: 'upload', label: '① アップロード', desc: '顧客資料(Excel/CSV)を入れる' },
  { key: 'decode', label: '② AI解読', desc: '数式やシートの関係を読み取る' },
  { key: 'review', label: '③ 検収', desc: '読み取り結果を人が確認・承認' },
  { key: 'generate', label: '④ 成果物生成', desc: 'KPIEE 投入物を自動生成' },
  { key: 'match', label: '⑤ 数値照合', desc: '元帳票と数値が合うか検算' },
  { key: 'done', label: '⑥ 完了', desc: 'パッケージを出力' },
] as const

/** プロジェクト status からステッパーの現在位置を割り出す */
const stepIndex = computed(() => {
  switch (project.value?.status) {
    case 'draft': return 0
    case 'analyzing': return 1
    case 'reviewing': return 2
    case 'generating': return 3
    case 'matching': return 4
    case 'completed': return 5
    default: return 0
  }
})

const isRunning = computed(() => project.value?.runs.some(r => r.status === 'running') ?? false)
// 直近の実行が失敗したときだけ表示する（過去の失敗履歴は新しい成功実行で消える）
const lastFailedRun = computed(() => {
  const latest = project.value?.runs[0]
  return latest?.status === 'failed' ? latest : undefined
})
const hasArtifacts = computed(() => (project.value?.artifacts.length ?? 0) > 0)

/** 現在の状態から「次にやること」を案内する（迷わないように1アクションだけ強調） */
const guide = computed((): { text: string; action?: { label: string; stage: 'decode' | 'generate' | 'match' }; goTab?: typeof tab.value } => {
  if (isRunning.value) return { text: 'AI が処理中です。完了すると自動で結果が表示されます。' }
  const s = project.value?.status
  if (s === 'draft' || !s) {
    return hasArtifacts.value
      ? { text: '資料が揃いました。まず「② AI解読」を実行しましょう。', action: { label: '② AI解読を実行', stage: 'decode' } }
      : { text: 'まずは顧客から受け取った Excel / CSV をアップロードしてください。', goTab: 'upload' }
  }
  if (s === 'analyzing') return { text: '解読が終わると「③ 検収」に進めます。' }
  if (s === 'reviewing') return { text: '「③ 検収」で読み取り結果を確認・承認したら「④ 成果物生成」へ。', action: { label: '④ 成果物を生成', stage: 'generate' }, goTab: 'review' }
  if (s === 'generating') return { text: '「成果物」を確認し、問題なければ「⑤ 数値照合」で検算します。', action: { label: '⑤ 数値照合を実行', stage: 'match' }, goTab: 'deliverables' }
  if (s === 'matching') return { text: '照合結果を確認してください。' }
  if (s === 'completed') return { text: '完了しました。「📦 パッケージ出力」で成果物をダウンロードできます。', goTab: 'match' }
  return { text: '' }
})

async function runGuideAction() {
  const a = guide.value.action
  if (a) await startStage(a.stage)
}

let timer: ReturnType<typeof setInterval> | null = null

async function load() {
  project.value = await get<ProjectDetailData>(`/projects/${projectId}`)
}

async function startStage(stage: 'decode' | 'generate' | 'match') {
  error.value = ''
  try {
    await post(`/projects/${projectId}/pipeline/${stage}`)
    await load()
  } catch (e) {
    error.value = String(e)
  }
}

function downloadPackage() {
  // UC-08: 最終成果物5点セットの zip ダウンロード
  window.open(`/api/projects/${projectId}/package`, '_blank')
}

onMounted(async () => {
  await load()
  // 実行中ステータスの反映のため 2 秒間隔でポーリングする
  timer = setInterval(async () => {
    const wasRunning = isRunning.value
    await load()
    // 実行完了を検知したら子パネルを再読込する
    if (wasRunning && !isRunning.value) refreshKey.value++
  }, 2000)
})
onUnmounted(() => { if (timer) clearInterval(timer) })
</script>

<template>
  <div v-if="project">
    <div style="display: flex; justify-content: space-between; align-items: center">
      <h1>{{ project.customer_name }} <span class="muted">#{{ project.id }}</span></h1>
      <button @click="downloadPackage">📦 パッケージ出力（5点セット）</button>
    </div>
    <p class="muted">{{ project.description }}</p>

    <!-- ステッパー（各段階の意味つき） -->
    <div class="stepper">
      <div
        v-for="(s, i) in STEPS" :key="s.key" class="step"
        :class="{ active: i === stepIndex, done: i < stepIndex }"
      >
        <span class="step-label">{{ s.label }}</span>
        <span class="step-desc">{{ s.desc }}</span>
      </div>
    </div>

    <!-- 次にやること案内（迷わないように1アクションだけ強調） -->
    <div class="guide" :class="{ running: isRunning }">
      <span class="guide-icon">{{ isRunning ? '⏳' : '👉' }}</span>
      <span class="guide-text">{{ guide.text }}</span>
      <button v-if="guide.action" class="primary" :disabled="isRunning" @click="runGuideAction">{{ guide.action.label }}</button>
      <span v-if="isRunning" class="badge warn">処理中…</span>
    </div>

    <p v-if="error" class="error-box">{{ error }}</p>
    <p v-if="lastFailedRun && !isRunning" class="error-box">
      直近の実行（{{ lastFailedRun.stage }}）が失敗しました: {{ lastFailedRun.error }}
    </p>

    <!-- タブ -->
    <div class="tabs">
      <button :class="{ active: tab === 'upload' }" @click="tab = 'upload'">📥 資料アップロード</button>
      <button :class="{ active: tab === 'scripts' }" @click="tab = 'scripts'">📜 変換スクリプト</button>
      <button :class="{ active: tab === 'relations' }" @click="tab = 'relations'">🔗 シート関係</button>
      <button :class="{ active: tab === 'review' }" @click="tab = 'review'">✅ 解読検収</button>
      <button :class="{ active: tab === 'deliverables' }" @click="tab = 'deliverables'">📄 成果物</button>
      <button :class="{ active: tab === 'match' }" @click="tab = 'match'">🔢 数値照合</button>
      <button :class="{ active: tab === 'questions' }" @click="tab = 'questions'">💬 顧客確認事項</button>
      <button :class="{ active: tab === 'chat' }" @click="tab = 'chat'">🤖 AI Q&A</button>
    </div>

    <UploadPanel v-if="tab === 'upload'" :project-id="projectId" :artifacts="project.artifacts" @changed="load" />
    <ScriptsPanel v-else-if="tab === 'scripts'" :project-id="projectId" />
    <RelationsPanel v-else-if="tab === 'relations'" :project-id="projectId" :artifacts="project.artifacts" />
    <ReviewPanel v-else-if="tab === 'review'" :key="refreshKey" :project-id="projectId" :artifacts="project.artifacts" />
    <DeliverablesPanel v-else-if="tab === 'deliverables'" :key="refreshKey" :project-id="projectId" />
    <MatchPanel v-else-if="tab === 'match'" :key="refreshKey" :project-id="projectId" />
    <QuestionsPanel v-else-if="tab === 'questions'" :key="refreshKey" :project-id="projectId" />
    <ChatPanel v-else-if="tab === 'chat'" :project-id="projectId" />

    <!-- 手動操作（通常は上の案内に従えばOK。再実行などが必要なときだけ使う） -->
    <details class="manual-ops">
      <summary>手動でパイプラインを実行（再実行・上級者向け）</summary>
      <div class="toolbar" style="margin-top:10px">
        <button :disabled="isRunning" @click="startStage('decode')">▶ AI解読（P1）</button>
        <button :disabled="isRunning" @click="startStage('generate')">▶ 成果物生成（P2+P3）</button>
        <button :disabled="isRunning" @click="startStage('match')">▶ 数値照合（P4）</button>
      </div>
    </details>
  </div>
</template>

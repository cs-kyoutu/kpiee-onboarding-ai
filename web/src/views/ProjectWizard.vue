<script setup lang="ts">
// 新UI: 案件ごとの5ステップ。
//   ① データ取り込み（Google ドライブ）→ ② 分類確認 → ③ 構造解析 → ④ アウトプット相談 → ⑤ HTML 生成
//
// 従来UI（ProjectDetail.vue のタブ）は機能ごとの入口が10個並び、初見では「次に何をするか」が読めない。
// こちらは「1画面に1つの決めごと」に絞り、完了条件を満たすと次へ進める形にする。
// どちらが使いやすいか比べるため、両方を残して ProjectPage.vue のトグルで切り替える。
//
// ステップの完了はサーバー側の状態から導く（画面のフラグに頼らない。別端末・再読込でも同じに見える）:
//   ① 解析できたファイルが1件以上ある
//   ② roles_confirmed の印が立っている（人が分類を確定した。自動分類だけでは立たない）
//   ③ 関係グラフに表が1つ以上ある
//   ④ 構成指定が保存済み（相談でも手動チェックでも可）
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { get, getProjectRelations, getReportSpec, type ProjectDetailData } from '../api'
import DrivePickStep from '../components/wizard/DrivePickStep.vue'
import ClassifyStep from '../components/wizard/ClassifyStep.vue'
import AnalyzeStep from '../components/wizard/AnalyzeStep.vue'
import OutputChatStep from '../components/wizard/OutputChatStep.vue'
import OutputStep from '../components/wizard/OutputStep.vue'

const props = defineProps<{ projectId: number }>()

const project = ref<ProjectDetailData | null>(null)
const step = ref(1)
const regionCount = ref(0)
const specConfigured = ref(false)
const error = ref('')

const STEPS = [
  { no: 1, label: 'データ取り込み', desc: 'ドライブから案件のファイルを選ぶ' },
  { no: 2, label: '分類確認', desc: 'インプット / マスタ / 中間 / 最終アウトプット' },
  { no: 3, label: '構造解析', desc: '表どうしの関係を解析して確認' },
  { no: 4, label: 'アウトプット相談', desc: '何を載せるか AI と決める' },
  { no: 5, label: 'HTML 生成', desc: '確認してダウンロード' },
] as const

const parsedArtifacts = computed(() => project.value?.artifacts.filter(a => a.parse_status === 'done') ?? [])
const done = computed(() => ({
  1: parsedArtifacts.value.length > 0,
  2: parsedArtifacts.value.length > 0 && (project.value?.flags ?? []).includes('roles_confirmed'),
  3: regionCount.value > 0,
  4: specConfigured.value,
  5: false,
}) as Record<number, boolean>)

/** そのステップを開いてよいか（前のステップが終わっているか） */
function reachable(no: number): boolean {
  for (let i = 1; i < no; i++) if (!done.value[i]) return false
  return true
}

const blockedReason = computed(() => {
  if (reachable(step.value)) return ''
  if (!done.value[1]) return 'まずファイルを取り込んでください。'
  if (!done.value[2]) return 'シートの分類を確定してください。'
  if (!done.value[3]) return '表が検出されていません。取り込んだファイルを確認してください。'
  if (!done.value[4]) return 'アウトプットの構成を確定してください。'
  return ''
})

async function load() {
  error.value = ''
  try {
    project.value = await get<ProjectDetailData>(`/projects/${props.projectId}`)
    // 関係グラフと構成指定は解析対象が無ければ 404 になり得るので、失敗は「未達」として扱う
    try {
      regionCount.value = (await getProjectRelations(props.projectId)).regions.length
    } catch {
      regionCount.value = 0
    }
    try {
      specConfigured.value = (await getReportSpec(props.projectId)).configured
    } catch {
      specConfigured.value = false
    }
  } catch (e) {
    error.value = String(e)
  }
}

function goto(no: number) {
  if (reachable(no)) step.value = no
}

function next() {
  if (step.value < 5 && reachable(step.value + 1)) step.value++
}

// パイプライン実行中は状態が変わるのでポーリングする（従来UI と同じ間隔）
let timer: ReturnType<typeof setInterval> | null = null
onMounted(async () => {
  await load()
  // 初回は「今やるべきところ」から始める
  step.value = [1, 2, 3, 4].find(n => !done.value[n]) ?? 5
  timer = setInterval(() => {
    if (project.value?.runs.some(r => r.status === 'running')) void load()
  }, 2500)
})
onUnmounted(() => { if (timer) clearInterval(timer) })

// 子から変更が来たら状態を取り直す（取り込み・分類確定・構成保存）
watch(step, () => { void load() })
</script>

<template>
  <div v-if="project" class="wizard">
    <div class="wz-head">
      <h1>{{ project.customer_name }} <span class="muted">#{{ project.id }}</span></h1>
      <p v-if="project.description" class="muted">{{ project.description }}</p>
    </div>

    <ol class="wz-steps">
      <li
        v-for="s in STEPS" :key="s.no"
        :class="{ active: step === s.no, done: done[s.no], locked: !reachable(s.no) }"
        @click="goto(s.no)"
      >
        <span class="no">{{ done[s.no] ? '✓' : s.no }}</span>
        <span class="tx"><b>{{ s.label }}</b><em>{{ s.desc }}</em></span>
      </li>
    </ol>

    <p v-if="error" class="error-box">{{ error }}</p>
    <p v-if="blockedReason" class="guide">{{ blockedReason }}</p>

    <div class="wz-panel">
      <DrivePickStep
        v-if="step === 1" :project-id="props.projectId" :artifacts="project.artifacts" @changed="load"
      />
      <ClassifyStep
        v-else-if="step === 2" :project-id="props.projectId" :artifacts="project.artifacts" @changed="load"
      />
      <AnalyzeStep
        v-else-if="step === 3" :project-id="props.projectId" :runs="project.runs" @changed="load"
      />
      <OutputChatStep v-else-if="step === 4" :project-id="props.projectId" @changed="load" />
      <OutputStep v-else :project-id="props.projectId" />
    </div>

    <div class="wz-nav">
      <button :disabled="step === 1" @click="step--">← 戻る</button>
      <span class="muted">{{ step }} / {{ STEPS.length }}</span>
      <button class="primary" :disabled="step === 5 || !reachable(step + 1)" @click="next">次へ →</button>
    </div>
  </div>
</template>

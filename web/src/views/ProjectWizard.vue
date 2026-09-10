<script setup lang="ts">
// 案件ごとの5ステップ。
//   ① 資料・データ取り込み → ② 分類確認 → ③ 構造把握 → ④ レポート作成 → ⑤ SQL構築
//
// 以前は機能ごとのタブ（ProjectDetail.vue）が10個並ぶ従来UI と併存していたが、
// この4つ以外の入口（解読検収・成果物生成・数値照合・顧客確認事項・AI Q&A）は
// レポート作成の流れに関係しないため畳んだ。構造把握に必要な入口（シート関係・ブック関係・要確認）は
// ステップ3の中へ移し、数式に残らない前提（業務資料・Apps Script）はステップ1の中へ移した。
//
// ④ は「相談」と「出来上がりの確認」を1画面にまとめている。何を直したいかは実物を見て初めて
// 出てくるため、プレビューを見ながら相談し、その場で作り直せる形にした。
//
// ステップの完了はサーバー側の状態から導く（画面のフラグに頼らない。別端末・再読込でも同じに見える）:
//   ① 解析できたファイルが1件以上ある
//   ② roles_confirmed の印が立っている（人が分類を確定した。自動分類だけでは立たない）
// 関係グラフ（重い処理）はこの画面では取らない。必要な「構造解析」の画面だけが取る。
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { get, type ProjectDetailData, type ProjectDoc } from '../api'
import DrivePickStep from '../components/wizard/DrivePickStep.vue'
import DocsPanel from '../components/wizard/DocsPanel.vue'
import ClassifyStep from '../components/wizard/ClassifyStep.vue'
import AnalyzeStep from '../components/wizard/AnalyzeStep.vue'
import OutputStep from '../components/wizard/OutputStep.vue'
import SqlBuildStep from '../components/wizard/SqlBuildStep.vue'

const props = defineProps<{ projectId: number }>()

/** データ取り込みで開いているドライブフォルダ。資料の受け口の初期表示に渡す */
const dataFolder = ref<{ id?: string; name: string }>({ name: 'マイドライブ' })

// ?step=2 で開始位置を指定できる（「分類のところを見て」と URL で渡せるように）
const route = useRoute()

const project = ref<ProjectDetailData | null>(null)
const step = ref(1)
const error = ref('')

const STEPS = [
  { no: 1, label: '資料・データ取り込み', desc: '案件のファイルと、要件定義書・手順書を入れる' },
  { no: 2, label: '分類確認', desc: 'インプット / マスタ / 中間 / 最終アウトプット' },
  { no: 3, label: '構造把握', desc: 'シート関係・ブック関係・要確認を見る' },
  { no: 4, label: 'レポート作成', desc: '出来上がりを見ながら相談・修正して出力' },
  { no: 5, label: 'SQL構築', desc: '読み合わせ後、SQLジョブを対話で組み立てる' },
] as const

const parsedArtifacts = computed(() => project.value?.artifacts.filter(a => a.parse_status === 'done') ?? [])
/** 解析がまだ走っているファイル。ある間は次へ進ませない（半分の状態で分類・解析を見せない） */
const parsingArtifacts = computed(() =>
  project.value?.artifacts.filter(a => a.parse_status !== 'done' && a.parse_status !== 'failed') ?? [])
/** 要件定義書・手順書（本文が読めたもの）。ステップ1の必須条件 */
const docs = ref<ProjectDoc[]>([])
const hasDocs = computed(() => docs.value.some(d => d.kind === 'doc' && d.text_length > 0))

const done = computed(() => ({
  // データが解析済みで、解析中のファイルが残っておらず、要件定義書が入っていること。
  // 要件定義書を必須にするのは、無いまま進むと分類・関係・レポートの要件が全部空で出て
  // 「生成が違う」となるため（協和の再現で実際に起きた）。
  1: parsedArtifacts.value.length > 0 && parsingArtifacts.value.length === 0 && hasDocs.value,
  2: parsedArtifacts.value.length > 0 && (project.value?.flags ?? []).includes('roles_confirmed'),
  3: true, // 解析結果の確認。ここで止める条件は無い（表0件なら画面側で警告を出す）
  4: true, // レポートは何度でも作り直す場所。ここで止めると SQL構築へ進めない
  5: false, // 最終ステップ
}) as Record<number, boolean>)

/** そのステップを開いてよいか（前のステップが終わっているか） */
function reachable(no: number): boolean {
  for (let i = 1; i < no; i++) if (!done.value[i]) return false
  return true
}

/** 「次へ」を押せない理由。押せないボタンだけ見せると「なぜ？」になるので、理由を常に添える */
const nextBlockedReason = computed(() => {
  if (step.value >= STEPS.length || reachable(step.value + 1)) return ''
  if (step.value === 1) {
    if (parsedArtifacts.value.length === 0) return 'まずデータ（Excel / CSV）を取り込んでください。'
    if (parsingArtifacts.value.length > 0) {
      return `ファイルを解析しています（残り ${parsingArtifacts.value.length} 件）。終わると次へ進めます。`
    }
    if (!hasDocs.value) return '要件定義書・手順書を入れてください（下の「要件定義書・手順書の取り込み」から。次へ進む必須条件です）。'
  }
  if (step.value === 2 && !done.value[2]) return '「この分類で確定する」を押すと次へ進めます。'
  return ''
})

const blockedReason = computed(() => {
  if (reachable(step.value)) return ''
  if (!done.value[1]) return nextBlockedReason.value || 'まずステップ1（資料・データ取り込み）を終えてください。'
  if (!done.value[2]) return 'シートの分類を確定してください。'
  return ''
})

async function load() {
  error.value = ''
  try {
    const [p, d] = await Promise.all([
      get<ProjectDetailData>(`/projects/${props.projectId}`),
      get<ProjectDoc[]>(`/projects/${props.projectId}/docs`).catch(() => [] as ProjectDoc[]),
    ])
    project.value = p
    docs.value = d
  } catch (e) {
    error.value = String(e)
  }
}

function goto(no: number) {
  if (reachable(no)) step.value = no
}

function next() {
  if (step.value < STEPS.length && reachable(step.value + 1)) step.value++
}

// パイプライン実行中は状態が変わるのでポーリングする
let timer: ReturnType<typeof setInterval> | null = null
onMounted(async () => {
  await load()
  // 初回は URL 指定があればそこ、無ければ「今やるべきところ」から始める
  const q = Number(route.query.step)
  step.value = q >= 1 && q <= STEPS.length && reachable(q)
    ? q
    : ([1, 2, 3].find(n => !done.value[n]) ?? 4)
  timer = setInterval(() => {
    if (document.hidden) return
    // パイプライン実行中と、取り込んだファイルの解析中は状態が変わるので取り直す
    // （解析が終わった瞬間に「次へ」が押せるようになる）
    if (project.value?.runs.some(r => r.status === 'running') || parsingArtifacts.value.length > 0) void load()
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
      <Transition name="wz-step" mode="out-in">
      <div :key="step" class="wz-step-body">
      <!-- ① データと資料。受け口は分けるが、同じフォルダから拾えるよう1画面に置く -->
      <template v-if="step === 1">
        <DrivePickStep
          :project-id="props.projectId" :artifacts="project.artifacts"
          @changed="load" @folder="dataFolder = $event"
        />
        <DocsPanel
          :project-id="props.projectId" :folder-id="dataFolder.id" :folder-name="dataFolder.name"
          @changed="load"
        />
      </template>
      <ClassifyStep
        v-else-if="step === 2" :project-id="props.projectId" :artifacts="project.artifacts"
        :confirmed="(project.flags ?? []).includes('roles_confirmed')" @changed="load"
      />
      <AnalyzeStep
        v-else-if="step === 3" :project-id="props.projectId" :artifacts="project.artifacts"
        :runs="project.runs" @changed="load"
      />
      <OutputStep v-else-if="step === 4" :project-id="props.projectId" @changed="load" />
      <SqlBuildStep v-else :project-id="props.projectId" />
      </div>
      </Transition>
    </div>

    <div class="wz-nav">
      <button :disabled="step === 1" @click="step--">← 戻る</button>
      <span class="muted">{{ step }} / {{ STEPS.length }}</span>
      <!-- 押せない理由をボタンの隣に常に出す（灰色のボタンだけだと「なぜ？」で止まる） -->
      <span v-if="nextBlockedReason" class="wz-nav-reason">
        <span v-if="parsingArtifacts.length > 0" class="wz-spinner wz-spinner-sm"></span>
        {{ nextBlockedReason }}
      </span>
      <button class="primary" :disabled="step === STEPS.length || !reachable(step + 1)" @click="next">次へ →</button>
    </div>
  </div>
</template>

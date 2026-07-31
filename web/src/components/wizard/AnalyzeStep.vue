<script setup lang="ts">
// 新UI ステップ3: 構造解析の実行と結果確認。
//
// 関係解析（数式・値一致からの関係グラフ）は取り込み時に済んでいるため、ここでは結果を見せる。
// AI 解読（decode）は任意。関係図とレポートは AI 無しでも出るので、必須にはしない
// （待ち時間と費用が要る処理を通過条件にすると、レポートまで辿り着けない案件が出る）。
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { get, post, getProjectRelations, type AnalysisRun, type RelationGraph } from '../../api'

const props = defineProps<{ projectId: number; runs: AnalysisRun[] }>()
const emit = defineEmits<{ changed: [] }>()

const graph = ref<RelationGraph | null>(null)
const attention = ref<{ total: number; kinds: { kind: string; count: number }[] } | null>(null)
const loading = ref(true)
const error = ref('')

const running = computed(() => props.runs.some(r => r.status === 'running'))
const lastDecode = computed(() => props.runs.find(r => r.stage === 'decode'))
const decoded = computed(() => graph.value?.hasFindings === true)

const copyPairs = computed(() => {
  const g = graph.value
  if (!g) return 0
  const seen = new Set(g.edges.filter(e => e.type === 'copy').map(e => `${e.from}>${e.to}`))
  return seen.size
})

async function load() {
  loading.value = true
  error.value = ''
  try {
    graph.value = await getProjectRelations(props.projectId)
    attention.value = await get(`/projects/${props.projectId}/attention`)
  } catch (e) {
    error.value = String(e)
  } finally {
    loading.value = false
  }
}

async function runDecode() {
  error.value = ''
  try {
    await post(`/projects/${props.projectId}/pipeline/decode`)
    emit('changed')
  } catch (e) {
    error.value = String(e)
  }
}

// 解析中は結果が変わるので、実行が終わったタイミングで読み直す
let timer: ReturnType<typeof setInterval> | null = null
onMounted(async () => {
  await load()
  timer = setInterval(async () => {
    if (running.value) { emit('changed'); return }
    if (graph.value?.hasFindings !== true && lastDecode.value?.status === 'done') await load()
  }, 3000)
})
onUnmounted(() => { if (timer) clearInterval(timer) })
</script>

<template>
  <div class="wz-body">
    <p class="wz-lede">
      取り込んだファイルの数式・値の一致から、表どうしの関係を解析しました。
      内容を確認して次のステップへ進んでください。
    </p>

    <p v-if="error" class="error-box">{{ error }}</p>
    <p v-if="loading" class="muted">解析結果を読み込み中…</p>

    <template v-else-if="graph">
      <div class="wz-tiles">
        <div class="wz-tile"><span class="tl">検出した表</span><span class="tv">{{ graph.regions.length }}</span></div>
        <div class="wz-tile"><span class="tl">表どうしの関係</span><span class="tv">{{ (graph.edgeTotal ?? graph.edges.length).toLocaleString() }}</span></div>
        <div class="wz-tile" :class="{ warn: copyPairs > 0 }">
          <span class="tl">手作業コピー推定</span><span class="tv">{{ copyPairs }}</span>
        </div>
        <div class="wz-tile" :class="{ warn: (attention?.total ?? 0) > 0 }">
          <span class="tl">要確認</span><span class="tv">{{ attention?.total ?? 0 }}</span>
        </div>
      </div>

      <div v-if="graph.regions.length === 0" class="wz-card">
        <p class="badge ng">表を検出できませんでした</p>
        <p class="muted">
          取り込んだファイルが空か、表として認識できない形式の可能性があります。
          前のステップでファイルを確認してください。
        </p>
      </div>

      <div class="wz-card">
        <h3 class="wz-h">AI 解読（任意）</h3>
        <p class="muted">
          数式の意味づけ・kpiee 機能への対応づけを AI が行います。レポートの関係図・確認事項は解読なしでも出ますが、
          解読するとロジックの説明が具体的になります。
        </p>
        <div class="wz-actions">
          <span v-if="decoded" class="badge ok">解読済み</span>
          <span v-else-if="running" class="badge warn">実行中…</span>
          <span v-else-if="lastDecode?.status === 'failed'" class="badge ng">前回失敗: {{ lastDecode.error }}</span>
          <span v-else class="badge info">未実行</span>
          <button :disabled="running || graph.regions.length === 0" @click="runDecode">
            {{ decoded ? '再解読する' : 'AI 解読を実行' }}
          </button>
        </div>
      </div>

      <div v-if="graph.overview?.summary" class="wz-card">
        <h3 class="wz-h">全体構造のサマリ（AI 解読）</h3>
        <p class="wz-pre">{{ graph.overview.summary }}</p>
      </div>

      <div v-if="attention && attention.total > 0" class="wz-card">
        <h3 class="wz-h">要確認の内訳</h3>
        <ul class="wz-list">
          <li v-for="k in attention.kinds" :key="k.kind">{{ k.kind }}: {{ k.count }} 件</li>
        </ul>
        <p class="muted">これらは次のレポートで「ご確認いただきたい点」として顧客に問いかける材料になります。</p>
      </div>
    </template>
  </div>
</template>

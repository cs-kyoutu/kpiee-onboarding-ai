<script setup lang="ts">
// ステップ3: 構造把握。解析結果の確認と、掘り下げの入口。
//
// 関係解析（数式・値一致からの関係グラフ）は取り込み時に済んでいるため、ここでは結果を見せる。
// AI 解読（decode）は任意。関係図とレポートは AI 無しでも出るので、必須にはしない
// （待ち時間と費用が要る処理を通過条件にすると、レポートまで辿り着けない案件が出る）。
//
// 掘り下げは中で切り替える:
//   シート関係 … 表どうしの関係グラフ（クリックで掘り下げ）
//   ブック関係 … ファイル間の受け渡しの登録。Excel の数式はファイルを跨げないため、
//                ここで登録した業務知識だけが顧客レポートの全体関係図の根拠になる
//   要確認     … 判断がつかなかった点の内訳
// どれも重い処理（関係グラフの読み込み）を伴うので、開いたときに初めて描く
// （タブを1枚めくるたびに全部読み込むと、目録の表示まで待たされる）。
import { computed, onMounted, onUnmounted, ref } from 'vue'
import {
  get, post, getProjectRelations, type AnalysisRun, type Artifact, type RelationGraph,
} from '../../api'
import RelationsPanel from '../RelationsPanel.vue'
import FileRelationsPanel from '../FileRelationsPanel.vue'
import AttentionPanel from '../AttentionPanel.vue'

const props = defineProps<{ projectId: number; artifacts: Artifact[]; runs: AnalysisRun[] }>()
const emit = defineEmits<{ changed: [] }>()

type View = 'summary' | 'sheets' | 'books' | 'attention'
const view = ref<View>('summary')
const VIEWS: { key: View; label: string; hint: string }[] = [
  { key: 'summary', label: '概要', hint: '解析できた件数と AI 解読' },
  { key: 'sheets', label: 'シート関係', hint: '表どうしの関係を掘り下げる' },
  { key: 'books', label: 'ブック関係', hint: 'ファイル間の受け渡しを登録する（レポートの全体関係図の根拠）' },
  { key: 'attention', label: '要確認', hint: '判断がつかなかった点' },
]

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
      <b>ブック関係</b>だけは自動では出せないため（Excel の数式はファイルを跨げません）、
      伺った受け渡しをそこで登録してください。
    </p>

    <div class="wz-subtabs">
      <button
        v-for="v in VIEWS" :key="v.key" :class="{ on: view === v.key }" :title="v.hint"
        @click="view = v.key"
      >{{ v.label }}</button>
    </div>

    <!-- 掘り下げ（開いたときに初めて描く。関係グラフの読み込みが重いため） -->
    <RelationsPanel
      v-if="view === 'sheets'" :project-id="props.projectId" :artifacts="props.artifacts"
      @open-attention="view = 'attention'"
    />
    <FileRelationsPanel
      v-else-if="view === 'books'" :project-id="props.projectId" @changed="emit('changed')"
    />
    <AttentionPanel v-else-if="view === 'attention'" :project-id="props.projectId" />

    <template v-else>
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
        <p class="muted">
          これらは次のレポートで「ご確認いただきたい点」として顧客に問いかける材料になります。
          <button class="link" @click="view = 'attention'">1件ずつ見る</button>
        </p>
      </div>
    </template>
    </template>
  </div>
</template>

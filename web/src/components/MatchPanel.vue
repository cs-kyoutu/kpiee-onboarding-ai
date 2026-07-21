<script setup lang="ts">
// SC-06 数値照合 + KPIEE 実装プレビュー。
// これまでは「生成 SQL を実行して帳票と突き合わせる」だけだったが、report_config 層
// （集計・カスタム数式）まで含めて KPIEE 上の最終帳票を再現し、
//   ・Tier1: 各項目/指標が KPIEE でどう実装されるか／実装不可か（実装可否）
//   ・Tier2: 再現レポート vs 顧客帳票の突き合わせ
// を表示する。従来の SQL 単体照合は折りたたみに退避（画面を煩雑にしないため）。
import { computed, onMounted, ref } from 'vue'
import { get, getKpieePreview, getKpieeImplReport, type MatchResult, type KpieePreview, type ImplReport } from '../api'

const props = defineProps<{ projectId: number }>()

const preview = ref<KpieePreview | null>(null)
const impl = ref<ImplReport | null>(null)
const result = ref<MatchResult | null>(null)
const loading = ref(true)
const selected = ref<MatchResult['mismatches'][0] | null>(null)

const CAUSE_LABELS: Record<string, string> = {
  rounding: '丸め誤差', manual_input: '手入力の可能性', logic_missing: 'ロジック未再現',
  data_issue: 'データ起因', unknown: '原因不明',
}
const STATUS_LABEL: Record<string, string> = { ok: '✅ 実装可', warn: '⚠ 要注意', blocked: '⛔ 実装不可/欠落' }

const cmp = computed(() => preview.value?.comparison ?? null)
const matchRate = computed(() => cmp.value?.matchRate ?? 0)
const rateColor = computed(() => matchRate.value >= 0.99 ? '#1a7f37' : matchRate.value >= 0.8 ? '#92600a' : '#b91c1c')

const fmt = (v: string | number | null): string => v === null || v === undefined || v === '' ? '' : typeof v === 'number' ? v.toLocaleString() : String(v)

async function loadAll() {
  loading.value = true
  try {
    const [pv, im, mr] = await Promise.all([
      getKpieePreview(props.projectId).catch(() => null),
      getKpieeImplReport(props.projectId).catch(() => null),
      get<MatchResult | null>(`/projects/${props.projectId}/match-results`).catch(() => null),
    ])
    preview.value = pv
    impl.value = im
    result.value = mr
  } finally {
    loading.value = false
  }
}
onMounted(loadAll)
</script>

<template>
  <div v-if="loading" class="muted panel">KPIEE 実装プレビューを読み込み中…</div>
  <div v-else-if="preview && !preview.available" class="muted panel">{{ preview.message }}</div>
  <div v-else-if="preview">
    <!-- ①ヘッドライン: 帳票再現の一致率 -->
    <div v-if="cmp" class="panel">
      <h2>KPIEE 上での再現度（成果物を投入したときに帳票が再現されるか）</h2>
      <div style="display:flex; gap:24px; align-items:center">
        <div style="font-size:32px; font-weight:700" :style="{ color: rateColor }">{{ (matchRate * 100).toFixed(1) }}%</div>
        <div>
          <div>対象セル: {{ cmp.total }} ／ 一致: <span style="color:#1a7f37">{{ cmp.matched }}</span> ／ 不一致: <span style="color:#b91c1c">{{ cmp.total - cmp.matched }}</span></div>
          <div v-if="cmp.missingColumns.length" class="badge ng" style="margin-top:6px">
            ⛔ 帳票にあるが KPIEE で欠落する列: {{ cmp.missingColumns.join(', ') }}
          </div>
        </div>
      </div>
      <p class="muted" style="margin-top:8px">
        ※ ローカル近似（DuckDB 実行）です。Snowflake の型・丸め・期間バケット・会計設定は未反映。厳密検証は実 API 投入（Phase 2）で行います。
      </p>
    </div>

    <!-- ②再現レポート vs 顧客帳票（並べて表示） -->
    <div class="panel">
      <h2>レポート再現 ⟷ 顧客帳票</h2>
      <p class="muted">左＝report_config を適用して KPIEE が描くであろう表 ／ 右＝顧客の最終帳票（正解）。</p>
      <div style="display:flex; gap:24px; flex-wrap:wrap">
        <div v-if="preview.rendered">
          <h3>② KPIEE 再現レポート</h3>
          <table>
            <thead><tr><th>{{ preview.rendered.groupCol }}</th><th v-for="m in preview.rendered.metricNames" :key="m">{{ m }}</th></tr></thead>
            <tbody>
              <tr v-for="row in preview.rendered.rows" :key="row.key">
                <td>{{ row.key }}</td>
                <td v-for="(c, i) in row.cells" :key="i" style="text-align:right">{{ fmt(c) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-if="preview.finalOutput">
          <h3>③ 顧客の最終帳票</h3>
          <table>
            <thead><tr><th v-for="(h, i) in preview.finalOutput.header" :key="i">{{ h }}</th></tr></thead>
            <tbody>
              <tr v-for="(row, r) in preview.finalOutput.rows" :key="r">
                <td v-for="(c, i) in row" :key="i" :style="{ textAlign: i === 0 ? 'left' : 'right' }">{{ fmt(c) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div v-if="cmp && cmp.mismatches.length" style="margin-top:12px">
        <h3>不一致セル</h3>
        <table>
          <thead><tr><th>行</th><th>列</th><th>帳票（期待）</th><th>KPIEE 再現</th></tr></thead>
          <tbody>
            <tr v-for="(m, i) in cmp.mismatches" :key="i" class="cell-mismatch-row">
              <td>{{ m.label }}</td><td>{{ m.column }}</td>
              <td style="text-align:right">{{ m.expected.toLocaleString() }}</td>
              <td style="text-align:right">{{ m.actual === null ? '—' : m.actual.toLocaleString() }}</td>
            </tr>
          </tbody>
        </table>
        <p class="muted">不一致は「顧客帳票の手入力・丸め」か「ロジック未再現」のどちらかです。前者は顧客確認事項へ、後者は検収を直して再生成してください。</p>
      </div>
      <p v-if="preview.notes && preview.notes.length" class="muted" style="margin-top:8px">
        <span v-for="(n, i) in preview.notes" :key="i" style="display:block">・{{ n }}</span>
      </p>

      <!-- SQLジョブ出力（データファイル）は詳細確認用に折りたたみ -->
      <details v-if="preview.dataFile" style="margin-top:10px">
        <summary class="muted">① SQLジョブ出力（＝KPIEE データファイル）と SQL を見る</summary>
        <pre class="code" style="white-space:pre-wrap; margin-top:8px">{{ preview.sql }}</pre>
        <table style="margin-top:8px">
          <thead><tr><th v-for="c in preview.dataFile.columns" :key="c">{{ c }}</th></tr></thead>
          <tbody>
            <tr v-for="(row, r) in preview.dataFile.rows" :key="r">
              <td v-for="(c, i) in row" :key="i" :style="{ textAlign: i === 0 ? 'left' : 'right' }">{{ fmt(c) }}</td>
            </tr>
          </tbody>
        </table>
      </details>
    </div>

    <!-- ③KPIEE 実装可否（Tier1） -->
    <div v-if="impl && impl.available" class="panel">
      <h2>KPIEE 実装可否</h2>
      <div style="margin-bottom:8px">
        <span class="badge ok">実装可 {{ impl.summary.ok }}</span>
        <span class="badge warn" style="margin-left:6px">要注意 {{ impl.summary.warn }}</span>
        <span class="badge ng" style="margin-left:6px">実装不可/欠落 {{ impl.summary.blocked }}</span>
      </div>
      <table>
        <thead><tr><th>対象</th><th>判定</th><th>KPIEE 実装方法 / 理由</th></tr></thead>
        <tbody>
          <tr v-for="(it, i) in impl.items" :key="i">
            <td class="mono">{{ it.source }}</td>
            <td><span class="badge" :class="it.status === 'ok' ? 'ok' : it.status === 'warn' ? 'warn' : 'ng'">{{ STATUS_LABEL[it.status] }}</span></td>
            <td>{{ it.how }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 従来: SQL 単体の照合（詳細確認用に折りたたみ） -->
    <details v-if="result" class="panel">
      <summary>SQL 単体の照合結果（従来・詳細）</summary>
      <div style="margin-top:10px">
        <div>対象セル: {{ result.total_cells }} ／ 一致: {{ result.matched_cells }} ／ 不一致: {{ result.total_cells - result.matched_cells }}</div>
        <table v-if="result.mismatches.length" style="margin-top:8px">
          <thead><tr><th>セル</th><th>行</th><th>列</th><th>期待</th><th>生成値</th><th>原因</th></tr></thead>
          <tbody>
            <tr v-for="m in result.mismatches" :key="m.cell_ref" class="cell-mismatch-row" style="cursor:pointer" @click="selected = m">
              <td class="mono">{{ m.cell_ref }}</td><td>{{ m.row_label }}</td><td>{{ m.column }}</td>
              <td style="text-align:right">{{ m.expected.toLocaleString() }}</td>
              <td style="text-align:right">{{ m.actual === null ? '—' : m.actual.toLocaleString() }}</td>
              <td><span class="badge warn">{{ CAUSE_LABELS[m.cause_category] ?? m.cause_category }}</span></td>
            </tr>
          </tbody>
        </table>
        <p v-if="selected" class="muted" style="margin-top:8px">{{ selected.cell_ref }}: {{ selected.explanation }}</p>
      </div>
    </details>
  </div>
  <div v-else class="muted panel">照合データがありません。成果物生成後に「▶ 数値照合」を実行してください。</div>
</template>

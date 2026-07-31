<script setup lang="ts">
// 新UI ステップ5: レポート HTML の生成・確認・ダウンロード。
//
// 生成は保存済みの解析結果＋構成指定から決定的に行う（AI 呼び出しなし）ので、
// 「確認して、直したければ前のステップへ戻ってまた出す」を何度でも繰り返せる。
import { computed, onMounted, ref } from 'vue'
import { getReportSpec, reportUrl, type ReportFacts, type ReportSpec } from '../../api'

const props = defineProps<{ projectId: number }>()

const spec = ref<ReportSpec | null>(null)
const facts = ref<ReportFacts | null>(null)
const sectionLabels = ref<Record<string, string>>({})
const itemLabels = ref<Record<string, string>>({})
const error = ref('')
// プレビューは iframe。開くまで読み込まない（レポート生成は軽くはない）
const previewOn = ref(false)
// 生成し直したときに iframe を作り替えるための連番
const reloadKey = ref(0)

const previewSrc = computed(() => `${reportUrl(props.projectId, true)}&v=${reloadKey.value}`)

const onSections = computed(() =>
  spec.value ? Object.entries(spec.value.sections).filter(([, v]) => v).map(([k]) => sectionLabels.value[k] ?? k) : [])
const offSections = computed(() =>
  spec.value ? Object.entries(spec.value.sections).filter(([, v]) => !v).map(([k]) => sectionLabels.value[k] ?? k) : [])
const offItems = computed(() =>
  spec.value ? Object.entries(spec.value.items).filter(([, v]) => !v).map(([k]) => itemLabels.value[k] ?? k) : [])

function download() {
  window.open(reportUrl(props.projectId), '_blank')
}

onMounted(async () => {
  try {
    const d = await getReportSpec(props.projectId)
    spec.value = d.spec
    facts.value = d.facts
    sectionLabels.value = d.sectionLabels
    itemLabels.value = d.itemLabels
  } catch (e) {
    error.value = String(e)
  }
})
</script>

<template>
  <div class="wz-body">
    <p class="wz-lede">
      構成にもとづいて HTML を生成します。1ファイルで完結する資料なので、そのまま顧客へ共有できます
      （原本のセル値は含まれません）。
    </p>
    <p v-if="error" class="error-box">{{ error }}</p>

    <div class="wz-card">
      <h3 class="wz-h">生成される内容</h3>
      <ul class="wz-list">
        <li v-if="facts">対象: {{ facts.files.length }} ファイル ／ {{ facts.regionCount }} 表 ／ 関係 {{ facts.edgeCount.toLocaleString() }} 件</li>
        <li v-if="facts">確認事項: {{ facts.questionCount }} 件（手作業コピー推定 {{ facts.copyPairCount }} 組）</li>
        <li>載せる節: {{ onSections.join(' / ') || '（なし）' }}</li>
        <li v-if="offSections.length > 0">外した節: {{ offSections.join(' / ') }}</li>
        <li v-if="offItems.length > 0">外した項目: {{ offItems.join(' / ') }}</li>
        <li v-if="spec?.focus">重点: {{ spec.focus }}</li>
      </ul>
      <div class="wz-actions">
        <button class="primary" @click="download">HTML をダウンロード</button>
        <button @click="previewOn = !previewOn">{{ previewOn ? 'プレビューを閉じる' : 'この画面でプレビュー' }}</button>
        <button v-if="previewOn" @click="reloadKey++">プレビューを再生成</button>
      </div>
      <p class="muted">
        関係図はノード形式で、ブラウザで開くとクリックして掘り下げられます（印刷時は静止画に切り替わります）。
      </p>
    </div>

    <div v-if="previewOn" class="wz-card wz-preview">
      <iframe :key="reloadKey" :src="previewSrc" title="レポートのプレビュー"></iframe>
    </div>
  </div>
</template>

<script setup lang="ts">
// SC-06 数値照合結果。一致率サマリと不一致セル一覧（原因分類付き）を表示する。
import { computed, onMounted, ref } from 'vue'
import { get, type MatchResult } from '../api'

const props = defineProps<{ projectId: number }>()

const result = ref<MatchResult | null>(null)
const selected = ref<MatchResult['mismatches'][0] | null>(null)

const matchRate = computed(() => {
  if (!result.value || result.value.total_cells === 0) return 0
  return result.value.matched_cells / result.value.total_cells
})

const CAUSE_LABELS: Record<string, string> = {
  rounding: '丸め誤差',
  manual_input: '手入力の可能性',
  logic_missing: 'ロジック未再現',
  data_issue: 'データ起因',
  unknown: '原因不明',
}

onMounted(async () => {
  result.value = await get<MatchResult | null>(`/projects/${props.projectId}/match-results`)
})
</script>

<template>
  <div v-if="!result" class="muted panel">
    照合結果がまだありません。成果物生成後に「▶ 数値照合」を実行してください。
  </div>
  <div v-else>
    <div class="panel">
      <h2>照合サマリ（成果物 v{{ result.deliverable_version }}）</h2>
      <div style="display: flex; gap: 24px; align-items: center">
        <div style="font-size: 32px; font-weight: 700"
          :style="{ color: matchRate >= 0.99 ? '#1a7f37' : matchRate >= 0.8 ? '#92600a' : '#b91c1c' }">
          {{ (matchRate * 100).toFixed(1) }}%
        </div>
        <div>
          <div>対象セル: {{ result.total_cells }}</div>
          <div>一致: <span style="color: #1a7f37">{{ result.matched_cells }}</span> /
            不一致: <span style="color: #b91c1c">{{ result.total_cells - result.matched_cells }}</span></div>
        </div>
      </div>
    </div>

    <div v-if="result.mismatches.length > 0" class="panel">
      <h2>不一致セル一覧</h2>
      <table>
        <thead>
          <tr><th>セル</th><th>行ラベル</th><th>列</th><th>帳票の値（期待）</th><th>生成構成の値</th><th>原因分類</th></tr>
        </thead>
        <tbody>
          <tr
            v-for="m in result.mismatches" :key="m.cell_ref"
            class="cell-mismatch-row" style="cursor: pointer"
            @click="selected = m"
          >
            <td class="mono">{{ m.cell_ref }}</td>
            <td>{{ m.row_label }}</td>
            <td>{{ m.column }}</td>
            <td style="text-align: right">{{ m.expected.toLocaleString() }}</td>
            <td style="text-align: right">{{ m.actual === null ? '—' : m.actual.toLocaleString() }}</td>
            <td><span class="badge warn">{{ CAUSE_LABELS[m.cause_category] ?? m.cause_category }}</span></td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="selected" class="panel" style="border-left: 4px solid #d97706">
      <h2>原因候補: {{ selected.cell_ref }}</h2>
      <p>{{ selected.explanation }}</p>
      <p class="muted">
        対応方針: ロジック起因の場合は検収内容を修正して「▶ 成果物生成」を再実行（UC-07）。
        データ起因（手入力等）の場合は「顧客確認事項」タブに登録して顧客へ照会してください。
      </p>
    </div>
  </div>
</template>

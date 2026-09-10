<script setup lang="ts">
// AI が流した SQL とその結果の一覧。
// 確定した会話（メッセージの tool_trace）と、処理中の途中経過の両方で同じ見え方にするため切り出した。
import type { SqlToolTrace } from '../../api'

defineProps<{ traces: SqlToolTrace[] }>()

function traceTitle(t: SqlToolTrace): string {
  if (t.tool === 'run_sql') return `▶ 実行: ${t.label}`
  if (t.tool === 'save_sql') return `💾 保存: ${t.label}`
  if (t.tool === 'read_reference') return `📖 ナレッジ: ${t.label}`
  if (t.tool === 'read_column_file') return `🗂 物理カラム: ${t.label}`
  return t.tool
}
</script>

<template>
  <details v-for="(t, i) in traces" :key="i" class="wz-sqltrace" :class="{ err: t.error }">
    <summary>
      {{ traceTitle(t) }}
      <span v-if="t.error" class="badge ng">エラー</span>
      <!-- 結果もエラーもまだ無い＝いま流している最中（途中経過でだけ出る） -->
      <span v-else-if="!t.result && t.tool === 'run_sql'" class="badge info">実行中…</span>
    </summary>
    <pre v-if="t.sql" class="wz-sql">{{ t.sql }}</pre>
    <p v-if="t.error" class="error-box">{{ t.error }}</p>
    <div v-else-if="t.result" class="wz-sqlresult">
      <table>
        <thead><tr><th v-for="c in t.result.columns" :key="c">{{ c }}</th></tr></thead>
        <tbody>
          <tr v-for="(r, ri) in t.result.rows" :key="ri">
            <td v-for="(v, ci) in r" :key="ci">{{ v }}</td>
          </tr>
        </tbody>
      </table>
      <p class="muted">
        {{ t.result.totalRows.toLocaleString() }} 行{{ t.result.truncated ? '（先頭30行のみ表示）' : '' }}
      </p>
    </div>
  </details>
</template>

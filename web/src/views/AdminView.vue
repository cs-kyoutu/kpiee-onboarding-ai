<script setup lang="ts">
// SC-08 管理画面。AI トークン使用量とコストの可視化（設計書 §7.5）。
import { onMounted, ref } from 'vue'
import { get } from '../api'

interface UsageRow {
  project_id: number
  customer_name: string | null
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  request_count: number
  estimated_cost_usd: number
}

const aiMode = ref('')
const rows = ref<UsageRow[]>([])

onMounted(async () => {
  const res = await get<{ aiMode: string; projects: UsageRow[] }>('/admin/usage')
  aiMode.value = res.aiMode
  rows.value = res.projects
})
</script>

<template>
  <h1>管理 — AI 使用量ダッシュボード</h1>
  <div class="panel">
    <p>
      AI モード: <span class="badge" :class="aiMode === 'mock' ? 'warn' : 'ok'">{{ aiMode === 'mock' ? 'モック（ANTHROPIC_API_KEY 未設定）' : aiMode }}</span>
    </p>
    <table>
      <thead>
        <tr>
          <th>プロジェクト</th><th>リクエスト数</th><th>入力トークン</th><th>出力トークン</th>
          <th>キャッシュ読取</th><th>推定コスト（USD）</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="r in rows" :key="r.project_id">
          <td>#{{ r.project_id }} {{ r.customer_name ?? '' }}</td>
          <td style="text-align: right">{{ r.request_count }}</td>
          <td style="text-align: right">{{ r.input_tokens?.toLocaleString() }}</td>
          <td style="text-align: right">{{ r.output_tokens?.toLocaleString() }}</td>
          <td style="text-align: right">{{ r.cache_read_tokens?.toLocaleString() }}</td>
          <td style="text-align: right">${{ r.estimated_cost_usd?.toFixed(4) }}</td>
        </tr>
        <tr v-if="rows.length === 0"><td colspan="6" class="muted">使用実績がありません（モックモードでは記録されません）</td></tr>
      </tbody>
    </table>
  </div>
</template>

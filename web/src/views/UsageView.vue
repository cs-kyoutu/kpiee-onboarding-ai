<script setup lang="ts">
// トークン使用量モニタリング（専用ダッシュボード）。
// KPI タイル + 日別トレンド(インラインSVG) + 段階別バー + プロジェクト別テーブル。
// 「モニタリング」なので手動更新＋一定間隔の自動更新を持つ。単一色（--primary=大きさ表現）で統一。
import { onMounted, onBeforeUnmount, ref, computed } from 'vue'
import { get } from '../api'

interface Row {
  project_id?: number
  customer_name?: string | null
  stage?: string
  day?: string
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  request_count: number
  estimated_cost_usd: number
}
interface UsageResp {
  aiMode: string
  model: string
  totals: Row
  projects: Row[]
  byStage: Row[]
  byDay: Row[]
}

const data = ref<UsageResp | null>(null)
const loading = ref(false)
const lastUpdated = ref<string>('')
const auto = ref(true)
let timer: ReturnType<typeof setInterval> | null = null

async function load() {
  loading.value = true
  try {
    data.value = await get<UsageResp>('/admin/usage')
    lastUpdated.value = new Date().toLocaleTimeString()
  } finally {
    loading.value = false
  }
}
function toggleAuto() {
  auto.value = !auto.value
  setupTimer()
}
function setupTimer() {
  if (timer) { clearInterval(timer); timer = null }
  if (auto.value) timer = setInterval(load, 30000) // 30秒ごと
}
onMounted(() => { load(); setupTimer() })
onBeforeUnmount(() => { if (timer) clearInterval(timer) })

// ---- 数値整形 ----
const fmt = (n: number) => Math.round(n).toLocaleString()
function fmtCompact(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 2) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(n >= 10_000 ? 0 : 1) + 'k'
  return String(Math.round(n))
}
const usd = (n: number) => '$' + (n < 1 ? n.toFixed(4) : n.toFixed(2))

// ---- 日別トレンド（合計トークン=入力+出力）: インラインSVG棒 ----
const W = 720, H = 200, PAD_L = 8, PAD_R = 8, PAD_T = 12, PAD_B = 22
const days = computed(() => data.value?.byDay ?? [])
const dayTotals = computed(() => days.value.map(d => d.input_tokens + d.output_tokens))
const dayMax = computed(() => Math.max(1, ...dayTotals.value))
const bars = computed(() => {
  const n = days.value.length
  if (n === 0) return [] as { x: number; y: number; w: number; h: number; d: Row; total: number }[]
  const innerW = W - PAD_L - PAD_R
  const slot = innerW / n
  const bw = Math.max(2, Math.min(28, slot - 2))
  const innerH = H - PAD_T - PAD_B
  return days.value.map((d, i) => {
    const total = d.input_tokens + d.output_tokens
    const h = Math.max(1, (total / dayMax.value) * innerH)
    return { x: PAD_L + i * slot + (slot - bw) / 2, y: PAD_T + innerH - h, w: bw, h, d, total }
  })
})
// x軸ラベルは先頭・中間・末尾のみ（混雑回避）
const dayTicks = computed(() => {
  const n = days.value.length
  if (n === 0) return []
  const idxs = n <= 3 ? days.value.map((_, i) => i) : [0, Math.floor((n - 1) / 2), n - 1]
  return idxs.map(i => ({ x: bars.value[i].x + bars.value[i].w / 2, label: (days.value[i].day ?? '').slice(5) }))
})

// ---- 段階別（トークン合計の水平バー） ----
const stageMax = computed(() => Math.max(1, ...(data.value?.byStage ?? []).map(s => s.input_tokens + s.output_tokens)))
const stageLabel: Record<string, string> = {
  decode: '解読', generate: '成果物生成', match: '数値照合', qa: 'Q&A', overview: '概要',
}
</script>

<template>
  <div class="usage-head">
    <h1>トークン使用量モニタ</h1>
    <div class="head-right">
      <span v-if="data" class="badge" :class="data.aiMode === 'mock' ? 'warn' : 'ok'">
        AI: {{ data.aiMode === 'mock' ? 'モック' : data.aiMode }}
      </span>
      <span class="muted upd" v-if="lastUpdated">更新 {{ lastUpdated }}</span>
      <button @click="load" :disabled="loading">{{ loading ? '更新中…' : '↻ 更新' }}</button>
      <button @click="toggleAuto" :class="{ primary: auto }">自動更新 {{ auto ? 'ON' : 'OFF' }}</button>
    </div>
  </div>

  <!-- KPI タイル -->
  <div class="kpis" v-if="data">
    <div class="kpi">
      <div class="kpi-label">総リクエスト</div>
      <div class="kpi-value">{{ fmt(data.totals.request_count) }}</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">入力トークン</div>
      <div class="kpi-value">{{ fmtCompact(data.totals.input_tokens) }}</div>
      <div class="kpi-sub">{{ fmt(data.totals.input_tokens) }}</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">出力トークン</div>
      <div class="kpi-value">{{ fmtCompact(data.totals.output_tokens) }}</div>
      <div class="kpi-sub">{{ fmt(data.totals.output_tokens) }}</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">キャッシュ読取</div>
      <div class="kpi-value">{{ fmtCompact(data.totals.cache_read_tokens) }}</div>
      <div class="kpi-sub">{{ fmt(data.totals.cache_read_tokens) }}</div>
    </div>
    <div class="kpi accent">
      <div class="kpi-label">推定コスト（累計）</div>
      <div class="kpi-value">{{ usd(data.totals.estimated_cost_usd) }}</div>
      <div class="kpi-sub">{{ data.model }} 単価換算</div>
    </div>
  </div>

  <!-- 日別トレンド -->
  <div class="panel">
    <div class="panel-title">日別トークン使用量（入力+出力・直近{{ days.length }}日）</div>
    <svg v-if="bars.length" :viewBox="`0 0 ${W} ${H}`" class="chart" preserveAspectRatio="none" role="img"
         aria-label="日別トークン使用量の推移">
      <rect v-for="(b, i) in bars" :key="i" :x="b.x" :y="b.y" :width="b.w" :height="b.h"
            rx="3" class="bar">
        <title>{{ b.d.day }} — 合計 {{ fmt(b.total) }}（入力 {{ fmt(b.d.input_tokens) }} / 出力 {{ fmt(b.d.output_tokens) }}） / {{ b.d.request_count }}件</title>
      </rect>
      <text v-for="(t, i) in dayTicks" :key="'t'+i" :x="t.x" :y="H - 6" class="axis" text-anchor="middle">{{ t.label }}</text>
    </svg>
    <p v-else class="muted empty">使用実績がありません（モックモードでは記録されません）。</p>
  </div>

  <!-- 段階別 -->
  <div class="panel" v-if="data && data.byStage.length">
    <div class="panel-title">段階別トークン（入力+出力）</div>
    <div class="stage-rows">
      <div class="stage-row" v-for="s in data.byStage" :key="s.stage ?? '-'">
        <div class="stage-name">{{ stageLabel[s.stage ?? ''] ?? s.stage ?? '不明' }}</div>
        <div class="stage-bar-wrap">
          <div class="stage-bar" :style="{ width: ((s.input_tokens + s.output_tokens) / stageMax * 100) + '%' }"></div>
        </div>
        <div class="stage-val">{{ fmtCompact(s.input_tokens + s.output_tokens) }}<span class="muted"> · {{ usd(s.estimated_cost_usd) }} · {{ s.request_count }}件</span></div>
      </div>
    </div>
  </div>

  <!-- プロジェクト別 -->
  <div class="panel" v-if="data">
    <div class="panel-title">プロジェクト別</div>
    <table>
      <thead>
        <tr><th>プロジェクト</th><th>リクエスト</th><th>入力</th><th>出力</th><th>キャッシュ読取</th><th>推定コスト</th></tr>
      </thead>
      <tbody>
        <tr v-for="r in data.projects" :key="r.project_id">
          <td>#{{ r.project_id }} {{ r.customer_name ?? '' }}</td>
          <td class="r">{{ fmt(r.request_count) }}</td>
          <td class="r">{{ fmt(r.input_tokens) }}</td>
          <td class="r">{{ fmt(r.output_tokens) }}</td>
          <td class="r">{{ fmt(r.cache_read_tokens) }}</td>
          <td class="r">{{ usd(r.estimated_cost_usd) }}</td>
        </tr>
        <tr v-if="data.projects.length === 0"><td colspan="6" class="muted">使用実績がありません。</td></tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.usage-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
.usage-head h1 { margin: 0; }
.head-right { display: flex; align-items: center; gap: 8px; }
.upd { font-size: 12px; }

.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 14px; }
.kpi { background: var(--panel); border: 1px solid var(--border); border-radius: var(--r-lg); padding: 14px 16px; box-shadow: var(--sh-sm); }
.kpi.accent { border-color: var(--primary); background: var(--primary-soft); }
.kpi-label { font-size: 12px; color: var(--muted); font-weight: 600; }
.kpi-value { font-size: 26px; font-weight: 800; color: var(--text); line-height: 1.2; margin-top: 4px; font-variant-numeric: tabular-nums; }
.kpi.accent .kpi-value { color: var(--primary-dark); }
.kpi-sub { font-size: 11px; color: var(--muted-2); margin-top: 2px; font-variant-numeric: tabular-nums; }

.panel-title { font-size: 13px; font-weight: 700; color: var(--text); margin-bottom: 10px; }
.chart { width: 100%; height: 200px; display: block; }
.chart .bar { fill: var(--primary); }
.chart .bar:hover { fill: var(--primary-dark); }
.chart .axis { fill: var(--muted-2); font-size: 10px; }
.empty { padding: 24px 0; text-align: center; }

.stage-rows { display: flex; flex-direction: column; gap: 8px; }
.stage-row { display: grid; grid-template-columns: 96px 1fr auto; align-items: center; gap: 10px; }
.stage-name { font-size: 13px; font-weight: 600; color: var(--text); }
.stage-bar-wrap { background: #eef1f5; border-radius: 6px; height: 14px; overflow: hidden; }
.stage-bar { height: 100%; background: var(--primary); border-radius: 6px; min-width: 2px; }
.stage-val { font-size: 12px; color: var(--text); font-variant-numeric: tabular-nums; white-space: nowrap; }

td.r, th.r { text-align: right; }
table td.r { font-variant-numeric: tabular-nums; }
</style>

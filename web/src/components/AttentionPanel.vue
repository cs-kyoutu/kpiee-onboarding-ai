<script setup lang="ts">
// 「⚠ 要確認」パネル。関係グラフの警告（手入力混入など）を全件、
// ファイル→シート→列 に集約して俯瞰できる形で表示する。
// フラットな数千行の羅列（シート関係タブの旧「注意」）では確認不能だったため、
// シート単位のカード＋規模バー＋列チップに整理し、多い順に並べる。
import { computed, onMounted, ref } from 'vue'
import { get } from '../api'

const props = defineProps<{ projectId: number }>()

interface AttentionGroup { kind: string; file: string; sheet: string; count: number; columns: string[] }
interface AttentionData { total: number; fileCount?: number; kinds: { kind: string; count: number }[]; groups: AttentionGroup[] }

const data = ref<AttentionData | null>(null)
const loading = ref(true)
const error = ref('')
const expanded = ref<Set<string>>(new Set()) // 列チップを全部見せるカード
const kindFilter = ref<string | null>(null)

// 警告種別 → 人が読めるラベルと説明
const KIND_INFO: Record<string, { label: string; desc: string }> = {
  mixed_formula_column: {
    label: '手入力混入',
    desc: '数式列なのに一部セルだけ手入力で上書きされている列。特別値引き・例外対応の疑いがあり、SQL 化すると数値がズレる元になるため、検収時に「なぜ手入力か」を確認してください。',
  },
  unknown_region: {
    label: '参照先不明',
    desc: '数式の参照先が表として特定できなかった箇所。取り込み漏れ・外部参照の可能性があります。',
  },
}
const kindLabel = (k: string) => KIND_INFO[k]?.label ?? k
const kindDesc = (k: string) => KIND_INFO[k]?.desc ?? ''

onMounted(async () => {
  try {
    data.value = await get<AttentionData>(`/projects/${props.projectId}/attention`)
  } catch (e) {
    error.value = String(e)
  } finally {
    loading.value = false
  }
})

const multiFile = computed(() => (data.value?.fileCount ?? 0) > 1)
const visibleGroups = computed(() => {
  const gs = data.value?.groups ?? []
  return kindFilter.value ? gs.filter(g => g.kind === kindFilter.value) : gs
})
const maxCount = computed(() => Math.max(1, ...visibleGroups.value.map(g => g.count)))

const cardKey = (g: AttentionGroup) => `${g.kind}|${g.file}|${g.sheet}`
const CHIP_LIMIT = 24
function toggleExpand(g: AttentionGroup) {
  const k = cardKey(g)
  const s = new Set(expanded.value)
  if (s.has(k)) s.delete(k); else s.add(k)
  expanded.value = s
}
const chipsOf = (g: AttentionGroup) =>
  expanded.value.has(cardKey(g)) ? g.columns : g.columns.slice(0, CHIP_LIMIT)
</script>

<template>
  <div v-if="loading" class="muted">集計中…</div>
  <div v-else-if="error" class="panel err">読み込みに失敗しました: {{ error }}</div>
  <template v-else-if="data">
    <div v-if="data.total === 0" class="panel">
      <p class="muted">要確認の指摘はありません（手入力混入などは検出されませんでした）。</p>
    </div>
    <template v-else>
      <!-- 種別サマリ（クリックで絞り込み） -->
      <div class="kind-tiles">
        <button
          v-for="k in data.kinds" :key="k.kind"
          class="kind-tile" :class="{ active: kindFilter === k.kind }"
          @click="kindFilter = kindFilter === k.kind ? null : k.kind"
        >
          <span class="kt-count">{{ k.count.toLocaleString() }}</span>
          <span class="kt-label">{{ kindLabel(k.kind) }}</span>
        </button>
        <div class="kind-desc muted">
          {{ kindFilter ? kindDesc(kindFilter) : kindDesc(data.kinds[0]?.kind ?? '') }}
        </div>
      </div>

      <!-- シート別カード（多い順）。バーで規模を比較できるようにする -->
      <div class="cards">
        <div v-for="g in visibleGroups" :key="cardKey(g)" class="card">
          <div class="card-head">
            <div class="card-title">
              <span v-if="multiFile && g.file && g.file !== g.sheet" class="card-file">{{ g.file }}</span>
              <span class="card-sheet">{{ g.sheet }}</span>
            </div>
            <span class="badge warn">{{ kindLabel(g.kind) }} {{ g.count.toLocaleString() }}件</span>
          </div>
          <div class="scale-bar"><div class="scale-fill" :style="{ width: (g.count / maxCount * 100) + '%' }"></div></div>
          <div class="chips">
            <span v-for="c in chipsOf(g)" :key="c" class="chip mono">{{ c }}</span>
            <button
              v-if="g.columns.length > CHIP_LIMIT" class="chip more"
              @click="toggleExpand(g)"
            >{{ expanded.has(cardKey(g)) ? '折りたたむ' : `他 ${g.columns.length - CHIP_LIMIT} 列を表示` }}</button>
          </div>
        </div>
      </div>
    </template>
  </template>
</template>

<style scoped>
.kind-tiles { display:flex; align-items:flex-start; gap:12px; flex-wrap:wrap; margin-bottom:14px }
.kind-tile {
  display:flex; flex-direction:column; align-items:flex-start; gap:2px;
  padding:10px 16px; border-radius:var(--r); border:1px solid var(--border-strong);
  background:#fff; cursor:pointer;
}
.kind-tile.active { border-color:var(--warn); background:var(--warn-bg) }
.kt-count { font-size:22px; font-weight:800; font-variant-numeric:tabular-nums; color:var(--warn) }
.kt-label { font-size:12px; font-weight:600; color:var(--text) }
.kind-desc { flex:1 1 260px; font-size:12.5px; line-height:1.6; padding-top:4px }

.cards { display:flex; flex-direction:column; gap:10px }
.card { background:var(--panel); border:1px solid var(--border); border-radius:var(--r-lg); padding:12px 16px; box-shadow:var(--sh-sm) }
.card-head { display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap }
.card-title { display:flex; align-items:baseline; gap:8px; min-width:0 }
.card-file { font-size:12px; color:var(--muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:280px }
.card-sheet { font-size:14px; font-weight:700; color:var(--text) }
.badge.warn { background:var(--warn-bg); color:var(--warn); white-space:nowrap }

.scale-bar { height:6px; background:#f0f2f5; border-radius:4px; margin:8px 0; overflow:hidden }
.scale-fill { height:100%; background:var(--warn); border-radius:4px; min-width:2px }

.chips { display:flex; flex-wrap:wrap; gap:6px }
.chip {
  font-size:11.5px; padding:2px 8px; border-radius:999px;
  background:#f6f7f9; border:1px solid var(--border); color:var(--text);
  max-width:220px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
}
.chip.more { cursor:pointer; background:#fff; color:var(--primary-dark); border-color:var(--primary); font-weight:600 }
.chip.more:hover { background:var(--primary-soft) }
.err { color:var(--ng) }
</style>

<script setup lang="ts">
// SC-04 解読結果検収。左: シートビューア（数式ハイライト） / 右: AI解読項目リスト。
// 項目ごとに 承認 / 修正 / 却下 を行う（UC-04: ロジック単位の承認）。
import { computed, onMounted, ref } from 'vue'
import { get, patch, type Artifact, type Finding, type SheetPreview } from '../api'
import SheetViewer from './SheetViewer.vue'

const props = defineProps<{ projectId: number; artifacts: Artifact[] }>()

const findings = ref<Finding[]>([])
const preview = ref<SheetPreview | null>(null)
const highlightRef = ref<string | null>(null)
const editingId = ref<number | null>(null)
const editText = ref('')
const sheetViewer = ref<InstanceType<typeof SheetViewer> | null>(null)
const showSheet = ref(false) // 中間シート（数式ビューア）の表示トグル

const approvedCount = computed(() => findings.value.filter(f => ['approved', 'modified'].includes(f.review_status)).length)

// 種別: ラベル + 平易な説明（専門用語を噛み砕く）
const LOGIC: Record<string, { label: string; desc: string }> = {
  join: { label: '結合', desc: '別の表から対応する値を引いてくる（VLOOKUP 等）' },
  union: { label: '縦結合', desc: '複数の表を縦に積み重ねて1つにする' },
  arithmetic: { label: '四則演算', desc: '足し算・掛け算などで計算する' },
  allocation: { label: '按分', desc: '比率に応じて金額を割り振る' },
  filter: { label: '絞り込み', desc: '条件に合う行だけを抜き出す' },
  aggregate: { label: '集計', desc: '合計・件数などにまとめる' },
  manual_input: { label: '手入力', desc: '数式でなく人が直接入力した値' },
  format_only: { label: '書式のみ', desc: '見た目だけで計算はしていない' },
  unknown: { label: '不明', desc: '自動では判定できなかった' },
}
const TARGET: Record<string, { label: string; desc: string }> = {
  sql_job: { label: 'SQLジョブ', desc: 'KPIEE の前処理 SQL で再現する' },
  report_metric: { label: 'レポート指標', desc: 'レポートの数値項目として設定する' },
  report_axis: { label: 'レポート軸', desc: 'レポートの行／列の軸として設定する' },
  master: { label: 'マスタ', desc: '拠点・科目などの軸マスタとして登録する' },
  custom_row: { label: '計算行', desc: 'レポートの計算行として実現する' },
  allocation: { label: '按分設定', desc: '按分ロジックとして設定する' },
  needs_customer_confirmation: { label: '顧客に確認', desc: '出所が不明なので顧客への確認が必要' },
}
const CONF: Record<string, { label: string; cls: string; note: string }> = {
  high: { label: '高', cls: 'ok', note: 'ほぼ確実' },
  medium: { label: '中', cls: 'warn', note: '念のため確認' },
  low: { label: '低', cls: 'ng', note: '怪しい・要確認' },
}
const logic = (t: string) => LOGIC[t] ?? { label: t, desc: '' }
const target = (t: string) => TARGET[t] ?? { label: t, desc: '' }
const conf = (c: string) => CONF[c] ?? { label: c, cls: 'warn', note: '' }
// "シート名!セル" を分解して読みやすく
const refParts = (ref: string) => {
  const i = ref.indexOf('!')
  return i > 0 ? { sheet: ref.slice(0, i), cell: ref.slice(i + 1) } : { sheet: ref, cell: '' }
}
const statusClass = (s: string) =>
  s === 'approved' || s === 'modified' ? 'st-ok' : s === 'rejected' ? 'st-ng' : 'st-todo'
const STATUS_LABEL: Record<string, string> = { pending: '未処理', approved: '承認済', modified: '修正済', rejected: '却下' }

async function load() {
  findings.value = await get<Finding[]>(`/projects/${props.projectId}/findings`)
  // シートプレビューを読み込む。中間シート専用アップロードが無い混在(mixed/auto)ファイルにも対応。
  const done = (a: Artifact) => a.parse_status === 'done'
  const art = props.artifacts.find(a => a.kind === 'working_sheet' && done(a))
    ?? props.artifacts.find(a => a.kind === 'mixed' && done(a))
    ?? props.artifacts.find(done)
  preview.value = art ? await get<SheetPreview>(`/artifacts/${art.id}/preview`) : null
}

async function setStatus(f: Finding, status: string) {
  const updated = await patch<Finding>(`/findings/${f.id}`, { review_status: status })
  Object.assign(f, updated)
}

function startEdit(f: Finding) {
  editingId.value = f.id
  editText.value = f.modified_content ?? f.explanation
}

async function saveEdit(f: Finding) {
  const updated = await patch<Finding>(`/findings/${f.id}`, {
    review_status: 'modified',
    modified_content: editText.value,
  })
  Object.assign(f, updated)
  editingId.value = null
}

function focusCell(f: Finding) {
  showSheet.value = true // 場所クリックで中間シートを自動展開
  highlightRef.value = f.source_ref
  // ハイライト対象のシートタブへ自動で切り替える
  requestAnimationFrame(() => sheetViewer.value?.syncSheetToHighlight())
}

async function approveAll() {
  for (const f of findings.value) {
    if (f.review_status === 'pending') await setStatus(f, 'approved')
  }
}

onMounted(load)
</script>

<template>
  <!-- このステップの説明 -->
  <div class="review-guide">
    <p style="margin:0 0 4px"><strong>このステップ：</strong>AI が「各シートのどの部分が何をしているか」を読み取りました。内容が正しいか確認してください。</p>
    <p class="muted" style="margin:0">
      <span class="act ok">承認</span>＝内容が正しい
      <span class="act">修正</span>＝説明を直す
      <span class="act ng">却下</span>＝不要・誤り　／
      <span class="ng-text">確信度【低】</span>の項目は特に確認してください。
    </p>
  </div>

  <div class="toolbar">
    <span class="badge info">承認 {{ approvedCount }} / {{ findings.length }} 件</span>
    <button class="primary" @click="approveAll">未処理をまとめて承認</button>
  </div>

  <!-- シートプレビュー: 横並びの折りたたみ（プルダウン）。既定は閉じて解読項目を全幅で表示 -->
  <div class="sheet-bar">
    <button @click="showSheet = !showSheet">{{ showSheet ? '▾ シートを隠す' : '▸ シートを表示（数式は黄色 / シートごとにタブ）' }}</button>
    <span class="muted">各項目の「📍場所」をクリックすると、ここが開いて該当シート・セルが黄色く表示されます。</span>
  </div>
  <div v-show="showSheet" class="panel sheet-panel">
    <SheetViewer v-if="preview" ref="sheetViewer" :sheets="preview.sheets" :highlight-ref="highlightRef" />
    <p v-else class="muted">中間スプレッドシートが未アップロードです</p>
  </div>

  <p v-if="findings.length === 0" class="muted">
    解読項目がありません。「② AI解読」を実行してください。
  </p>

  <!-- AI解読項目（全幅） -->
  <div v-else class="findings-list">
    <div v-for="f in findings" :key="f.id" class="finding" :class="statusClass(f.review_status)">
        <!-- 主役: 何をしているかの説明 -->
        <p v-if="editingId !== f.id" class="f-explain">{{ f.modified_content ?? f.explanation }}</p>

        <!-- 平易な意味づけ -->
        <p class="f-meaning">
          種類: <strong>{{ logic(f.logic_type).label }}</strong>
          <span class="muted">（{{ logic(f.logic_type).desc }}）</span>
          <br>KPIEE では: <strong :class="{ 'ng-text': f.kpiee_target === 'needs_customer_confirmation' }">{{ target(f.kpiee_target).label }}</strong>
          <span class="muted">（{{ target(f.kpiee_target).desc }}）</span>
        </p>

        <!-- 場所 + 確信度 -->
        <div class="f-sub">
          <a class="f-loc" @click="focusCell(f)">📍 {{ refParts(f.source_ref).sheet }}<span v-if="refParts(f.source_ref).cell"> ・ {{ refParts(f.source_ref).cell }}</span></a>
          <span class="badge" :class="conf(f.confidence).cls">確信度 {{ conf(f.confidence).label }}（{{ conf(f.confidence).note }}）</span>
        </div>

        <details v-if="f.formula_raw" class="f-formula">
          <summary>元の数式を見る（任意）</summary>
          <code>{{ f.formula_raw }}</code>
        </details>

        <!-- 修正フォーム -->
        <div v-if="editingId === f.id" class="f-edit">
          <textarea v-model="editText" rows="3" />
          <div class="toolbar" style="margin: 6px 0 0">
            <button class="ok" @click="saveEdit(f)">修正を保存（承認扱い）</button>
            <button @click="editingId = null">キャンセル</button>
          </div>
        </div>

        <!-- 操作 -->
        <div v-else class="f-actions">
          <button class="ok" :disabled="f.review_status === 'approved'" @click="setStatus(f, 'approved')">承認</button>
          <button @click="startEdit(f)">修正</button>
          <button class="danger" :disabled="f.review_status === 'rejected'" @click="setStatus(f, 'rejected')">却下</button>
          <span class="badge" :class="['approved', 'modified'].includes(f.review_status) ? 'ok' : f.review_status === 'rejected' ? 'ng' : 'warn'">
            {{ STATUS_LABEL[f.review_status] }}
          </span>
        </div>
      </div>
    </div>
</template>

<style scoped>
.review-guide { background:#eaf3fb; border:1px solid #bcd8f0; border-left:4px solid var(--primary); border-radius:8px; padding:10px 14px; margin-bottom:12px; font-size:13px; line-height:1.6; }
.review-guide .act { display:inline-block; padding:1px 7px; border-radius:5px; border:1px solid var(--border); background:#fff; font-size:12px; }
.review-guide .act.ok { border-color:var(--ok); color:var(--ok); }
.review-guide .act.ng { border-color:var(--ng); color:var(--ng); }
.ng-text { color:var(--ng); font-weight:600; }

.sheet-bar { display:flex; align-items:center; gap:12px; flex-wrap:wrap; margin-bottom:8px; }
.sheet-bar .muted { font-size:12px; }
.sheet-panel { max-height:480px; overflow:auto; }
.findings-list { display:flex; flex-direction:column; }

.finding { background:#fff; border:1px solid var(--border); border-left-width:4px; border-radius:8px; padding:14px 16px; margin-bottom:12px; }
.finding.st-ok { border-left-color:var(--ok); }
.finding.st-ng { border-left-color:var(--ng); }
.finding.st-todo { border-left-color:#d97706; }
.f-explain { margin:0 0 8px; font-size:14px; line-height:1.6; }
.f-meaning { margin:0 0 8px; font-size:13px; line-height:1.7; }
.f-sub { display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap; margin-bottom:8px; }
.f-loc { cursor:pointer; color:var(--primary); font-size:12.5px; }
.f-loc:hover { text-decoration:underline; }
.f-formula { margin-bottom:8px; }
.f-formula summary { cursor:pointer; font-size:12px; color:var(--muted); }
.f-formula code { display:block; margin-top:6px; padding:8px 10px; background:#f4f5f7; border-radius:6px; font-size:12px; color:#475569; word-break:break-all; white-space:pre-wrap; }
.f-actions { display:flex; align-items:center; gap:8px; }
.f-edit textarea { width:100%; }
</style>

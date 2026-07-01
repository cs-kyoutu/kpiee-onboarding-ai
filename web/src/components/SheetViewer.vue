<script setup lang="ts">
// シートビューア（SC-03 / SC-04 共用）。
// 数式セルは黄色ハイライト、セルクリックで数式原文を表示する（設計書 SC-04 ワイヤー準拠）。
import { computed, ref } from 'vue'
import type { SheetPreview } from '../api'

const props = defineProps<{
  sheets: SheetPreview['sheets']
  /** 検収画面から渡されるハイライト対象（例: 集計!B2） */
  highlightRef?: string | null
}>()

const activeSheetIdx = ref(0)
const selectedCell = ref<{ ref: string; formula?: string; value: string | number | null } | null>(null)

const activeSheet = computed(() => props.sheets[activeSheetIdx.value])

/** ハイライト対象の参照がアクティブシートのセルと一致するか（行範囲圧縮分はプレフィックス一致で吸収） */
function isHighlighted(sheetName: string, cellRef: string): boolean {
  if (!props.highlightRef) return false
  const [hSheet, hRef] = props.highlightRef.split('!')
  if (hSheet !== sheetName) return false
  if (!hRef) return false
  // 範囲表記（B2:B10）は先頭セルで一致判定する
  const first = hRef.split(':')[0]
  return first === cellRef
}

/** highlightRef のシートを自動で開く */
function syncSheetToHighlight() {
  if (!props.highlightRef) return
  const sheetName = props.highlightRef.split('!')[0]
  const idx = props.sheets.findIndex(s => s.name === sheetName)
  if (idx >= 0) activeSheetIdx.value = idx
}
defineExpose({ syncSheetToHighlight })

/** 列見出し（A, B, C...）を最大セル数から作る */
const columnHeaders = computed(() => {
  const sheet = activeSheet.value
  if (!sheet) return []
  let maxCol = 0
  for (const row of sheet.rows) {
    for (const cell of row.cells) {
      const letters = cell.ref.replace(/\d+/g, '')
      let n = 0
      for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
      if (n > maxCol) maxCol = n
    }
  }
  const headers: string[] = []
  for (let i = 1; i <= maxCol; i++) {
    let s = ''
    let n = i
    while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26) }
    headers.push(s)
  }
  return headers
})

function cellAt(row: SheetPreview['sheets'][0]['rows'][0], col: string) {
  return row.cells.find(c => c.ref.replace(/\d+/g, '') === col)
}
</script>

<template>
  <div>
    <div class="tabs" style="margin-bottom: 8px">
      <button
        v-for="(s, i) in sheets" :key="s.name"
        :class="{ active: i === activeSheetIdx }"
        @click="activeSheetIdx = i; selectedCell = null"
      >
        {{ s.name }}
        <span v-if="s.formulaCellCount > 0" class="badge warn">数式 {{ s.formulaCellCount }}</span>
      </button>
    </div>

    <div v-if="selectedCell" class="panel" style="padding: 8px 12px; margin-bottom: 8px">
      <strong class="mono">{{ selectedCell.ref }}</strong>:
      <span v-if="selectedCell.formula" class="mono">={{ selectedCell.formula }}</span>
      <span class="muted"> → {{ selectedCell.value }}</span>
    </div>

    <div v-if="activeSheet" class="sheet-viewer">
      <table>
        <thead>
          <tr>
            <th></th>
            <th v-for="col in columnHeaders" :key="col">{{ col }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in activeSheet.rows" :key="row.rowNumber">
            <th>
              {{ row.rowNumber }}
              <span v-if="row.compressedRange" class="muted">〜{{ row.compressedRange.to }}</span>
            </th>
            <td
              v-for="col in columnHeaders" :key="col"
              :class="{ formula: !!cellAt(row, col)?.formula, highlight: isHighlighted(activeSheet.name, `${col}${row.rowNumber}`) }"
              class="mono"
              @click="cellAt(row, col) && (selectedCell = cellAt(row, col)!)"
            >{{ cellAt(row, col)?.value ?? '' }}</td>
          </tr>
        </tbody>
      </table>
      <p class="muted" v-if="activeSheet.rows.some(r => r.compressedRange)">
        ※「〜N」付きの行は同一数式パターンの連続行を圧縮表示しています
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
// シート関係ビュー（プロジェクト全体）。
// アップロードされた全ファイル(xlsx/csv)を1つのグラフにまとめて表示する。
// ファイルが1つならそのファイル単体、複数なら自動でファイル間の関係(手コピー等)も表示する。
//   ① 関係の種類の凡例（平易な日本語）
//   ② 表領域グラフ（SVG, 表どうしの繋がりを矢印で）
//   ③ 根拠つき関係リスト
//   ④ 注意（手入力混入など）
import { computed, ref, watch } from 'vue'
import { get, getProjectRelations, type Artifact, type RelationGraph, type RelEdge, type RelType, type RelRegion, type SheetPreview } from '../api'

const props = defineProps<{ projectId: number; artifacts: Artifact[] }>()
const emit = defineEmits<{ (e: 'open-attention'): void }>()

// 解析対象になり得るファイル数（xlsx/csv かつ解析済み）
const analyzableCount = computed(() =>
  props.artifacts.filter(a => /\.(xlsx|xlsm|csv)$/i.test(a.original_filename) && a.parse_status === 'done').length)

const graph = ref<RelationGraph | null>(null)
const loading = ref(false)
const error = ref('')
const selected = ref<string | null>(null) // クリックで選択中の表領域ID

// シート単位の統計（総セル数・数式セル数）はパース結果（preview）から取得する
const sheetStats = ref<Map<string, { rowCount: number; columnCount: number; formulaCellCount: number }>>(new Map())
const stripExt = (f: string) => f.replace(/\.[^.]+$/, '')
const statKey = (file: string, sheet: string) => `${file}::${sheet}`

async function load() {
  loading.value = true; error.value = ''
  selected.value = null
  try {
    graph.value = await getProjectRelations(props.projectId)
    // 各ファイルの preview からシート統計を集める（行数×列数＝総セル数、数式セル数）
    const stats = new Map<string, { rowCount: number; columnCount: number; formulaCellCount: number }>()
    const targets = props.artifacts.filter(a => /\.(xlsx|xlsm|csv)$/i.test(a.original_filename) && a.parse_status === 'done')
    await Promise.all(targets.map(async a => {
      try {
        const pv = await get<SheetPreview>(`/artifacts/${a.id}/preview`)
        for (const s of pv.sheets) {
          stats.set(statKey(stripExt(pv.filename), s.name),
            { rowCount: s.rowCount, columnCount: s.columnCount, formulaCellCount: s.formulaCellCount })
        }
      } catch { /* preview 取得失敗は統計なしで続行 */ }
    }))
    sheetStats.value = stats
  }
  catch (e) { error.value = String(e) }
  finally { loading.value = false }
}

// アップロードで解析対象ファイル数が変わったら読み直す
watch(analyzableCount, () => { if (analyzableCount.value > 0) load() }, { immediate: true })

const regionById = computed(() => {
  const m = new Map<string, RelRegion>()
  graph.value?.regions.forEach(r => m.set(r.id, r))
  return m
})
const multiFile = computed(() => (graph.value?.fileCount ?? 0) > 1)

// 全体構造の自然言語サマリ（decode 実行後に付与される。未実行なら null）
const overview = computed(() => graph.value?.overview ?? null)

// 列の表示/折りたたみ（既定は折りたたみ＝表どうしの繋がりだけ見せて見やすく）
const showColumns = ref(false)
const headerH = 40   // 2段見出し（1段目=シート名 / 2段目=小さなメタ情報）
const COL_ROW_H = 26
const NODE_W = 230   // ノード(表)の幅
const COL_W = 280    // 段(layer)の横間隔

// ---- 関係種別のメタ（平易な説明・色） ----
const REL_META: Record<RelType, { label: string; desc: string; color: string; dashed?: boolean }> = {
  'filtered-agg': { label: '集計', desc: 'SUMIF 等で条件に合う行を合計', color: '#2e7d32' },
  'aggregation': { label: '集計', desc: 'SUM 等でまとめて合計', color: '#2e7d32' },
  'lookup-join': { label: '引き当て', desc: 'VLOOKUP 等で別表から値を引く', color: '#1565c0' },
  'passthrough': { label: '転記', desc: '別セルの値をそのまま持ってくる', color: '#00838f' },
  'derived': { label: '計算', desc: '四則演算で求める', color: '#e65100' },
  'filter-key': { label: '条件キー', desc: '集計・引き当ての「どの行か」を決めるキー列', color: '#9e9e9e' },
  'copy': { label: '手コピー疑い', desc: '数式がないのに値が一致＝手で貼った可能性', color: '#c62828', dashed: true },
}
const relMeta = (t: RelType) => REL_META[t]
const mainTypes: RelType[] = ['filtered-agg', 'aggregation', 'lookup-join', 'passthrough', 'derived', 'copy']

// AI解読（findings）の種別ラベル（日本語表示）
const LOGIC_LABELS: Record<string, string> = {
  join: '結合', union: '縦結合', arithmetic: '四則演算', allocation: '按分',
  filter: '絞り込み', aggregate: '集計', manual_input: '手入力', format_only: '書式のみ', unknown: '不明',
}
const TARGET_LABELS: Record<string, string> = {
  sql_job: 'SQLジョブ', report_metric: 'レポート指標', report_axis: 'レポート軸',
  master: 'マスタ', custom_row: '計算行', allocation: '按分設定', needs_customer_confirmation: '⚠ 顧客確認',
}
const logicLabel = (t: string) => LOGIC_LABELS[t] ?? t
const targetLabel = (t: string) => TARGET_LABELS[t] ?? t

// key (=`${regionId}:${colName}`) を regionId と列名に分解。regionId は ':' を含まない
const regionIdOf = (key: string) => key.slice(0, key.indexOf(':'))
const colOf = (key: string) => key.slice(key.indexOf(':') + 1)
const regionLabel = (id: string) => {
  const r = regionById.value.get(id)
  if (!r) {
    // 未解決（グラフのキャップ等で regions に無い）でも、raw id (`ファイル／シート#n`) から
    // ファイル・シートを取り出して表示する。どのファイル/シートか必ず分かるように。
    const m = /^(.*)／(.*)#\d+$/.exec(id)
    if (m) return multiFile.value && m[1] !== m[2] ? `${m[1]}・${m[2]}` : m[2]
    return id
  }
  // ファイルが1つなら冗長なファイル名は出さず、シート名だけで示す
  if (!multiFile.value || r.sheet === r.file) return r.sheet
  return `${r.file}・${r.sheet}`
}
const short = (key: string) => `${regionLabel(regionIdOf(key))} の「${colOf(key)}」`

// グラフのノード見出し: シート名を主役にし、複数ファイル時のみファイル名を副題に出す
const nodeTitle = (r: RelRegion): { main: string; sub: string | null } =>
  (!multiFile.value || r.sheet === r.file) ? { main: r.sheet, sub: null } : { main: r.sheet, sub: r.file }

// ---- 表領域グラフのレイアウト（依存の深さで左→右に段組み） ----
interface Node { region: RelRegion; layer: number; x: number; y: number; w: number; h: number }
interface RegionEdge { from: string; to: string; types: Set<RelType>; copy: boolean }

const layout = computed(() => {
  const g = graph.value
  if (!g) return { nodes: [] as Node[], edges: [] as (RegionEdge & { x1: number; y1: number; x2: number; y2: number; color: string; dashed: boolean })[], width: 0, height: 0 }

  // 表領域レベルに集約（列レベル辺 → 表どうしの辺）
  const reMap = new Map<string, RegionEdge>()
  for (const e of g.edges) {
    if (e.type === 'filter-key') continue // 本線でないので図では省略
    const from = regionIdOf(e.from), to = regionIdOf(e.to)
    if (from === to) continue
    const k = `${from}->${to}`
    if (!reMap.has(k)) reMap.set(k, { from, to, types: new Set(), copy: false })
    const re = reMap.get(k)!
    re.types.add(e.type)
    if (e.type === 'copy') re.copy = true
  }
  const regionEdges = [...reMap.values()]

  // 段(layer)割り: 入次数0をソースとし、最長距離で層を決める（循環は打ち切り）
  const ids = g.regions.map(r => r.id)
  const incoming = new Map<string, string[]>()
  ids.forEach(id => incoming.set(id, []))
  for (const e of regionEdges) incoming.get(e.to)?.push(e.from)
  const layerOf = new Map<string, number>()
  const calc = (id: string, seen: Set<string>): number => {
    if (layerOf.has(id)) return layerOf.get(id)!
    if (seen.has(id)) return 0
    seen.add(id)
    const ins = incoming.get(id) ?? []
    const l = ins.length === 0 ? 0 : Math.min(6, Math.max(...ins.map(p => calc(p, seen) + 1)))
    layerOf.set(id, l)
    return l
  }
  ids.forEach(id => calc(id, new Set()))

  // 配置
  const GAP_Y = 36, PAD = 20
  const hh = headerH
  const byLayer = new Map<number, RelRegion[]>()
  for (const r of g.regions) {
    const l = layerOf.get(r.id) ?? 0
    if (!byLayer.has(l)) byLayer.set(l, [])
    byLayer.get(l)!.push(r)
  }
  const nodes: Node[] = []
  let maxY = 0
  for (const [l, regs] of [...byLayer.entries()].sort((a, b) => a[0] - b[0])) {
    let y = PAD
    for (const r of regs) {
      // 折りたたみ時は見出しのみ、展開時は列数ぶんの高さ
      const h = showColumns.value ? hh + r.columns.length * COL_ROW_H + 8 : hh
      nodes.push({ region: r, layer: l, x: PAD + l * COL_W, y, w: NODE_W, h })
      y += h + GAP_Y
      if (y > maxY) maxY = y
    }
  }
  const nodeById = new Map(nodes.map(n => [n.region.id, n]))
  const width = PAD * 2 + (Math.max(0, ...nodes.map(n => n.layer)) + 1) * COL_W
  const height = Math.max(maxY, 120)

  const edges = regionEdges.map(re => {
    const a = nodeById.get(re.from)!, b = nodeById.get(re.to)!
    const primary = mainTypes.find(t => re.types.has(t)) ?? 'derived'
    const m = relMeta(primary)
    return {
      ...re,
      x1: a.x + a.w, y1: a.y + a.h / 2,
      x2: b.x, y2: b.y + b.h / 2,
      color: re.copy ? REL_META.copy.color : m.color,
      dashed: re.copy,
    }
  }).filter(e => e.x1 !== undefined)

  return { nodes, edges, width, height }
})

// 列レベルの関係リスト（本線→キーの順、種別でまとめる）
const groupedEdges = computed(() => {
  const g = graph.value
  if (!g) return [] as { type: RelType; items: RelEdge[] }[]
  const order: RelType[] = [...mainTypes, 'filter-key']
  return order
    .map(type => ({ type, items: g.edges.filter(e => e.type === type) }))
    .filter(grp => grp.items.length > 0)
})

const usedTypes = computed(() => {
  const s = new Set<RelType>()
  graph.value?.edges.forEach(e => s.add(e.type))
  return [...s]
})

// ファイルをまたぐコピー辺の件数（複数ファイル時の見どころ）
const crossFileCopies = computed(() =>
  (graph.value?.edges ?? []).filter(e =>
    e.type === 'copy' && regionById.value.get(regionIdOf(e.from))?.file !== regionById.value.get(regionIdOf(e.to))?.file).length)

// ---- 表領域の選択（クリックで関係先だけ強調、他は薄く） ----
function selectRegion(id: string) {
  selected.value = selected.value === id ? null : id
}

// 表領域どうしの隣接（filter-key 等の補助線は除く、無向）
const adjacency = computed(() => {
  const m = new Map<string, Set<string>>()
  const add = (a: string, b: string) => { (m.get(a) ?? m.set(a, new Set()).get(a)!).add(b) }
  for (const e of graph.value?.edges ?? []) {
    if (e.type === 'filter-key') continue
    const f = regionIdOf(e.from), t = regionIdOf(e.to)
    if (f === t) continue
    add(f, t); add(t, f)
  }
  return m
})

// 選択時に「表示状態」を保つ集合（選択ノード＋その直接の関係先）
const highlighted = computed(() => {
  if (!selected.value) return null
  const s = new Set<string>([selected.value])
  adjacency.value.get(selected.value)?.forEach(id => s.add(id))
  return s
})

const isDim = (id: string) => highlighted.value !== null && !highlighted.value.has(id)
const edgeDim = (from: string, to: string) =>
  highlighted.value !== null && !(highlighted.value.has(from) && highlighted.value.has(to))

// ---- 選択シートの要約（日本語表示専用） ----
const selectedSummary = computed(() => {
  const id = selected.value
  if (!id) return null
  const r = regionById.value.get(id)
  if (!r) return null
  const stat = sheetStats.value.get(statKey(r.file, r.sheet))
  // このシートが参照している先（上流：データを引いてくる元）
  const refUp = new Set<string>()
  // このシートを参照している側（下流：このシートのデータを使う先）
  const refDown = new Set<string>()
  for (const e of graph.value?.edges ?? []) {
    if (e.type === 'filter-key') continue
    const f = regionIdOf(e.from), t = regionIdOf(e.to)
    if (f === t) continue
    if (t === id) refUp.add(regionLabel(f))
    if (f === id) refDown.add(regionLabel(t))
  }
  const formulaCols = r.columns.filter(c => c.hasFormula).length
  const mixedCols = r.columns.filter(c => c.mixedFormula).length
  return {
    sheet: r.sheet,
    range: `${colLetterRef(r.c0)}${r.r0}:${colLetterRef(r.c1)}${r.r1}`,
    rowCount: stat?.rowCount ?? r.dataRowCount,
    totalCells: stat ? stat.rowCount * stat.columnCount : null,
    formulaCells: stat?.formulaCellCount ?? null,
    formulaCols,
    mixedCols,
    colCount: r.columns.length,
    refUp: [...refUp],
    refDown: [...refDown],
    description: describe(refUp.size, refDown.size),
    ai: r.ai ?? [],
  }
})

// ---- 選択シートの内部構造（階層フロー図: 入力→計算→出力） ----
const selectedStructure = computed(() =>
  selected.value ? (graph.value?.sheetStructures?.find(s => s.regionId === selected.value) ?? null) : null)

const ST = { NW: 156, NH: 38, LX: 196, GY: 14, PAD: 14 }
const structLayout = computed(() => {
  const s = selectedStructure.value
  if (!s || s.nodes.length === 0) return null
  const byLayer = new Map<number, typeof s.nodes>()
  for (const n of s.nodes) { if (!byLayer.has(n.layer)) byLayer.set(n.layer, []); byLayer.get(n.layer)!.push(n) }
  const pos = new Map<string, { x: number; y: number; n: typeof s.nodes[number] }>()
  let maxY = 0
  for (const [l, ns] of [...byLayer.entries()].sort((a, b) => a[0] - b[0])) {
    let y = ST.PAD
    for (const n of ns) { pos.set(n.id, { x: ST.PAD + l * ST.LX, y, n }); y += ST.NH + ST.GY; if (y > maxY) maxY = y }
  }
  const nodes = [...pos.values()].map(p => ({ ...p, w: ST.NW, h: ST.NH }))
  const edges = s.edges.map(e => {
    const a = pos.get(e.from), b = pos.get(e.to)
    if (!a || !b) return null
    const primary = mainTypes.find(t => e.types.includes(t)) ?? 'derived'
    return {
      x1: a.x + ST.NW, y1: a.y + ST.NH / 2, x2: b.x, y2: b.y + ST.NH / 2,
      type: primary, color: relMeta(primary).color, dashed: e.types.length === 1 && e.types[0] === 'copy',
    }
  }).filter((e): e is NonNullable<typeof e> => e !== null)
  return { nodes, edges, width: ST.PAD * 2 + s.layerCount * ST.LX, height: Math.max(maxY, 70) }
})

// 構造図のノードをクリック → 詳細（取得元/提供先・代表数式）をボックス表示
const selectedStructNode = ref<string | null>(null)
watch(selectedStructure, () => { selectedStructNode.value = null })
const structNodeDetail = computed(() => {
  const s = selectedStructure.value
  if (!s || !selectedStructNode.value) return null
  const node = s.nodes.find(n => n.id === selectedStructNode.value)
  if (!node) return null
  const nameOf = (id: string) => s.nodes.find(n => n.id === id)?.label ?? id
  const incoming = s.edges.filter(e => e.to === node.id).map(e => ({ label: nameOf(e.from), types: e.types }))
  const outgoing = s.edges.filter(e => e.from === node.id).map(e => ({ label: nameOf(e.to), types: e.types }))
  return { node, incoming, outgoing }
})

// AI解読がある表領域ID（グラフのノード表示用）
const aiRegionIds = computed(() => {
  const s = new Set<string>()
  graph.value?.regions.forEach(r => { if (r.ai && r.ai.length) s.add(r.id) })
  return s
})

// ノード見出し2段目の小さなメタ情報行（複数ファイル時のファイル名 / AI解読の有無 / 列数）
const metaLine = (r: RelRegion): string =>
  [
    multiFile.value ? nodeTitle(r).sub : null,
    aiRegionIds.value.has(r.id) ? 'AI' : null,
    `${r.columns.length}列`,
  ].filter(Boolean).join(' · ')

// 参照関係から日本語の役割説明を自動生成
function describe(up: number, down: number): string {
  if (up === 0 && down > 0) return '他シートの計算元になっている起点データ（マスタ／取込元）と推定されます。'
  if (up > 0 && down > 0) return '他シートを参照しつつ、別シートからも参照される中間シートです。'
  if (up > 0 && down === 0) return '他シートを参照して作られる終着シート（帳票・レポート）と推定されます。'
  return '他シートとの参照関係は検出されていません（独立シート・手入力の可能性）。'
}

// SVG テキストは自動で折り返し・省略されないため、箱幅に合わせて手動で省略する。
// 半角(ASCII・半角カナ)はおよそフォント幅の0.6、全角は1としてざっくり見積もる。
const charPx = (ch: string, fontPx: number) => (/[\x00-\xff｡-ﾟ]/.test(ch) ? fontPx * 0.6 : fontPx)
function fitText(s: string, maxPx: number, fontPx: number): string {
  let acc = 0, out = ''
  for (const ch of s) {
    const cw = charPx(ch, fontPx)
    if (acc + cw > maxPx) return out + '…'
    acc += cw; out += ch
  }
  return out
}
// 列番号(1始まり) → 列記号(A, B, ... AA)
function colLetterRef(c: number): string {
  let s = ''; let n = c
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26) }
  return s || 'A'
}
</script>

<template>
  <div class="panel">
    <h2>シート関係 — どの表がどう繋がっているか</h2>
    <p class="muted">
      アップロードした全ファイルの中で「どの表のどの列が、別のどの表から計算・転記されているか」を自動解析します。
      <span v-if="multiFile">ファイルが複数あるので、<strong>ファイルをまたぐ関係</strong>も対象です。</span>
      手で値を貼った（数式が無い）箇所は値の一致から推定し<span style="color:#c62828">赤い破線</span>で示します。
    </p>

    <div v-if="analyzableCount === 0" class="muted" style="padding:12px 0">
      関係分析できるファイル（.xlsx / .csv）がまだありません。「資料アップロード」から追加してください。
    </div>

    <template v-else>
      <p v-if="loading" class="muted">解析中…（大きいファイルは初回 10〜20 秒ほどかかります。2回目以降は即時表示されます）</p>
      <p v-if="error" class="error-box">{{ error }}</p>

      <template v-if="graph && graph.regions.length > 0">
        <div class="summary muted">
          {{ graph.fileCount }} ファイル / {{ graph.regions.length }} 表 /
          {{ (graph.edgeTotal ?? graph.edges.length).toLocaleString() }} 関係
          <span v-if="graph.edgeCollapsed" class="badge warn">大規模のため代表 {{ graph.edges.length.toLocaleString() }} 件に集約表示</span>
          <span v-if="multiFile && crossFileCopies > 0" class="badge ng">ファイル間コピー {{ crossFileCopies }} 件</span>
          <span v-if="graph.hasFindings" class="badge info">AI解読 融合済み</span>
        </div>
        <p v-if="!graph.hasFindings" class="ai-banner">
          まだ「② AI解読」が未実行です。実行すると各シートの<strong>意味づけ</strong>が関係図に融合され、表をクリックすると AI の解読内容が表示されます。
          あわせて、下記の<strong>全体構造の解説</strong>（データの流れの要約）も生成されます。
        </p>

        <!-- 全体構造の解説（AI が「入力→加工→出力」を平易な日本語で要約） -->
        <div v-if="overview" class="overview">
          <div class="ov-head">
            <span class="ov-ico">🗺️</span>
            <h3>全体構造の解説 — どのデータが、どう加工され、どう出力されるか</h3>
          </div>
          <p class="ov-summary">{{ overview.summary }}</p>

          <!-- 入力 → 加工 → 出力 の3段フロー -->
          <div class="ov-flow">
            <section class="ov-col ov-in">
              <div class="ov-col-title">📥 入力データ</div>
              <ul>
                <li v-for="(it, i) in overview.inputs" :key="i">
                  <strong>{{ it.name }}</strong>
                  <span class="muted">{{ it.description }}</span>
                </li>
                <li v-if="overview.inputs.length === 0" class="muted">（入力データの特定なし）</li>
              </ul>
            </section>
            <div class="ov-arrow">→</div>
            <section class="ov-col ov-step">
              <div class="ov-col-title">⚙️ 加工の流れ</div>
              <ol>
                <li v-for="(st, i) in overview.steps" :key="i">
                  <strong>{{ st.title }}</strong>
                  <span class="muted">{{ st.description }}</span>
                </li>
                <li v-if="overview.steps.length === 0" class="muted">（加工ステップの特定なし）</li>
              </ol>
            </section>
            <div class="ov-arrow">→</div>
            <section class="ov-col ov-out">
              <div class="ov-col-title">📤 出力（帳票・レポート）</div>
              <ul>
                <li v-for="(o, i) in overview.outputs" :key="i">
                  <strong>{{ o.name }}</strong>
                  <span class="muted">{{ o.description }}</span>
                </li>
                <li v-if="overview.outputs.length === 0" class="muted">（出力物の特定なし）</li>
              </ul>
            </section>
          </div>

          <!-- 注意点 -->
          <div v-if="overview.caveats.length" class="ov-caveats">
            <div class="ov-caveats-title">⚠ 関係者への注意</div>
            <ul>
              <li v-for="(c, i) in overview.caveats" :key="i">{{ c }}</li>
            </ul>
          </div>
          <p class="muted ov-foot">この解説は AI解読（②）の結果から自動生成されています。資料を追加・変更して再解読すると更新されます。</p>
        </div>

        <!-- 凡例 -->
        <div class="legend">
          <span v-for="t in usedTypes" :key="t" class="legend-item">
            <span class="swatch" :style="{ background: relMeta(t).color, borderStyle: relMeta(t).dashed ? 'dashed' : 'solid' }"></span>
            <strong>{{ relMeta(t).label }}</strong>：{{ relMeta(t).desc }}
          </span>
        </div>

        <!-- 表示切替: 列を隠すと表どうしの繋がりだけ見えて分かりやすい -->
        <div class="graph-toolbar">
          <button @click="showColumns = !showColumns">
            {{ showColumns ? '列を隠す（表だけ表示）' : '各表の列も表示する' }}
          </button>
          <span class="muted">表をクリックすると関係するシートだけ強調され、要約が下に表示されます。もう一度クリックで解除。</span>
        </div>

        <!-- グラフ -->
        <div class="graph-wrap">
          <svg :width="layout.width" :height="layout.height" :viewBox="`0 0 ${layout.width} ${layout.height}`">
            <defs>
              <marker v-for="t in usedTypes" :key="t" :id="`arrow-${t}`" markerWidth="9" markerHeight="9"
                refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
                <path d="M0,0 L8,3 L0,6 Z" :fill="relMeta(t).color" />
              </marker>
            </defs>
            <g v-for="(e, i) in layout.edges" :key="i" :opacity="edgeDim(e.from, e.to) ? 0.1 : 1">
              <path
                :d="`M${e.x1},${e.y1} C${e.x1 + 50},${e.y1} ${e.x2 - 50},${e.y2} ${e.x2},${e.y2}`"
                fill="none" :stroke="e.color" stroke-width="2"
                :stroke-dasharray="e.dashed ? '6 4' : undefined"
                :marker-end="`url(#arrow-${e.copy ? 'copy' : (mainTypes.find(t => e.types.has(t)) ?? 'derived')})`"
              />
            </g>
            <g v-for="n in layout.nodes" :key="n.region.id"
              style="cursor:pointer" :opacity="isDim(n.region.id) ? 0.15 : 1"
              @click="selectRegion(n.region.id)">
              <rect :x="n.x" :y="n.y" :width="n.w" :height="n.h" rx="7" fill="#fff"
                :stroke="n.region.id === selected ? '#e65100' : '#1b6ec2'" :stroke-width="n.region.id === selected ? 3 : 1.5" />
              <rect :x="n.x" :y="n.y" :width="n.w" :height="headerH" rx="7" :fill="n.region.id === selected ? '#e65100' : '#1b6ec2'" />
              <!-- 見出し1段目: シート名（箱幅に収まるよう省略、全名はホバーで表示） -->
              <text :x="n.x + 11" :y="n.y + 17" fill="#fff" font-size="13.5" font-weight="700">
                {{ fitText(nodeTitle(n.region).main, n.w - 22, 13.5) }}
              </text>
              <!-- 見出し2段目: 小さなメタ情報（ファイル名 · AI · 列数） -->
              <text :x="n.x + 11" :y="n.y + 32" fill="#cfe3f7" font-size="10">
                {{ fitText(metaLine(n.region), n.w - 22, 10) }}
              </text>
              <!-- 列は折りたたみ可能（列名も箱幅に収める） -->
              <template v-if="showColumns">
                <text v-for="(col, ci) in n.region.columns" :key="col.c"
                  :x="n.x + 12" :y="n.y + headerH + 18 + ci * COL_ROW_H" font-size="12.5" fill="#333">
                  {{ fitText(col.name, n.w - 30, 12.5) }}
                  <tspan v-if="col.hasFormula" fill="#e65100"> ƒ</tspan>
                  <tspan v-if="col.mixedFormula" fill="#c62828"> ⚠</tspan>
                </text>
              </template>
            </g>
          </svg>
        </div>
        <p class="muted caption">
          箱＝{{ multiFile ? '表（ファイル・シート単位、' : '表（シート単位、' }}1シートに複数表があれば自動分割）。矢印は「左の表 → 右の表」へデータが流れる向き。
          列を開くと <span class="ff">ƒ</span>＝数式列、<span class="warn-mark">⚠</span>＝数式列なのに一部手入力の疑い、が表示されます。
        </p>

        <!-- 選択シートの要約 -->
        <div v-if="selectedSummary" class="sheet-summary">
          <div class="ss-head">
            <strong>{{ selectedSummary.sheet }}</strong>
            <button class="ss-close" @click="selected = null">閉じる</button>
          </div>
          <p class="muted ss-desc">{{ selectedSummary.description }}</p>
          <table class="ss-table">
            <tbody>
              <tr><th>表領域</th><td>{{ selectedSummary.range }}（{{ selectedSummary.colCount }}列）</td></tr>
              <tr><th>総セル数</th><td>{{ selectedSummary.totalCells != null ? selectedSummary.totalCells.toLocaleString() + 'セル' : '—' }}</td></tr>
              <tr><th>行数</th><td>{{ selectedSummary.rowCount != null ? selectedSummary.rowCount.toLocaleString() + '行' : '—' }}</td></tr>
              <tr>
                <th>数式</th>
                <td>
                  <span v-if="selectedSummary.formulaCells != null">数式セル {{ selectedSummary.formulaCells.toLocaleString() }}個・</span>数式列 {{ selectedSummary.formulaCols }}列
                  <span v-if="selectedSummary.mixedCols > 0" class="warn-mark">（うち手入力混入の疑い {{ selectedSummary.mixedCols }}列）</span>
                  <span v-if="selectedSummary.formulaCols === 0 && !selectedSummary.formulaCells" class="muted">数式なし（値のみ）</span>
                </td>
              </tr>
              <tr>
                <th>参照元（取得元）</th>
                <td>
                  <template v-if="selectedSummary.refUp.length">
                    <span v-for="(s, i) in selectedSummary.refUp" :key="i" class="ss-chip">{{ s }}</span>
                  </template>
                  <span v-else class="muted">なし</span>
                </td>
              </tr>
              <tr>
                <th>参照先（提供先）</th>
                <td>
                  <template v-if="selectedSummary.refDown.length">
                    <span v-for="(s, i) in selectedSummary.refDown" :key="i" class="ss-chip">{{ s }}</span>
                  </template>
                  <span v-else class="muted">なし</span>
                </td>
              </tr>
            </tbody>
          </table>

          <!-- このシートの内部構造（階層フロー: 入力→計算→出力） -->
          <div v-if="structLayout" class="ss-struct">
            <div class="ss-struct-head">このシートの内部構造（データの流れ）</div>
            <div class="struct-wrap">
              <svg :width="structLayout.width" :height="structLayout.height" :viewBox="`0 0 ${structLayout.width} ${structLayout.height}`">
                <defs>
                  <marker v-for="t in usedTypes" :key="t" :id="`sarrow-${t}`" markerWidth="8" markerHeight="8"
                    refX="7" refY="3" orient="auto" markerUnits="strokeWidth">
                    <path d="M0,0 L7,3 L0,6 Z" :fill="relMeta(t).color" />
                  </marker>
                </defs>
                <path v-for="(e, i) in structLayout.edges" :key="i"
                  :d="`M${e.x1},${e.y1} C${e.x1 + 40},${e.y1} ${e.x2 - 40},${e.y2} ${e.x2},${e.y2}`"
                  fill="none" :stroke="e.color" stroke-width="1.8"
                  :stroke-dasharray="e.dashed ? '5 4' : undefined" :marker-end="`url(#sarrow-${e.type})`" />
                <g v-for="n in structLayout.nodes" :key="n.n.id" style="cursor:pointer"
                  @click="selectedStructNode = (selectedStructNode === n.n.id ? null : n.n.id)">
                  <rect :x="n.x" :y="n.y" :width="n.w" :height="n.h" rx="7" fill="#fff"
                    :stroke="selectedStructNode === n.n.id ? '#e65100' : '#2563eb'"
                    :stroke-width="selectedStructNode === n.n.id ? 2.5 : 1.3" />
                  <text :x="n.x + 10" :y="n.y + (n.n.colCount > 1 ? 16 : 23)" font-size="12" font-weight="600" fill="#1b212b">{{ fitText(n.n.label, n.w - 20, 12) }}</text>
                  <text v-if="n.n.colCount > 1" :x="n.x + 10" :y="n.y + 30" font-size="10" fill="#9aa1ad">{{ n.n.colCount }}列</text>
                </g>
              </svg>
            </div>
            <p class="muted struct-cap">
              左＝入力、右へ行くほど計算・出力です。<strong>各ボックスをクリック</strong>すると、取得元・提供先と代表数式が下に表示されます。反復する列はまとめています{{ selectedStructure?.truncated ? '（多いため主要なグループのみ表示）' : '' }}。
            </p>

            <!-- ノードクリック時の詳細ボックス -->
            <div v-if="structNodeDetail" class="struct-detail">
              <div class="sd-head">
                <strong>{{ structNodeDetail.node.label }}</strong>
                <span v-if="structNodeDetail.node.colCount > 1" class="badge info">{{ structNodeDetail.node.colCount }}列</span>
                <button class="sd-close" @click="selectedStructNode = null">閉じる</button>
              </div>
              <div class="sd-grid">
                <div v-if="structNodeDetail.incoming.length" class="sd-block">
                  <div class="sd-label">取得元（この計算の入力）</div>
                  <div class="sd-chips">
                    <span v-for="(s, i) in structNodeDetail.incoming" :key="'i' + i" class="badge info">{{ s.label }}</span>
                  </div>
                </div>
                <div v-if="structNodeDetail.outgoing.length" class="sd-block">
                  <div class="sd-label">提供先（この結果を使う）</div>
                  <div class="sd-chips">
                    <span v-for="(s, i) in structNodeDetail.outgoing" :key="'o' + i" class="badge">{{ s.label }}</span>
                  </div>
                </div>
              </div>
              <div v-if="structNodeDetail.node.samples.length" class="sd-block">
                <div class="sd-label">代表的な数式（実際のセル式）</div>
                <table class="sd-formulas">
                  <tbody>
                    <tr v-for="(s, i) in structNodeDetail.node.samples" :key="i">
                      <td class="mono sd-col">{{ s.col }}</td>
                      <td class="mono">= {{ s.formula }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p v-else class="muted" style="margin:6px 0 0">この要素は入力（数式なし）です。</p>
              <p v-if="structNodeDetail.node.colCount > structNodeDetail.node.cols.length" class="muted" style="margin:6px 0 0">
                （列 {{ structNodeDetail.node.colCount }} 件中 {{ structNodeDetail.node.cols.length }} 件を表示）
              </p>
            </div>
          </div>

          <!-- AI解読（decode の融合結果） -->
          <div class="ss-ai">
            <div class="ss-ai-head">AI解読</div>
            <ul v-if="selectedSummary.ai.length" class="ss-ai-list">
              <li v-for="(f, i) in selectedSummary.ai" :key="i">
                <div class="ss-ai-meta">
                  <span class="mono muted">{{ f.source_ref }}</span>
                  <span class="badge">{{ logicLabel(f.logic_type) }}</span>
                  <span class="badge" :class="f.kpiee_target === 'needs_customer_confirmation' ? 'warn' : 'info'">→ {{ targetLabel(f.kpiee_target) }}</span>
                  <span class="badge" :class="f.confidence === 'high' ? 'ok' : f.confidence === 'low' ? 'ng' : 'warn'">確信度 {{ f.confidence }}</span>
                </div>
                <div class="ss-ai-exp">{{ f.explanation }}</div>
              </li>
            </ul>
            <p v-else class="muted" style="margin:4px 0">
              このシートの AI解読はまだありません。「② AI解読」を実行すると、各シートの意味がここに反映されます。
            </p>
          </div>
        </div>

        <!-- 関係リスト -->
        <h3>関係の一覧（根拠つき）</h3>
        <p v-if="graph.edgeCollapsed" class="muted" style="margin:-2px 0 8px">
          関係が {{ (graph.edgeTotal ?? 0).toLocaleString() }} 件と多いため、表どうしの関係ごとに代表的な根拠のみを表示しています。
        </p>
        <div v-for="grp in groupedEdges" :key="grp.type" class="rel-group">
          <div class="rel-head">
            <span class="swatch" :style="{ background: relMeta(grp.type).color, borderStyle: relMeta(grp.type).dashed ? 'dashed' : 'solid' }"></span>
            <strong>{{ relMeta(grp.type).label }}</strong>
            <span class="muted">— {{ relMeta(grp.type).desc }}（{{ grp.items.length }}件）</span>
          </div>
          <table>
            <tbody>
              <tr v-for="(e, i) in grp.items" :key="i">
                <td>{{ short(e.from) }}</td>
                <td style="text-align:center;color:#888">→</td>
                <td>{{ short(e.to) }}</td>
                <td class="evidence">
                  <code>{{ e.evidence }}</code>
                  <div v-if="e.aiHint" class="ai-hint"><strong>AI解読（提供先）</strong> {{ e.aiHint }}</div>
                </td>
                <td v-if="e.needsConfirmation"><span class="badge warn">要確認</span></td>
                <td v-else></td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- 注意（全件の羅列は確認不能なため、ここは要約のみ。整理表示は「⚠ 要確認」タブへ） -->
        <div v-if="graph.warnings.length" class="warn-panel">
          <div class="warn-head">
            <h3>注意（{{ (graph.warningTotal ?? graph.warnings.length).toLocaleString() }}件）</h3>
            <button class="primary" @click="emit('open-attention')">⚠ 要確認タブでシート別に見る</button>
          </div>
          <p class="muted" style="margin:4px 0 8px">手入力混入などの指摘です。全件はシート別・列別に集約した「⚠ 要確認」タブで確認してください。以下は例です。</p>
          <ul>
            <li v-for="(w, i) in graph.warnings.slice(0, 5)" :key="i">
              <span class="warn-loc">📍 {{ short(w.ref) }}</span> {{ w.message }}
            </li>
          </ul>
        </div>
      </template>

      <p v-else-if="graph && !loading" class="muted">関係を検出できる表が見つかりませんでした。</p>
    </template>
  </div>
</template>

<style scoped>
h3 { font-size:14px; margin:20px 0 8px; }
.summary { display:flex; align-items:center; gap:8px; margin:8px 0; }
.caption { line-height:1.6; margin:8px 0 0; }
.ff { color:#e65100; font-weight:600 }
.warn-mark { color:#b91c1c }

/* 凡例 */
.legend { display:flex; flex-wrap:wrap; gap:8px 18px; margin:12px 0; padding:12px 14px; background:#f7f8fa; border:1px solid #eceff3; border-radius:8px; font-size:12.5px; color:#4b5563 }
.legend-item { display:inline-flex; align-items:center; gap:7px }
.legend-item strong { color:#1f2430 }
.swatch { display:inline-block; width:13px; height:13px; border-radius:3px; border:2px solid transparent }

/* グラフ */
.graph-toolbar { display:flex; align-items:center; gap:12px; flex-wrap:wrap; margin:12px 0 8px }
.graph-toolbar .muted { font-size:12px }
.graph-wrap { overflow-x:auto; border:1px solid #eceff3; border-radius:10px; padding:10px; background:#fcfcfd }

/* 関係リスト */
.rel-group { margin:14px 0 }
.rel-head { display:flex; align-items:center; gap:8px; margin-bottom:6px; font-size:13px }
.evidence code { font-size:12px; color:#475569; background:#f4f5f7; padding:2px 6px; border-radius:4px; word-break:break-all }
.ai-hint { margin-top:4px; font-size:12px; color:#475569; line-height:1.5 }
.ai-hint strong { color:#155a9e; margin-right:4px }

/* 選択シートの要約 */
.sheet-summary { margin:14px 0; padding:16px 18px; border:1px solid #e3e7ec; border-radius:10px; background:#fcfdfe; box-shadow:0 1px 3px rgba(0,0,0,0.04) }
.ss-head { display:flex; justify-content:space-between; align-items:center; gap:8px }
.ss-head strong { font-size:16px }
.ss-close { padding:3px 12px; font-size:12px }
.ss-desc { margin:6px 0 12px; line-height:1.6 }
.ss-table { width:100%; border-collapse:collapse }
.ss-table th, .ss-table td { border:none; border-bottom:1px solid #eef1f4; padding:7px 4px; font-size:13px }
.ss-table th { text-align:left; width:130px; vertical-align:top; color:#6b7280; font-weight:600; white-space:nowrap }
.ss-table tr:last-child th, .ss-table tr:last-child td { border-bottom:none }
.ss-chip { display:inline-block; margin:2px 5px 2px 0; padding:2px 10px; background:#eef2f7; border-radius:12px; font-size:12.5px; color:#374151 }

/* シート内部構造（階層フロー図） */
.ss-struct { margin-top:14px; padding-top:12px; border-top:1px solid #eef1f4 }
.ss-struct-head { font-weight:700; font-size:13px; color:#155a9e; margin-bottom:8px }
.struct-wrap { overflow-x:auto; border:1px solid #eceff3; border-radius:8px; padding:8px; background:#fcfcfd }
.struct-cap { margin:6px 0 0; font-size:12px }

/* ノードクリック詳細ボックス */
.struct-detail { margin-top:12px; padding:14px 16px; border:1px solid #e3e7ec; border-radius:10px; background:#f9fafb; }
.sd-head { display:flex; align-items:center; gap:8px; margin-bottom:10px; }
.sd-head strong { font-size:15px; }
.sd-close { margin-left:auto; padding:3px 12px; font-size:12px; }
.sd-grid { display:flex; flex-wrap:wrap; gap:16px 28px; margin-bottom:10px; }
.sd-block { min-width:0; }
.sd-label { font-size:11px; font-weight:700; color:#6b7280; margin-bottom:5px; }
.sd-chips { display:flex; flex-wrap:wrap; gap:5px; }
.sd-formulas { background:#fff; border:1px solid #eceff3; border-radius:8px; overflow:hidden; }
.sd-formulas td { font-size:12px; padding:6px 10px; border-bottom:1px solid #f1f3f6; }
.sd-formulas tr:last-child td { border-bottom:none; }
.sd-col { white-space:nowrap; color:#1d4ed8; font-weight:600; width:1%; }

/* AI解読セクション */
.ss-ai { margin-top:14px; padding-top:12px; border-top:1px solid #eef1f4 }
.ss-ai-head { font-weight:700; font-size:13px; color:#155a9e; margin-bottom:8px }
.ss-ai-list { margin:0; padding-left:0; list-style:none; display:flex; flex-direction:column; gap:10px }
.ss-ai-list li { font-size:13px; line-height:1.6 }
.ss-ai-meta { display:flex; flex-wrap:wrap; align-items:center; gap:5px; margin-bottom:3px }
.ss-ai-exp { color:#374151 }

/* 全体構造の解説（入力→加工→出力フロー） */
.overview { margin:14px 0; padding:16px 18px; border:1px solid #d6e4f5; border-radius:12px; background:linear-gradient(180deg,#f6faff 0%,#fcfdff 100%); }
.ov-head { display:flex; align-items:center; gap:8px; margin-bottom:6px }
.ov-head h3 { margin:0; font-size:15px; color:#10325c }
.ov-ico { font-size:18px }
.ov-summary { margin:4px 0 14px; font-size:14px; line-height:1.7; color:#26303c }
.ov-flow { display:flex; align-items:stretch; gap:8px; flex-wrap:wrap }
.ov-col { flex:1; min-width:200px; background:#fff; border:1px solid #e3e7ec; border-radius:10px; padding:12px 14px }
.ov-col.ov-in { border-top:3px solid #00ac47 }
.ov-col.ov-step { border-top:3px solid #1565c0 }
.ov-col.ov-out { border-top:3px solid #e65100 }
.ov-col-title { font-weight:700; font-size:13px; margin-bottom:8px; color:#1f2430 }
.ov-col ul, .ov-col ol { margin:0; padding-left:18px; display:flex; flex-direction:column; gap:8px }
.ov-col ul { list-style:none; padding-left:0 }
.ov-col li { font-size:13px; line-height:1.55 }
.ov-col li strong { display:block; color:#1b212b }
.ov-col li .muted { font-size:12.5px }
.ov-arrow { display:flex; align-items:center; font-size:22px; color:#9aa7b6; font-weight:700 }
.ov-caveats { margin-top:14px; padding:10px 14px; background:#fffaf2; border:1px solid #f4e3c8; border-radius:8px }
.ov-caveats-title { font-weight:700; font-size:13px; color:#92510a; margin-bottom:6px }
.ov-caveats ul { margin:0; padding-left:18px; font-size:13px; line-height:1.7; color:#5b4a2e }
.ov-foot { margin:12px 0 0; font-size:11.5px }
/* 入力→加工→出力は横並びが基本。狭い画面では縦積みにし矢印を回転 */
@media (max-width: 760px) {
  .ov-flow { flex-direction:column }
  .ov-arrow { justify-content:center; transform:rotate(90deg) }
}

/* 案内・注意 */
.ai-banner { margin:8px 0; padding:10px 14px; background:#f7f8fa; border:1px solid #eceff3; border-left:3px solid var(--primary); border-radius:8px; font-size:13px; line-height:1.6 }
.warn-panel { margin-top:16px; padding:14px 16px; background:#fffaf2; border:1px solid #f4e3c8; border-radius:10px }
.warn-panel h3 { margin:0 0 8px; font-size:14px }
.warn-panel ul { margin:0; padding-left:18px; font-size:13px; line-height:1.7 }
.warn-loc { font-weight:600; color:#92400e; margin-right:4px; white-space:nowrap }
.warn-head { display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap }
.warn-head h3 { margin:0 }
</style>

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
// ①' キー・軸: 各表の主キー／軸列（何を軸に1行が決まるか）と、表どうしを結ぶキーの対応も表示する

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

// 全体構造の解説（decode 実行後に付与される。未実行なら null）
const overview = computed(() => graph.value?.overview ?? null)
// 旧形式（入力→加工→出力）で保存された過去の解読結果か。新フィールドが無い場合のみ従来のフロー表示へ
const isLegacyOverview = computed(() =>
  !!overview.value && !(overview.value.sheet_composition?.length || overview.value.table_definitions?.length))
// シート構成の役割バッジ色
const roleClass = (role: string) =>
  role === '入力' ? 'role-in' : role === '中間集計' ? 'role-mid' : role === '最終出力' ? 'role-out' : 'role-etc'

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

// ---- 表領域の選択（ER図の箱クリックで下に詳細を表示。再クリックで解除） ----
function selectRegion(id: string) {
  selected.value = selected.value === id ? null : id
}

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
    keys: r.keys ?? null,
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

// 表と表を結ぶキー列の対応（利用回数の多い順）
const keyLinks = computed(() => [...(graph.value?.keyLinks ?? [])].sort((a, b) => b.count - a.count))
const KEYLINK_SHOW = 50
// ER図の表示範囲: 既定は「対応（紐づき）に参加しているキー行・表だけ」に集約して見やすく。
// トグルで全キー・全表（キー検出済み）に切り替えられる
const showAllKeys = ref(false)

// 共通の層割り（入次数0を左端に、最長路で層を決める。循環は打ち切り）
function layerize(ids: string[], edges: { from: string; to: string }[]): Map<string, number> {
  const incoming = new Map<string, string[]>(ids.map(id => [id, []]))
  for (const e of edges) incoming.get(e.to)?.push(e.from)
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
  return layerOf
}

// ---- ① データフロー図（ファイル=箱、矢印=ファイルをまたぐデータの流れ） ----
// 数式はファイルを跨げないため、ファイル間の流れは実質「手コピー（値一致）」の集約。
const FF = { W: 200, H: 48, GX: 150, GY: 28, PAD: 16 }
const fileFlow = computed(() => {
  const g = graph.value
  if (!g || (g.fileCount ?? 0) <= 1) return null
  const files = [...new Set(g.regions.map(r => r.file))]
  if (files.length <= 1) return null
  // ファイル間辺の集約（filter-key は補助線なので除外）
  const agg = new Map<string, { from: string; to: string; count: number }>()
  for (const e of g.edges) {
    if (e.type === 'filter-key') continue
    const ff = regionById.value.get(regionIdOf(e.from))?.file
    const tf = regionById.value.get(regionIdOf(e.to))?.file
    if (!ff || !tf || ff === tf) continue
    const k = `${ff}->${tf}`
    const cur = agg.get(k)
    if (cur) cur.count++
    else agg.set(k, { from: ff, to: tf, count: 1 })
  }
  const flowEdges = [...agg.values()]
  const layerOf = layerize(files, flowEdges)
  const byLayer = new Map<number, string[]>()
  for (const f of files) {
    const l = layerOf.get(f) ?? 0
    if (!byLayer.has(l)) byLayer.set(l, [])
    byLayer.get(l)!.push(f)
  }
  // ファイルごとのシート数（箱の副題）
  const sheetsOf = new Map<string, Set<string>>()
  for (const r of g.regions) {
    if (!sheetsOf.has(r.file)) sheetsOf.set(r.file, new Set())
    sheetsOf.get(r.file)!.add(r.sheet)
  }
  const pos = new Map<string, { x: number; y: number }>()
  let maxY = 0
  for (const [l, fs] of [...byLayer.entries()].sort((a, b) => a[0] - b[0])) {
    let y = FF.PAD
    for (const f of fs) { pos.set(f, { x: FF.PAD + l * (FF.W + FF.GX), y }); y += FF.H + FF.GY; if (y > maxY) maxY = y }
  }
  const nodes = files.map(f => ({
    id: f, ...pos.get(f)!, w: FF.W, h: FF.H,
    label: f, sub: `${sheetsOf.get(f)?.size ?? 0}シート`,
  }))
  const edges = flowEdges.map(e => {
    const a = pos.get(e.from)!, b = pos.get(e.to)!
    const x1 = a.x + FF.W, y1 = a.y + FF.H / 2, x2 = b.x, y2 = b.y + FF.H / 2
    return { ...e, x1, y1, x2, y2, mx: (x1 + x2) / 2, my: (y1 + y2) / 2 - 6 }
  })
  const width = FF.PAD * 2 + (Math.max(0, ...files.map(f => layerOf.get(f) ?? 0)) + 1) * (FF.W + FF.GX) - FF.GX
  return { nodes, edges, width, height: Math.max(maxY, 80) }
})

// ---- ② キー関係図（ER図: キー列だけのエンティティ箱 ＋ 直角の紐づき線 ＋ 1/N 表記） ----
const KD = { W: 230, HEAD: 34, ROW: 24, GX: 170, GY: 30, PAD: 16, CAP: 24 }
const keyDiagram = computed(() => {
  const g = graph.value
  if (!g) return null
  const links = keyLinks.value
  const withKeys = g.regions.filter(r => (r.keys?.keys?.length ?? 0) > 0)
  if (withKeys.length === 0) return null
  const linkedIds = new Set(links.flatMap(l => [regionIdOf(l.a), regionIdOf(l.b)]))
  // 既定（集約表示）は紐づきに参加している表だけ。紐づきが1つも無いときは集約できないので全表
  const condensed = !showAllKeys.value && links.length > 0
  const pool = condensed ? withKeys.filter(r => linkedIds.has(r.id)) : withKeys
  // 紐づきに参加する表を優先し、残りは主キー持ちを優先。多すぎる場合は打ち切り
  const show = [...pool].sort((a, b) => {
    const la = linkedIds.has(a.id) ? 1 : 0, lb = linkedIds.has(b.id) ? 1 : 0
    if (la !== lb) return lb - la
    const pa = a.keys!.keys.some(k => k.role === 'primary') ? 1 : 0
    const pb = b.keys!.keys.some(k => k.role === 'primary') ? 1 : 0
    return pb - pa
  }).slice(0, KD.CAP)
  const showIds = new Set(show.map(r => r.id))
  const shownLinks = links.filter(l => showIds.has(regionIdOf(l.a)) && showIds.has(regionIdOf(l.b)))
  // データは b（参照される側=マスタ）→ a（数式側）に流れるので b を左の層へ
  const layerOf = layerize(show.map(r => r.id),
    shownLinks.map(l => ({ from: regionIdOf(l.b), to: regionIdOf(l.a) })))
  const byLayer = new Map<number, typeof show>()
  for (const r of show) {
    const l = layerOf.get(r.id) ?? 0
    if (!byLayer.has(l)) byLayer.set(l, [])
    byLayer.get(l)!.push(r)
  }
  const layersSorted = [...byLayer.entries()].sort((a, b) => a[0] - b[0])

  // 線の交差を減らす簡易バリセンタ: 各層を「前の層にいる接続相手の平均位置」で並べ替える
  const partnersOf = new Map<string, string[]>()
  for (const l of shownLinks) {
    const a = regionIdOf(l.a), b = regionIdOf(l.b)
    if (!partnersOf.has(a)) partnersOf.set(a, [])
    if (!partnersOf.has(b)) partnersOf.set(b, [])
    partnersOf.get(a)!.push(b)
    partnersOf.get(b)!.push(a)
  }
  const orderIndex = new Map<string, number>()
  for (const [l, regs] of layersSorted) {
    if (l > 0) {
      const score = (id: string) => {
        const ps = (partnersOf.get(id) ?? []).filter(p => (layerOf.get(p) ?? 0) < l && orderIndex.has(p))
        return ps.length === 0 ? 1e9 : ps.reduce((s, p) => s + orderIndex.get(p)!, 0) / ps.length
      }
      regs.sort((x, y) => score(x.id) - score(y.id))
    }
    regs.forEach((r, i) => orderIndex.set(r.id, i))
  }

  // 接続されているキー列（行のハイライト・集約表示のフィルタ用）
  const connectedKeys = new Set(shownLinks.flatMap(l => [l.a, l.b]))
  // 集約表示では紐づきに参加しているキー行だけを箱に出す（万一空になる表は全キーへフォールバック）
  const keysOf = (r: RelRegion) => {
    const all = r.keys!.keys
    if (!condensed) return all
    const conn = all.filter(k => connectedKeys.has(`${r.id}:${k.column}`))
    return conn.length > 0 ? conn : all
  }
  // カディナリティ: 列の値が全行一意なら 1（マスタ側）、繰り返しがあれば N（明細側）
  const cardOf = (key: string): string => {
    const st = regionById.value.get(regionIdOf(key))?.columns.find(c => c.name === colOf(key))?.stats
    return st ? (st.uniq === st.filled ? '1' : 'N') : ''
  }

  // 高さ: 層ごとの合計を出し、低い層は縦中央に寄せてバランスさせる
  const heightOf = (r: RelRegion) => KD.HEAD + keysOf(r).length * KD.ROW + 6
  const layerHeights = layersSorted.map(([, regs]) => regs.reduce((s, r) => s + heightOf(r), 0) + (regs.length - 1) * KD.GY)
  const maxLayerH = Math.max(...layerHeights, 90)

  interface KdRow { top: number; cy: number; mark: string; label: string; primary: boolean; connected: boolean; last: boolean }
  const nodes: { id: string; x: number; y: number; w: number; h: number; title: string; sub: string | null; rows: KdRow[] }[] = []
  const rowYOf = new Map<string, number>() // `${regionId}:${col}` → 行中心の y
  layersSorted.forEach(([l, regs], li) => {
    let y = KD.PAD + (maxLayerH - layerHeights[li]) / 2
    for (const r of regs) {
      const ks = keysOf(r)
      const h = heightOf(r)
      const rows: KdRow[] = ks.map((k, i) => {
        const top = y + KD.HEAD + i * KD.ROW
        const cy = top + KD.ROW / 2
        const key = `${r.id}:${k.column}`
        rowYOf.set(key, cy)
        return { top, cy, mark: k.role === 'primary' ? '🔑' : '◇', label: k.column, primary: k.role === 'primary', connected: connectedKeys.has(key), last: i === ks.length - 1 }
      })
      nodes.push({ id: r.id, x: KD.PAD + l * (KD.W + KD.GX), y, w: KD.W, h, title: r.sheet, sub: multiFile.value && r.file !== r.sheet ? r.file : null, rows })
      y += h + KD.GY
    }
  })
  const nodeById = new Map(nodes.map(n => [n.id, n]))

  // 同じキー列ペアは関数違いでも1本にまとめる（関数・根拠は対応表とツールチップで見せる）
  const pairMap = new Map<string, { a: string; b: string; fns: Set<string>; count: number }>()
  for (const l of shownLinks) {
    const k = `${l.a}|${l.b}`
    const cur = pairMap.get(k)
    if (cur) { cur.fns.add(l.fn); cur.count += l.count }
    else pairMap.set(k, { a: l.a, b: l.b, fns: new Set([l.fn]), count: l.count })
  }
  const edges = [...pairMap.values()].map(p => {
    const na = nodeById.get(regionIdOf(p.a))!, nb = nodeById.get(regionIdOf(p.b))!
    const ya = rowYOf.get(p.a) ?? na.y + KD.HEAD / 2
    const yb = rowYOf.get(p.b) ?? nb.y + KD.HEAD / 2
    // マスタ(b) → 利用側(a)。b が左にあれば右辺から、そうでなければ左辺から出す
    const bLeft = nb.x + nb.w <= na.x
    const x1 = bLeft ? nb.x + nb.w : nb.x
    const x2 = bLeft ? na.x : na.x + na.w
    const midX = (x1 + x2) / 2
    return {
      // ER 図らしい直角（エルボ）コネクタ
      d: `M${x1},${yb} L${midX},${yb} L${midX},${ya} L${x2},${ya}`,
      // 端点のカディナリティ（1=一意/マスタ, N=繰り返し/明細）
      bCard: { x: x1 + (bLeft ? 6 : -6), y: yb - 5, anchor: bLeft ? 'start' : 'end', text: cardOf(p.b) },
      aCard: { x: x2 + (bLeft ? -6 : 6), y: ya - 5, anchor: bLeft ? 'end' : 'start', text: cardOf(p.a) },
      title: `${short(p.b)}（${cardOf(p.b) || '?'}） ⇔ ${short(p.a)}（${cardOf(p.a) || '?'}）｜ ${[...p.fns].join('・')}`,
    }
  })
  const maxLayer = Math.max(0, ...layersSorted.map(([l]) => l))
  return {
    nodes, edges,
    width: KD.PAD * 2 + (maxLayer + 1) * (KD.W + KD.GX) - KD.GX,
    height: KD.PAD * 2 + maxLayerH,
    omitted: withKeys.length - show.length, condensed, headH: KD.HEAD, rowH: KD.ROW,
  }
})

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
      「どの表のどの列が、別のどの表から計算・転記されているか」を全ファイル横断で自動解析します。
      <span v-if="multiFile"><strong>ファイルをまたぐ関係</strong>も対象です。</span>
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
          <!-- 顧客との読み合わせ用レポート（自己完結HTML）。画面表示はそのまま、ファイル出力だけを追加 -->
          <a class="report-link" :href="`/api/projects/${projectId}/relations/report`" download>📄 顧客共有用レポート（HTML）</a>
        </div>
        <p v-if="!graph.hasFindings" class="ai-banner">
          まだ「② AI解読」が未実行です。実行すると各シートの<strong>意味づけ</strong>が関係図に融合され、表をクリックすると AI の解読内容が表示されます。
          あわせて、下記の<strong>全体構造の解説</strong>（シート構成とテーブル定義書）も生成されます。
        </p>

        <!-- ① データフロー図: ファイルどうしのデータの流れ（複数ファイル時のみ） -->
        <section v-if="fileFlow" class="sec">
          <div class="sec-head">
            <span class="sec-ico">🗂️</span>
            <div class="sec-titles">
              <h3>データフロー図 — ファイルどうしのデータの流れ</h3>
              <p class="sec-sub">
                矢印＝あるファイルの値が別のファイルで使われている向き（数値は関係の件数<template v-if="graph.edgeCollapsed">・大規模のため代表値</template>）。
                数式はファイルを跨げないため、ファイル間の流れは値の一致から推定した<strong>手コピー</strong>が中心です。
              </p>
            </div>
          </div>
          <div class="graph-wrap">
            <svg :width="fileFlow.width" :height="fileFlow.height" :viewBox="`0 0 ${fileFlow.width} ${fileFlow.height}`">
              <defs>
                <marker id="ff-arrow" markerWidth="9" markerHeight="9" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
                  <path d="M0,0 L8,3 L0,6 Z" fill="#c62828" />
                </marker>
              </defs>
              <g v-for="(e, i) in fileFlow.edges" :key="i">
                <path :d="`M${e.x1},${e.y1} C${e.x1 + 60},${e.y1} ${e.x2 - 60},${e.y2} ${e.x2},${e.y2}`"
                  fill="none" stroke="#c62828" stroke-width="2" stroke-dasharray="6 4" marker-end="url(#ff-arrow)" />
                <text :x="e.mx" :y="e.my" text-anchor="middle" font-size="11" fill="#c62828" class="halo">{{ e.count }}件</text>
              </g>
              <g v-for="n in fileFlow.nodes" :key="n.id">
                <rect :x="n.x" :y="n.y" :width="n.w" :height="n.h" rx="9" fill="#fff7f2" stroke="#e0876a" stroke-width="1.5" />
                <text :x="n.x + 12" :y="n.y + 20" font-size="13" font-weight="700" fill="#7c3a1d">📄 {{ fitText(n.label, n.w - 24, 13) }}</text>
                <text :x="n.x + 12" :y="n.y + 36" font-size="10.5" fill="#a1663f">{{ n.sub }}</text>
              </g>
            </svg>
          </div>
        </section>

        <!-- ② キー関係図: 各表の主キー・軸だけの箱と、キーどうしの紐づき線（ER図風） -->
        <section v-if="keyDiagram" class="sec">
          <div class="sec-head">
            <span class="sec-ico">🔑</span>
            <div class="sec-titles">
              <h3>キー関係図（ER図） — 各表の主キーと、その紐づき</h3>
              <p class="sec-sub">
                箱＝表、行＝<strong>キー列だけ</strong>（🔑＝主キー、◇＝軸・結合キー）。
                線はキーどうしの紐づきで、端の <strong>1</strong>＝値が一意（マスタ側）、<strong>N</strong>＝繰り返しあり（明細側）。
                線にマウスを乗せると照合方法が表示され、根拠は下の対応表で確認できます。
                <strong>箱をクリック</strong>すると、その表の詳細（キーの根拠・統計・内部構造・AI解読）が下に表示されます。
                <template v-if="keyDiagram.condensed">いまは<strong>対応があるキー行・表だけ</strong>に集約して表示中です。</template>
              </p>
            </div>
            <button v-if="keyLinks.length" class="sec-action" @click="showAllKeys = !showAllKeys">
              {{ showAllKeys ? '対応があるキーだけに集約' : 'すべてのキー・表を表示' }}
            </button>
          </div>
          <div class="graph-wrap">
            <svg :width="keyDiagram.width" :height="keyDiagram.height" :viewBox="`0 0 ${keyDiagram.width} ${keyDiagram.height}`">
              <!-- 紐づき線（ER らしい直角コネクタ + 1/N） -->
              <g v-for="(e, i) in keyDiagram.edges" :key="i" class="kd-edge">
                <title>{{ e.title }}</title>
                <path :d="e.d" fill="none" stroke="#7c3aed" stroke-width="1.8" />
                <text :x="e.bCard.x" :y="e.bCard.y" :text-anchor="e.bCard.anchor" font-size="11" fill="#5b21b6" class="halo">{{ e.bCard.text }}</text>
                <text :x="e.aCard.x" :y="e.aCard.y" :text-anchor="e.aCard.anchor" font-size="11" fill="#5b21b6" class="halo">{{ e.aCard.text }}</text>
              </g>
              <!-- エンティティ箱（キー列だけの表）。クリックでその表の詳細を下に表示 -->
              <g v-for="n in keyDiagram.nodes" :key="n.id" style="cursor:pointer" @click="selectRegion(n.id)">
                <rect :x="n.x" :y="n.y" :width="n.w" :height="n.h" rx="8" fill="#fff"
                  :stroke="n.id === selected ? '#e65100' : '#7c3aed'" :stroke-width="n.id === selected ? 2.5 : 1.5" />
                <rect :x="n.x" :y="n.y" :width="n.w" :height="keyDiagram.headH" rx="8" :fill="n.id === selected ? '#e65100' : '#7c3aed'" />
                <rect :x="n.x" :y="n.y + keyDiagram.headH - 8" :width="n.w" height="8" :fill="n.id === selected ? '#e65100' : '#7c3aed'" />
                <text :x="n.x + 11" :y="n.y + (n.sub ? 15 : 21)" fill="#fff" font-size="13" font-weight="700">{{ fitText(n.title, n.w - 22, 13) }}</text>
                <text v-if="n.sub" :x="n.x + 11" :y="n.y + 28" fill="#e4d7fb" font-size="10">📄 {{ fitText(n.sub, n.w - 34, 10) }}</text>
                <template v-for="(row, ri) in n.rows" :key="ri">
                  <!-- 紐づきに参加している行は薄紫で強調 -->
                  <rect v-if="row.connected" :x="n.x + 1" :y="row.top" :width="n.w - 2" :height="keyDiagram.rowH" fill="#f3edfd" />
                  <line v-if="!row.last" :x1="n.x + 1" :y1="row.top + keyDiagram.rowH" :x2="n.x + n.w - 1" :y2="row.top + keyDiagram.rowH" stroke="#eee9f8" />
                  <text :x="n.x + 11" :y="row.cy + 4" font-size="12"
                    :fill="row.primary ? '#1b212b' : '#4b5563'" :font-weight="row.primary ? 700 : 400">
                    {{ row.mark }} {{ fitText(row.label, n.w - 40, 12) }}
                  </text>
                </template>
              </g>
            </svg>
          </div>
          <p v-if="keyDiagram.edges.length === 0" class="muted" style="margin:8px 0 0">
            キーどうしの紐づき（数式による照合）はまだ検出されていません。各表のキーのみ表示しています。
          </p>
          <p v-if="keyDiagram.omitted > 0" class="muted" style="margin:8px 0 0">
            <template v-if="keyDiagram.condensed">
              対応（紐づき）の無い {{ keyDiagram.omitted }} 表は非表示です。「すべてのキー・表を表示」で確認できます。
            </template>
            <template v-else>
              表が多いため {{ keyDiagram.omitted }} 表を省略しています（紐づき参加・主キー持ちを優先表示）。
            </template>
          </p>

        <!-- 選択シートの要約（ER図の箱をクリックすると表示: キーの根拠・統計・内部構造・AI解読） -->
        <div v-if="selectedSummary" class="sheet-summary">
          <div class="ss-head">
            <strong>{{ selectedSummary.sheet }}</strong>
            <button class="ss-close" @click="selected = null">閉じる</button>
          </div>
          <p class="muted ss-desc">{{ selectedSummary.description }}</p>
          <table class="ss-table">
            <tbody>
              <tr><th>表領域</th><td>{{ selectedSummary.range }}（{{ selectedSummary.colCount }}列）</td></tr>
              <tr>
                <th>キー・軸（推定）</th>
                <td>
                  <template v-if="selectedSummary.keys">
                    <div v-for="(k, i) in selectedSummary.keys.keys" :key="i" class="key-item">
                      <span class="key-chip" :class="k.role === 'primary' ? 'key-primary' : 'key-axis'">
                        {{ k.role === 'primary' ? '🔑 主キー' : '軸' }}
                      </span>
                      <strong>{{ k.column }}</strong>
                      <ul class="key-evidence">
                        <!-- 軸列の根拠（組合せの説明）は下の 📐 行と重複するので個別表示から除く -->
                        <li v-for="(ev, j) in k.evidence.filter(ev => ev !== selectedSummary!.keys!.axisNote)" :key="j">{{ ev }}</li>
                      </ul>
                    </div>
                    <p v-if="selectedSummary.keys.axisNote" class="key-note">📐 {{ selectedSummary.keys.axisNote }}</p>
                    <p v-if="selectedSummary.keys.colAxis" class="key-note">📅 {{ selectedSummary.keys.colAxis }}</p>
                  </template>
                  <span v-else class="muted">検出できませんでした（一意な列・軸らしい列の組が見つからない表です）</span>
                </td>
              </tr>
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


          <!-- キーの対応表（根拠つき） -->
          <template v-if="keyLinks.length">
            <div class="kd-table-title">キーの対応表（根拠つき）</div>
            <table class="keylink-table">
              <thead>
                <tr><th>マスタ側（参照される）</th><th></th><th>利用側（数式を書いた）</th><th>結合方法</th><th>根拠（実際の数式の例）</th></tr>
              </thead>
              <tbody>
                <tr v-for="(l, i) in keyLinks.slice(0, KEYLINK_SHOW)" :key="i">
                  <td>{{ short(l.b) }}</td>
                  <td class="kl-arrow">⇔</td>
                  <td>{{ short(l.a) }}</td>
                  <td class="kl-fn"><span class="badge info">{{ l.fn }}</span><span v-if="l.count > 1" class="muted"> ×{{ l.count }}</span></td>
                  <td class="evidence"><code>{{ l.evidence }}</code></td>
                </tr>
              </tbody>
            </table>
            <p v-if="keyLinks.length > KEYLINK_SHOW" class="muted" style="margin:6px 0 0">
              利用回数の多い上位 {{ KEYLINK_SHOW }} 件を表示しています（全 {{ keyLinks.length.toLocaleString() }} 件）。
            </p>
          </template>
        </section>

        <!-- 全体構造の解説（①シート構成 → ②テーブル定義書。旧形式の保存結果はフロー表示に自動フォールバック） -->
        <div v-if="overview" class="overview">
          <div class="sec-head">
            <span class="sec-ico">🗺️</span>
            <div class="sec-titles">
              <h3>全体構造の解説 — シート構成とテーブル定義書</h3>
              <p class="sec-sub">AI解読（②）の結果から自動生成。資料を追加・変更して再解読すると更新されます。</p>
            </div>
          </div>
          <p class="ov-summary">{{ overview.summary }}</p>

          <!-- ① シート構成: どのシートが合わさってどのシートになるか -->
          <template v-if="overview.sheet_composition?.length">
            <div class="ov-sec-title">シート構成（どのシートから作られるか）</div>
            <div class="ov-table-wrap">
              <table class="ov-table">
                <thead>
                  <tr><th>シート</th><th>役割</th><th>構成元</th><th>作られ方</th><th>説明</th></tr>
                </thead>
                <tbody>
                  <tr v-for="(sc, i) in overview.sheet_composition" :key="i">
                    <td class="ov-strong">{{ sc.sheet }}</td>
                    <td><span class="ov-role" :class="roleClass(sc.role)">{{ sc.role }}</span></td>
                    <td>
                      <template v-if="sc.composed_of.length">
                        <span v-for="(s, j) in sc.composed_of" :key="j" class="ov-chip">{{ s }}</span>
                      </template>
                      <span v-else class="muted">—</span>
                    </td>
                    <td>{{ sc.method }}</td>
                    <td class="muted">{{ sc.description }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </template>

          <!-- ② テーブル定義書（同一レイアウトのシート群は1つの定義書にまとまる）。
               定義書ごとに折りたたみカードにし、少数（2つまで）は最初から開いておく -->
          <div v-if="overview.table_definitions?.length" class="ov-sec-title">テーブル定義書</div>
          <details v-for="(def, di) in (overview.table_definitions ?? [])" :key="`def-${di}`"
            class="ov-def" :open="(overview.table_definitions?.length ?? 0) <= 2">
            <summary>
              <span class="ov-def-badge">定義書{{ (overview.table_definitions?.length ?? 0) > 1 ? ` ${di + 1}` : '' }}</span>
              <strong>{{ def.title }}</strong>
              <span class="muted">{{ def.columns.length }}項目・適用 {{ def.applies_to.length }}シート</span>
            </summary>
            <div class="ov-applies">
              <span class="muted">適用シート:</span>
              <span v-for="(s, j) in def.applies_to" :key="j" class="ov-chip">{{ s }}</span>
            </div>
            <div class="ov-table-wrap">
              <table class="ov-table">
                <thead>
                  <tr><th class="ov-w-pos">位置</th><th class="ov-w-item">項目</th><th class="ov-w-type">型</th><th>定義・出所</th></tr>
                </thead>
                <tbody>
                  <tr v-for="(col, j) in def.columns" :key="j">
                    <td class="ov-pos">{{ col.position }}</td>
                    <td class="ov-strong">{{ col.item }}</td>
                    <td class="ov-type">{{ col.type }}</td>
                    <td>{{ col.definition }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div v-if="def.calc_rows.length" class="ov-table-wrap" style="margin-top:8px">
              <table class="ov-table">
                <thead>
                  <tr><th class="ov-w-item">計算行</th><th>定義（行方向の集計・計算）</th></tr>
                </thead>
                <tbody>
                  <tr v-for="(cr, j) in def.calc_rows" :key="j">
                    <td class="ov-strong">{{ cr.label }}</td>
                    <td>{{ cr.definition }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </details>

          <!-- 旧形式（入力→加工→出力フロー）: 過去の解読結果の表示互換。再解読すると新形式に置き換わる -->
          <div v-if="isLegacyOverview" class="ov-flow">
            <section class="ov-col ov-in">
              <div class="ov-col-title">📥 入力データ</div>
              <ul>
                <li v-for="(it, i) in (overview.inputs ?? [])" :key="i">
                  <strong>{{ it.name }}</strong>
                  <span class="muted">{{ it.description }}</span>
                </li>
                <li v-if="(overview.inputs ?? []).length === 0" class="muted">（入力データの特定なし）</li>
              </ul>
            </section>
            <div class="ov-arrow">→</div>
            <section class="ov-col ov-step">
              <div class="ov-col-title">⚙️ 加工の流れ</div>
              <ol>
                <li v-for="(st, i) in (overview.steps ?? [])" :key="i">
                  <strong>{{ st.title }}</strong>
                  <span class="muted">{{ st.description }}</span>
                </li>
                <li v-if="(overview.steps ?? []).length === 0" class="muted">（加工ステップの特定なし）</li>
              </ol>
            </section>
            <div class="ov-arrow">→</div>
            <section class="ov-col ov-out">
              <div class="ov-col-title">📤 出力（帳票・レポート）</div>
              <ul>
                <li v-for="(o, i) in (overview.outputs ?? [])" :key="i">
                  <strong>{{ o.name }}</strong>
                  <span class="muted">{{ o.description }}</span>
                </li>
                <li v-if="(overview.outputs ?? []).length === 0" class="muted">（出力物の特定なし）</li>
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
        </div>

        <!-- 関係の一覧: 件数が多いので折りたたみ（根拠を確認したい時だけ開く） -->
        <details class="sec sec-fold">
          <summary>
            <span class="sec-ico">📋</span>
            <strong>関係の一覧（根拠つき）</strong>
            <span class="muted">全 {{ (graph.edgeTotal ?? graph.edges.length).toLocaleString() }} 件 — クリックで展開</span>
          </summary>
          <p v-if="graph.edgeCollapsed" class="muted" style="margin:10px 0 0">
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
        </details>

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
.summary { display:flex; align-items:center; gap:8px; margin:8px 0; flex-wrap:wrap; }
.warn-mark { color:#b91c1c }

/* 顧客共有用レポートのダウンロードリンク（右端に寄せる） */
.report-link { margin-left:auto; white-space:nowrap; flex-shrink:0; padding:4px 12px; font-size:12.5px;
  border:1px solid #c9def4; border-radius:8px; background:#edf4fc; color:#1f5fae; text-decoration:none; font-weight:600 }
.report-link:hover { background:#e0edfa }

/* セクションカード: パネル内の大きな区切りを統一の見た目にする（マップ / キー / 一覧） */
.sec { margin:16px 0; padding:14px 16px; border:1px solid #e3e7ec; border-radius:12px; background:#fff; box-shadow:0 1px 3px rgba(0,0,0,0.04) }
.sec-head { display:flex; align-items:flex-start; gap:10px; margin-bottom:12px }
.sec-ico { font-size:18px; line-height:1.35 }
.sec-titles { min-width:0 }
.sec-head h3 { margin:0; font-size:14.5px; color:#10325c }
.sec-sub { margin:3px 0 0; font-size:12.5px; color:#6b7280; line-height:1.6 }
.sec-action { margin-left:auto; white-space:nowrap; flex-shrink:0; padding:5px 12px; font-size:12.5px }

/* 折りたたみセクション（関係マップ・関係の一覧など、普段は閉じておく詳細データ） */
details.sec-fold > summary { cursor:pointer; display:flex; align-items:center; gap:8px; font-size:14px; list-style:none }
details.sec-fold > summary::-webkit-details-marker { display:none }
details.sec-fold > summary::after { content:'▸'; margin-left:auto; color:#9aa1ad; transition:transform .15s }
details.sec-fold[open] > summary::after { transform:rotate(90deg) }
details.sec-fold > summary .muted { font-size:12px }

/* 図中ラベルの白フチ（線の上でも読めるように） */
.halo { paint-order:stroke; stroke:#fff; stroke-width:3px; font-weight:600 }

/* キー関係図: 線にマウスを乗せると強調（ツールチップで照合方法を表示） */
.kd-edge path { transition:stroke-width .1s }
.kd-edge:hover path { stroke-width:3.2 }

/* キーの対応表の小見出し */
.kd-table-title { margin:14px 0 6px; font-weight:700; font-size:13px; color:#5b21b6; padding-left:8px; border-left:3px solid #7c3aed }

/* 凡例 */
.swatch { display:inline-block; width:13px; height:13px; border-radius:3px; border:2px solid transparent }

/* グラフ */
.graph-wrap { overflow-x:auto; border:1px solid #eceff3; border-radius:10px; padding:10px; background:#fcfcfd }

/* 関係リスト */
.rel-group { margin:14px 0 }
.rel-head { display:flex; align-items:center; gap:8px; margin-bottom:6px; font-size:13px }
.evidence code { font-size:12px; color:#475569; background:#f4f5f7; padding:2px 6px; border-radius:4px; word-break:break-all }
.ai-hint { margin-top:4px; font-size:12px; color:#475569; line-height:1.5 }
.ai-hint strong { color:#155a9e; margin-right:4px }

/* 選択シートの要約（マップで選択中のノードと同じオレンジで紐づけ） */
.sheet-summary { margin:12px 0 2px; padding:16px 18px; border:1px solid #e3e7ec; border-left:3px solid #e65100; border-radius:10px; background:#fcfdfe }
.ss-head { display:flex; justify-content:space-between; align-items:center; gap:8px }
.ss-head strong { font-size:16px }
.ss-close { padding:3px 12px; font-size:12px }
.ss-desc { margin:6px 0 12px; line-height:1.6 }
.ss-table { width:100%; border-collapse:collapse }
.ss-table th, .ss-table td { border:none; border-bottom:1px solid #eef1f4; padding:7px 4px; font-size:13px }
.ss-table th { text-align:left; width:130px; vertical-align:top; color:#6b7280; font-weight:600; white-space:nowrap }
.ss-table tr:last-child th, .ss-table tr:last-child td { border-bottom:none }
.ss-chip { display:inline-block; margin:2px 5px 2px 0; padding:2px 10px; background:#eef2f7; border-radius:12px; font-size:12.5px; color:#374151 }

/* キー・軸（推定） */
.key-item { margin:2px 0 8px }
.key-item:last-of-type { margin-bottom:2px }
.key-chip { display:inline-block; margin-right:7px; padding:1px 9px; border-radius:999px; font-size:11.5px; font-weight:700; white-space:nowrap }
.key-chip.key-primary { background:#fdf3e0; color:#a05a00; border:1px solid #f0dcb4 }
.key-chip.key-axis { background:#e8f0fb; color:#0d4ea6; border:1px solid #d0e0f5 }
.key-evidence { margin:3px 0 0; padding-left:20px; font-size:12px; color:#6b7280; line-height:1.6 }
.key-note { margin:6px 0 0; font-size:12.5px; color:#374151 }

/* キーのつながり */
.keylink-table { width:100%; border-collapse:collapse; font-size:13px }
.keylink-table th { text-align:left; padding:6px 8px; background:#f2f6fb; color:#3b4657; font-size:12px; white-space:nowrap; border-bottom:1px solid #e3e7ec }
.keylink-table td { padding:6px 8px; border-bottom:1px solid #eef1f5; vertical-align:top }
.kl-arrow { text-align:center; color:#888; white-space:nowrap }
.kl-fn { white-space:nowrap }

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

/* 全体構造の解説（シート構成＋テーブル定義書。ov-flow は旧形式互換表示） */
.overview { margin:16px 0; padding:14px 16px; border:1px solid #d6e4f5; border-radius:12px; background:linear-gradient(180deg,#f6faff 0%,#fcfdff 100%); box-shadow:0 1px 3px rgba(0,0,0,0.04) }
.ov-summary { margin:0 0 14px; font-size:14px; line-height:1.7; color:#26303c }
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
/* 入力→加工→出力は横並びが基本。狭い画面では縦積みにし矢印を回転 */
@media (max-width: 760px) {
  .ov-flow { flex-direction:column }
  .ov-arrow { justify-content:center; transform:rotate(90deg) }
}

/* シート構成・テーブル定義書 */
.ov-sec-title { margin:16px 0 6px; font-weight:700; font-size:13.5px; color:#10325c; padding-left:8px; border-left:3px solid #1565c0 }
.ov-table-wrap { overflow-x:auto; background:#fff; border:1px solid #e3e7ec; border-radius:10px }
.ov-table { width:100%; border-collapse:collapse; font-size:13px }
.ov-table th { text-align:left; padding:8px 12px; background:#f2f6fb; color:#3b4657; font-size:12px; white-space:nowrap; border-bottom:1px solid #e3e7ec }
.ov-table td { padding:8px 12px; border-bottom:1px solid #eef1f5; line-height:1.55; vertical-align:top }
.ov-table tr:last-child td { border-bottom:none }
.ov-table tbody tr:nth-child(even) td { background:#fafcfe }
.ov-w-pos { width:64px } .ov-w-item { width:160px } .ov-w-type { width:90px }
.ov-type { white-space:nowrap; color:#4b5563 }

/* テーブル定義書の折りたたみカード */
.ov-def { margin:8px 0; background:#fff; border:1px solid #e3e7ec; border-radius:10px; padding:10px 14px }
.ov-def > summary { cursor:pointer; display:flex; align-items:center; gap:8px; font-size:13.5px; list-style:none }
.ov-def > summary::-webkit-details-marker { display:none }
.ov-def > summary::after { content:'▸'; margin-left:auto; color:#9aa1ad; transition:transform .15s }
.ov-def[open] > summary::after { transform:rotate(90deg) }
.ov-def > summary .muted { font-size:12px }
.ov-def[open] > summary { margin-bottom:8px }
.ov-def-badge { display:inline-block; padding:1px 9px; border-radius:999px; background:#e8f0fb; color:#0d4ea6; font-size:11.5px; font-weight:700; white-space:nowrap }
.ov-strong { font-weight:600; color:#1b212b; white-space:nowrap }
.ov-pos { font-family:ui-monospace, Consolas, monospace; white-space:nowrap; color:#374151 }
.ov-role { display:inline-block; padding:1px 8px; border-radius:999px; font-size:11.5px; font-weight:600; white-space:nowrap }
.ov-role.role-in { background:#e7f6ec; color:#046b2d }
.ov-role.role-mid { background:#e8f0fb; color:#0d4ea6 }
.ov-role.role-out { background:#fdeee2; color:#b34700 }
.ov-role.role-etc { background:#eef0f3; color:#4b5563 }
.ov-chip { display:inline-block; margin:1px 4px 1px 0; padding:1px 8px; background:#eef3fa; border:1px solid #d9e4f2; border-radius:999px; font-size:12px; color:#274766; white-space:nowrap }
.ov-applies { margin:0 0 6px; font-size:12.5px; line-height:1.9 }

/* 案内・注意 */
.ai-banner { margin:8px 0; padding:10px 14px; background:#f7f8fa; border:1px solid #eceff3; border-left:3px solid var(--primary); border-radius:8px; font-size:13px; line-height:1.6 }
.warn-panel { margin-top:16px; padding:14px 16px; background:#fffaf2; border:1px solid #f4e3c8; border-radius:10px }
.warn-panel h3 { margin:0 0 8px; font-size:14px }
.warn-panel ul { margin:0; padding-left:18px; font-size:13px; line-height:1.7 }
.warn-loc { font-weight:600; color:#92400e; margin-right:4px; white-space:nowrap }
.warn-head { display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap }
.warn-head h3 { margin:0 }
</style>

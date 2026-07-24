// 顧客共有用「データ構造 分析レポート」(自己完結 HTML) の生成。
//
// 目的: 受領データの関係分析（RelationGraph）を、顧客との読み合わせに使える1枚のHTMLへ整形する。
//   - 確定事項（数式由来）と推定（値一致・構造推定）を視覚的に分離し、確認は推定部分だけに絞る
//   - 「ご確認いただきたい点」を Q-01.. の番号付きカードとして決定的に自動抽出する（AI 呼び出しなし）
//   - セルの生値は載せない（列名・数式・行数などの構造情報のみ）— 社外共有しても原本数値が漏れない
// summaryDoc.ts（Word/md のパッケージ資料）と同じ「保存済み派生結果から決定的に組み立てる」等級。
import type { RelationGraph, Region, Edge, RelationWarning, KeyLink } from './preprocess/relations.js';
import { colLetter } from './preprocess/relations.js';

export interface RelationsReportInput {
  customerName: string;
  generatedAt: Date;
  fileCount: number;
  graph: RelationGraph;
}

// ============================================================
// 小道具
// ============================================================
const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const regionIdOf = (key: string): string => {
  const i = key.indexOf(':');
  return i < 0 ? key : key.slice(0, i);
};
const colNameOf = (key: string): string => {
  const i = key.indexOf(':');
  return i < 0 ? '' : key.slice(i + 1);
};

const shortText = (s: string, max = 72): string => (s.length <= max ? s : `${s.slice(0, max)}…`);

/** 関係種別を顧客向けの4分類へ畳む */
type Group = 'ref' | 'agg' | 'move' | 'copy';
const groupOf = (t: Edge['type']): Group =>
  t === 'copy' ? 'copy'
  : (t === 'aggregation' || t === 'filtered-agg') ? 'agg'
  : (t === 'lookup-join' || t === 'filter-key') ? 'ref'
  : 'move';

// 4色は色覚多様性チェック（validate_palette）通過済みの組。ラベル併記で色だけに頼らない。
const GROUP_META: Record<Group, { label: string; color: string; cls: string; dashed: boolean }> = {
  ref:  { label: '参照・照合（VLOOKUP等）', color: '#1F5FAE', cls: 'lookup', dashed: false },
  agg:  { label: '集計（SUMIFS・SUM等）',   color: '#1E9E6A', cls: 'agg',    dashed: false },
  move: { label: '転記・計算（=参照・四則）', color: '#7B5EA7', cls: 'move',   dashed: false },
  copy: { label: '手コピー推定（要確認）',   color: '#B96A00', cls: 'copy',   dashed: true },
};
const GROUP_ORDER: Group[] = ['ref', 'agg', 'move', 'copy'];

const confLabel = (c: number): string => (c >= 0.8 ? '高' : c >= 0.5 ? '中' : '低');

// ============================================================
// 表領域ペア単位の辺集約・役割・レイヤ計算
// ============================================================
interface PairAgg {
  from: string; to: string;                 // region id
  counts: Partial<Record<Group, number>>;
  best: Partial<Record<Group, Edge>>;       // 各分類の代表辺（確信度最大）
  total: number;
}

function aggregatePairs(edges: Edge[]): PairAgg[] {
  const map = new Map<string, PairAgg>();
  for (const e of edges) {
    const from = regionIdOf(e.from);
    const to = regionIdOf(e.to);
    if (!from || !to || from === to) continue;
    const k = `${from}\u0000${to}`;
    let p = map.get(k);
    if (!p) { p = { from, to, counts: {}, best: {}, total: 0 }; map.set(k, p); }
    const g = groupOf(e.type);
    p.counts[g] = (p.counts[g] ?? 0) + 1;
    p.total++;
    const cur = p.best[g];
    if (!cur || (e.confidence ?? 0) > (cur.confidence ?? 0)) p.best[g] = e;
  }
  return [...map.values()];
}

const dominantGroup = (p: PairAgg): Group => {
  // 数式由来を優先（copy は数式が無い時だけ代表色になる）。
  // 同数のときは agg を優先: SUMIFS は filtered-agg + filter-key の対で出るため、
  // 参照(ref)と同数になりがちだが、データフローとしての意味は「集計」の側にある。
  const order: Group[] = ['agg', 'move', 'ref'];
  let best: Group | null = null;
  for (const g of order) {
    if ((p.counts[g] ?? 0) === 0) continue;
    if (best === null || (p.counts[g] ?? 0) > (p.counts[best] ?? 0)) best = g;
  }
  return best ?? 'copy';
};

type Role = 'マスタ（参照元）' | '元データ（明細）' | '中間集計' | '最終アウトプット' | '独立（つながりなし）';

function computeRoles(regions: Region[], pairs: PairAgg[]): Map<string, Role> {
  const stat = new Map<string, { in: number; outRef: number; outOther: number }>();
  const get = (id: string) => {
    let s = stat.get(id);
    if (!s) { s = { in: 0, outRef: 0, outOther: 0 }; stat.set(id, s); }
    return s;
  };
  for (const p of pairs) {
    get(p.to).in += p.total;
    const g = dominantGroup(p);
    if (g === 'ref') get(p.from).outRef += p.total;
    else get(p.from).outOther += p.total;
  }
  const roles = new Map<string, Role>();
  for (const r of regions) {
    const s = stat.get(r.id);
    if (!s || (s.in === 0 && s.outRef === 0 && s.outOther === 0)) { roles.set(r.id, '独立（つながりなし）'); continue; }
    if (s.in === 0 && s.outRef > 0 && s.outOther === 0) roles.set(r.id, 'マスタ（参照元）');
    else if (s.in === 0) roles.set(r.id, '元データ（明細）');
    else if (s.outRef + s.outOther > 0) roles.set(r.id, '中間集計');
    else roles.set(r.id, '最終アウトプット');
  }
  return roles;
}

/** 前段からの最長距離でレイヤを割り当てる（循環は反復上限で自然に打ち切り） */
function computeLayers(ids: string[], pairs: PairAgg[]): Map<string, number> {
  const layer = new Map<string, number>(ids.map(id => [id, 0]));
  const cap = Math.min(ids.length + 2, 12); // レポートで見せる深さはこの程度で十分
  for (let pass = 0; pass < cap; pass++) {
    let changed = false;
    for (const p of pairs) {
      const lf = layer.get(p.from); const lt = layer.get(p.to);
      if (lf === undefined || lt === undefined) continue;
      if (lt < lf + 1 && lf + 1 < cap) { layer.set(p.to, lf + 1); changed = true; }
    }
    if (!changed) break;
  }
  return layer;
}

// ============================================================
// 表示ラベル・キー要約
// ============================================================
function buildLabels(regions: Region[]): Map<string, string> {
  // 基本はシート名。同名シートが複数ファイルにある時だけファイル名を前置し、
  // 同一シートに複数表がある場合だけ (2) 等で区別する（ラベルは短いほど読みやすい）
  const filesOfSheet = new Map<string, Set<string>>();
  for (const r of regions) {
    let s = filesOfSheet.get(r.sheet);
    if (!s) { s = new Set(); filesOfSheet.set(r.sheet, s); }
    s.add(r.file);
  }
  const perSheet = new Map<string, number>();
  for (const r of regions) perSheet.set(`${r.file}\u0000${r.sheet}`, (perSheet.get(`${r.file}\u0000${r.sheet}`) ?? 0) + 1);
  const seen = new Map<string, number>();
  const labels = new Map<string, string>();
  for (const r of regions) {
    const sk = `${r.file}\u0000${r.sheet}`;
    const n = (seen.get(sk) ?? 0) + 1;
    seen.set(sk, n);
    const ambiguous = (filesOfSheet.get(r.sheet)?.size ?? 1) > 1;
    // CSV 由来のシート名は一律「データ」で意味を持たないため、ファイル名をラベルにする
    const base = r.sheet === 'データ' && r.file ? r.file
      : ambiguous && r.file ? `${r.file} › ${r.sheet}` : r.sheet;
    labels.set(r.id, (perSheet.get(sk) ?? 1) > 1 ? `${base} (${n})` : base);
  }
  return labels;
}

function keySummary(r: Region): string {
  if (r.keys?.grain) return r.keys.grain; // 横持ち: 行キー × 列軸 の2次元グレイン
  const ks = r.keys?.keys ?? [];
  if (ks.length === 0) return '（不明）';
  const primary = ks.filter(k => k.role === 'primary');
  if (primary.length > 0) return primary.map(k => k.column).join('、');
  if (r.keys?.axisNote) return r.keys.axisNote;
  return ks.map(k => k.column).join(' × ');
}

/** 図のノード副題用の短いキー表記（axisNote のような文は使わず列名だけ） */
function keySummaryShort(r: Region): string {
  const ks = r.keys?.keys ?? [];
  if (ks.length === 0) return '';
  const primary = ks.filter(k => k.role === 'primary');
  if (primary.length > 0) return primary.map(k => k.column).join('、');
  return ks.map(k => k.column).join(' × ');
}

const rangeOf = (r: Region): string => `${colLetter(r.c0)}${r.r0}:${colLetter(r.c1)}${r.r1}`;

// ============================================================
// ご確認いただきたい点（決定的な質問抽出）
// ============================================================
interface Question {
  id: string; priority: 'high' | 'mid'; kind: string; title: string;
  analysis?: string; ask: string; kpiee?: string;
  refPair?: string; // copy 質問→辺表・図から参照するための `${from}\u0000${to}`
}

function buildQuestions(
  regions: Region[], pairs: PairAgg[], warnings: RelationWarning[],
  labels: Map<string, string>, roles: Map<string, Role>,
): Question[] {
  const qs: Omit<Question, 'id'>[] = [];

  // (1) 手コピー推定（値一致）: 表ペア単位に1問。列数の多い順に最大3問
  const copyPairs = pairs
    .filter(p => (p.counts.copy ?? 0) > 0)
    .sort((a, b) => (b.counts.copy ?? 0) - (a.counts.copy ?? 0));
  for (const p of copyPairs.slice(0, 3)) {
    const from = labels.get(p.from) ?? p.from;
    const to = labels.get(p.to) ?? p.to;
    const rep = p.best.copy;
    const n = p.counts.copy ?? 0;
    const undirected = rep?.needsConfirmation;
    qs.push({
      priority: 'high', kind: '手コピーの確認', refPair: `${p.from}\u0000${p.to}`,
      title: undirected
        ? `「${from}」と「${to}」で値が一致する列があります。どちらが元データですか？`
        : `「${to}」の一部の列は「${from}」からの手作業転記ですか？`,
      analysis: `数式が無いのに値が完全一致する列を ${n} 組検出しました（${rep ? shortText(rep.evidence, 40) : '値一致'}）。手作業のコピーと推定しています。`,
      ask: undirected
        ? '①どちらの表が元（正）ですか？ ②転記のタイミングと担当の方を教えてください。'
        : '①この理解で合っていますか？ ②転記のタイミングと担当の方は？ ③両者が一致しない場合はどちらが正ですか？',
      kpiee: '元とする表と集計ロジックが確定すれば、この転記作業は自動化できます。',
    });
  }
  if (copyPairs.length > 3) {
    qs.push({
      priority: 'high', kind: '手コピーの確認',
      title: `ほか ${copyPairs.length - 3} 組の表ペアでも手コピーの可能性を検出しています。`,
      analysis: '個別の一覧はお打ち合わせで画面をご覧いただきながら確認させてください。',
      ask: '主要なものから順に、転記の有無と方向を確認させてください。',
    });
  }

  // (2) 数式列への手入力上書き（mixed_formula_column）: シート単位に集約して最大2問
  const mixedBySheet = new Map<string, { file: string; sheet: string; count: number; cols: Set<string> }>();
  for (const w of warnings) {
    if (w.kind !== 'mixed_formula_column') continue;
    const regionId = regionIdOf(w.ref);
    const col = colNameOf(w.ref);
    const m = /^(.*)／(.*)#\d+$/.exec(regionId);
    const file = m?.[1] ?? '';
    const sheet = m?.[2] ?? regionId;
    const k = `${file}\u0000${sheet}`;
    let g = mixedBySheet.get(k);
    if (!g) { g = { file, sheet, count: 0, cols: new Set() }; mixedBySheet.set(k, g); }
    g.count++;
    if (col) g.cols.add(col);
  }
  const mixed = [...mixedBySheet.values()].sort((a, b) => b.count - a.count);
  for (const g of mixed.slice(0, 2)) {
    const cols = [...g.cols].slice(0, 3).join('、') + (g.cols.size > 3 ? ` ほか${g.cols.size - 3}列` : '');
    qs.push({
      priority: 'high', kind: '数式と手入力の混在',
      title: `「${g.sheet}」の数式列に、数式を上書きした手入力が ${g.count} 箇所あります。意図的な補正ですか？`,
      analysis: `数式が主体の列（${cols}）の中に、数式が消えて数値が直接入っているセルがあります。`,
      ask: '返品・締め処理などによる意図的な修正でしょうか？ 修正のルールがあれば教えてください。',
      kpiee: '補正ルールが明文化できれば取込時に反映します。例外的な修正なら「補正値の入力欄」として設計します。',
    });
  }
  if (mixed.length > 2) {
    qs.push({
      priority: 'mid', kind: '数式と手入力の混在',
      title: `ほか ${mixed.length - 2} シートでも数式と手入力の混在を検出しています。`,
      ask: '一覧を添えますので、意図的な補正かどうかをご確認ください。',
    });
  }

  // (3) どの表ともつながらない表: まとめて1問
  const orphans = regions.filter(r => roles.get(r.id) === '独立（つながりなし）' && r.dataRowCount >= 3);
  if (orphans.length > 0) {
    const names = orphans.slice(0, 4).map(r => `「${labels.get(r.id) ?? r.sheet}」`).join('、')
      + (orphans.length > 4 ? ` ほか${orphans.length - 4}表` : '');
    qs.push({
      priority: 'mid', kind: '出所不明の表',
      title: `${names} は、他のどの表ともつながりが見つかりませんでした。出所を教えてください。`,
      analysis: '受領データ内のどの表とも、数式・値の一致が見つかりませんでした。別ファイル・別システム由来の可能性があります。',
      ask: '元データの所在（別Excel／基幹システム／手入力）と、現役で使われている表かどうかを教えてください。',
      kpiee: '継続して使う表であれば、元データのご提供をお願いします。',
    });
  }

  // (4) 大きい表なのにキーが特定できない: まとめて1問
  const noKey = regions.filter(r => r.dataRowCount >= 20 && (r.keys?.keys?.length ?? 0) === 0);
  if (noKey.length > 0) {
    const names = noKey.slice(0, 3).map(r => `「${labels.get(r.id) ?? r.sheet}」`).join('、')
      + (noKey.length > 3 ? ` ほか${noKey.length - 3}表` : '');
    qs.push({
      priority: 'mid', kind: 'キーの確認',
      title: `${names} について、1行を一意に決める列（キー）が特定できませんでした。`,
      analysis: '値の一意性・数式からのキー利用のいずれからもキー列を推定できませんでした。',
      ask: 'この表の1行は「何が決まると1行になる」のか（例: 受注ごと・店舗×月ごと）を教えてください。',
      kpiee: 'キーの定義は集計の正確さに直結するため、最初に確定させたい項目です。',
    });
  }

  // (5) 運用の確認（固定）
  qs.push({
    priority: 'mid', kind: '運用の確認',
    title: '更新の運用について教えてください（頻度・担当・他ファイルの有無）。',
    ask: '①各ファイルはどのくらいの頻度で、どなたが更新されますか？ ②今回のファイルのほかに、報告・集計に使うファイルはありますか？ ③使われていない古いシートがあれば教えてください。',
  });

  return qs
    .sort((a, b) => (a.priority === b.priority ? 0 : a.priority === 'high' ? -1 : 1))
    .slice(0, 8)
    .map((q, i) => ({ ...q, id: `Q-${String(i + 1).padStart(2, '0')}` }));
}

// ============================================================
// 関係マップ（SVG）
// ============================================================
const NODE_W = 192, NODE_H = 62, COL_GAP = 128, ROW_GAP = 24, PAD = 28;
const MAX_NODES = 28, MAX_EDGES = 60;

// インタラクティブ・グラフ（Obsidian 風 force graph）へ渡すデータ。静的SVGと同じ kept 集合から作る。
interface GNode { id: string; label: string; sub: string; role: string; deg: number; x: number; y: number }
interface GLink { s: string; t: string; color: string; dashed: boolean; label: string; qid?: string; count: number }
interface GraphData { nodes: GNode[]; links: GLink[]; w: number; h: number }
interface MapResult { svg: string; omittedNodes: number; omittedEdges: number; data: GraphData }

function buildMap(
  regions: Region[], pairs: PairAgg[], labels: Map<string, string>,
  copyQuestionByPair: Map<string, string>, roles: Map<string, Role>,
): MapResult | null {
  if (pairs.length === 0) return null;

  // つながりのある表だけを、次数の大きい順に上限まで採用
  const degree = new Map<string, number>();
  for (const p of pairs) {
    degree.set(p.from, (degree.get(p.from) ?? 0) + p.total);
    degree.set(p.to, (degree.get(p.to) ?? 0) + p.total);
  }
  const connected = regions.filter(r => degree.has(r.id));
  const kept = connected
    .slice()
    .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0))
    .slice(0, MAX_NODES);
  const keptIds = new Set(kept.map(r => r.id));
  const drawPairs = pairs.filter(p => keptIds.has(p.from) && keptIds.has(p.to)).slice(0, MAX_EDGES);
  if (drawPairs.length === 0) return null;

  const layers = computeLayers([...keptIds], drawPairs);
  const byLayer = new Map<number, Region[]>();
  for (const r of kept) {
    const l = layers.get(r.id) ?? 0;
    let arr = byLayer.get(l);
    if (!arr) { arr = []; byLayer.set(l, arr); }
    arr.push(r);
  }
  const layerNos = [...byLayer.keys()].sort((a, b) => a - b);
  // 空レイヤを詰める（0,1,3 → 0,1,2）
  const layerIndex = new Map<number, number>(layerNos.map((l, i) => [l, i]));
  for (const arr of byLayer.values()) arr.sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0));

  const pos = new Map<string, { x: number; y: number }>();
  let maxRows = 0;
  for (const l of layerNos) {
    const arr = byLayer.get(l)!;
    maxRows = Math.max(maxRows, arr.length);
    arr.forEach((r, i) => {
      pos.set(r.id, { x: PAD + layerIndex.get(l)! * (NODE_W + COL_GAP), y: PAD + i * (NODE_H + ROW_GAP) });
    });
  }
  const width = PAD * 2 + layerNos.length * NODE_W + (layerNos.length - 1) * COL_GAP;
  const height = PAD * 2 + maxRows * NODE_H + (maxRows - 1) * ROW_GAP;

  const trunc = (s: string, n = 15) => (s.length <= n ? s : `${s.slice(0, n)}…`);
  const showEdgeLabels = drawPairs.length <= 8;

  const parts: string[] = [];
  parts.push(`<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="表どうしの関係マップ">`);
  parts.push('<defs>');
  for (const g of GROUP_ORDER) {
    parts.push(`<marker id="arr-${g}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="${GROUP_META[g].color}"/></marker>`);
  }
  parts.push('</defs>');

  // 辺（ノードより先に描いて下に敷く）。ラベルは辺・ノードの上に最後に重ねる
  const edgeLabels: string[] = [];
  for (const p of drawPairs) {
    const a = pos.get(p.from)!; const b = pos.get(p.to)!;
    const g = dominantGroup(p);
    const meta = GROUP_META[g];
    const sameCol = Math.abs(a.x - b.x) < 1;
    // 同一レイヤ（縦並び）は縦線、そうでなければ右辺→左辺の曲線
    let d: string; let lx: number; let ly: number;
    if (sameCol) {
      const x = a.x + NODE_W / 2;
      // from の底辺（または上辺）から to へ向けて描き、矢印が正しい端に付くようにする
      d = a.y < b.y
        ? `M${x},${a.y + NODE_H} L${x},${b.y}`
        : `M${x},${a.y} L${x},${b.y + NODE_H}`;
      lx = x + 8; ly = (Math.min(a.y, b.y) + NODE_H + Math.max(a.y, b.y)) / 2;
    } else {
      const src = a.x < b.x ? a : b;
      const dst = a.x < b.x ? b : a;
      const x1 = src.x + NODE_W, y1 = src.y + NODE_H / 2;
      const x2 = dst.x, y2 = dst.y + NODE_H / 2;
      // 向きが右→左（逆流）の場合も座標は同じ曲線で、矢印だけが正しい端に付く
      const rev = a.x > b.x;
      // 2レイヤ以上を跨ぐ辺は中間ノードを貫通しないよう上へ迂回させる
      const span = Math.round(Math.abs(a.x - b.x) / (NODE_W + COL_GAP));
      if (span >= 2) {
        const cy = Math.max(10, Math.min(y1, y2) - 52);
        d = rev
          ? `M${x2},${y2} C${x2 - 70},${cy} ${x1 + 70},${cy} ${x1},${y1}`
          : `M${x1},${y1} C${x1 + 70},${cy} ${x2 - 70},${cy} ${x2},${y2}`;
        lx = (x1 + x2) / 2; ly = cy + 12;
      } else {
        d = rev
          ? `M${x2},${y2} C${x2 - 46},${y2} ${x1 + 46},${y1} ${x1},${y1}`
          : `M${x1},${y1} C${x1 + 46},${y1} ${x2 - 46},${y2} ${x2},${y2}`;
        lx = (x1 + x2) / 2; ly = (y1 + y2) / 2 - 7;
      }
    }
    const dash = meta.dashed ? ' stroke-dasharray="7 5"' : '';
    parts.push(`<path d="${d}" fill="none" stroke="${meta.color}" stroke-width="2"${dash} marker-end="url(#arr-${g})"/>`);
    const qid = g === 'copy' ? copyQuestionByPair.get(`${p.from}\u0000${p.to}`) : undefined;
    if (showEdgeLabels || qid) {
      const text = qid ? `手コピー推定 → ${qid}` : `${meta.label.split('（')[0]}${p.total > 1 ? ` ×${p.total}` : ''}`;
      // 白フチ（paint-order）でノード・他の辺に重なっても読めるようにする
      const anchor = sameCol ? '' : ' text-anchor="middle"';
      edgeLabels.push(`<text x="${lx}" y="${ly}" font-size="10.5" fill="${meta.color}"${anchor}${qid ? ' font-weight="bold"' : ''} style="paint-order:stroke;stroke:#FCFDFE;stroke-width:3px">${esc(text)}</text>`);
    }
  }

  // ノード
  for (const r of kept) {
    const p = pos.get(r.id)!;
    const label = labels.get(r.id) ?? r.sheet;
    const rows = `${r.dataRowCount.toLocaleString()}行`;
    const key = keySummaryShort(r);
    const sub = key === '' ? rows : `${rows} ／ ${trunc(key, 12)}`;
    parts.push(`<g><rect x="${p.x}" y="${p.y}" width="${NODE_W}" height="${NODE_H}" rx="10" fill="#fff" stroke="#DDE5EE"/>` +
      `<text x="${p.x + 14}" y="${p.y + 26}" font-size="12.5" font-weight="bold" fill="#0E2A47">${esc(trunc(label))}</text>` +
      `<text x="${p.x + 14}" y="${p.y + 46}" font-size="10" fill="#7A8794">${esc(sub)}</text></g>`);
  }
  parts.push(...edgeLabels);
  parts.push('</svg>');

  // インタラクティブ・グラフ用データ。初期座標は上の階層レイアウト（pos）を種にして
  // ブラウザ側の力学シミュレーションが素早く収束するようにする（決定的な初期配置）。
  const gnodes: GNode[] = kept.map(r => {
    const p = pos.get(r.id)!;
    const key = keySummaryShort(r);
    return {
      id: r.id,
      label: labels.get(r.id) ?? r.sheet,
      sub: key === '' ? `${r.dataRowCount.toLocaleString()}行` : `${r.dataRowCount.toLocaleString()}行 ／ ${key}`,
      role: roles.get(r.id) ?? '',
      deg: degree.get(r.id) ?? 1,
      x: p.x + NODE_W / 2, y: p.y + NODE_H / 2,
    };
  });
  const glinks: GLink[] = drawPairs.map(p => {
    const g = dominantGroup(p);
    const qid = g === 'copy' ? copyQuestionByPair.get(`${p.from}\u0000${p.to}`) : undefined;
    return {
      s: p.from, t: p.to, color: GROUP_META[g].color, dashed: GROUP_META[g].dashed,
      label: GROUP_META[g].label.split('（')[0], qid, count: p.total,
    };
  });

  return {
    svg: parts.join('\n'),
    omittedNodes: connected.length - kept.length,
    omittedEdges: pairs.filter(p => keptIds.has(p.from) && keptIds.has(p.to)).length - drawPairs.length,
    data: { nodes: gnodes, links: glinks, w: width, h: height },
  };
}

// ============================================================
// キー関係図（ER 図）— キー列でつながる表どうしを、主キー/軸と 1:N で示す
// ============================================================
const ER = { W: 226, HEAD: 30, ROW: 22, GX: 148, GY: 26, PAD: 16, CAP: 20 };

interface ErResult { svg: string; omitted: number }

/** 表示幅に収まるよう全角=1・半角=0.6 で概算して省略する（SVGは自動折返ししないため） */
function fitText(s: string, maxPx: number, fontPx: number): string {
  let acc = 0, out = '';
  for (const ch of s) {
    const cw = /[\x00-\xff｡-ﾟ]/.test(ch) ? fontPx * 0.6 : fontPx;
    if (acc + cw > maxPx) return out + '…';
    acc += cw; out += ch;
  }
  return out;
}

function buildErDiagram(regions: Region[], keyLinks: KeyLink[], labels: Map<string, string>): ErResult | null {
  const links = [...keyLinks].sort((a, b) => b.count - a.count);
  if (links.length === 0) return null; // 表間のキー対応が無ければ ER は描かない（内訳/詳細でキーは確認可能）
  const byId = new Map(regions.map(r => [r.id, r]));
  const withKeys = regions.filter(r => (r.keys?.keys?.length ?? 0) > 0);
  const linkedIds = new Set(links.flatMap(l => [regionIdOf(l.a), regionIdOf(l.b)]));
  const pool = withKeys.filter(r => linkedIds.has(r.id));
  if (pool.length === 0) return null;
  const show = [...pool].sort((a, b) => {
    const pa = a.keys!.keys.some(k => k.role === 'primary') ? 1 : 0;
    const pb = b.keys!.keys.some(k => k.role === 'primary') ? 1 : 0;
    return pb - pa;
  }).slice(0, ER.CAP);
  const showIds = new Set(show.map(r => r.id));
  const shownLinks = links.filter(l => showIds.has(regionIdOf(l.a)) && showIds.has(regionIdOf(l.b)));
  if (shownLinks.length === 0) return null;

  // データは b（参照される側=マスタ）→ a（数式側）へ流れる。b を左の層へ置く（最長経路レイヤ）。
  const layer = new Map<string, number>(show.map(r => [r.id, 0]));
  const lp = shownLinks.map(l => ({ from: regionIdOf(l.b), to: regionIdOf(l.a) }));
  const cap = Math.min(show.length + 2, 12);
  for (let pass = 0; pass < cap; pass++) {
    let changed = false;
    for (const e of lp) {
      const lf = layer.get(e.from), lt = layer.get(e.to);
      if (lf === undefined || lt === undefined) continue;
      if (lt < lf + 1 && lf + 1 < cap) { layer.set(e.to, lf + 1); changed = true; }
    }
    if (!changed) break;
  }
  const byLayer = new Map<number, Region[]>();
  for (const r of show) {
    const l = layer.get(r.id) ?? 0;
    if (!byLayer.has(l)) byLayer.set(l, []);
    byLayer.get(l)!.push(r);
  }
  const layersSorted = [...byLayer.entries()].sort((a, b) => a[0] - b[0]);

  // 交差を減らす簡易バリセンタ: 前の層の接続相手の平均位置で並べ替える
  const partners = new Map<string, string[]>();
  for (const l of shownLinks) {
    const a = regionIdOf(l.a), b = regionIdOf(l.b);
    (partners.get(a) ?? partners.set(a, []).get(a)!).push(b);
    (partners.get(b) ?? partners.set(b, []).get(b)!).push(a);
  }
  const orderIndex = new Map<string, number>();
  for (const [l, regs] of layersSorted) {
    if (l > 0) {
      const score = (id: string) => {
        const ps = (partners.get(id) ?? []).filter(p => (layer.get(p) ?? 0) < l && orderIndex.has(p));
        return ps.length === 0 ? 1e9 : ps.reduce((s, p) => s + orderIndex.get(p)!, 0) / ps.length;
      };
      regs.sort((x, y) => score(x.id) - score(y.id));
    }
    regs.forEach((r, i) => orderIndex.set(r.id, i));
  }

  const connectedKeys = new Set(shownLinks.flatMap(l => [l.a, l.b]));
  const keysOf = (r: Region) => {
    const conn = r.keys!.keys.filter(k => connectedKeys.has(`${r.id}:${k.column}`));
    return conn.length > 0 ? conn : r.keys!.keys;
  };
  // カーディナリティ: 列の値が全行一意なら 1（マスタ側）、繰り返しがあれば N（明細側）
  const cardOf = (key: string): string => {
    const st = byId.get(regionIdOf(key))?.columns.find(c => c.name === colNameOf(key))?.stats;
    return st ? (st.uniq === st.filled ? '1' : 'N') : '';
  };

  const heightOf = (r: Region) => ER.HEAD + keysOf(r).length * ER.ROW + 6;
  const layerHeights = layersSorted.map(([, regs]) => regs.reduce((s, r) => s + heightOf(r), 0) + (regs.length - 1) * ER.GY);
  const maxLayerH = Math.max(...layerHeights, 90);

  interface Node { id: string; x: number; y: number; w: number; h: number; title: string; rows: { cy: number; mark: string; label: string; primary: boolean; connected: boolean }[] }
  const nodes: Node[] = [];
  const rowY = new Map<string, number>();
  layersSorted.forEach(([l, regs], li) => {
    let y = ER.PAD + (maxLayerH - layerHeights[li]) / 2;
    for (const r of regs) {
      const ks = keysOf(r);
      const rows = ks.map((k, i) => {
        const cy = y + ER.HEAD + i * ER.ROW + ER.ROW / 2;
        const key = `${r.id}:${k.column}`;
        rowY.set(key, cy);
        return { cy, mark: k.role === 'primary' ? '🔑' : '◇', label: k.column, primary: k.role === 'primary', connected: connectedKeys.has(key) };
      });
      nodes.push({ id: r.id, x: ER.PAD + l * (ER.W + ER.GX), y, w: ER.W, h: heightOf(r), title: labels.get(r.id) ?? r.sheet, rows });
      y += heightOf(r) + ER.GY;
    }
  });
  const nodeById = new Map(nodes.map(n => [n.id, n]));

  // 同じキー列ペアは関数違いでも1本にまとめる
  const pairMap = new Map<string, { a: string; b: string }>();
  for (const l of shownLinks) pairMap.set(`${l.a}|${l.b}`, { a: l.a, b: l.b });

  const maxLayer = Math.max(0, ...layersSorted.map(([l]) => l));
  const width = ER.PAD * 2 + (maxLayer + 1) * (ER.W + ER.GX) - ER.GX;
  const height = ER.PAD * 2 + maxLayerH;

  const parts: string[] = [];
  parts.push(`<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="キー関係図（ER）">`);
  // コネクタ（エルボ）＋端点のカーディナリティ
  for (const p of pairMap.values()) {
    const na = nodeById.get(regionIdOf(p.a))!, nb = nodeById.get(regionIdOf(p.b))!;
    const ya = rowY.get(p.a) ?? na.y + ER.HEAD / 2;
    const yb = rowY.get(p.b) ?? nb.y + ER.HEAD / 2;
    const bLeft = nb.x + nb.w <= na.x;
    const x1 = bLeft ? nb.x + nb.w : nb.x;
    const x2 = bLeft ? na.x : na.x + na.w;
    const midX = (x1 + x2) / 2;
    parts.push(`<path d="M${x1},${yb} L${midX},${yb} L${midX},${ya} L${x2},${ya}" fill="none" stroke="#7A8794" stroke-width="1.6"/>`);
    const bc = cardOf(p.b), ac = cardOf(p.a);
    if (bc) parts.push(`<text x="${x1 + (bLeft ? 6 : -6)}" y="${yb - 5}" font-size="11" font-weight="700" fill="#1F5FAE" text-anchor="${bLeft ? 'start' : 'end'}">${bc}</text>`);
    if (ac) parts.push(`<text x="${x2 + (bLeft ? -6 : 6)}" y="${ya - 5}" font-size="11" font-weight="700" fill="#B96A00" text-anchor="${bLeft ? 'end' : 'start'}">${ac}</text>`);
  }
  // エンティティ（表）ボックス
  for (const n of nodes) {
    parts.push(`<g>`);
    parts.push(`<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="9" fill="#fff" stroke="#C9D4E0" stroke-width="1.2"/>`);
    parts.push(`<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${ER.HEAD}" rx="9" fill="#0E2A47"/>`);
    parts.push(`<rect x="${n.x}" y="${n.y + ER.HEAD - 9}" width="${n.w}" height="9" fill="#0E2A47"/>`);
    parts.push(`<text x="${n.x + 12}" y="${n.y + 20}" font-size="12.5" font-weight="700" fill="#fff">${esc(fitText(n.title, n.w - 24, 12.5))}</text>`);
    n.rows.forEach((row) => {
      const ty = row.cy + 4;
      if (row.connected) parts.push(`<rect x="${n.x + 3}" y="${row.cy - ER.ROW / 2}" width="${n.w - 6}" height="${ER.ROW}" fill="#EDF4FC"/>`);
      parts.push(`<text x="${n.x + 12}" y="${ty}" font-size="11.5" fill="${row.primary ? '#0E2A47' : '#4b5563'}" font-weight="${row.primary ? 700 : 400}">${row.mark} ${esc(fitText(row.label, n.w - 34, 11.5))}</text>`);
    });
    parts.push(`</g>`);
  }
  parts.push('</svg>');
  return { svg: parts.join('\n'), omitted: withKeys.length - show.length };
}

// ============================================================
// 本体
// ============================================================
export function buildRelationsReportHtml(input: RelationsReportInput): string {
  const { graph } = input;
  const regions = graph.regions ?? [];
  const edges = (graph.edges ?? []) as Edge[];
  const warnings = graph.warnings ?? [];

  const labels = buildLabels(regions);
  const pairs = aggregatePairs(edges);
  const roles = computeRoles(regions, pairs);
  const questions = buildQuestions(regions, pairs, warnings, labels, roles);
  const copyQuestionByPair = new Map<string, string>();
  for (const q of questions) if (q.refPair) copyQuestionByPair.set(q.refPair, q.id);
  const map = buildMap(regions, pairs, labels, copyQuestionByPair, roles);
  const er = buildErDiagram(regions, graph.keyLinks ?? [], labels);

  const edgeTotal = graph.edgeTotal ?? edges.length;
  const dateStr = input.generatedAt.toISOString().slice(0, 10);
  const customer = input.customerName ? `${input.customerName}様` : 'ご担当者様';

  // ---- サマリ文（決定的に組み立てる） ----
  const bullets: string[] = [];
  {
    const sorted = regions.filter(r => roles.get(r.id) !== '独立（つながりなし）');
    const srcs = sorted.filter(r => roles.get(r.id) === '元データ（明細）').sort((a, b) => b.dataRowCount - a.dataRowCount);
    const sinks = sorted.filter(r => roles.get(r.id) === '最終アウトプット');
    const masters = sorted.filter(r => roles.get(r.id) === 'マスタ（参照元）');
    if (srcs.length > 0 && sinks.length > 0) {
      bullets.push(`データは <b>「${esc(labels.get(srcs[0].id) ?? '')}」を起点</b>に、最終的に「${esc(labels.get(sinks[0].id) ?? '')}」へ流れています。` +
        (masters.length > 0 ? `「${masters.slice(0, 2).map(m => esc(labels.get(m.id) ?? '')).join('」「')}」は引き当て用のマスタです。` : ''));
    } else if (sorted.length > 0) {
      bullets.push(`${regions.length}表のうち ${sorted.length}表が数式・値のつながりを持っています。`);
    }
    const copyCount = pairs.filter(p => (p.counts.copy ?? 0) > 0).length;
    const formulaCount = pairs.length - copyCount;
    if (formulaCount > 0) bullets.push(`表をつなぐ関係の大半は数式（SUMIFS・VLOOKUP等）で、<b>構造は自動で追跡できました</b>。`);
    if (copyCount > 0) bullets.push(`一方、<b>数式ではなく手作業の転記と推定されるつながりが ${copyCount} 組</b>あります（値の一致から逆推定）。ここが今回確認したい中心です。`);
    else if (warnings.length > 0) bullets.push(`数式列への手入力の上書きなど、確認したい箇所が ${warnings.length} 件あります。`);
    else if (copyCount === 0) bullets.push('手作業転記の疑いは検出されませんでした。');
  }

  // ---- 内訳テーブル ----
  const INV_CAP = 40;
  const invRows: string[] = [];
  {
    let prevFile = '\u0000'; let prevSheet = '\u0000';
    for (const r of regions.slice(0, INV_CAP)) {
      const fileCell = r.file === prevFile ? '' : esc(r.file || '─');
      const sheetCell = r.file === prevFile && r.sheet === prevSheet ? '' : esc(r.sheet);
      prevFile = r.file; prevSheet = r.sheet;
      invRows.push(`<tr><td>${fileCell}</td><td>${sheetCell}</td><td class="mono">${esc(rangeOf(r))}</td>` +
        `<td class="r">${r.dataRowCount.toLocaleString()}</td><td>${esc(keySummary(r))}</td><td>${esc(roles.get(r.id) ?? '')}</td></tr>`);
    }
  }
  const invNote = regions.length > INV_CAP ? `<p class="tbl-note">※ 表が多いため上位 ${INV_CAP} 表のみ掲載しています（全 ${regions.length} 表）。</p>` : '';

  // ---- 根拠テーブル（数式の代表 + 手コピー） ----
  const evRows: string[] = [];
  {
    const fmtEnd = (key: string) => {
      const rid = regionIdOf(key); const col = colNameOf(key);
      const l = labels.get(rid) ?? rid;
      return col ? `${esc(l)} の「${esc(col)}」` : esc(l);
    };
    const formulaBest = pairs
      .flatMap(p => GROUP_ORDER.filter(g => g !== 'copy').map(g => p.best[g]).filter((e): e is Edge => !!e))
      .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
      .slice(0, 10);
    for (const e of formulaBest) {
      const g = groupOf(e.type);
      evRows.push(`<tr><td>${fmtEnd(e.from)} → ${fmtEnd(e.to)}</td>` +
        `<td><span class="rel ${GROUP_META[g].cls}">${esc(GROUP_META[g].label.split('（')[0])}</span></td>` +
        `<td class="mono">${esc(shortText(e.evidence))}</td><td class="conf"><b>${confLabel(e.confidence ?? 0)}</b>（数式）</td></tr>`);
    }
    const copyBest = pairs.filter(p => p.best.copy).slice(0, 4);
    for (const p of copyBest) {
      const e = p.best.copy!;
      const qid = copyQuestionByPair.get(`${p.from}\u0000${p.to}`);
      evRows.push(`<tr><td>${fmtEnd(e.from)} → ${fmtEnd(e.to)}</td>` +
        `<td><span class="rel copy">手コピー推定</span></td>` +
        `<td>数式なし。${esc(shortText(e.evidence, 50))}</td><td class="conf"><b>${confLabel(e.confidence ?? 0)}</b>（値一致）${qid ? ` → ${qid}` : ''}</td></tr>`);
    }
  }

  // ---- 各表の詳細 ----
  const DETAIL_CAP = 10;
  const detailRegions = regions
    .slice()
    .sort((a, b) => b.dataRowCount - a.dataRowCount)
    .slice(0, DETAIL_CAP);
  const detailBlocks = detailRegions.map((r, i) => {
    const keyCols = new Set((r.keys?.keys ?? []).map(k => k.column));
    const chips = r.columns.slice(0, 24).map(c => {
      const cls = keyCols.has(c.name) ? 'colchip key'
        : c.mixedFormula ? 'colchip manual'
        : c.hasFormula ? 'colchip formula'
        : c.manualNumeric > 0 ? 'colchip manual' : 'colchip';
      const mark = c.mixedFormula ? ' ⚠' : '';
      return `<span class="${cls}">${esc(c.name)}${mark}</span>`;
    }).join('');
    const more = r.columns.length > 24 ? `<span class="colchip">…他${r.columns.length - 24}列</span>` : '';
    const keyNote = r.keys?.grain
      ? `<p class="key-note">🔑 セルは <b>${esc(r.keys.grain)}</b> の組合せで決まります（横持ち表。縦持ちに展開すると「行キー・軸・値」の形になります）。</p>`
      : r.keys?.axisNote
      ? `<p class="key-note">🔑 ${esc(r.keys.axisNote)}</p>`
      : keyCols.size > 0
        ? `<p class="key-note">🔑 <b>${esc(keySummary(r))}</b> が1行を決めるキーと推定しています。</p>`
        : '';
    const colAxis = r.keys?.colAxis ? `<p class="rnote">${esc(r.keys.colAxis)}</p>` : '';
    const mixedCols = r.columns.filter(c => c.mixedFormula).map(c => c.name);
    const mixedNote = mixedCols.length > 0
      ? `<p class="rnote">⚠ ${esc(mixedCols.slice(0, 3).join('、'))} 列で数式と手入力の混在があります。</p>` : '';
    return `<details class="region"${i === 0 ? ' open' : ''}>
      <summary><b>${esc(labels.get(r.id) ?? r.sheet)}</b><span class="loc">${esc(r.file)} › ${esc(r.sheet)}!${esc(rangeOf(r))}</span><span class="rows">${r.dataRowCount.toLocaleString()}行 × ${r.columns.length}列</span></summary>
      <div class="rbody"><div class="colchips">${chips}${more}</div>${keyNote}${colAxis}${mixedNote}</div>
    </details>`;
  }).join('\n');
  const detailNote = regions.length > DETAIL_CAP
    ? `<p class="tbl-note">※ 行数の多い上位 ${DETAIL_CAP} 表を掲載しています。残り ${regions.length - DETAIL_CAP} 表の詳細はお打ち合わせで画面をご覧いただけます。</p>` : '';

  // ---- 質問カード ----
  const qCards = questions.map(q => `
    <div class="qcard${q.priority === 'high' ? ' p-high' : ''}">
      <div class="qhead"><span class="qid">${q.id}</span><span class="qtag ${q.priority === 'high' ? 'high' : 'mid'}">優先度 ${q.priority === 'high' ? '高' : '中'}</span><span class="qtag kind">${esc(q.kind)}</span></div>
      <div class="qtitle">${esc(q.title)}</div>
      <dl class="qgrid">
        ${q.analysis ? `<dt>分析結果</dt><dd>${esc(q.analysis)}</dd>` : ''}
        <dt>伺いたいこと</dt><dd>${esc(q.ask)}</dd>
        ${q.kpiee ? `<dt>kpieeでは</dt><dd>${esc(q.kpiee)}</dd>` : ''}
      </dl>
      <div class="ansbox">ご回答メモ：</div>
    </div>`).join('\n');

  const mapSection = map ? `
<section class="alt">
  <div class="wrap">
    <div class="sec-head">
      <div class="eyebrow">03 ── RELATIONSHIPS</div>
      <h2>表どうしの関係</h2>
      <p class="sec-lede">受領データの表が「どのキーでつながり」「どの向きに流れているか」を2つの図で示します。まず<b>キー関係図（ER）</b>で対応関係を、次に<b>データの流れ</b>で全体像をご確認ください。</p>
    </div>
    ${er ? `
    <h3 class="sub-h">キー関係図（ER）</h3>
    <p class="graph-guide">各ボックス＝表。<b>🔑＝主キー</b>（1行を一意に決める列）／◇＝軸。表を結ぶ線は同じキー列での対応で、<b>端の 1 / N が対応関係（1対多）</b>を表します（1＝一意＝マスタ側、N＝繰り返し＝明細側）。</p>
    <div class="map-scroll er-scroll">${er.svg}</div>
    ${er.omitted > 0 ? `<p class="tbl-note">※ キーでつながる表を優先して表示しています（ほか ${er.omitted} 表は省略）。全体はお打ち合わせで画面をご覧いただけます。</p>` : ''}
    ` : ''}
    <h3 class="sub-h">データの流れ（関係マップ）</h3>
    <p class="graph-guide">各ノード＝<b>1つの表</b>（大きさ＝つながりの多さ）。<b>関係の多い表ほど上、少ない表ほど下</b>に並び、上から下へ全体像を追えます。矢印＝関係の向き、線の色＝関係の種類、<b>破線＝手作業コピー（要確認）</b>。表の1行を決めるキー・軸は「02 内訳」「04 各表の詳細」でご確認いただけます。<span class="only-screen">右上の <b>＋ / － / ⤢全画面 / ⟳</b> ボタンで拡大・全画面表示できます（Escで戻る）。ノードにカーソルを合わせると関係先を強調、ドラッグで移動もできます。</span><span class="only-print">※ 本紙は静止画です。操作版はブラウザでご覧ください。</span></p>
    <div class="map-static map-scroll">${map.svg}</div>
    <figure class="map-interactive" id="relgraph" aria-label="表どうしの関係グラフ（操作可能）"></figure>
    <script type="application/json" id="relgraph-data">${JSON.stringify(map.data).replace(/</g, '\\u003c')}</script>
    <div class="legend">
      <span class="lg-h">関係の種類</span>
      ${GROUP_ORDER.map(g => `<span class="li"><span class="sw${GROUP_META[g].dashed ? ' dash' : ''}" style="border-color:${GROUP_META[g].color}"></span>${esc(GROUP_META[g].label)}</span>`).join('\n      ')}
    </div>
    <div class="legend">
      <span class="lg-h">表の役割</span>
      <span class="li"><span class="nrole src"></span>元データ（明細）</span>
      <span class="li"><span class="nrole mst"></span>マスタ（参照元）</span>
      <span class="li"><span class="nrole mid"></span>中間集計</span>
      <span class="li"><span class="nrole out"></span>最終アウトプット</span>
      <span class="li"><span class="nrole iso"></span>独立（つながりなし・要確認）</span>
    </div>
    ${map.omittedNodes > 0 || map.omittedEdges > 0 ? `<p class="tbl-note">※ 図はつながりの多い表を優先して表示しています（省略: 表 ${map.omittedNodes}・関係 ${map.omittedEdges}）。全体はお打ち合わせで画面をご覧いただけます。</p>` : ''}
    <div class="callout info">
      <span class="mark">ℹ️</span>
      <span>ピボットテーブル・INDIRECT関数・ファイル間の数式リンクは自動追跡の対象外です。該当する処理をお使いの場合は、お打ち合わせで補足をお願いします。</span>
    </div>

    <div class="sec-head" style="margin-top:44px;margin-bottom:18px">
      <h2 style="font-size:19px">関係の根拠（抜粋）</h2>
      <p class="sec-lede" style="font-size:13px">各関係の判定根拠となった数式・値一致の一部です。</p>
    </div>
    <div style="overflow-x:auto">
      <table class="ot">
        <tr><th>参照元 → 参照先</th><th>種別</th><th>根拠（数式・一致の抜粋）</th><th>確度</th></tr>
        ${evRows.join('\n        ')}
      </table>
    </div>
  </div>
</section>` : `
<section class="alt">
  <div class="wrap">
    <div class="sec-head">
      <div class="eyebrow">03 ── DATA FLOW</div>
      <h2>データの流れ（関係マップ）</h2>
      <p class="sec-lede">表どうしをつなぐ数式・値一致の関係は検出されませんでした。各表が独立して管理されている可能性があります（05 の確認事項をご覧ください）。</p>
    </div>
  </div>
</section>`;

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>データ構造 分析レポート｜${esc(input.customerName || 'kpiee')}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Zen+Old+Mincho:wght@600;700;900&family=Noto+Sans+JP:wght@400;500;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
${REPORT_CSS}
</style>
</head>
<body>

<header>
  <div class="wrap">
    <div class="hero">
      <div class="brand">kpiee ONBOARDING ── DATA STRUCTURE REVIEW / dataX Inc.</div>
      <h1>ご提供データの<span class="em">構造分析</span>レポート<br>── 読み合わせのお願い</h1>
      <p class="lede">kpiee導入に先立ち、ご提供いただいたExcel・CSVファイルの構造（表・キー・数式のつながり）を解析しました。本資料は「私たちの理解が合っているか」を確認するためのものです。特に <b style="color:#fff">05. ご確認いただきたい点</b> について、お打ち合わせでご回答をいただけますと幸いです。</p>
      <div class="hero-meta">
        <span>宛先：<b>${esc(customer)}</b></span>
        <span>分析日：<b>${dateStr}</b></span>
        <span>作成：dataX カスタマーサクセス</span>
      </div>
    </div>
  </div>
</header>

<section class="alt">
  <div class="wrap">
    <div class="sec-head">
      <div class="eyebrow">01 ── SUMMARY</div>
      <h2>分析サマリ</h2>
    </div>
    <div class="tiles">
      <div class="tile"><div class="tl">受領ファイル</div><div class="tv">${input.fileCount}<small>件</small></div></div>
      <div class="tile"><div class="tl">検出した表</div><div class="tv">${regions.length}<small>表</small></div></div>
      <div class="tile"><div class="tl">表どうしの関係</div><div class="tv">${edgeTotal.toLocaleString()}<small>件</small></div></div>
      <div class="tile warn"><div class="tl">ご確認いただきたい点</div><div class="tv">${questions.length}<small>件</small></div></div>
    </div>
    <div class="summary">
      <div class="stitle">まとめ</div>
      <ul>
        ${bullets.map(b => `<li>${b}</li>`).join('\n        ')}
      </ul>
    </div>
  </div>
</section>

<section>
  <div class="wrap">
    <div class="sec-head">
      <div class="eyebrow">02 ── INVENTORY</div>
      <h2>受領データの内訳</h2>
      <p class="sec-lede">1つのシートに複数の表が含まれる場合は、表単位に分割して解析しています。「主キー」は<b>1行を一意に決める列</b>の推定です。</p>
    </div>
    <div style="overflow-x:auto">
      <table class="ot">
        <tr><th>ファイル</th><th>シート</th><th>表（位置）</th><th>行数</th><th>主キー／軸（推定）</th><th>役割（推定）</th></tr>
        ${invRows.join('\n        ')}
      </table>
      ${invNote}
    </div>
  </div>
</section>

${mapSection}

<section>
  <div class="wrap">
    <div class="sec-head">
      <div class="eyebrow">04 ── TABLES</div>
      <h2>各表の詳細</h2>
      <p class="sec-lede">クリックで展開できます。列の色分け：<span class="colchip key">キー列</span> <span class="colchip formula">数式列</span> <span class="colchip manual">手入力の数値</span></p>
    </div>
    ${detailBlocks}
    ${detailNote}
  </div>
</section>

<section class="alt">
  <div class="wrap">
    <div class="sec-head">
      <div class="eyebrow">05 ── QUESTIONS</div>
      <h2>ご確認いただきたい点（${questions.length}件）</h2>
      <p class="sec-lede">自動解析では「推定」までしかできない箇所です。お打ち合わせの際、上から順にご回答をいただけますと、kpieeの設定を正確に進められます。<b>回答メモ欄は印刷してそのままお使いいただけます。</b></p>
    </div>
    ${qCards}
    <div class="callout info">
      <span class="mark">💡</span>
      <span>実線の関係（数式由来）は数式そのものが根拠のため、原則ご確認は不要です。上記は<b>自動解析が「推定」に留まる箇所だけ</b>を抽出しています。</span>
    </div>
  </div>
</section>

<section>
  <div class="wrap">
    <div class="sec-head">
      <div class="eyebrow">06 ── NEXT STEP</div>
      <h2>今後の進め方</h2>
    </div>
    <div class="steps">
      <div class="step"><div class="no">1</div>
        <h3>本資料の読み合わせ<span class="who">貴社 × 弊社</span></h3>
        <p>お打ち合わせ（30〜60分）で、05の確認事項にご回答をいただきます。わかる範囲で結構です。</p>
      </div>
      <div class="step"><div class="no">2</div>
        <h3>定義の確定・追加データのご提供<span class="who">貴社 × 弊社</span></h3>
        <p>ご回答をもとにデータ定義を確定します。不足データがあればご提供をお願いします。</p>
      </div>
      <div class="step"><div class="no">3</div>
        <h3>kpieeへの取込設定・KPIツリー構築<span class="who">弊社主導</span></h3>
        <p>確定した構造にもとづき、kpieeのデータ取込とKPIの紐付けを設定します。手転記いただいていた箇所は自動化されます。</p>
      </div>
      <div class="step"><div class="no">4</div>
        <h3>数値検証・運用開始<span class="who">貴社 × 弊社</span></h3>
        <p>既存のExcel報告と kpiee の数値を突き合わせ、一致を確認してから運用に切り替えます。</p>
      </div>
    </div>
    <div class="callout warn">
      <span class="mark">⚠️</span>
      <span>本レポートは自動解析の結果にもとづきます。数式のないつながり（破線）や役割・キーの表記は推定であり、ご確認の結果によって内容を更新します。本資料に原本の数値データは含まれていません（列名・数式・行数などの構造情報のみ）。</span>
    </div>
  </div>
</section>

<footer>
  <div class="wrap">© dataX Inc.　|　kpiee データ構造分析レポート（${dateStr} 生成）　|　本資料は貴社との確認用資料であり、社外への共有はお控えください。</div>
</footer>
${map ? `<script>${REPORT_GRAPH_JS}</script>` : ''}
</body>
</html>
`;
}

// レポートのスタイル（bdash 提案資料と同じデザイン言語）。JSの開示アニメーションは
// 配布ファイルでは不要なので持たず、CSSのみで完結させる。
const REPORT_CSS = `
:root{
  --ink:#0E2A47;--blue:#1F5FAE;--sky:#3D9BE9;
  --green:#1E9E6A;--green-bg:#E9F7F0;--violet:#7B5EA7;--violet-bg:#F1EDF8;
  --amber:#B96A00;--amber-bg:#FFF4E3;--red:#C24141;--red-bg:#FBEFEF;
  --paper:#F7F9FC;--text:#3A4552;--sub:#7A8794;--line:#DDE5EE;--blue-bg:#EDF4FC;
  --mono:'IBM Plex Mono',monospace;--disp:'Zen Old Mincho',serif;--body:'Noto Sans JP',sans-serif;
}
*{margin:0;padding:0;box-sizing:border-box}
html{scroll-behavior:smooth}
body{font-family:var(--body);color:var(--text);background:var(--paper);font-size:15px;line-height:1.85;-webkit-font-smoothing:antialiased}
.wrap{max-width:1060px;margin:0 auto;padding:0 28px}
header{background:var(--ink);color:#fff;position:relative;overflow:hidden}
header::after{content:'';position:absolute;right:-120px;top:-120px;width:420px;height:420px;border-radius:50%;background:radial-gradient(circle,rgba(61,155,233,.25),transparent 70%);pointer-events:none}
.hero{padding:64px 0 52px;position:relative;z-index:1;max-width:820px}
.brand{font-family:var(--mono);font-size:12px;letter-spacing:.18em;color:var(--sky);margin-bottom:20px}
h1{font-family:var(--disp);font-weight:900;font-size:34px;line-height:1.5;letter-spacing:.02em;margin-bottom:16px}
h1 .em{color:var(--sky)}
.lede{color:#C6D6E8;font-size:15px;max-width:40em}
.hero-meta{display:flex;gap:10px;margin-top:24px;flex-wrap:wrap}
.hero-meta span{font-size:12px;border:1px solid rgba(255,255,255,.28);border-radius:999px;padding:4px 14px;color:#D8E4F2}
.hero-meta span b{color:#fff;font-weight:500}
section{padding:60px 0}
section.alt{background:#fff}
.sec-head{margin-bottom:32px}
.eyebrow{font-family:var(--mono);font-size:12px;letter-spacing:.16em;color:var(--blue);margin-bottom:10px}
h2{font-family:var(--disp);font-weight:700;font-size:26px;color:var(--ink);line-height:1.5}
.sec-lede{margin-top:12px;max-width:46em;color:var(--text)}
.tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:18px}
.tile{background:#fff;border:1px solid var(--line);border-radius:16px;padding:20px 22px}
.tile .tl{font-size:12px;color:var(--sub);letter-spacing:.04em}
.tile .tv{font-family:var(--mono);font-size:30px;color:var(--ink);line-height:1.4;margin-top:2px}
.tile .tv small{font-size:14px;color:var(--sub);margin-left:2px}
.tile.warn{border-top:4px solid var(--amber)}
.tile.warn .tv{color:var(--amber)}
.summary{margin-top:26px;background:#fff;border:1px solid var(--line);border-radius:16px;padding:24px 28px}
.summary .stitle{font-weight:700;color:var(--ink);font-size:14px;border-left:3px solid var(--blue);padding-left:10px;margin-bottom:10px}
.summary ul{list-style:none;display:flex;flex-direction:column;gap:8px;font-size:13.5px}
.summary li{padding-left:16px;position:relative}
.summary li::before{content:'▸';position:absolute;left:0;color:var(--blue)}
.summary li b{color:var(--ink)}
.ot{width:100%;border-collapse:collapse;font-size:12.5px;background:#fff;border-radius:12px;overflow:hidden;border:1px solid var(--line)}
.ot th{background:var(--ink);color:#fff;padding:8px 12px;text-align:left;font-weight:500;white-space:nowrap}
.ot td{padding:8px 12px;border-bottom:1px solid var(--line);vertical-align:top}
.ot tr:last-child td{border-bottom:none}
.ot td.mono{font-family:var(--mono);font-size:11.5px;white-space:nowrap}
.ot td.r{text-align:right;font-family:var(--mono);font-size:11.5px}
.tbl-note{font-size:11.5px;color:var(--sub);margin-top:8px}
.rel{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:700;border-radius:999px;padding:2px 10px;white-space:nowrap}
.rel::before{content:'';width:8px;height:8px;border-radius:50%;background:currentColor}
.rel.lookup{background:var(--blue-bg);color:var(--blue)}
.rel.agg{background:var(--green-bg);color:var(--green)}
.rel.move{background:var(--violet-bg);color:var(--violet)}
.rel.copy{background:var(--amber-bg);color:var(--amber)}
.conf{font-family:var(--mono);font-size:11px;color:var(--sub)}
.conf b{color:var(--ink);font-weight:500}
.map-scroll{overflow-x:auto;background:#FCFDFE;border:1px solid var(--line);border-radius:16px;padding:18px}
.map-scroll svg{min-width:760px;width:100%;height:auto;display:block;font-family:var(--body)}
.legend{display:flex;gap:14px;flex-wrap:wrap;margin-top:14px;font-size:12px}
.legend .li{display:inline-flex;align-items:center;gap:7px;color:var(--text)}
.legend .sw{width:22px;height:0;border-top:3px solid;border-radius:2px}
.legend .sw.dash{border-top-style:dashed}
details.region{background:#fff;border:1px solid var(--line);border-radius:14px;margin-bottom:12px;overflow:hidden}
details.region summary{cursor:pointer;padding:14px 20px;display:flex;align-items:center;gap:12px;flex-wrap:wrap;list-style:none}
details.region summary::-webkit-details-marker{display:none}
details.region summary::before{content:'▸';color:var(--blue);transition:transform .2s}
details.region[open] summary::before{transform:rotate(90deg)}
details.region summary b{color:var(--ink);font-size:14px}
details.region summary .loc{font-family:var(--mono);font-size:11px;color:var(--sub)}
details.region summary .rows{font-family:var(--mono);font-size:11px;color:var(--sub);margin-left:auto}
details.region .rbody{padding:4px 20px 18px;border-top:1px solid var(--line)}
.colchips{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0 4px}
.colchip{font-size:11.5px;border:1px solid var(--line);border-radius:8px;padding:3px 10px;background:#FCFDFE}
.colchip.key{border-color:#C9DEF4;background:var(--blue-bg);color:var(--blue);font-weight:700}
.colchip.formula{border-color:#BFE5D3;background:var(--green-bg);color:var(--green)}
.colchip.manual{border-color:#F0D8B0;background:var(--amber-bg);color:var(--amber)}
.rnote{font-size:12px;color:var(--sub)}
.key-note{font-size:12.5px;margin-top:8px}
.key-note b{color:var(--ink)}
.qcard{background:#fff;border:1px solid var(--line);border-left:5px solid var(--amber);border-radius:14px;padding:20px 24px;margin-bottom:16px}
.qcard.p-high{border-left-color:var(--red)}
.qhead{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px}
.qid{font-family:var(--mono);font-size:13px;font-weight:500;color:var(--ink)}
.qtag{font-size:10.5px;font-weight:700;border-radius:999px;padding:2px 11px}
.qtag.kind{background:var(--blue-bg);color:var(--blue)}
.qtag.high{background:var(--red-bg);color:var(--red)}
.qtag.mid{background:var(--amber-bg);color:var(--amber)}
.qtitle{font-size:15px;font-weight:700;color:var(--ink)}
.qgrid{display:grid;grid-template-columns:96px 1fr;gap:6px 14px;font-size:13px;margin-top:6px}
.qgrid dt{color:var(--sub);font-size:12px;padding-top:2px}
.qgrid dd{line-height:1.75}
.ansbox{margin-top:12px;border:1.5px dashed var(--line);border-radius:10px;min-height:56px;padding:8px 12px;font-size:12px;color:var(--sub);background:#FCFDFE}
.steps{position:relative;margin-left:12px}
.steps::before{content:'';position:absolute;left:21px;top:8px;bottom:8px;width:2px;background:var(--line)}
.step{position:relative;padding:0 0 26px 66px}
.step:last-child{padding-bottom:0}
.step .no{position:absolute;left:0;top:0;width:44px;height:44px;border-radius:50%;background:var(--blue);color:#fff;display:flex;align-items:center;justify-content:center;font-family:var(--disp);font-weight:700;font-size:18px;box-shadow:0 0 0 5px var(--paper)}
.step h3{font-size:16px;color:var(--ink);display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.step h3 .who{font-size:11px;font-weight:700;border-radius:999px;padding:2px 11px;background:var(--blue-bg);color:var(--blue)}
.step p{font-size:13.5px;margin-top:4px;max-width:46em}
.callout{margin-top:24px;border-radius:14px;padding:16px 20px;font-size:13px;display:flex;gap:12px;align-items:flex-start}
.callout.warn{background:var(--amber-bg);border:1px solid #F0D8B0;color:#7A5100}
.callout.info{background:var(--blue-bg);border:1px solid #C9DEF4;color:#1C4B84}
.callout .mark{font-size:17px;line-height:1.4}
footer{padding:30px 0 42px;color:var(--sub);font-size:11.5px;text-align:center}
@media (max-width:900px){
  h1{font-size:26px}
  .tiles{grid-template-columns:1fr 1fr}
  .qgrid{grid-template-columns:1fr}
  .qgrid dt{padding-top:6px}
}
/* ---- キー関係図（ER）＋インタラクティブ関係グラフ ---- */
.sub-h{font-family:var(--disp);font-weight:700;font-size:18px;color:var(--ink);margin:30px 0 6px}
.er-scroll svg{min-width:640px;width:100%;height:auto;display:block;font-family:var(--body)}
.graph-guide{font-size:12.5px;color:var(--text);line-height:1.7;margin-bottom:12px}
.only-print{display:none}
.map-interactive{display:none;position:relative;background:#FCFDFE;border:1px solid var(--line);border-radius:16px;padding:8px;margin:0;min-height:440px;touch-action:none;overflow:hidden}
.relgraph-ctrl{position:absolute;top:12px;right:12px;display:flex;gap:6px;z-index:3}
.relgraph-ctrl button{width:32px;height:32px;padding:0;border:1px solid var(--line);background:#fff;color:var(--ink);border-radius:8px;font-size:15px;line-height:1;cursor:pointer;box-shadow:0 1px 3px rgba(14,42,71,.1)}
.relgraph-ctrl button:hover{background:var(--blue-bg);border-color:var(--blue);color:var(--blue)}
.map-interactive.expanded{position:fixed;inset:0;z-index:9999;margin:0;border-radius:0;min-height:0;padding:16px}
.map-interactive.expanded .relgraph-svg{height:100%;max-height:100%}
body.relgraph-noscroll{overflow:hidden}
.relgraph-svg{width:100%;height:auto;display:block;font-family:var(--body)}
.relgraph-svg .nd{cursor:grab;transition:opacity .15s}
.relgraph-svg .rl{transition:opacity .15s}
.legend .lg-h{font-weight:700;color:var(--ink);font-size:12px;margin-right:2px}
.nrole{width:13px;height:13px;border-radius:50%;display:inline-block;border:2px solid;vertical-align:-2px}
.nrole.src{background:var(--green-bg);border-color:var(--green)}
.nrole.mst{background:var(--blue-bg);border-color:var(--blue)}
.nrole.mid{background:var(--violet-bg);border-color:var(--violet)}
.nrole.out{background:var(--red-bg);border-color:var(--red)}
.nrole.iso{background:#F2F5F8;border-color:#9AA7B4}
@media print{
  header::after{display:none}
  section{padding:28px 0}
  details.region{page-break-inside:avoid}
  details.region:not([open]) summary::before{content:'▸'}
  .qcard{page-break-inside:avoid}
  .map-interactive{display:none!important}
  .map-static{display:block!important}
  .only-print{display:inline}
  .only-screen{display:none}
}
`;

// インタラクティブ関係グラフ（Obsidian 風の力学配置）。外部ライブラリ無しの素の SVG + JS。
// #relgraph-data（JSON）を読み、力学シミュレーションで配置。ノード=表（役割で色分け＋ラベル）、
// 辺=関係（種類で色、破線=手コピー）。ホバーで関係先を強調、ドラッグ移動、ホイール拡大、背景パン。
// 初期化に失敗したら静的SVG（.map-static）へ戻す。※テンプレートリテラルに埋めるためバッククォート/${ は使わない。
const REPORT_GRAPH_JS = `
(function(){
  try{
    var host=document.getElementById('relgraph');
    var dataEl=document.getElementById('relgraph-data');
    if(!host||!dataEl) return;
    var data=JSON.parse(dataEl.textContent);
    if(!data||!data.nodes||!data.nodes.length) return;
    var staticEl=document.querySelector('.map-static');
    if(staticEl) staticEl.style.display='none';
    host.style.display='block';

    var NS='http://www.w3.org/2000/svg';
    var W=host.clientWidth||820, H=Math.max(440,Math.min(680,(data.h||520)));
    var svg=document.createElementNS(NS,'svg');
    svg.setAttribute('viewBox','0 0 '+W+' '+H);
    svg.setAttribute('class','relgraph-svg');
    host.appendChild(svg);

    var defs=document.createElementNS(NS,'defs'); svg.appendChild(defs);
    var mk={};
    data.links.forEach(function(l){ if(mk[l.color]!=null) return; var id='ar'+Object.keys(mk).length;
      var m=document.createElementNS(NS,'marker'); m.setAttribute('id',id); m.setAttribute('viewBox','0 0 10 10');
      m.setAttribute('refX','9'); m.setAttribute('refY','5'); m.setAttribute('markerWidth','7'); m.setAttribute('markerHeight','7'); m.setAttribute('orient','auto');
      var pa=document.createElementNS(NS,'path'); pa.setAttribute('d','M0,0 L10,5 L0,10 z'); pa.setAttribute('fill',l.color); m.appendChild(pa);
      defs.appendChild(m); mk[l.color]=id; });

    var gZoom=document.createElementNS(NS,'g'); svg.appendChild(gZoom);
    var gL=document.createElementNS(NS,'g'); gZoom.appendChild(gL);
    var gN=document.createElementNS(NS,'g'); gZoom.appendChild(gN);

    var nodes=data.nodes, links=data.links, byId={};
    nodes.forEach(function(n){ byId[n.id]=n; });
    // 縦フロー: 関係の多い表ほど上（小さい y）、少ない表ほど下。degree で目標 y（ly）を決め、
    // x は初期は疑似分散し、あとは斥力で横に広げる。
    var mnd=1e9, mxd=-1e9;
    nodes.forEach(function(n){ mnd=Math.min(mnd,n.deg); mxd=Math.max(mxd,n.deg); });
    nodes.forEach(function(n, i){
      var t = mxd>mnd ? (n.deg-mnd)/(mxd-mnd) : 0.5;
      n.ly = 50 + (1-t)*(H-100);                 // 関係多い→上
      n.y = n.ly;
      n.x = 60 + ((i*137) % Math.max(1, W-120)); // 決定的な疑似分散（Math.random は使わない）
      n.vx=0; n.vy=0; n.r=9+Math.min(15,Math.sqrt(n.deg)*3); n.fx=null; n.fy=null;
    });

    function roleStyle(role){
      if(/最終/.test(role)) return {s:'#C24141',f:'#FBEFEF'};
      if(/マスタ/.test(role)) return {s:'#1F5FAE',f:'#EDF4FC'};
      if(/中間/.test(role)) return {s:'#7B5EA7',f:'#F1EDF8'};
      if(/元データ/.test(role)) return {s:'#1E9E6A',f:'#E9F7F0'};
      return {s:'#9AA7B4',f:'#F2F5F8'};
    }
    function trunc(s,n){ return s.length<=n? s : s.slice(0,n)+'…'; }

    var adj={}; nodes.forEach(function(n){ adj[n.id]={}; });
    var LE=links.map(function(l){
      adj[l.s][l.t]=1; adj[l.t][l.s]=1;
      var p=document.createElementNS(NS,'path'); p.setAttribute('class','rl'); p.setAttribute('fill','none');
      p.setAttribute('stroke',l.color); p.setAttribute('stroke-width','2'); p.setAttribute('marker-end','url(#'+mk[l.color]+')');
      if(l.dashed) p.setAttribute('stroke-dasharray','7 5'); gL.appendChild(p);
      var t=document.createElementNS(NS,'text'); t.setAttribute('font-size','10.5'); t.setAttribute('fill',l.color);
      t.setAttribute('text-anchor','middle'); t.setAttribute('style','paint-order:stroke;stroke:#fff;stroke-width:3px;opacity:0;pointer-events:none');
      t.textContent=l.label+(l.qid?(' → '+l.qid):'')+(l.count>1?(' ×'+l.count):''); gL.appendChild(t);
      return {l:l,p:p,t:t};
    });
    var NE=nodes.map(function(n){
      var st=roleStyle(n.role);
      var g=document.createElementNS(NS,'g'); g.setAttribute('class','nd');
      var c=document.createElementNS(NS,'circle'); c.setAttribute('r',n.r); c.setAttribute('fill',st.f); c.setAttribute('stroke',st.s); c.setAttribute('stroke-width','2.5'); g.appendChild(c);
      var nm=document.createElementNS(NS,'text'); nm.setAttribute('text-anchor','middle'); nm.setAttribute('font-size','12'); nm.setAttribute('font-weight','700'); nm.setAttribute('fill','#0E2A47'); nm.setAttribute('style','paint-order:stroke;stroke:#F7F9FC;stroke-width:4px;pointer-events:none'); nm.textContent=trunc(n.label,16); g.appendChild(nm);
      var rl=document.createElementNS(NS,'text'); rl.setAttribute('text-anchor','middle'); rl.setAttribute('font-size','9.5'); rl.setAttribute('fill',st.s); rl.setAttribute('style','paint-order:stroke;stroke:#F7F9FC;stroke-width:3px;pointer-events:none'); rl.textContent=n.role.replace(/（.*$/,''); g.appendChild(rl);
      var tt=document.createElementNS(NS,'title'); tt.textContent=n.label+' ／ '+n.role+' ／ '+n.sub; g.appendChild(tt);
      g.addEventListener('mouseenter',function(){ hl(n.id); });
      g.addEventListener('mouseleave',function(){ hl(null); });
      g.addEventListener('pointerdown',function(ev){ drag=n; n.fx=n.x; n.fy=n.y; ev.stopPropagation(); if(svg.setPointerCapture){ try{ svg.setPointerCapture(ev.pointerId); }catch(e){} } });
      gN.appendChild(g);
      return {n:n,g:g,nm:nm,rl:rl};
    });

    function draw(){
      LE.forEach(function(o){ var a=byId[o.l.s],b=byId[o.l.t]; var mx=(a.x+b.x)/2, my=(a.y+b.y)/2-14;
        o.p.setAttribute('d','M'+a.x+','+a.y+' Q'+mx+','+my+' '+b.x+','+b.y); o.t.setAttribute('x',mx); o.t.setAttribute('y',my); });
      NE.forEach(function(o){ o.g.setAttribute('transform','translate('+o.n.x+','+o.n.y+')'); o.nm.setAttribute('y',o.n.r+13); o.rl.setAttribute('y',o.n.r+25); });
    }
    function hl(id){
      NE.forEach(function(o){ o.g.style.opacity=(id==null||o.n.id===id||adj[id][o.n.id])?1:0.18; });
      LE.forEach(function(o){ var on=(id!=null&&(o.l.s===id||o.l.t===id)); o.p.style.opacity=(id==null||on)?1:0.07; o.t.setAttribute('style','paint-order:stroke;stroke:#fff;stroke-width:3px;pointer-events:none;opacity:'+(on?1:0)); });
    }

    var alpha=1, raf=null, drag=null;
    function tick(){
      var i,j,a,b,dx,dy,d,d2,f,ux,uy;
      for(i=0;i<nodes.length;i++){ for(j=i+1;j<nodes.length;j++){ a=nodes[i]; b=nodes[j]; dx=a.x-b.x; dy=a.y-b.y; d2=dx*dx+dy*dy+0.01; d=Math.sqrt(d2); f=2800/d2; ux=dx/d; uy=dy/d; a.vx+=ux*f; a.vy+=uy*f; b.vx-=ux*f; b.vy-=uy*f; } }
      links.forEach(function(l){ var a=byId[l.s],b=byId[l.t]; var dx=b.x-a.x,dy=b.y-a.y; var d=Math.sqrt(dx*dx+dy*dy)+0.01; var f=(d-150)*0.02; var ux=dx/d,uy=dy/d; a.vx+=ux*f; a.vy+=uy*f; b.vx-=ux*f; b.vy-=uy*f; });
      nodes.forEach(function(n){ n.vy+=(n.ly-n.y)*0.03; n.vx+=(W/2-n.x)*0.006; });
      nodes.forEach(function(n){ if(n.fx!=null){ n.x=n.fx; n.y=n.fy; n.vx=0; n.vy=0; return; } n.vx*=0.85; n.vy*=0.85; n.x+=n.vx*alpha; n.y+=n.vy*alpha; n.x=Math.max(40,Math.min(W-40,n.x)); n.y=Math.max(34,Math.min(H-28,n.y)); });
      draw(); alpha*=0.98; if(alpha>0.02){ raf=requestAnimationFrame(tick); } else { raf=null; }
    }
    function reheat(){ alpha=Math.max(alpha,0.5); if(!raf) raf=requestAnimationFrame(tick); }

    var scale=1,ox=0,oy=0;
    function apply(){ gZoom.setAttribute('transform','translate('+ox+','+oy+') scale('+scale+')'); }
    function toG(ev){ var r=svg.getBoundingClientRect(); var x=(ev.clientX-r.left)*(W/r.width), y=(ev.clientY-r.top)*(H/r.height); return {x:(x-ox)/scale,y:(y-oy)/scale}; }
    var pan=null;
    svg.addEventListener('pointerdown',function(ev){ if(ev.target===svg||ev.target===gZoom){ pan={x:ev.clientX,y:ev.clientY,ox:ox,oy:oy}; } });
    svg.addEventListener('pointermove',function(ev){ if(drag){ var p=toG(ev); drag.fx=p.x; drag.fy=p.y; reheat(); return; } if(pan){ var r=svg.getBoundingClientRect(); ox=pan.ox+(ev.clientX-pan.x)*(W/r.width); oy=pan.oy+(ev.clientY-pan.y)*(H/r.height); apply(); } });
    window.addEventListener('pointerup',function(){ if(drag){ drag.fx=null; drag.fy=null; drag=null; } pan=null; });
    svg.addEventListener('wheel',function(ev){ ev.preventDefault(); var r=svg.getBoundingClientRect(); var mx=(ev.clientX-r.left)*(W/r.width), my=(ev.clientY-r.top)*(H/r.height); var ns=Math.max(0.4,Math.min(3,scale*(ev.deltaY<0?1.12:0.9))); ox=mx-(mx-ox)*(ns/scale); oy=my-(my-oy)*(ns/scale); scale=ns; apply(); },{passive:false});

    // 拡大・全画面ボタン（右上）
    function zoomAt(cx,cy,f){ var ns=Math.max(0.4,Math.min(4,scale*f)); ox=cx-(cx-ox)*(ns/scale); oy=cy-(cy-oy)*(ns/scale); scale=ns; apply(); }
    var expanded=false;
    function toggleExpand(){ expanded=!expanded; host.classList.toggle('expanded',expanded); document.body.classList.toggle('relgraph-noscroll',expanded); }
    document.addEventListener('keydown',function(e){ if(e.key==='Escape'&&expanded) toggleExpand(); });
    var bar=document.createElement('div'); bar.className='relgraph-ctrl';
    function ctl(txt,title,fn){ var b=document.createElement('button'); b.type='button'; b.textContent=txt; b.title=title; b.setAttribute('aria-label',title); b.addEventListener('click',function(ev){ ev.stopPropagation(); fn(); }); bar.appendChild(b); }
    ctl('＋','拡大',function(){ zoomAt(W/2,H/2,1.25); });
    ctl('－','縮小',function(){ zoomAt(W/2,H/2,0.8); });
    ctl('⤢','全画面で見る（Escで戻る）',function(){ toggleExpand(); });
    ctl('⟳','表示をリセット',function(){ scale=1; ox=0; oy=0; apply(); });
    host.appendChild(bar);

    draw(); apply(); reheat();
  }catch(e){
    var h=document.getElementById('relgraph'); if(h) h.style.display='none';
    var s=document.querySelector('.map-static'); if(s) s.style.display='';
  }
})();
`;

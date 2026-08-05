// 関係グラフを「表領域(region)ペア」「ファイル(ブック)ペア」へ畳む共通処理。
//
// 元は relationsReport.ts の内部関数だったが、次の3か所で同じ判定を使う必要が出たため切り出した:
//   - relationsReport.ts … レポートの図・表・セグメント分割
//   - relations/declared.ts … 確定済みファイル関係との突き合わせと確信度補正
//   - index.ts の API … ファイル関係の初期案の提示
// 判定を二重定義すると「画面では関係があるのにレポートには出ない」類のズレを生むので、ここが唯一の実装。
import type { Region, Edge } from '../preprocess/relations.js';

/** `表領域ID:列名` 形式のキーから表領域IDを取り出す（region.id は ':' を含まない） */
export const regionIdOf = (key: string): string => {
  const i = key.indexOf(':');
  return i < 0 ? key : key.slice(0, i);
};
/** 同キーから列名を取り出す（列名が無い場合は空文字） */
export const colNameOf = (key: string): string => {
  const i = key.indexOf(':');
  return i < 0 ? '' : key.slice(i + 1);
};

// ペアの鍵は NUL 区切り。ファイル名にスペースが入ることは珍しくなく、region id も
// ファイル名を含むため、スペース区切りだと別のペアが同じ鍵へ潰れうる。
/** 表領域ペアの一意な鍵（質問カードとの相互参照にも使う） */
export const regionPairKey = (from: string, to: string): string => `${from}\u0000${to}`;
/** ファイル対の一意な鍵（宣言との突き合わせ・図・質問カードで共用） */
export const filePairKey = (from: string, to: string): string => `${from}\u0000${to}`;

/** 関係種別を顧客向けの4分類へ畳む */
export type Group = 'ref' | 'agg' | 'move' | 'copy';
export const groupOf = (t: Edge['type']): Group =>
  t === 'copy' ? 'copy'
  : (t === 'aggregation' || t === 'filtered-agg') ? 'agg'
  : (t === 'lookup-join' || t === 'filter-key') ? 'ref'
  : 'move';

// 4色は色覚多様性チェック（validate_palette）通過済みの組。ラベル併記で色だけに頼らない。
export const GROUP_META: Record<Group, { label: string; color: string; cls: string; dashed: boolean }> = {
  ref:  { label: '参照・照合（VLOOKUP等）', color: '#1F5FAE', cls: 'lookup', dashed: false },
  agg:  { label: '集計（SUMIFS・SUM等）',   color: '#1E9E6A', cls: 'agg',    dashed: false },
  move: { label: '転記・計算（=参照・四則）', color: '#7B5EA7', cls: 'move',   dashed: false },
  copy: { label: '手修正推定（要確認）',   color: '#B96A00', cls: 'copy',   dashed: true },
};
export const GROUP_ORDER: Group[] = ['ref', 'agg', 'move', 'copy'];

// ============================================================
// 表領域ペア単位の集約
// ============================================================
export interface PairAgg {
  from: string; to: string;                 // region id
  counts: Partial<Record<Group, number>>;
  best: Partial<Record<Group, Edge>>;       // 各分類の代表辺（確信度最大）
  total: number;
}

export function aggregatePairs(edges: Edge[]): PairAgg[] {
  const map = new Map<string, PairAgg>();
  for (const e of edges) {
    const from = regionIdOf(e.from);
    const to = regionIdOf(e.to);
    if (!from || !to || from === to) continue;
    const k = regionPairKey(from, to);
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

export const dominantGroup = (p: PairAgg): Group => {
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

/** 前段からの最長距離でレイヤを割り当てる（循環は反復上限で自然に打ち切り） */
export function computeLayers(ids: string[], pairs: PairAgg[]): Map<string, number> {
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
// ファイル(ブック)ペア単位の集約
// ============================================================
export interface FilePair { from: string; to: string; counts: Partial<Record<Group, number>>; total: number }

/** 表領域ペアをファイル単位へ畳む。ファイル内の流れは対象外（シート単位の図で見せる） */
export function aggregateFilePairs(regions: Region[], pairs: PairAgg[]): FilePair[] {
  const fileOf = new Map(regions.map(r => [r.id, r.file]));
  const map = new Map<string, FilePair>();
  for (const p of pairs) {
    const from = fileOf.get(p.from); const to = fileOf.get(p.to);
    if (!from || !to || from === to) continue;
    const k = filePairKey(from, to);
    let fp = map.get(k);
    if (!fp) { fp = { from, to, counts: {}, total: 0 }; map.set(k, fp); }
    for (const g of GROUP_ORDER) {
      const n = p.counts[g] ?? 0;
      if (n > 0) { fp.counts[g] = (fp.counts[g] ?? 0) + n; fp.total += n; }
    }
  }
  return [...map.values()];
}

export const dominantFileGroup = (p: FilePair): Group => {
  const order: Group[] = ['agg', 'move', 'ref'];
  let best: Group | null = null;
  for (const g of order) {
    if ((p.counts[g] ?? 0) === 0) continue;
    if (best === null || (p.counts[g] ?? 0) > (p.counts[best] ?? 0)) best = g;
  }
  return best ?? 'copy';
};

/**
 * ファイルのレイヤ（流れの段）を最長経路で決める。最終アウトプットは必ず最右へ寄せる。
 * 全体フロー図の配置と、レポート 02 のセグメント分割（取込 ▶ 集計 ▶ 最終アウトプット）で共用する。
 */
export function computeFileLayers(
  fileLabels: string[], filePairs: FilePair[], outputs: Set<string>,
): Map<string, number> {
  const layer = new Map<string, number>(fileLabels.map(l => [l, 0]));
  const cap = Math.min(fileLabels.length + 2, 8);
  for (let pass = 0; pass < cap; pass++) {
    let changed = false;
    for (const p of filePairs) {
      const lf = layer.get(p.from); const lt = layer.get(p.to);
      if (lf === undefined || lt === undefined) continue;
      if (lt < lf + 1 && lf + 1 < cap) { layer.set(p.to, lf + 1); changed = true; }
    }
    if (!changed) break;
  }
  const maxNonOut = Math.max(0, ...fileLabels.filter(l => !outputs.has(l)).map(l => layer.get(l) ?? 0));
  const outLayer = outputs.size > 0 ? maxNonOut + 1 : maxNonOut;
  for (const l of fileLabels) if (outputs.has(l)) layer.set(l, outLayer);
  return layer;
}

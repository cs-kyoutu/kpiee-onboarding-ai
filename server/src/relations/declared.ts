// 担当者が確定した「ブック（ファイル）どうしの関係」を、自動解析済みの関係グラフへ重ねる層。
//
// なぜ必要か:
//   ファイル間の関係のうち、外部通合文書参照（`[1]Sheet!A1`）で書かれたものは数式から確定できる
//   （relations.ts が解決する）。しかし参照先ファイルが未受領のとき、リンクが切れているとき、
//   ピボットや人手の転記のときは自動検出できず、「値の一致による手修正推定」（confidence 0.55）
//   だけが残る。正しい推定もノイズも同じ確度で並ぶので、確認したい論点が埋もれる。
//   逆に、担当者が知っているつながりは自動検出できないと図から消え、論点そのものが失われる。
//   そこで「人が知っている関係」を入力として受け取り、推定の確度を上下させる。
//
// 設計の要点:
//   - 数式由来の辺は絶対に変更しない。数式は事実であり、宣言で上書きしてよいものではない。
//     補正の対象は「ファイルを跨ぐ手修正推定(copy)」だけ。
//   - 純粋関数として書き、関係グラフのキャッシュ（relationsCache.ts）の外で毎回合成する。
//     宣言の編集はキャッシュを無効化しない＝CPU 重量級の再解析を伴わない。
import type { RelationGraph, Region, Edge, RelationWarning } from '../preprocess/relations.js';
import {
  aggregatePairs, aggregateFilePairs, dominantFileGroup, filePairKey, regionIdOf,
  type FilePair, type Group,
} from './fileGraph.js';

export type FileRelType = 'aggregate' | 'reference' | 'transcribe' | 'manual_copy' | 'unknown';

export const FILE_REL_LABELS: Record<FileRelType, string> = {
  aggregate: '集計',
  reference: '参照・マスタ引き当て',
  transcribe: '転記',
  manual_copy: '手作業コピー',
  unknown: '種別未設定',
};

export const FILE_REL_TYPES = Object.keys(FILE_REL_LABELS) as FileRelType[];

/** 確定済みのブック関係。fromFile / toFile は region.file と同じラベル（拡張子なし） */
export interface DeclaredFileRel {
  id: number;
  fromFile: string;
  toFile: string;
  relType: FileRelType;
  note: string;
  origin: 'auto' | 'manual';
  /**
   * うかがった作成手順のステップ番号（1〜）。手順書がある案件で入る。
   * これが入っていると、02 の全体関係図を「ステップの帯」に組み替えて描ける
   * （どのファイルが何番目の作業で入ってくるのかが、図だけで追えるようになる）。
   */
  step?: number;
  /** そのステップの見出し（例: エリア人件費の計算）。同じ step には同じ文字列を入れる */
  stepTitle?: string;
  /** そのステップで受け側へ足される項目（例: 部門コード・管理料）。帯の図に書き込む */
  adds?: string;
}

/** 自動検出されたが未登録のファイル対（画面に初期案として出す） */
export interface ProposedFileRel {
  fromFile: string;
  toFile: string;
  relType: FileRelType;
  total: number;
  reason: string;
}

/**
 * 宣言と自動検出の突き合わせ結果。
 *   matched                … 宣言があり、同じ向きの関係も検出できた
 *   declared_not_detected  … 宣言はあるが自動検出できなかった（外部リンク・ピボット・手作業の疑い）
 *   detected_not_declared  … 検出したが宣言がない（担当者も把握していない経路の可能性）
 *   direction_conflict     … 宣言と検出で向きが逆
 */
export type AuditVerdict = 'matched' | 'declared_not_detected' | 'detected_not_declared' | 'direction_conflict';

export interface FileRelAudit {
  fromFile: string;
  toFile: string;
  verdict: AuditVerdict;
  relType?: FileRelType;
  note?: string;
  detectedTotal: number;
}

/** 自動検出の代表分類から、ブック関係の種別を当てる（初期案の既定値） */
export function groupToRelType(g: Group): FileRelType {
  switch (g) {
    case 'agg': return 'aggregate';
    case 'ref': return 'reference';
    case 'move': return 'transcribe';
    case 'copy': return 'manual_copy';
  }
}

/** 関係グラフからファイル対を取り出す（宣言の初期案・突き合わせの共通の下ごしらえ） */
function detectedFilePairs(graph: RelationGraph): FilePair[] {
  const regions = graph.regions ?? [];
  const edges = (graph.edges ?? []) as Edge[];
  return aggregateFilePairs(regions, aggregatePairs(edges));
}

/**
 * 自動検出されたファイル対のうち、まだ登録されていないものを初期案として返す。
 * 逆向きの登録がある対は初期案に出さない（「両方向を確定させる」誘導になってしまうため）。
 * それらは突き合わせで direction_conflict として表に出る。
 */
export function proposeFileRelations(graph: RelationGraph, declared: DeclaredFileRel[]): ProposedFileRel[] {
  const known = new Set<string>();
  for (const d of declared) {
    known.add(filePairKey(d.fromFile, d.toFile));
    known.add(filePairKey(d.toFile, d.fromFile));
  }
  return detectedFilePairs(graph)
    .filter(p => !known.has(filePairKey(p.from, p.to)))
    .map(p => {
      const g = dominantFileGroup(p);
      return {
        fromFile: p.from,
        toFile: p.to,
        relType: groupToRelType(g),
        total: p.total,
        reason: g === 'copy'
          ? `値の一致から手修正と推定（${p.total} 件）`
          : `数式から検出（${p.total} 件）`,
      };
    })
    .sort((a, b) => b.total - a.total);
}

/** 宣言と自動検出を突き合わせる */
export function auditFileRelations(graph: RelationGraph, declared: DeclaredFileRel[]): FileRelAudit[] {
  const detected = new Map(detectedFilePairs(graph).map(p => [filePairKey(p.from, p.to), p]));
  const out: FileRelAudit[] = [];
  const consumed = new Set<string>();

  for (const d of declared) {
    const fwd = detected.get(filePairKey(d.fromFile, d.toFile));
    const rev = detected.get(filePairKey(d.toFile, d.fromFile));
    if (fwd) {
      // 逆向きも検出されていたら、それも同じ宣言で説明がつく（値の一致から向きは決められない）。
      // ここで消さないと、同じ2ファイルの話が「一致」と「未宣言」の2件に分かれて並ぶ。
      consumed.add(filePairKey(d.fromFile, d.toFile));
      consumed.add(filePairKey(d.toFile, d.fromFile));
      out.push({ fromFile: d.fromFile, toFile: d.toFile, verdict: 'matched', relType: d.relType, note: d.note, detectedTotal: fwd.total });
    } else if (rev) {
      consumed.add(filePairKey(d.toFile, d.fromFile));
      out.push({ fromFile: d.fromFile, toFile: d.toFile, verdict: 'direction_conflict', relType: d.relType, note: d.note, detectedTotal: rev.total });
    } else {
      out.push({ fromFile: d.fromFile, toFile: d.toFile, verdict: 'declared_not_detected', relType: d.relType, note: d.note, detectedTotal: 0 });
    }
  }

  // 宣言が1件も無いプロジェクトで「未宣言」を全件並べても意味が無いので、
  // 何らかの宣言がある場合だけ「検出したが未宣言」を論点として出す。
  if (declared.length > 0) {
    for (const [k, p] of detected) {
      if (consumed.has(k)) continue;
      out.push({ fromFile: p.from, toFile: p.to, verdict: 'detected_not_declared', detectedTotal: p.total });
    }
  }
  return out;
}

export interface DeclaredOverlay {
  declaredFileRels: DeclaredFileRel[];
  fileRelAudit: FileRelAudit[];
}

/** 補正後の上限。数式由来（0.95）を超えないようにして、推定が事実を追い越さないようにする */
const DECLARED_BOOST_CAP = 0.95;
const DECLARED_BOOST = 0.3;
/** 未宣言のファイル間手修正に掛ける減衰（0.55 → 約0.30、確度ラベルが「中」から「低」へ落ちる） */
const UNDECLARED_DAMP = 0.55;

/**
 * 確定済みブック関係をグラフへ重ね、ファイルを跨ぐ手修正推定の確信度を補正する。
 * 元のグラフは変更せず、辺だけ新しい配列を作って返す（キャッシュ済みオブジェクトを汚さない）。
 */
export function applyDeclaredFileRelations(
  graph: RelationGraph, declared: DeclaredFileRel[],
): RelationGraph & DeclaredOverlay {
  const regions = graph.regions ?? [];
  const fileOfRegion = new Map<string, string>(regions.map((r: Region) => [r.id, r.file]));

  const forward = new Set<string>();
  const byPair = new Map<string, DeclaredFileRel>();
  for (const d of declared) {
    forward.add(filePairKey(d.fromFile, d.toFile));
    byPair.set(filePairKey(d.fromFile, d.toFile), d);
  }

  // 登録が1件も無いプロジェクトでは減衰させない。
  // 「登録がない」が意味を持つのは、担当者が少なくとも一部を登録した後だけ。
  // 未登録=減衰を無条件に適用すると、この機能を使っていない案件の確度が理由なく下がってしまう。
  const damping = declared.length > 0;

  const edges = ((graph.edges ?? []) as Edge[]).map(e => {
    // 数式由来の辺は事実なので触らない。宣言はあくまで「推定の確度」を動かすだけ。
    if (e.type !== 'copy') return e;
    const from = fileOfRegion.get(regionIdOf(e.from));
    const to = fileOfRegion.get(regionIdOf(e.to));
    if (!from || !to || from === to) return e; // 同一ファイル内のコピーは宣言の対象外
    const conf = e.confidence ?? 0;

    if (forward.has(filePairKey(from, to))) {
      const d = byPair.get(filePairKey(from, to))!;
      return {
        ...e,
        confidence: Math.min(DECLARED_BOOST_CAP, conf + DECLARED_BOOST),
        needsConfirmation: false,
        evidence: `${e.evidence}／ブック関係の登録「${from} → ${to}（${FILE_REL_LABELS[d.relType]}）」と一致`,
      };
    }
    if (forward.has(filePairKey(to, from))) {
      // 登録は逆向き。どちらが正かは人にしか決められないので、確度は動かさず確認対象にする
      return { ...e, needsConfirmation: true, conflictsDeclared: true };
    }
    if (!damping) return e;
    return {
      ...e,
      confidence: conf * UNDECLARED_DAMP,
      needsConfirmation: true,
      evidence: `${e.evidence}／ブック関係の登録なし`,
    };
  });

  const fileRelAudit = auditFileRelations(graph, declared);

  // 「登録したのに検出できない」「向きが逆」は運用担当者が真っ先に見るべき論点なので、
  // レポートの質問だけでなく ⚠要確認 タブにも出す。
  // ref の形式は AttentionPanel の parse（`ファイル／シート#n`）に合わせる。
  const warnings: RelationWarning[] = [...(graph.warnings ?? [])];
  for (const a of fileRelAudit) {
    if (a.verdict === 'declared_not_detected') {
      warnings.push({
        kind: 'declared_not_detected',
        ref: `${a.fromFile}／（ブック関係）#1`,
        message: `登録された「${a.fromFile} → ${a.toFile}」のつながりを自動検出できませんでした（外部リンク・ピボット・手作業の可能性）`,
      });
    } else if (a.verdict === 'direction_conflict') {
      warnings.push({
        kind: 'declared_direction_conflict',
        ref: `${a.fromFile}／（ブック関係）#1`,
        message: `登録は「${a.fromFile} → ${a.toFile}」ですが、検出した値の流れは逆向き（${a.toFile} → ${a.fromFile}、${a.detectedTotal} 件）です`,
      });
    }
  }

  return { ...graph, edges, warnings, declaredFileRels: declared, fileRelAudit };
}

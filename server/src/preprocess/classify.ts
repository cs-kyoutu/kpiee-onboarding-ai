// シート役割の自動分類器。
// 1つのワークブックに raw / 中間 / 帳票 が混在しているケースに対応するため、
// シート間の数式参照グラフから各シートの役割を推定する。
//
// 判定原理（参照の向きが役割を語る）:
//   - 他シートから参照されるが、自分はどこも参照しない → input_data（raw、出発点）
//   - 他シートを参照し、かつ他シートからも参照される   → working_sheet（中間、経由点）
//   - 他シートを参照するが、誰からも参照されない       → final_output（帳票、終着点）
//   - どこも参照せず誰からも参照されない:
//       数式あり → working_sheet（独立した作業シート）
//       数式なし → unknown（値貼り付け or 手入力。人の確認が必要）
import type { ParsedArtifact, ParsedSheet } from './parse.js';

// master_data（マスタ）は自動判定しない。参照専用の分類表・コード表は「他シートから参照される
// 出発点」なので構造だけでは input_data と区別できず、どちらであるかは業務知識でしか決まらない。
// 取込後の分類確認で人が指定する枠として持ち、パイプライン上は入力データと同じ扱いにする。
export type SheetRole = 'input_data' | 'master_data' | 'working_sheet' | 'final_output' | 'unknown';

/** 分類確認 UI・レポートで使う表示名。役割の語彙を1か所に集める */
export const SHEET_ROLE_LABELS: Record<SheetRole, string> = {
  input_data: 'インプット（raw）',
  master_data: 'マスタ（分類表）',
  working_sheet: '中間シート',
  final_output: '最終アウトプット',
  unknown: '判定不能',
};

/** システム出力(raw)と見なす行数の下限。これ以下の「数式なしシート」は値貼り付け・手入力の
 *  可能性が残るので従来どおり unknown（人の確認）に回す。ここで閾値を切る意味がそれ。 */
const SYSTEM_EXPORT_MIN_ROWS = 1000;
/** 「全行に値が入っている列」と見なす充填率。ヘッダー付きの表なら主要列はほぼ全行埋まる */
const DENSE_COLUMN_RATIO = 0.9;
/** 上記の密な列が最低いくつあれば「表形式」と見なすか */
const MIN_DENSE_COLUMNS = 2;
/** 列統計が無い経路（xlsx/CSV）での代替判定: 行の幅が最大幅のこの割合以上なら「揃っている」 */
const WIDTH_TOLERANCE = 0.7;
const UNIFORM_ROW_RATIO = 0.8;

/**
 * 「数式が1つも無く、大量の行が均一な表形式で並ぶ」＝基幹システム出力（raw）と判定できるか。
 * 行を絞ったシート（truncated）でも判定できるよう、行数は sheet.rowCount（＝実際の総行数。
 * 絞っても総計を保つ）を見る。
 *
 * 均一性は列統計があればそれで見る（Drive ストリーミング経路。全行から算出済みなので最も確か）。
 * 無い経路では保持行の幅分布で見るが、空セルは詰められて幅が揺れるため「最大幅の一定割合以上」
 * という緩い基準にする（幅の完全一致で判定すると実データでほぼ通らない）。
 */
function isSystemExportSheet(sheet: ParsedSheet): boolean {
  if (sheet.formulaCellCount > 0) return false;
  if (sheet.rowCount < SYSTEM_EXPORT_MIN_ROWS) return false;
  if (sheet.columnCount < 2) return false;

  if (sheet.columnStats && sheet.columnStats.length > 0) {
    const dense = sheet.columnStats.filter(c => c.filled >= sheet.rowCount * DENSE_COLUMN_RATIO).length;
    return dense >= MIN_DENSE_COLUMNS;
  }

  const body = sheet.rows.filter(r => r.rowNumber > 1); // ヘッダー行を除く
  if (body.length < 2) return false;
  const maxWidth = Math.max(...body.map(r => r.cells.length));
  if (maxWidth < 2) return false;
  const aligned = body.filter(r => r.cells.length >= maxWidth * WIDTH_TOLERANCE).length;
  return aligned / body.length >= UNIFORM_ROW_RATIO;
}

export interface SheetClassification {
  role: SheetRole;
  /** 検収者向けの判定理由（日本語） */
  reason: string;
  /** このシートの数式が参照しているシート名 */
  references: string[];
}

/** 数式文字列からシート参照（`シート名!` / `'シート名'!`）を抽出する */
export function extractSheetRefs(formula: string, knownSheets: Set<string>): string[] {
  const refs = new Set<string>();
  // 引用付き（'集計 2024'!A1）と引用なし（集計!A1）の両形式に対応
  const re = /'([^']+)'!|([A-Za-z0-9_À-鿿぀-ヿ＀-￯]+)!/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(formula)) !== null) {
    const name = m[1] ?? m[2];
    if (knownSheets.has(name)) refs.add(name);
  }
  return [...refs];
}

/**
 * ワークブック内の全シートの役割を推定する。
 * @returns シート名 → 分類結果
 */
export function classifySheetRoles(parsed: ParsedArtifact): Record<string, SheetClassification> {
  const sheetNames = new Set(parsed.sheets.map(s => s.name));

  // 参照グラフ構築: refs[シート] = そのシートの数式が参照する他シート集合
  const refs = new Map<string, Set<string>>();
  for (const sheet of parsed.sheets) {
    const out = new Set<string>();
    for (const row of sheet.rows) {
      for (const cell of row.cells) {
        if (!cell.formula) continue;
        for (const r of extractSheetRefs(cell.formula, sheetNames)) {
          if (r !== sheet.name) out.add(r);
        }
      }
    }
    refs.set(sheet.name, out);
  }

  // 被参照集合: referencedBy[シート] = そのシートを参照しているシート集合
  const referencedBy = new Map<string, Set<string>>();
  for (const name of sheetNames) referencedBy.set(name, new Set());
  for (const [from, targets] of refs) {
    for (const to of targets) referencedBy.get(to)!.add(from);
  }

  const result: Record<string, SheetClassification> = {};
  for (const sheet of parsed.sheets) {
    const out = refs.get(sheet.name)!;
    const inbound = referencedBy.get(sheet.name)!;
    const referencesOthers = out.size > 0;
    const isReferenced = inbound.size > 0;

    let role: SheetRole;
    let reason: string;
    if (!referencesOthers && isReferenced) {
      role = 'input_data';
      reason = `${[...inbound].join('・')} から参照される出発点（自身はどこも参照しない）→ raw データと推定`;
    } else if (referencesOthers && isReferenced) {
      role = 'working_sheet';
      reason = `${[...out].join('・')} を参照しつつ ${[...inbound].join('・')} から参照される経由点 → 中間シートと推定`;
    } else if (referencesOthers && !isReferenced) {
      role = 'final_output';
      reason = `${[...out].join('・')} を参照するが誰からも参照されない終着点 → 帳票と推定`;
    } else if (sheet.formulaCellCount > 0) {
      role = 'working_sheet';
      reason = '他シートとの参照関係はないが数式を含む → 独立した作業シートと推定';
    } else if (isSystemExportSheet(sheet)) {
      // CSV 特例（下記）と同じ論理。数式が1つも無く、大量の行が均一な表形式で並ぶシートは
      // 人が値を貼ったものではなく基幹システムの出力（raw）と見るのが実務上ほぼ確実。
      // これを unknown にすると SQL の FROM 対象にもテーブル定義書にも載らず、
      // 必須のインプットデータが毎回手動指定待ちになる。
      role = 'input_data';
      reason = `数式が無く ${sheet.rowCount.toLocaleString()} 行 × ${sheet.columnCount} 列の均一な表形式`
        + ` → 基幹システム出力（インプットデータ）と推定`;
    } else {
      role = 'unknown';
      reason = '数式がなく参照関係もないため自動判定不能（値貼り付け・手入力の可能性）。役割を手動で指定してください';
    }
    result[sheet.name] = { role, reason, references: [...out] };
  }

  // CSV は単一シートかつ数式を持たないため、グラフでは unknown になる。
  // 実務上 CSV は基幹システム出力（インプット）であることがほとんどなので既定を input_data にする
  if (parsed.fileType === 'csv') {
    for (const key of Object.keys(result)) {
      result[key] = {
        role: 'input_data',
        reason: 'CSV ファイルのため基幹システム出力（インプットデータ）と推定',
        references: [],
      };
    }
  }

  return result;
}

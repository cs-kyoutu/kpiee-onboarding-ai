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
import type { ParsedArtifact } from './parse.js';

export type SheetRole = 'input_data' | 'working_sheet' | 'final_output' | 'unknown';

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

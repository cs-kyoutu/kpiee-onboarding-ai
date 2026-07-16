// モック AI 実装。
// ANTHROPIC_API_KEY 未設定のローカル環境でも、アップロード→解読→検収→生成→照合→
// パッケージングの全フローを動作確認できるようにするための決定的（deterministic）実装。
// 実運用では client.ts の Claude 呼び出しが使われる。
import type { ParsedArtifact, ParsedSheet } from '../preprocess/parse.js';
import type { Finding, GenerationResult, StructureOverview, SheetComposition, TableDefinition } from './schemas.js';

/** 数式文字列からロジック種別を推定する単純なヒューリスティック */
function classifyFormula(formula: string): Finding['logic_type'] {
  const f = formula.toUpperCase();
  if (/VLOOKUP|XLOOKUP|HLOOKUP|INDEX\s*\(.*MATCH/.test(f)) return 'join';
  if (/SUMIF|SUMIFS|COUNTIF|COUNTIFS|SUMPRODUCT|SUM\(|AVERAGE|SUBTOTAL|PIVOT/.test(f)) return 'aggregate';
  if (/IF\(|FILTER\(/.test(f)) return 'filter';
  if (/[+\-*/^]/.test(f)) return 'arithmetic';
  return 'unknown';
}

function targetFor(logicType: Finding['logic_type']): Finding['kpiee_target'] {
  switch (logicType) {
    case 'join': return 'sql_job';
    case 'aggregate': return 'sql_job';
    case 'filter': return 'sql_job';
    case 'arithmetic': return 'report_metric';
    case 'manual_input': return 'needs_customer_confirmation';
    default: return 'needs_customer_confirmation';
  }
}

function explanationFor(logicType: Finding['logic_type'], formula: string, ref: string): string {
  switch (logicType) {
    case 'join': return `${ref} は参照系数式（${formula.slice(0, 60)}）による横結合。データコネクタの横結合または SQLジョブの JOIN で再現`;
    case 'aggregate': return `${ref} は集計数式（${formula.slice(0, 60)}）。SQLジョブの GROUP BY 集計で再現`;
    case 'filter': return `${ref} は条件分岐/絞り込み（${formula.slice(0, 60)}）。SQLジョブの WHERE / CASE で再現`;
    case 'arithmetic': return `${ref} は四則演算（${formula.slice(0, 60)}）。レポートのカスタム指標数式で再現`;
    default: return `${ref} の数式（${formula.slice(0, 60)}）は自動分類できず。顧客確認を推奨`;
  }
}

/** P1 解読のモック: 中間シートの数式セルから解読項目を機械的に抽出する */
export function mockDecode(workingSheets: ParsedArtifact[]): Finding[] {
  const findings: Finding[] = [];
  let seq = 1;
  // 同一数式パターン（行番号を除去した署名）ごとに1項目へまとめる
  const seen = new Set<string>();

  for (const artifact of workingSheets) {
    for (const sheet of artifact.sheets) {
      for (const row of sheet.rows) {
        for (const cell of row.cells) {
          if (!cell.formula) continue;
          const pattern = `${sheet.name}|${cell.ref.replace(/\d+/g, '')}|${cell.formula.replace(/\d+/g, 'N')}`;
          if (seen.has(pattern)) continue;
          seen.add(pattern);

          const logicType = classifyFormula(cell.formula);
          const rangeNote = row.compressedRange
            ? `${sheet.name}!${cell.ref.replace(/\d+/g, '')}${row.compressedRange.from}:${cell.ref.replace(/\d+/g, '')}${row.compressedRange.to}`
            : `${sheet.name}!${cell.ref}`;
          findings.push({
            id: `F${String(seq++).padStart(3, '0')}`,
            source_ref: rangeNote,
            formula_raw: `=${cell.formula}`,
            logic_type: logicType,
            kpiee_target: targetFor(logicType),
            explanation: explanationFor(logicType, cell.formula, rangeNote),
            confidence: logicType === 'unknown' ? 'low' : 'medium',
          });
        }
      }
      // 数式ゼロのシートは値貼り付け（手入力）の可能性として1項目挙げる
      if (sheet.formulaCellCount === 0 && sheet.rows.length > 0) {
        findings.push({
          id: `F${String(seq++).padStart(3, '0')}`,
          source_ref: `${sheet.name}!A1:${sheet.rows[0]?.cells.at(-1)?.ref ?? 'A1'}`,
          logic_type: 'manual_input',
          kpiee_target: 'needs_customer_confirmation',
          explanation: `シート「${sheet.name}」に数式が存在しないため、値貼り付けまたは手入力の可能性。ロジックの出所を顧客に確認要`,
          confidence: 'low',
        });
      }
    }
  }
  return findings;
}

/**
 * シート1枚からテーブル定義書を機械生成する（モック用）。
 * ヘッダー行を列定義とみなし、2行目のセルから型と出所（手入力/数式）を推定する。
 */
function mockTableDef(title: string, appliesTo: string[], sheet: ParsedSheet | undefined): TableDefinition | null {
  if (!sheet) return null;
  const headerCells = sheet.rows[0]?.cells ?? [];
  const colOf = (ref: string) => ref.replace(/\d+/g, '');
  const dataByCol = new Map((sheet.rows[1]?.cells ?? []).map(c => [colOf(c.ref), c]));
  const columns = headerCells.slice(0, 12).map(c => {
    const col = colOf(c.ref);
    const d = dataByCol.get(col);
    return {
      position: `${col}列`,
      item: String(c.value ?? `${col}列`),
      type: typeof d?.value === 'number' ? '数値' : '文字列',
      definition: d?.formula ? `数式 =${d.formula.slice(0, 60)}` : '手入力または値貼り付け（自動推定）',
    };
  });
  if (columns.length === 0) return null;
  return { title, applies_to: appliesTo, columns, calc_rows: [] };
}

/**
 * 全体構造サマリのモック生成。
 * AI 不在でも UI を確認できるよう、役割別コレクションから機械的に
 * 「シート構成（どのシートからどう作られるか）＋テーブル定義書」を組み立てる。
 */
export function mockOverview(collections: {
  inputs: { tableName: string; parsed: ParsedArtifact }[];
  working: ParsedArtifact[];
  finalOutput: ParsedArtifact | null;
}): StructureOverview {
  const inputNames = collections.inputs.map(i => i.tableName);
  const workingNames = collections.working.flatMap(w => w.sheets.map(s => s.name));
  const outName = collections.finalOutput?.sheets[0]?.name;

  const sheet_composition: SheetComposition[] = [
    ...inputNames.map(name => ({
      sheet: name,
      role: '入力' as const,
      composed_of: [],
      method: '手入力・取込データ',
      description: '集計・引き当ての出発点になるインプットデータです。',
    })),
    ...workingNames.map(name => ({
      sheet: name,
      role: '中間集計' as const,
      composed_of: inputNames,
      method: '集計・計算（数式構成からの自動推定）',
      description: '入力データを集計・計算・引き当てして整える中間シートです。',
    })),
    ...(outName ? [{
      sheet: outName,
      role: '最終出力' as const,
      composed_of: workingNames.length ? workingNames : inputNames,
      method: '加工結果の転記・合算（自動推定）',
      description: '加工結果をまとめた最終帳票です。',
    }] : []),
  ];

  const table_definitions = [
    mockTableDef('入力データ', inputNames, collections.inputs[0]?.parsed.sheets[0]),
    mockTableDef('中間シート（共通レイアウト）', workingNames, collections.working[0]?.sheets[0]),
    ...(outName ? [mockTableDef('最終帳票', [outName], collections.finalOutput?.sheets[0])] : []),
  ].filter((d): d is TableDefinition => d !== null);

  return {
    summary: `${inputNames.length} 種類の入力データを、${workingNames.length || 1} 段階の加工を経て${outName ? `「${outName}」という帳票` : 'レポート'}として出力する構成です。（自動推定の概要）`,
    sheet_composition,
    table_definitions,
    caveats: ['この概要は数式・シート構成からの自動推定です。AI解読（②）を実行すると、より正確な定義書に置き換わります。'],
  };
}

/** ヘッダー行とデータ行を取り出すユーティリティ */
function headerAndData(sheet: ParsedSheet): { header: string[]; data: (string | number | null)[][] } {
  const header = (sheet.rows[0]?.cells ?? []).map(c => String(c.value ?? ''));
  const data = sheet.rows.slice(1).map(r => {
    // セル参照から列位置を割り出して欠損列を null 埋めする
    const arr: (string | number | null)[] = new Array(header.length).fill(null);
    for (const c of r.cells) {
      const colIdx = colIndex(c.ref);
      if (colIdx < header.length) arr[colIdx] = c.value;
    }
    return arr;
  });
  return { header, data };
}

function colIndex(ref: string): number {
  const letters = ref.replace(/\d+/g, '');
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * P2 生成のモック: 最初のインプットデータを対象に、
 * 先頭の文字列列を軸、数値列を SUM 指標とする集計 SQL を組み立てる。
 */
export function mockGenerate(
  inputArtifacts: { tableName: string; parsed: ParsedArtifact }[],
  feedbackErrors?: string[],
): GenerationResult {
  const first = inputArtifacts[0];
  if (!first) throw new Error('インプットデータがありません');
  const sheet = first.parsed.sheets[0];
  const { header, data } = headerAndData(sheet);

  // 列型推定: データ行の過半が数値なら数値列とみなす
  const numericCols: string[] = [];
  let groupCol = header[0] ?? 'col1';
  for (let i = 0; i < header.length; i++) {
    const values = data.map(r => r[i]).filter(v => v !== null && v !== '');
    const numCount = values.filter(v => typeof v === 'number').length;
    if (values.length > 0 && numCount > values.length / 2) numericCols.push(header[i]);
    else if (numericCols.length === 0) groupCol = header[i];
  }

  const sumExprs = numericCols.map(c => `  SUM("${c}") AS "${c}"`).join(',\n');
  const sql = `SELECT\n  "${groupCol}",\n${sumExprs}\nFROM ${first.tableName}\nGROUP BY "${groupCol}"\nORDER BY "${groupCol}"`;

  // 軸マスタ: グループ列の distinct 値
  const distinct = [...new Set(data.map(r => String(r[colNameIndex(header, groupCol)] ?? '')))].filter(v => v !== '');
  const masterCsv = [`${groupCol}_code,${groupCol}_name`, ...distinct.map((v, i) => `${i + 1},${v}`)].join('\n');

  return {
    sql,
    sql_explanation: feedbackErrors?.length
      ? `検証エラー（${feedbackErrors.join(' / ')}）を考慮して再生成した集計 SQL（モック）`
      : `${first.tableName} を「${groupCol}」で集計し数値列を合算する SQL（モック生成）`,
    master_csv: masterCsv,
    report_config: {
      report_name: '月次実績レポート（自動生成）',
      x_axis: { type: 'master', label: groupCol },
      y_axis: [{ type: 'master', label: groupCol }],
      metrics: numericCols.map(c => ({ name: c, source_column: c, aggregation: 'sum' })),
      value_filters: [],
    },
    // モックは findings と紐付かないため空。マッピング表の該当列は「—」表示になる
    finding_outputs: [],
  };
}

function colNameIndex(header: string[], name: string): number {
  const i = header.indexOf(name);
  return i >= 0 ? i : 0;
}

/** P4 不一致原因分類のモック: 値の差分から機械的に分類する */
export function mockClassifyCause(expected: number, actual: number | null): { cause_category: string; explanation: string } {
  if (actual === null) {
    return { cause_category: 'logic_missing', explanation: '生成構成の出力に対応する値が存在しない。ロジック未再現の可能性' };
  }
  const diff = Math.abs(expected - actual);
  if (diff < 1) {
    return { cause_category: 'rounding', explanation: '差分が 1 未満のため丸め誤差の可能性が高い' };
  }
  return { cause_category: 'manual_input', explanation: '差分が大きい。帳票側の手修正または未解読ロジックの可能性' };
}

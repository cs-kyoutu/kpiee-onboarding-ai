// オンボーディング整理ドキュメント生成。
// パッケージに「①ファイル別シート一覧 ②テーブル定義書 ③手入力・要確認リスト」を
// 読みやすくまとめた資料を同梱する。AI 呼び出しは行わず、保存済みの解読結果
// （project_overviews / findings）とアーティファクトから決定的に組み立てる。
// 出力は Word(.docx) と Markdown の 2 形式（Word はそのまま配布・編集用、md はどこでも読める）。
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  Table, TableRow, TableCell, WidthType, BorderStyle,
} from 'docx';
import { db } from './db.js';
import { collectByRole } from './pipeline/orchestrator.js';
import type { StructureOverview, TableDefinition } from './ai/schemas.js';

const ROLE_LABEL: Record<string, string> = {
  input_data: 'インプット（raw）',
  working_sheet: '中間シート',
  final_output: '最終帳票',
  unknown: '⚠ 判定不能（要確認）',
  mixed: '混在',
};

interface FileSheets { filename: string; sheets: { name: string; role: string; rowCount: number; hasFormula: boolean }[] }
// source_ref（"シート名!セル範囲"）を ファイル / シート / 列 に分解して保持する
interface ConfirmItem { file: string; sheet: string; columns: string; cell: string; kind: string; detail: string; confidence?: string }

/** "シート名!A1:C1" を { sheet, cell, columns } に分解する。列は "D列" / "A〜C列" の形にする */
function parseRef(ref: string, sheetToFile: Map<string, string>): { file: string; sheet: string; cell: string; columns: string } {
  const bang = ref.indexOf('!');
  if (bang < 0) return { file: '', sheet: '', cell: ref, columns: ref }; // "!" が無い形はそのまま列欄へ
  const sheet = ref.slice(0, bang).replace(/^'|'$/g, '');
  const cell = ref.slice(bang + 1);
  const letters = cell.match(/[A-Za-z]+/g) ?? [];
  const first = letters[0]?.toUpperCase();
  const last = letters[letters.length - 1]?.toUpperCase();
  const columns = !first ? cell : first === last ? `${first}列` : `${first}〜${last}列`;
  return { file: sheetToFile.get(sheet) ?? '', sheet, cell, columns };
}

export interface SummaryData {
  customerName: string;
  version: number;
  generatedAt: string;
  files: FileSheets[];
  overview?: StructureOverview;
  tableDefs: TableDefinition[];
  confirmItems: ConfirmItem[];
  caveats: string[];
}

/** パッケージ資料の材料を保存済みデータから集める（AI 呼び出しなし） */
export async function gatherSummary(projectId: number): Promise<SummaryData> {
  const project = await db.prepare(`SELECT customer_name FROM projects WHERE id = ?`).get(projectId) as { customer_name: string } | undefined;
  const latest = await db.prepare(`SELECT COALESCE(MAX(version), 0) AS v FROM deliverables WHERE project_id = ?`).get(projectId) as { v: number };

  // ① ファイル別シート一覧（役割つき）
  const collections = await collectByRole(projectId);
  const files: FileSheets[] = collections.artifacts.map(a => ({
    filename: a.row.original_filename,
    sheets: a.parsed.sheets.map(s => ({
      name: s.name,
      role: ROLE_LABEL[a.roles[s.name] ?? a.row.kind] ?? (a.roles[s.name] ?? a.row.kind),
      rowCount: s.rowCount,
      hasFormula: s.formulaCellCount > 0,
    })),
  }));

  // ② テーブル定義書・概要（解読時に保存した overview から）
  const ovRow = await db.prepare(`SELECT content FROM project_overviews WHERE project_id = ?`).get(projectId) as { content: string } | undefined;
  const overview: StructureOverview | undefined = ovRow ? JSON.parse(ovRow.content) : undefined;

  // ③ 手入力・要確認リスト（needs_customer_confirmation / manual_input の findings ＋ overview.caveats）
  const findings = await db.prepare(
    `SELECT source_ref, logic_type, kpiee_target, explanation, confidence
       FROM findings
      WHERE project_id = ? AND (kpiee_target = 'needs_customer_confirmation' OR logic_type = 'manual_input')
      ORDER BY id`,
  ).all(projectId) as { source_ref: string; logic_type: string; kpiee_target: string; explanation: string; confidence: string }[];
  // シート名 → ファイル名の対応表（要確認項目の出所ファイルを引くため）
  const sheetToFile = new Map<string, string>();
  for (const f of files) for (const s of f.sheets) if (!sheetToFile.has(s.name)) sheetToFile.set(s.name, f.filename);

  const confirmItems: ConfirmItem[] = findings.map(f => {
    const { file, sheet, cell, columns } = parseRef(f.source_ref, sheetToFile);
    return {
      file, sheet, columns, cell,
      kind: f.logic_type === 'manual_input' ? '手入力の疑い' : f.kpiee_target === 'needs_customer_confirmation' ? '要顧客確認' : f.logic_type,
      detail: f.explanation,
      confidence: f.confidence,
    };
  });

  return {
    customerName: project?.customer_name ?? '—',
    version: latest.v,
    generatedAt: new Date().toISOString().slice(0, 10),
    files,
    overview,
    tableDefs: overview?.table_definitions ?? [],
    confirmItems,
    caveats: overview?.caveats ?? [],
  };
}

// ================= Markdown =================
export function buildSummaryMarkdown(d: SummaryData): string {
  const L: string[] = [];
  L.push(`# オンボーディング整理資料 — ${d.customerName}（v${d.version}）`, '', `作成日: ${d.generatedAt}`, '');
  if (d.overview?.summary) L.push('## 概要', '', d.overview.summary, '');

  L.push('## ① ファイル別 シート一覧', '');
  for (const f of d.files) {
    L.push(`### ${f.filename}`, '', '| シート | 役割 | 行数 | 数式 |', '|---|---|---|---|');
    for (const s of f.sheets) L.push(`| ${s.name} | ${s.role} | ${s.rowCount} | ${s.hasFormula ? 'あり' : 'なし'} |`);
    L.push('');
  }

  L.push('## ② テーブル定義書', '');
  if (d.tableDefs.length === 0) L.push('（テーブル定義はありません）', '');
  for (const t of d.tableDefs) {
    L.push(`### ${t.title}`, '', `適用シート: ${t.applies_to.join('・') || '—'}`, '');
    if (t.columns.length) {
      L.push('| 列位置 | 項目 | 型 | 定義・出所 |', '|---|---|---|---|');
      for (const c of t.columns) L.push(`| ${c.position} | ${c.item} | ${c.type} | ${c.definition.replace(/\|/g, '\\|')} |`);
      L.push('');
    }
    if (t.calc_rows.length) {
      L.push('計算行:', '', '| 行ラベル | 定義 |', '|---|---|');
      for (const r of t.calc_rows) L.push(`| ${r.label} | ${r.definition.replace(/\|/g, '\\|')} |`);
      L.push('');
    }
  }

  L.push('## ③ 手入力・要確認リスト', '');
  if (d.confirmItems.length === 0 && d.caveats.length === 0) L.push('（要確認項目はありません）', '');
  if (d.confirmItems.length) {
    L.push('| ファイル | シート | 列（セル） | 種別 | 内容 | 確信度 |', '|---|---|---|---|---|---|');
    for (const c of d.confirmItems) {
      const colCell = c.cell && c.columns !== c.cell ? `${c.columns}（${c.cell}）` : c.columns;
      L.push(`| ${c.file || '—'} | ${c.sheet || '—'} | ${colCell} | ${c.kind} | ${c.detail.replace(/\|/g, '\\|')} | ${c.confidence ?? ''} |`);
    }
    L.push('');
  }
  if (d.caveats.length) {
    L.push('注意事項:', '');
    for (const c of d.caveats) L.push(`- ${c}`);
    L.push('');
  }
  return L.join('\n');
}

// ================= Word (.docx) =================
const HEADER_FILL = 'E8EEF7';
const cellText = (text: string, opts?: { bold?: boolean; align?: 'left' | 'right' }) => new TableCell({
  children: [new Paragraph({ alignment: opts?.align === 'right' ? AlignmentType.RIGHT : AlignmentType.LEFT, children: [new TextRun({ text: text || '', bold: opts?.bold })] })],
  shading: opts?.bold ? { fill: HEADER_FILL } : undefined,
});

/** ヘッダ配列 + 行配列（各行はセル文字列配列）から表を作る。rightCols は右寄せにする列 index の集合 */
function makeTable(headers: string[], rows: string[][], rightCols: Set<number> = new Set()): Table {
  const border = { style: BorderStyle.SINGLE, size: 2, color: 'BBBBBB' };
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border },
    rows: [
      new TableRow({ tableHeader: true, children: headers.map(h => cellText(h, { bold: true })) }),
      ...rows.map(r => new TableRow({ children: r.map((c, i) => cellText(c, { align: rightCols.has(i) ? 'right' : 'left' })) })),
    ],
  });
}

const h = (text: string, level: (typeof HeadingLevel)[keyof typeof HeadingLevel]) => new Paragraph({ heading: level, children: [new TextRun({ text })], spacing: { before: 240, after: 120 } });
const p = (text: string) => new Paragraph({ children: [new TextRun({ text })], spacing: { after: 80 } });

export async function buildSummaryDocx(d: SummaryData): Promise<Buffer> {
  const body: (Paragraph | Table)[] = [];
  body.push(new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: `オンボーディング整理資料 — ${d.customerName}` })] }));
  body.push(p(`v${d.version} ／ 作成日: ${d.generatedAt}`));
  if (d.overview?.summary) { body.push(h('概要', HeadingLevel.HEADING_1)); body.push(p(d.overview.summary)); }

  // ① ファイル別シート一覧
  body.push(h('① ファイル別 シート一覧', HeadingLevel.HEADING_1));
  for (const f of d.files) {
    body.push(h(f.filename, HeadingLevel.HEADING_2));
    body.push(makeTable(
      ['シート', '役割', '行数', '数式'],
      f.sheets.map(s => [s.name, s.role, String(s.rowCount), s.hasFormula ? 'あり' : 'なし']),
      new Set([2]),
    ));
  }

  // ② テーブル定義書
  body.push(h('② テーブル定義書', HeadingLevel.HEADING_1));
  if (d.tableDefs.length === 0) body.push(p('（テーブル定義はありません）'));
  for (const t of d.tableDefs) {
    body.push(h(t.title, HeadingLevel.HEADING_2));
    body.push(p(`適用シート: ${t.applies_to.join('・') || '—'}`));
    if (t.columns.length) body.push(makeTable(['列位置', '項目', '型', '定義・出所'], t.columns.map(c => [c.position, c.item, c.type, c.definition])));
    if (t.calc_rows.length) { body.push(p('計算行:')); body.push(makeTable(['行ラベル', '定義'], t.calc_rows.map(r => [r.label, r.definition]))); }
  }

  // ③ 手入力・要確認リスト
  body.push(h('③ 手入力・要確認リスト', HeadingLevel.HEADING_1));
  if (d.confirmItems.length === 0 && d.caveats.length === 0) body.push(p('（要確認項目はありません）'));
  if (d.confirmItems.length) body.push(makeTable(
    ['ファイル', 'シート', '列（セル）', '種別', '内容', '確信度'],
    d.confirmItems.map(c => [c.file || '—', c.sheet || '—', c.cell && c.columns !== c.cell ? `${c.columns}（${c.cell}）` : c.columns, c.kind, c.detail, c.confidence ?? '']),
  ));
  if (d.caveats.length) {
    body.push(p('注意事項:'));
    for (const c of d.caveats) body.push(new Paragraph({ bullet: { level: 0 }, children: [new TextRun({ text: c })] }));
  }

  const doc = new Document({
    styles: { default: { document: { run: { font: 'Yu Gothic', size: 21 } } } }, // 10.5pt / 日本語フォント
    sections: [{ children: body }],
  });
  return Packer.toBuffer(doc);
}

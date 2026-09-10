// SQL構築チャット。構造分析レポートの読み合わせが終わった案件で、
// kpiee の SQLジョブ（Snowflake SELECT）を担当者との対話で組み立てる。
//
// 協和医科器械の構築をそのまま製品の中へ移す:
//   ナレッジ（kpiee-sql-builder スキル）の4ターン運用 — 復唱 → ロジックと質問 →
//   事前検証＋SQL＋検算 → 検算の突き合わせ — を AI が進行し、
//   検証クエリ・本体・検算を取込済みの実データ（DuckDB サンドボックス）で自分で流して
//   結果を見せる。協和で人が kpiee にコピペして往復していた部分が、その場で回る。
//
// コンテキスト戦略は Q&A（qa/agent.ts）と同じ:
//   常時入れるのは SKILL.md ＋ workflow.md ＋ 案件の前提だけ。
//   残り13本の references はチャットの read_reference 道具でオンデマンドに読ませる。
//
// ローカル実行の限界を偽らない:
//   本番は Snowflake、ここは DuckDB。ナレッジ必須関数はポリフィル（simulate.ts）で埋めるが、
//   物理カラム名（IMPORT_xxxxx）はローカルに存在しない。ローカル検証はローカルのテーブル名で行い、
//   納品 SQL への物理名の当てはめは、ユーザーが貼る Redash の結果（クエリ145/147）を根拠にする。
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { db } from './db.js';
import { aiAvailable, callStructured, callWithTools } from './ai/client.js';
import { COLUMN_MATCH_SCHEMA } from './ai/schemas.js';
import { collectByRole } from './pipeline/orchestrator.js';
import { SqlSandbox, tableHeaderOf } from './match/simulate.js';
import { scanQuery } from './validator/queryScanner.js';
import { docsBlock, listProjectDocs, type ProjectDoc } from './projectDocs.js';
import type { StructureOverview } from './ai/schemas.js';

const KNOWLEDGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../knowledge/kpiee-sql');

export interface SqlChatMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  tool_trace: string | null;
  created_at: string;
}

export interface SqlJob {
  id: number;
  name: string;
  sql: string;
  note: string;
  output_spec: string;
  updated_at: string;
}

export async function sqlChatHistory(projectId: number): Promise<SqlChatMessage[]> {
  return await db.prepare(
    `SELECT id, role, content, tool_trace, created_at FROM sql_chat_messages WHERE project_id = ? ORDER BY id`,
  ).all(projectId) as SqlChatMessage[];
}

export async function listSqlJobs(projectId: number): Promise<SqlJob[]> {
  return await db.prepare(
    `SELECT id, name, sql, note, output_spec, updated_at FROM sql_jobs WHERE project_id = ? ORDER BY id`,
  ).all(projectId) as SqlJob[];
}

export async function deleteSqlJob(id: number): Promise<void> {
  await db.prepare(`DELETE FROM sql_jobs WHERE id = ?`).run(id);
}

// ---- 物理カラムの対応（ステップ1で人が確定するもの）----

export interface SqlColumnRow {
  id?: number;
  table_name: string;
  physical_column: string;
  logical_name: string;
  asset_name: string;
  /** 原本側の対応（取込済みデータのローカルテーブル・列）。空 = 突き合わせできていない */
  local_table: string;
  local_column: string;
  note: string;
}

/** 物理カラム名からテーブル名を切り出す（IMPORT_30016_STRING_1 → IMPORT_30016） */
const tableOfPhysical = (physical: string): string => {
  const m = physical.match(/^([A-Za-z]+_\d+)_/);
  return m ? m[1] : '';
};

export async function listColumnMap(projectId: number): Promise<SqlColumnRow[]> {
  return await db.prepare(
    `SELECT id, table_name, physical_column, logical_name, asset_name, local_table, local_column, note
       FROM sql_column_maps WHERE project_id = ? ORDER BY id`,
  ).all(projectId) as SqlColumnRow[];
}

/** 対応表を丸ごと置き換える（確定は上書き。部分更新にすると画面と DB の行がずれる） */
export async function saveColumnMap(projectId: number, rows: SqlColumnRow[]): Promise<void> {
  await db.tx(async t => {
    await t.prepare(`DELETE FROM sql_column_maps WHERE project_id = ?`).run(projectId);
    for (const r of rows) {
      const physical = r.physical_column.trim();
      if (!physical) continue;
      await t.prepare(
        `INSERT INTO sql_column_maps (project_id, table_name, physical_column, logical_name, asset_name, local_table, local_column, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(projectId, r.table_name.trim() || tableOfPhysical(physical), physical,
        (r.logical_name ?? '').trim(), (r.asset_name ?? '').trim(),
        (r.local_table ?? '').trim(), (r.local_column ?? '').trim(), (r.note ?? '').trim());
    }
  });
}

/** 素朴な CSV/TSV の1行分解。引用符付きカンマだけ面倒を見る（Redash の書き出しが対象） */
function splitCsvLine(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQ = false;
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === sep) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map(s => s.trim());
}

/**
 * 添付された Redash の書き出し（クエリ145 など）から対応表の初期案を起こす。
 *
 * 列の当たりの付け方: 物理カラム名の列は「IMPORT_数字_」パターンが最も多い列。
 * 論理名・アセット名はヘッダー名で当て、当たらなければ物理列以外のテキスト列を順に使う。
 * ここは初期案でしかない — 直すのは人（画面の表で編集して確定する）。
 */
export function parseColumnFiles(docs: { filename: string; content: string }[]): {
  rows: SqlColumnRow[]; notes: string[];
} {
  const rows: SqlColumnRow[] = [];
  const notes: string[] = [];
  const isPhysical = (v: string) => /^[A-Za-z]+_\d+_[A-Za-z]+_\d+$/.test(v.trim());

  for (const doc of docs) {
    const lines = doc.content.split('\n').filter(l => l.trim() !== '');
    if (lines.length < 2) { notes.push(`${doc.filename}: 行が少なく読み取れませんでした`); continue; }
    const sep = (lines[0].match(/\t/g)?.length ?? 0) > (lines[0].match(/,/g)?.length ?? 0) ? '\t' : ',';
    const header = splitCsvLine(lines[0], sep);
    const data = lines.slice(1).map(l => splitCsvLine(l, sep));

    // 物理カラム名の列: IMPORT_xxxxx_型_連番 パターンの出現が最多の列
    const physIdx = header.map((_, c) => data.filter(r => isPhysical(r[c] ?? '')).length)
      .reduce((best, n, c, arr) => (n > (arr[best] ?? -1) && n > 0 ? c : best), -1);
    if (physIdx < 0) { notes.push(`${doc.filename}: 物理カラム名（IMPORT_…）の列が見つかりませんでした`); continue; }

    const findBy = (patterns: RegExp[]): number =>
      header.findIndex(h => patterns.some(p => p.test(h)));
    let logiIdx = findBy([/論理|logical|カラム名|列名|label/i]);
    const assetIdx = findBy([/アセット|asset|データファイル|テーブル名/i]);
    if (logiIdx < 0) {
      // ヘッダーで当たらなければ、物理列・アセット列以外の最初のテキスト列を論理名とみなす
      logiIdx = header.findIndex((_, c) => c !== physIdx && c !== assetIdx
        && data.some(r => (r[c] ?? '') !== '' && !isPhysical(r[c] ?? '')));
    }

    let added = 0;
    for (const r of data) {
      const physical = (r[physIdx] ?? '').trim();
      if (!isPhysical(physical)) continue;
      rows.push({
        table_name: tableOfPhysical(physical),
        physical_column: physical,
        logical_name: logiIdx >= 0 ? (r[logiIdx] ?? '').trim() : '',
        asset_name: assetIdx >= 0 ? (r[assetIdx] ?? '').trim() : '',
        local_table: '',
        local_column: '',
        note: '',
      });
      added++;
    }
    notes.push(`${doc.filename}: ${added} 行を読み取りました（物理名の列: ${header[physIdx] || `列${physIdx + 1}`}）`);
  }
  return { rows, notes };
}

/**
 * Redash から起こした行を、取込済みデータ（原本）の列と突き合わせる。
 *
 * 手で376行を対応付けるのは現実的でない。kpiee 取込の性質を使って自動で当てる:
 *   - クエリ145 の論理名は、取込時の原本ヘッダーがそのまま入る → 列名で当たる
 *   - アセット名は原本ファイル名に番号・種別タグ（「3-1. [raw] 〜」）を足した形 → 名前を均して当たる
 * 当たらなかった行は空のまま残し、人が表で直す（自動突き合わせは初期案でしかない）。
 */
export function matchColumnsToLocal(
  rows: SqlColumnRow[],
  tables: { name: string; filename: string; columns: string[] }[],
): { rows: SqlColumnRow[]; matched: number; unmatchedLocal: string[] } {
  const norm = (s: string) => s.normalize('NFKC').replace(/[\s　_\-./／・()（）\[\]【】]/g, '').toLowerCase();
  // アセット名から番号・種別タグを落とす（「3-1. [raw] SPD収支管理表」→「SPD収支管理表」）
  const assetCore = (s: string) => norm(s.replace(/\[[^\]]*\]|【[^】]*】|（[^）]*）|\([^)]*\)/g, '').replace(/^[\d\s\-.．]+/, ''));
  // 先頭の飾り・連番を落とした形も候補にする。「■ ③SPD収支管理表」の ■ や、原本「②〜」と
  // アセット「③〜」の番号ずれ（協和で実際にあった形）は、中身の名前で当てるしかない
  const variants = (s: string): string[] => {
    const bare = s.replace(/^[\d■□●○◆◇★☆*＊]+/, '');
    return bare && bare !== s ? [s, bare] : [s];
  };

  // テーブル名だけでなく元ファイル名でも当てる。xlsx のテーブル名はシート名（Export 等）で、
  // アセット名（原本ファイル由来）とは一致しないことが多い（協和は全ファイル Export だった）
  const tableByNorm = tables.map(t => ({
    t, names: [norm(t.name), norm(t.filename.replace(/\.[^.]+$/, ''))].filter(Boolean).flatMap(variants),
  }));
  const findTable = (asset: string): { name: string; columns: string[] } | null => {
    const cores = variants(assetCore(asset)).filter(Boolean);
    if (cores.length === 0) return null;
    // 双方向の包含で当てる（原本側が「①68期集計得意先別実績」のように接頭記号を持つことがある。
    // NFKC で ③→3 に均されるため、丸数字とアセット番号もかみ合う）
    const hit = tableByNorm.find(x => x.names.some(n => cores.some(a => n.includes(a) || a.includes(n))));
    return hit ? hit.t : null;
  };

  let matched = 0;
  const usedLocal = new Set<string>();
  const out = rows.map(r => {
    if (r.local_table && r.local_column) return r; // 既に人が当てた行は触らない
    const table = findTable(r.asset_name);
    if (!table) return r;
    const ln = norm(r.logical_name);
    const col = ln === '' ? undefined : table.columns.find(c => norm(c) === ln)
      ?? table.columns.find(c => norm(c).includes(ln) || ln.includes(norm(c)));
    if (!col) return { ...r, local_table: table.name };
    matched++;
    usedLocal.add(`${table.name}!${col}`);
    return { ...r, local_table: table.name, local_column: col };
  });

  // 原本にあって Redash 側に当たらなかった列（未取込か、論理名の言い換え）。画面の注記に出す
  const unmatchedLocal = tables.flatMap(t =>
    t.columns.filter(c => !usedLocal.has(`${t.name}!${c}`)).map(c => `${t.name} の ${c}`));
  return { rows: out, matched, unmatchedLocal };
}

/**
 * 対応表の初期案を丸ごと組み立てる（ステップ1「読み取る」の本体）。
 *
 * 表の主役は「実装対象＝取込済みデータの列」。Redash の書き出しには他案件・移行用の
 * アセットも数百行並ぶため（協和の WS には 313 行中 271 行が無関係だった）、
 * Redash 側を基準に並べると、直すべき行が無関係な行に埋もれる。
 *   1) Redash の書き出しを読み取る
 *   2) 名寄せ（正規化した名前）で自動突き合わせ
 *   3) 名寄せで当たらなかった残りを AI が意味で対応づける（AI推定と明記）
 *   4) 原本の列を1行=1列で並べ、無関係なアセットの行は数だけ知らせて出さない
 */
export async function buildColumnDraft(projectId: number, docs: { filename: string; content: string }[]): Promise<{
  rows: SqlColumnRow[];
  notes: string[];
  matched: number;
  unmatchedLocal: string[];
  tables: { name: string; columns: string[] }[];
}> {
  const collections = await collectByRole(projectId);
  const tables = collections.inputs.map(i => ({
    name: i.tableName, filename: i.filename, columns: tableHeaderOf(i.parsed),
  }));
  return await assembleColumnDraft(projectId, docs, tables);
}

/** buildColumnDraft の本体（取込データの読み出し以外）。テーブル一覧を渡せるのでテストできる */
export async function assembleColumnDraft(
  projectId: number,
  docs: { filename: string; content: string }[],
  tables: { name: string; filename: string; columns: string[] }[],
): Promise<{
  rows: SqlColumnRow[];
  notes: string[];
  matched: number;
  unmatchedLocal: string[];
  tables: { name: string; columns: string[] }[];
}> {
  const parsed = parseColumnFiles(docs);
  const m = matchColumnsToLocal(parsed.rows, tables);
  const notes = [...parsed.notes];

  // この案件に関係するアセット＝原本ファイルと名前が突き合ったアセット。
  // 一度も当たらなかったアセットの行は他案件・移行用とみなし、表には出さない
  const relevantAssets = new Set(m.rows.filter(r => r.local_table !== '').map(r => r.asset_name));
  const relevantRows = m.rows.filter(r => relevantAssets.has(r.asset_name));
  const droppedCount = m.rows.length - relevantRows.length;
  if (droppedCount > 0) {
    notes.push(`受領ファイルと突き合わないアセットの ${droppedCount.toLocaleString()} 行（他案件・移行用とみられる）は表に出していません。`);
  }

  // 名寄せで残った分を AI が意味で対応づける（「★売上金額（割戻金含む）」↔ 論理名「売上」など）。
  // 間違った物理名は実行エラーより質が悪いので、確信のある対応だけ返させ、AI推定と明記する
  let aiMatched = 0;
  const unmatchedPhysical = relevantRows.filter(r => r.local_column === '');
  const unmatchedLocalCols = tables.flatMap(t =>
    t.columns.filter(c => !relevantRows.some(r => r.local_table === t.name && r.local_column === c))
      .map(c => ({ table: t.name, column: c })));
  if (aiAvailable() && unmatchedPhysical.length > 0 && unmatchedLocalCols.length > 0) {
    try {
      const instruction = [
        '取込データの列（原本）と、kpiee の物理カラムの対応づけです。名前の正規化一致では当たらなかった',
        '残り同士を、意味で対応づけてください。列名の言い換え（記号・注記の有無、略称）だけを根拠にし、',
        '確信が持てない対応は返さないでください。',
        '',
        '<原本の列（テーブル名 . 列名）>',
        ...unmatchedLocalCols.map(c => `- ${c.table} . ${c.column}`),
        '</原本の列>',
        '',
        '<物理カラム（物理名 | 論理名 | アセット名）>',
        ...unmatchedPhysical.map(r => `- ${r.physical_column} | ${r.logical_name} | ${r.asset_name}`),
        '</物理カラム>',
      ].join('\n');
      const result = await callStructured<{ matches: { local_table: string; local_column: string; physical_column: string; reason: string }[] }>(
        projectId, 'sql-columns', instruction, COLUMN_MATCH_SCHEMA as unknown as Record<string, unknown>,
      );
      const usable = new Set(unmatchedLocalCols.map(c => `${c.table}!${c.column}`));
      for (const match of result.data.matches) {
        const row = relevantRows.find(r => r.physical_column === match.physical_column && r.local_column === '');
        // 候補に無い名前を作った対応や、同じ原本列への二重の対応は捨てる
        if (!row || !usable.delete(`${match.local_table}!${match.local_column}`)) continue;
        row.local_table = match.local_table;
        row.local_column = match.local_column;
        row.note = `AI推定: ${match.reason}`;
        aiMatched++;
      }
      if (aiMatched > 0) notes.push(`名寄せで当たらなかった ${aiMatched} 行を AI が意味で対応づけました（備考に「AI推定」と根拠）。内容をご確認ください。`);
    } catch (e) {
      notes.push(`AI の対応づけは実行できませんでした（名寄せ分のみ）: ${String(e).slice(0, 120)}`);
    }
  }

  // 表を「原本の列」基準に並べ替える: 対応済み（原本の列順）→ 原本にあって対応が無い列（要確認）
  // → 関係アセットにあって原本に無い物理行（未取込の可能性）。同じ原本列に複数の物理行が
  // 当たることもある（アセットの重複書き出し）ため、置けなかった行も末尾に残して人に見せる
  const byLocal = new Map(relevantRows.filter(r => r.local_table && r.local_column)
    .map(r => [`${r.local_table}!${r.local_column}`, r]));
  const placed = new Set<SqlColumnRow>();
  const orderedRows: SqlColumnRow[] = [];
  for (const t of tables) {
    for (const c of t.columns) {
      const hit = byLocal.get(`${t.name}!${c}`);
      if (hit) placed.add(hit);
      orderedRows.push(hit ?? {
        table_name: '', physical_column: '', logical_name: '', asset_name: '',
        local_table: t.name, local_column: c, note: '',
      });
    }
  }
  orderedRows.push(...relevantRows.filter(r => !placed.has(r)));

  const unmatchedLocal = orderedRows.filter(r => r.physical_column === '').map(r => `${r.local_table} の ${r.local_column}`);
  return {
    rows: orderedRows, notes,
    matched: m.matched + aiMatched,
    unmatchedLocal,
    tables: tables.map(t => ({ name: t.name, columns: t.columns })),
  };
}

/** references の一覧（ファイル名 = 道具に渡す名前）。起動時に一度だけ読む */
function referenceNames(): string[] {
  try {
    return readdirSync(path.join(KNOWLEDGE_DIR, 'references'))
      .filter(f => f.endsWith('.md'))
      .map(f => f.replace(/\.md$/, ''));
  } catch {
    return [];
  }
}

function readKnowledge(rel: string): string {
  return readFileSync(path.join(KNOWLEDGE_DIR, rel), 'utf8');
}

// ---- 道具 ----

const TOOL_DEFS = [
  {
    name: 'list_tables',
    description: 'ローカルサンドボックスに登録されたテーブル（取込データ）の一覧。テーブル名・列名・行数を返す。'
      + 'FROM に書けるのはこの名前だけ。最初に必ず1回呼んで、何があるかを見てから SQL を書くこと。',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'run_sql',
    description: 'SQL を1本、取込済みの実データ（DuckDB サンドボックス）で実行して結果を返す。'
      + '事前検証 → 本体 → 検算 の順で、1本ずつ流すこと。エラーはそのまま原文で返る。'
      + '結果は先頭30行まで（それ以上は行数だけ返る）。集計・件数确认のクエリは LIMIT を自分で付けること。',
    input_schema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: '実行する SELECT / WITH 文（1本のみ）' },
        purpose: { type: 'string', description: 'この実行の目的（例: 検証0 日付変換の成否 / STEP1 本体 / 検算 販管費合計）。画面に出る' },
      },
      required: ['sql', 'purpose'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_column_file',
    description: '添付された Redash の物理カラム一覧（クエリ145/147 の書き出し CSV）を読む。'
      + '納品形の SQL で物理カラム名（IMPORT_xxxxx）を当てるときの唯一の根拠。捏造しない。'
      + 'ファイルが大きいときは search で絞る（ヘッダー行＋一致行だけが返る）。',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '読むファイル名。省略時は最初の1件' },
        search: { type: 'string', description: '絞り込み語（アセット名・論理名・シート名など）。省略時は全文（上限あり）' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'read_reference',
    description: 'ナレッジ（kpiee-sql-builder の references）を読む。配賦の骨格・検算の型・クレンジング等、'
      + '作業の局面に入ったら該当のファイルを読んでから書くこと。',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: `ファイル名（拡張子なし）。ある名前: ${referenceNames().join(' / ')}` },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'save_sql',
    description: '完成した SQL を成果物として保存する。同名は上書き。'
      + '保存前に SQLジョブ契約の静的検証を通す（違反はエラーで返る）。'
      + '検算まで通ってユーザーが合意したものだけを保存すること。output_spec（出力仕様: 順番→別名→予測物理名→原本の列→下流での用途）を必ず添える。',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '成果物名（例: STEP1_土台 / STEP4_販管費配賦 / 統合）' },
        sql: { type: 'string', description: '納品形の SQL（Snowflake 方言・最終SELECTの別名は日本語）' },
        note: { type: 'string', description: '前提・暫定事項・踏んだ罠（無ければ空文字）' },
        output_spec: { type: 'string', description: '出力仕様の表（Markdown）。原本の列を必ず含める' },
      },
      required: ['name', 'sql', 'output_spec'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_saved_sql',
    description: '保存済みの SQL 成果物一覧（名前と更新日時）。',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
] as const;

/** run_sql の結果を AI とトレース表示の両方に耐えるサイズへ丸める */
function shapeResult(columns: string[], rows: Record<string, unknown>[]): {
  columns: string[]; rows: string[][]; totalRows: number; truncated: boolean;
} {
  const MAX_ROWS = 30;
  const MAX_CELL = 200;
  const shaped = rows.slice(0, MAX_ROWS).map(r =>
    columns.map(c => {
      const v = r[c];
      const s = v === null || v === undefined ? '' : String(v);
      return s.length > MAX_CELL ? `${s.slice(0, MAX_CELL)}…` : s;
    }));
  return { columns, rows: shaped, totalRows: rows.length, truncated: rows.length > MAX_ROWS };
}

/** 画面へ出す1回分のツール呼び出し記録。run_sql は結果グリッドまで持つ */
export interface SqlToolTrace {
  tool: string;
  /** run_sql の purpose / read_reference の name / save_sql の name */
  label: string;
  sql?: string;
  result?: { columns: string[]; rows: string[][]; totalRows: number; truncated: boolean };
  error?: string;
}

/**
 * 物理カラム一覧の読み出し。全文は数百行 × 数列で数十KBになり得るため、
 * search があればヘッダー行（1行目）＋一致行だけ返す。無ければ上限まで返す。
 */
function shapeColumnFile(doc: ProjectDoc, search?: string): { filename: string; content: string; truncated: boolean } {
  const MAX_CHARS = 40_000;
  const lines = doc.content.split('\n');
  let picked: string[];
  if (search && search.trim()) {
    const s = search.trim().toLowerCase();
    picked = [lines[0] ?? '', ...lines.slice(1).filter(l => l.toLowerCase().includes(s))];
  } else {
    picked = lines;
  }
  let out = picked.join('\n');
  const truncated = out.length > MAX_CHARS;
  if (truncated) out = `${out.slice(0, MAX_CHARS)}\n…（続きは search で絞ってください）`;
  return { filename: doc.filename, content: out, truncated };
}

// ---- システムプロンプト ----

/** ナレッジ（SKILL＋workflow）をプロンプトへ常時入れるか。project_flags の印で持つ（既定 OFF） */
export const SQL_KNOWLEDGE_FLAG = 'sql_knowledge';
/** 物理カラムの対応を人が確定した印（SQL構築 ステップ1 の完了条件） */
export const SQL_COLUMNS_FLAG = 'sql_columns_confirmed';

export async function isKnowledgeOn(projectId: number): Promise<boolean> {
  const hit = await db.prepare(`SELECT flag FROM project_flags WHERE project_id = ? AND flag = ?`)
    .get(projectId, SQL_KNOWLEDGE_FLAG);
  return !!hit;
}

/**
 * 大前提。ナレッジの ON/OFF に関係なく常に入る。
 *
 * 顧客データの実数値を AI の文章・SQL へ出さない。この会話は画面共有や引き継ぎで
 * 顧客・他メンバーの目に触れる前提で、レポート（原本のセル値は載せない）・検収ビューアの
 * マスキングと同じ線を SQL構築でも守る。実額の確認は実行結果グリッド（画面側）に任せる。
 */
const GUARD_BLOCK = [
  '## 大前提（設定に関係なく、常に守ること）',
  '- 顧客データの実数値（セルの値・金額・合計・構成比など、データから読んだ数字）を、',
  '  **回答本文・SQL本文・SQLコメントへ絶対に書かない**。列名・シート名・テーブル名・数式の構造は書いてよい。',
  '  行数・列数・件数などデータの規模は書いてよい（中身の数字ではないため）。',
  '- 検算・検証の結果は「一致 / 不一致（桁が違う・符号が逆 など差の性質）」で伝える。実額は書かない。',
  '  実額を見たいユーザーは、画面の実行結果グリッドを自分で開ける。',
  '- SQL に、データから読んだ値をリテラルとして埋め込まない（WHERE の金額しきい値など）。',
  '  掛け目・税率・分岐条件の値は、ユーザーが明示したものだけを使い、出所をコメントに書く。',
].join('\n');

/**
 * 目的と製品の最小知識。ナレッジの ON/OFF に関係なく常に入る。
 * OFF の軽量運転でも「何のための SQL か・出力列が製品でどう見えるか」を知らないと、
 * 中間値を落とした最終値1列だけの SQL など、登録はできるが使えないものを作ってしまう。
 * 内容は knowledge/kpiee-sql（SKILL.md §2・calc-spec.md §6・allocation.md）の要点の縮約。
 */
const PRODUCT_BLOCK = [
  '## 目的と kpiee 製品の基礎知識',
  '- 作るのは、経営管理 SaaS「kpiee」のデータコネクトに登録する Snowflake の SELECT 文（SQLジョブ）。',
  '  取込済みアセット（IMPORT_xxxxx テーブル）から、レポート指標の元になるデータを組み立てる。',
  '- 最終SELECT の日本語別名は kpiee のカラムラベル（論理名）になり、レポート指標の選択肢と、',
  '  顧客が開く「数値の明細表示」の列見出しにそのまま出る。',
  '- 「数値の明細表示」＝レポートのセルを右クリックすると、その数字を構成した元の行が出る製品機能。',
  '  そこに何が出るかは **SQL の出力列がそのまま決める**。中間値（配賦前の額・比率・按分基準など）を',
  '  出力列に残さないと、顧客が明細を開いても「なぜこの金額か」に答えられない。',
  '- kpiee には製品側の配賦機能（配賦設定＝比率で費用を按分する設定画面）もある。配賦を SQL で書くと',
  '  明細上は普通の数値列になり「配賦された金額」という印が消えるため、根拠列を出力に残す。',
  '  製品配賦と SQL 配賦のどちらで組むかは案件によるので、迷ったらユーザーに確認する。',
].join('\n');

/** OFF（既定）で入れる最小限の契約。SKILL.md §4-1 と別名規則の要点だけを写した縮約版 */
const CONTRACT_BLOCK = [
  '## kpiee SQLジョブの契約（違反すると登録時に弾かれる）',
  '- 1本の SELECT または WITH のみ。セミコロン区切りの複数文・DML/DDL/USE は不可',
  '- @stage 参照・schema.func() 修飾呼び出し・メタデータ関数（CURRENT_USER 等）は不可',
  '- FROM/JOIN で参照できるのは登録済みアセット（テーブル）だけ',
  '- 別名は中間CTEが ASCII snake_case、最終SELECTが日本語（kpiee のカラムラベルになり顧客画面に出る）',
  '- 物理カラムの型を信用しない: 金額は TRY_TO_DECIMAL(x, 18, 2)、率は TRY_TO_DECIMAL(x, 12, 6)、',
  '  日付は書式明示の TRY_TO_DATE(x, \'YYYY/MM/DD\')（1引数版は使わない）',
  '- 分類キーの空白は COALESCE(NULLIF(TRIM(x, \' 　\'), \'\'), \'不明\') で「不明」に寄せる',
].join('\n');

async function buildSystemText(
  projectId: number, tables: SqlSandbox['tables'], knowledgeOn: boolean,
): Promise<string> {
  const ov = await db.prepare(`SELECT content FROM project_overviews WHERE project_id = ?`)
    .get(projectId) as { content: string } | undefined;
  const overview: StructureOverview | null = ov ? JSON.parse(ov.content) : null;

  const tableList = tables.map(t =>
    `- ${t.name}（${t.rowCount.toLocaleString()}行）: ${t.columns.slice(0, 40).join(', ')}${t.columns.length > 40 ? ' …' : ''}`,
  ).join('\n');

  const columnFiles = (await listProjectDocs(projectId, 'sql-columns')).filter(d => d.content.trim() !== '');
  const columnFileList = columnFiles.length > 0
    ? columnFiles.map(d => `- ${d.filename}（${d.content.length.toLocaleString()} 字）`).join('\n')
    : '（未添付。物理名が要る局面になったら、Redash クエリ145/147 の書き出し CSV の添付を依頼する）';

  // ステップ1で人が確定した対応表。これがあるときは物理名の一次根拠（原本ファイルより優先）。
  // 500行を超える案件は上限で切り、続きは read_column_file で絞らせる（プロンプトの肥大防止）。
  const confirmed = await listColumnMap(projectId);
  const MAX_MAP_ROWS = 500;
  const confirmedBlock = confirmed.length > 0
    ? [
        `人が確定した対応（${confirmed.length} 行）。物理名はここが一次根拠。`,
        '「原本の列」はローカルテーブルの実列名で、ローカル検証（run_sql）ではこれを使い、',
        '納品形（save_sql）では同じ行の物理カラム名に置き換える。出力仕様もこの対応から書く:',
        '原本（ローカルテーブル.列） | 物理カラム名 | カラム名（論理名） | アセット名',
        ...confirmed.slice(0, MAX_MAP_ROWS).map(r =>
          `${r.local_table && r.local_column ? `${r.local_table}.${r.local_column}` : '（原本未対応）'} | ${r.physical_column} | ${r.logical_name} | ${r.asset_name}${r.note ? `（${r.note}）` : ''}`),
        ...(confirmed.length > MAX_MAP_ROWS ? [`…残り ${confirmed.length - MAX_MAP_ROWS} 行は read_column_file で絞って参照`] : []),
      ].join('\n')
    : '（未確定。ステップ1（物理カラムの確認）が済んでいない案件では、物理名の当てはめを保留にして進める）';

  const envBlock = [
    '## この環境',
    '- Redash には接続していない。物理カラム名（IMPORT_xxxxx）の根拠は、ユーザーが添付した',
    '  クエリ145/147 の書き出しファイル（下の一覧）だけ。read_column_file で読む。',
    '  添付が無いのに物理名が要る局面では、添付を依頼するか貼ってもらう。**物理名を捏造しない。**',
    '- SQL はあなた自身が run_sql でローカル実行できる。実行環境は DuckDB で、',
    '  TRY_TO_DECIMAL / TRY_TO_NUMBER / TRY_TO_DATE(2引数) / IFF / NVL / ZEROIFNULL / DIV0 は',
    '  ポリフィル済み。それ以外の Snowflake 専用関数が要るときは、ローカル検証では等価な形に',
    '  書き換えて流し、納品形（save_sql）では Snowflake の形へ戻して、差異を note に書く。',
    '- FROM に書けるのはローカルのテーブル名（下の一覧）。納品形では IMPORT_xxxxx に置き換わるため、',
    '  出力仕様に対応表を必ず残す。',
    '- 検証・検算はユーザーに頼まず自分で run_sql で流す。ただし**検算の正解値**（合計がいくつになるべきか）',
    '  だけは実データから作れないので、ユーザーに確認する。',
    '- ユーザーへの説明は日本語で簡潔に。装飾記号（** や #）の多用は避ける。',
    '  SQL全文は run_sql / save_sql に渡し、本文には要点だけ書く。',
  ].join('\n');

  // ON: ナレッジ全文（4ターンの型で進行）。OFF（既定）: 大前提＋契約＋環境だけの軽量運転。
  // OFF は「常時入れない」ではなく「使わない」。read_reference の道具ごと外すので、
  // AI が判断でナレッジを読みに行くこともない（startSqlChat 側で tools から落としている）。
  const knowledgeBlocks = knowledgeOn
    ? [
        '進め方はナレッジ（下の SKILL / workflow）が正。記憶や一般論で進めず、そこに書かれた4ターンの型に従ってください。',
        '復唱（ターン1）は、レポートHTMLの代わりにこの案件の解析結果（下の構造サマリ）とテーブル一覧を根拠に行う。',
        '',
        GUARD_BLOCK,
        '',
        PRODUCT_BLOCK,
        '',
        envBlock,
        '',
        '## ナレッジ: SKILL.md（全文）',
        readKnowledge('SKILL.md'),
        '',
        '## ナレッジ: workflow.md（全文）',
        readKnowledge('references/workflow.md'),
      ]
    : [
        'ユーザーの依頼に沿って SQL を書き、run_sql で検証してから渡してください。',
        'この設定では構築ナレッジを参照しません（読む道具も渡していません）。下の大前提・契約・環境と、',
        'ユーザーの指示・この案件の解析結果だけを根拠に進めてください。型が要る局面で判断に迷ったら、',
        '推測で埋めずにユーザーへ聞くこと。',
        '',
        GUARD_BLOCK,
        '',
        PRODUCT_BLOCK,
        '',
        CONTRACT_BLOCK,
        '',
        envBlock,
      ];

  return [
    'あなたは kpiee 導入支援の担当者と一緒に、SQLジョブ（Snowflake の SELECT 文）を組み立てるアシスタントです。',
    ...knowledgeBlocks,
    '',
    '## この案件のローカルテーブル（FROM に書ける名前）',
    tableList || '（取込データがまだありません。まずデータの取り込みを案内してください）',
    '',
    '## 物理カラムの対応（確定済み）',
    confirmedBlock,
    '',
    '## 添付済みの物理カラム一覧（元ファイル。read_column_file で読める）',
    columnFileList,
    '',
    '## この案件の構造サマリ（解読済みのもの）',
    overview ? JSON.stringify(overview, null, 2) : '（AI 解読が未実行。構造把握のステップで実行できます）',
    await docsBlock(projectId),
  ].join('\n');
}

// ---- 実行 ----

const pendingProjects = new Set<number>();
/**
 * 処理中のツール実行記録。traces の実体をそのまま持つので、run_sql を1本流すたびに中身が増える。
 * 1回の応答で検証〜検算まで何本も流すため、終わるまで画面が無反応だと「遅い」ではなく「止まった」に見える。
 * ポーリングでこれを返して、いま何を流しているかを出す。
 */
const liveTraces = new Map<number, SqlToolTrace[]>();

export function isSqlChatPending(projectId: number): boolean {
  return pendingProjects.has(projectId);
}

/** 処理中の途中経過。完了すると空になり、確定版は assistant メッセージの tool_trace に入る */
export function sqlChatProgress(projectId: number): SqlToolTrace[] {
  return liveTraces.get(projectId) ?? [];
}

export async function startSqlChat(projectId: number, message: string): Promise<{ pending: boolean }> {
  if (pendingProjects.has(projectId)) {
    throw new Error('前のメッセージを処理中です。回答が表示されてから送ってください');
  }
  await db.prepare(`INSERT INTO sql_chat_messages (project_id, role, content) VALUES (?, 'user', ?)`)
    .run(projectId, message);

  if (!aiAvailable()) {
    await db.prepare(`INSERT INTO sql_chat_messages (project_id, role, content) VALUES (?, 'assistant', ?)`)
      .run(projectId, '（モックモード: ANTHROPIC_API_KEY 未設定のため SQL構築チャットは使えません）');
    return { pending: false };
  }

  pendingProjects.add(projectId);
  void (async () => {
    let sandbox: SqlSandbox | null = null;
    const traces: SqlToolTrace[] = [];
    liveTraces.set(projectId, traces); // 実体を共有する。以降 push するたび画面の途中経過が伸びる
    try {
      // 取込データを一度だけサンドボックスへ載せる（この質問処理の間だけ保持。C5: ターンをまたいで持たない）
      const collections = await collectByRole(projectId);
      sandbox = await SqlSandbox.create(collections.inputs);
      const allowedTables = sandbox.tables.map(t => t.name);

      const history = await db.prepare(
        `SELECT role, content FROM sql_chat_messages WHERE project_id = ? ORDER BY id`,
      ).all(projectId) as { role: 'user' | 'assistant'; content: string }[];

      // ナレッジ OFF は「プロンプトに入れない」だけでなく「読ませない」。道具ごと外して、
      // AI の判断でナレッジを引くこともできなくする（OFF の意味を1つに絞る）。
      const knowledgeOn = await isKnowledgeOn(projectId);
      const tools = knowledgeOn ? [...TOOL_DEFS] : TOOL_DEFS.filter(t => t.name !== 'read_reference');

      const result = await callWithTools(
        projectId,
        await buildSystemText(projectId, sandbox.tables, knowledgeOn),
        history,
        tools as unknown as Parameters<typeof callWithTools>[3],
        async call => {
          const input = call.input as Record<string, string>;
          switch (call.name) {
            case 'list_tables':
              return sandbox!.tables;

            case 'run_sql': {
              const trace: SqlToolTrace = { tool: 'run_sql', label: input.purpose ?? '', sql: input.sql };
              traces.push(trace);
              // 契約違反（複数文・DML 等）は実行前に弾いて理由を返す（本番で落ちる SQL を検証済みにしない）
              const scan = scanQuery(input.sql, allowedTables);
              if (!scan.ok) {
                trace.error = `SQLジョブ契約違反: ${scan.errors.map(e => e.message).join(' / ')}`;
                return { error: trace.error };
              }
              try {
                const { columns, rows } = await sandbox!.run(input.sql);
                trace.result = shapeResult(columns, rows);
                return trace.result;
              } catch (e) {
                trace.error = e instanceof Error ? e.message : String(e);
                return { error: trace.error };
              }
            }

            case 'read_column_file': {
              const files = (await listProjectDocs(projectId, 'sql-columns')).filter(d => d.content.trim() !== '');
              if (files.length === 0) {
                return { error: '物理カラム一覧が添付されていません。Redash クエリ145/147 の書き出し CSV を「物理カラム一覧」として添付してもらってください' };
              }
              const doc = input.name ? files.find(f => f.filename === input.name) : files[0];
              if (!doc) {
                return { error: `そのファイルはありません。添付済み: ${files.map(f => f.filename).join(' / ')}` };
              }
              traces.push({ tool: 'read_column_file', label: `${doc.filename}${input.search ? `（絞り込み: ${input.search}）` : ''}` });
              return shapeColumnFile(doc, input.search);
            }

            case 'read_reference': {
              // OFF では道具自体を渡していないので通常ここへは来ない（保険）
              if (!knowledgeOn) return { error: 'この案件は構築ナレッジ OFF の設定です。ナレッジは参照できません' };
              traces.push({ tool: 'read_reference', label: input.name });
              try {
                return readKnowledge(`references/${input.name.replace(/[^\w-]/g, '')}.md`);
              } catch {
                return { error: `そのナレッジはありません。ある名前: ${referenceNames().join(' / ')}` };
              }
            }

            case 'save_sql': {
              const trace: SqlToolTrace = { tool: 'save_sql', label: input.name, sql: input.sql };
              traces.push(trace);
              // 納品形は物理名（IMPORT_xxxxx）参照になり得るため、テーブル存在チェックは掛けない
              const scan = scanQuery(input.sql);
              if (!scan.ok) {
                trace.error = `SQLジョブ契約違反: ${scan.errors.map(e => e.message).join(' / ')}`;
                return { error: trace.error };
              }
              const updated = await db.prepare(
                `UPDATE sql_jobs SET sql = ?, note = ?, output_spec = ? WHERE project_id = ? AND name = ?`,
              ).run(input.sql, input.note ?? '', input.output_spec, projectId, input.name);
              if (updated.changes === 0) {
                await db.prepare(
                  `INSERT INTO sql_jobs (project_id, name, sql, note, output_spec) VALUES (?, ?, ?, ?, ?)`,
                ).run(projectId, input.name, input.sql, input.note ?? '', input.output_spec);
              }
              return { saved: true, name: input.name };
            }

            case 'list_saved_sql':
              return (await listSqlJobs(projectId)).map(j => ({ name: j.name, updated_at: j.updated_at }));

            default:
              return { error: `未知の道具: ${call.name}` };
          }
        },
        // 検証0〜4 → 本体 → 検算 で run_sql が多くなるため、Q&A 既定より余裕を持たせる
        24,
      );

      await db.prepare(
        `INSERT INTO sql_chat_messages (project_id, role, content, tool_trace) VALUES (?, 'assistant', ?, ?)`,
      ).run(projectId, result.text, JSON.stringify(traces));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await db.prepare(
        `INSERT INTO sql_chat_messages (project_id, role, content, tool_trace) VALUES (?, 'assistant', ?, ?)`,
      ).run(projectId, `（処理中にエラーが発生しました: ${msg}。もう一度お試しください）`, JSON.stringify(traces)).catch(() => {});
    } finally {
      sandbox?.close();
      liveTraces.delete(projectId);
      pendingProjects.delete(projectId);
    }
  })();
  return { pending: true };
}

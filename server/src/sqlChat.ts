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
import { aiAvailable, callWithTools } from './ai/client.js';
import { collectByRole } from './pipeline/orchestrator.js';
import { SqlSandbox } from './match/simulate.js';
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
  // OFF でも read_reference で必要な局面だけナレッジを読める（常時入れないだけで、無くすわけではない）。
  const knowledgeBlocks = knowledgeOn
    ? [
        '進め方はナレッジ（下の SKILL / workflow）が正。記憶や一般論で進めず、そこに書かれた4ターンの型に従ってください。',
        '復唱（ターン1）は、レポートHTMLの代わりにこの案件の解析結果（下の構造サマリ）とテーブル一覧を根拠に行う。',
        '',
        GUARD_BLOCK,
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
        '配賦・検算・出力仕様など、型が必要な局面に入ったら read_reference で該当ナレッジを読んでから書くこと。',
        '',
        GUARD_BLOCK,
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
    '## 添付済みの物理カラム一覧（read_column_file で読める）',
    columnFileList,
    '',
    '## この案件の構造サマリ（解読済みのもの）',
    overview ? JSON.stringify(overview, null, 2) : '（AI 解読が未実行。構造把握のステップで実行できます）',
    await docsBlock(projectId),
  ].join('\n');
}

// ---- 実行 ----

const pendingProjects = new Set<number>();
export function isSqlChatPending(projectId: number): boolean {
  return pendingProjects.has(projectId);
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
    try {
      // 取込データを一度だけサンドボックスへ載せる（この質問処理の間だけ保持。C5: ターンをまたいで持たない）
      const collections = await collectByRole(projectId);
      sandbox = await SqlSandbox.create(collections.inputs);
      const allowedTables = sandbox.tables.map(t => t.name);

      const history = await db.prepare(
        `SELECT role, content FROM sql_chat_messages WHERE project_id = ? ORDER BY id`,
      ).all(projectId) as { role: 'user' | 'assistant'; content: string }[];

      const result = await callWithTools(
        projectId,
        await buildSystemText(projectId, sandbox.tables, await isKnowledgeOn(projectId)),
        history,
        TOOL_DEFS as unknown as Parameters<typeof callWithTools>[3],
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
      pendingProjects.delete(projectId);
    }
  })();
  return { pending: true };
}

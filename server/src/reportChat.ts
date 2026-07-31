// アウトプット相談。「このレポートに何を載せるか」を担当者との対話で決める。
//
// なぜ対話にするか: 案件ごとに顧客へ見せたい範囲が違う（列構成まで見せる／流れ図だけで足りる／
// 確認事項を主役にする…）。デザインとレポートの骨格は固定したまま、構成要素の出し入れだけを
// 案件ごとに決められるようにする。決まった内容は report_specs に残り、HTML 生成時に反映される。
//
// AI の役割は2つだけ:
//   1. 解析結果（ファイル・シート役割・関係数・確認事項）を踏まえて、何を載せるべきか質問・提案する
//   2. 合意した内容を update_report_spec ツールで指定へ落とす
// 会話は Q&A（qa/agent.ts）と別テーブルに持つ。目的が違う履歴を混ぜると噛み合わなくなるため。
import { db } from './db.js';
import { aiAvailable, callWithTools } from './ai/client.js';
import {
  DEFAULT_REPORT_SPEC, REPORT_ITEM_LABELS, REPORT_SECTION_LABELS,
  describeReportSpec, normalizeReportSpec, type ReportSpec,
} from './reportSpec.js';

export interface ReportChatMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  spec_patch: string | null;
  created_at: string;
}

/** 保存済みの指定。未登録なら既定（全部出す） */
export async function loadReportSpec(projectId: number): Promise<ReportSpec> {
  const row = await db.prepare(`SELECT spec FROM report_specs WHERE project_id = ?`)
    .get(projectId) as { spec: string } | undefined;
  if (!row) return DEFAULT_REPORT_SPEC;
  try {
    return normalizeReportSpec(JSON.parse(row.spec));
  } catch {
    return DEFAULT_REPORT_SPEC; // 壊れた保存値は既定へ倒す（レポート生成を止めない）
  }
}

/** 指定が保存済みか（＝担当者が構成を決めたか）。画面のステップ完了判定に使う */
export async function reportSpecConfigured(projectId: number): Promise<boolean> {
  const row = await db.prepare(`SELECT project_id FROM report_specs WHERE project_id = ?`)
    .get(projectId) as { project_id: number } | undefined;
  return !!row;
}

/** 指定を保存する。部分指定は現在値の上に重ねる */
export async function saveReportSpec(projectId: number, patch: unknown): Promise<ReportSpec> {
  const merged = normalizeReportSpec(patch, await loadReportSpec(projectId));
  const json = JSON.stringify(merged);
  // upsert。ON CONFLICT を使わないのは SQLite / Postgres で同じ SQL を通したいため
  const updated = await db.prepare(`UPDATE report_specs SET spec = ? WHERE project_id = ?`).run(json, projectId);
  if (updated.changes === 0) {
    await db.prepare(`INSERT INTO report_specs (project_id, spec) VALUES (?, ?)`).run(projectId, json);
  }
  return merged;
}

export async function reportChatHistory(projectId: number): Promise<ReportChatMessage[]> {
  return await db.prepare(
    `SELECT id, role, content, spec_patch, created_at FROM report_chat_messages WHERE project_id = ? ORDER BY id`,
  ).all(projectId) as ReportChatMessage[];
}

/** 解析結果の要約。相談の前提として毎回システムプロンプトへ入れる */
export interface ProjectFacts {
  customerName: string;
  files: { filename: string; kind: string; sheetRoles: Record<string, string> | null }[];
  regionCount: number;
  edgeCount: number;
  copyPairCount: number;
  questionCount: number;
  declaredRelCount: number;
  multiFile: boolean;
}

function factsText(f: ProjectFacts): string {
  const roleLine = (r: Record<string, string> | null) =>
    r ? Object.entries(r).map(([s, role]) => `${s}=${role}`).join(', ') : '（シート役割未指定）';
  return [
    `顧客: ${f.customerName || '（未設定）'}`,
    `受領ファイル ${f.files.length} 件${f.multiFile ? '（複数ブック）' : '（1ブック）'}:`,
    ...f.files.map(a => `  - ${a.filename}（種別 ${a.kind}）: ${roleLine(a.sheetRoles)}`),
    `検出した表: ${f.regionCount} / 表どうしの関係: ${f.edgeCount} 件`,
    `手作業コピーと推定される関係: ${f.copyPairCount} 組`,
    `自動抽出された確認事項: ${f.questionCount} 件`,
    `登録済みブック関係: ${f.declaredRelCount} 件`,
  ].join('\n');
}

const SPEC_TOOL = {
  name: 'update_report_spec',
  description: '顧客共有レポートの構成指定を更新する。合意した項目だけを含めればよい（省略した項目は現状維持）。',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'レポート表題。既定のままにするなら省略' },
      focus: { type: 'string', description: 'この案件で特に確認したいこと（1文）' },
      sections: {
        type: 'object',
        description: '節の出し入れ',
        properties: Object.fromEntries(
          Object.entries(REPORT_SECTION_LABELS).map(([k, label]) => [k, { type: 'boolean', description: label }]),
        ),
      },
      items: {
        type: 'object',
        description: '節の中の項目の出し入れ',
        properties: Object.fromEntries(
          Object.entries(REPORT_ITEM_LABELS).map(([k, label]) => [k, { type: 'boolean', description: label }]),
        ),
      },
      notes: {
        type: 'array', items: { type: 'string' },
        description: 'まとめへ足す案件固有の補足（最大8件）',
      },
    },
  },
} as const;

function systemText(facts: ProjectFacts, spec: ReportSpec): string {
  return [
    'あなたは kpiee 導入支援の担当者を助けるアシスタントです。',
    'これから顧客へ渡す「データ構造 分析レポート（HTML）」に何を載せるかを、担当者との対話で決めます。',
    '',
    '## 進め方',
    '- 最初のターンでは、下の解析結果を読んで「この案件ならこの構成を勧めます」と理由つきで提案し、',
    '  判断が要る点を2〜3個だけ質問する。質問は一度にまとめて、選びやすい形（A/B や 出す/出さない）で聞く。',
    '- 決まっていない項目は既定（出す）のままにしておき、次のターンで確認する。',
    '- 回答は日本語で簡潔に。装飾記号（** や #）は使わず、箇条書きは「- 」で書く。',
    '',
    '## 反映のしかた（厳守）',
    '- 担当者の指示で決まった項目は、**必ず同じターンで update_report_spec を呼ぶ**。',
    '  ツールを呼ばずに「反映しました」「変更しました」と書くのは禁止（画面には何も起こらないため、',
    '  担当者は反映されたと誤解する）。合意した項目だけを入れ、頼まれていない項目は触らない。',
    '- 指示が下の指定項目のどれにも当たらない場合（例: 節の順番を変える、文章の言い回しを変える、',
    '  表の列を減らす、図の配色を変える）は、ツールを呼ばずに「それはこの画面では変えられません」と',
    '  はっきり伝え、近い代替（節や項目の出し入れ、重点の指定、補足メモ）を1つ提案する。',
    '  できない依頼に対して曖昧に同意しないこと。',
    '- 返答の最後に必ず2行を付ける:',
    '    反映した項目: （ツールで変えた項目。無ければ「なし」）',
    '    反映できないもの: （この画面では変えられない依頼。無ければ「なし」）',
    '',
    '## 変えられないこと（説明を求められたらこう答える）',
    '- レポートの見た目（配色・レイアウト・書式）は固定。案件ごとに変えない。',
    '- 表どうしの関係図はノード形式で必ず載る。これが顧客と構造合意する本体のため、外せない。',
    '- 原本のセル値は載せない（列名・数式・行数などの構造情報のみ）。',
    '- 全体関係図（ブック間）は複数ブックの案件でのみ出る。1ブックならシート・表単位の図から始まる。',
    '',
    '## 解析結果',
    factsText(facts),
    '',
    '## 現在の構成指定',
    describeReportSpec(spec).map(l => `- ${l}`).join('\n'),
  ].join('\n');
}

/** 相談の初手。担当者が何も入力していない段階で提案から始められるようにする */
export const REPORT_CHAT_KICKOFF =
  '解析結果を踏まえて、このレポートに載せる構成の提案と、決めておきたい点を教えてください。';

const pending = new Set<number>();
export function reportChatPending(projectId: number): boolean {
  return pending.has(projectId);
}

/**
 * 相談メッセージを受け付け、バックグラウンドで応答を生成する（即 return）。
 * ツール呼び出しで指定が更新され得るため、フロントは応答到着後に指定を取り直す。
 */
export async function startReportChat(
  projectId: number, message: string, facts: ProjectFacts,
): Promise<{ pending: boolean }> {
  if (pending.has(projectId)) {
    throw new Error('前のメッセージを処理中です。返答が表示されてから送ってください');
  }
  await db.prepare(`INSERT INTO report_chat_messages (project_id, role, content) VALUES (?, 'user', ?)`)
    .run(projectId, message);

  if (!aiAvailable()) {
    // モックモード: AI 無しでも相談の型が分かるよう、現状の指定と操作案内を返す
    const spec = await loadReportSpec(projectId);
    const answer = [
      '（モックモード: ANTHROPIC_API_KEY 未設定のため AI 提案はできません）',
      '右のチェックリストから直接、載せる項目を選べます。現在の指定は次のとおりです。',
      ...describeReportSpec(spec).map(l => `- ${l}`),
    ].join('\n');
    await db.prepare(`INSERT INTO report_chat_messages (project_id, role, content) VALUES (?, 'assistant', ?)`)
      .run(projectId, answer);
    return { pending: false };
  }

  pending.add(projectId);
  void (async () => {
    let patched: unknown = null;
    try {
      const history = (await db.prepare(
        `SELECT role, content FROM report_chat_messages WHERE project_id = ? ORDER BY id`,
      ).all(projectId)) as { role: 'user' | 'assistant'; content: string }[];
      const result = await callWithTools(
        projectId,
        systemText(facts, await loadReportSpec(projectId)),
        history,
        [SPEC_TOOL] as unknown as Parameters<typeof callWithTools>[3],
        async call => {
          if (call.name !== 'update_report_spec') return `未知のツール: ${call.name}`;
          patched = call.input;
          const saved = await saveReportSpec(projectId, call.input);
          return JSON.stringify({ ok: true, spec: saved });
        },
        6,
      );
      await db.prepare(
        `INSERT INTO report_chat_messages (project_id, role, content, spec_patch) VALUES (?, 'assistant', ?, ?)`,
      ).run(projectId, result.text, patched ? JSON.stringify(patched) : null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await db.prepare(`INSERT INTO report_chat_messages (project_id, role, content) VALUES (?, 'assistant', ?)`)
        .run(projectId, `（相談の応答生成でエラーが発生しました: ${msg}。もう一度お試しください）`).catch(() => {});
    } finally {
      pending.delete(projectId);
    }
  })();
  return { pending: true };
}

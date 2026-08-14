// KPIEE オンボーディング自動化 AI — ローカル API サーバー。
// 設計書のバックエンド（Rails 8 API）に相当する Node/Express 実装。
// 非同期パイプラインは fire-and-forget で起動し、クライアントは analysis_runs をポーリングする。
import './env.js'; // .env 読み込みは他モジュールの評価前に行う（AI クライアント初期化より先）
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { ZipArchive } from 'archiver';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { db, setProjectStatus, getProjectUsage, initDb } from './db.js';
import { putObject, removeObject } from './storage.js';
import { materializeBuffer, materializeParsed, driveKey, isDriveKey, driveIdOf } from './artifacts.js';
import { parseArtifact, type ParsedArtifact } from './preprocess/parse.js';
import { classifySheetRoles, SHEET_ROLE_LABELS, type SheetClassification } from './preprocess/classify.js';
import { analyzeBuffer, analyzeArtifacts, fileLabelOf, type RelationGraph } from './preprocess/relations.js';
import { analyzeArtifactsInWorker, type WorkerFile } from './preprocess/analyzeInWorker.js';
import { artifactSetSignature, getCachedRelationGraph, setCachedRelationGraph, invalidateRelationGraph } from './relationsCache.js';
import { runDecode, runGenerate, runMatch, tableNameOf } from './pipeline/orchestrator.js';
import { buildKpieePreview, buildImplReport } from './match/kpieePreview.js';
import { gatherSummary, buildSummaryDocx, buildSummaryMarkdown } from './summaryDoc.js';
import { buildRelationsReportHtml, summarizeReportQuestions } from './relationsReport.js';
import { addProjectDoc, listProjectDocs, deleteProjectDoc } from './projectDocs.js';
import {
  applyDeclaredFileRelations, proposeFileRelations, FILE_REL_TYPES, FILE_REL_LABELS,
  type DeclaredFileRel, type FileRelType,
} from './relations/declared.js';
import { startAsk as qaStartAsk, isAskPending as qaIsPending, getHistory as qaHistory } from './qa/agent.js';
import {
  loadReportSpec, saveReportSpec, reportSpecConfigured, reportChatHistory, reportChatPending,
  startReportChat, REPORT_CHAT_KICKOFF, type ProjectFacts,
} from './reportChat.js';
import { REPORT_ITEM_LABELS, REPORT_SECTION_LABELS } from './reportSpec.js';
import { invalidateBooks } from './qa/tools.js';
import { aiAvailable, callStructured, MODEL, estimateCostUsd } from './ai/client.js';
import { STEP_FLOW_SCHEMA } from './ai/schemas.js';
import {
  googleConfigured, fetchDriveArtifact, fetchDriveForRelations, clearStreamCache, listSpreadsheets, listFolderChildren, extractSpreadsheetId,
  oauthClientConfigured, connectionStatus, buildAuthUrl, exchangeCodeAndStore, disconnect, warmupDrive,
} from './google/drive.js';

const app = express();
// ALB/リバースプロキシ配下では TLS が LB で終端するため req.protocol が http に化ける。
// trust proxy を有効化して X-Forwarded-Proto を尊重させ、OAuth の redirect_uri を https で組める
// ようにする（さらに本番では GOOGLE_OAUTH_REDIRECT を明示して LB のホスト名で固定する）。
app.set('trust proxy', true);
// 本番は同一オリジン配信のため CORS は原則不要。CORS_ORIGIN（カンマ区切り）が指定されたときだけ
// そのオリジンに限定し、未指定なら従来どおり許可（ローカル開発の 5173→8787 用）。
const corsOrigins = process.env.CORS_ORIGIN?.split(',').map(s => s.trim()).filter(Boolean);
app.use(cors(corsOrigins && corsOrigins.length ? { origin: corsOrigins } : undefined));
app.use(express.json({ limit: '50mb' }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// ---- ヘルスチェック ----
// ALB/ECS 用の超軽量ヘルスチェック。DB にもフロント(web/dist)にも依存せず、
// 認証なしで即 200 を返す。DPB と同じ /healthz パスに合わせ、ターゲットグループの
// ヘルスチェックパスを両アプリで統一できるようにする（SPA フォールバックに紛れない）。
app.get('/healthz', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});
app.get('/api/health', async (_req, res) => {
  res.json({ ok: true, aiMode: aiAvailable() ? MODEL : 'mock', googleSheets: googleConfigured() });
});

// ---- プロジェクト（UC-01） ----
app.post('/api/projects', async (req, res) => {
  const { customer_name, description } = req.body as { customer_name?: string; description?: string };
  if (!customer_name) return res.status(400).json({ error: 'customer_name は必須です' });
  const result = await db.prepare(`INSERT INTO projects (customer_name, description) VALUES (?, ?)`)
    .run(customer_name, description ?? '');
  res.status(201).json(await db.prepare(`SELECT * FROM projects WHERE id = ?`).get(result.lastInsertRowid));
});

app.get('/api/projects', async (_req, res) => {
  // 一覧カードに照合一致率を出すため最新の match_results を結合する（SC-01）
  const projects = await db.prepare(`
    SELECT p.*,
      (SELECT CAST(matched_cells AS REAL) / NULLIF(total_cells, 0)
       FROM match_results m WHERE m.project_id = p.id ORDER BY m.id DESC LIMIT 1) AS match_rate
    FROM projects p ORDER BY p.id DESC
  `).all();
  res.json(projects);
});

// ---- 「人が確認した」印（project_flags）----
// 自動処理では立たない印だけを置く場所。新UI のステップ完了判定に使う。

/** 立っている印の一覧 */
async function projectFlags(projectId: number): Promise<string[]> {
  const rows = await db.prepare(`SELECT flag FROM project_flags WHERE project_id = ?`)
    .all(projectId) as { flag: string }[];
  return rows.map(r => r.flag);
}

async function setProjectFlag(projectId: number, flag: string): Promise<void> {
  // 既にあれば何もしない（PK 重複は無視。SQLite / pg で同じ形にするため事前確認する）
  const hit = await db.prepare(`SELECT flag FROM project_flags WHERE project_id = ? AND flag = ?`)
    .get(projectId, flag);
  if (!hit) await db.prepare(`INSERT INTO project_flags (project_id, flag) VALUES (?, ?)`).run(projectId, flag);
}

async function clearProjectFlag(projectId: number, flag: string): Promise<void> {
  await db.prepare(`DELETE FROM project_flags WHERE project_id = ? AND flag = ?`).run(projectId, flag);
}

const VALID_FLAGS = ['roles_confirmed'];

app.post('/api/projects/:id/flags/:flag', async (req, res) => {
  const flag = req.params.flag;
  if (!VALID_FLAGS.includes(flag)) return res.status(400).json({ error: `未知の flag: ${flag}` });
  await setProjectFlag(Number(req.params.id), flag);
  res.json({ ok: true, flags: await projectFlags(Number(req.params.id)) });
});

app.delete('/api/projects/:id/flags/:flag', async (req, res) => {
  await clearProjectFlag(Number(req.params.id), req.params.flag);
  res.json({ ok: true, flags: await projectFlags(Number(req.params.id)) });
});

app.get('/api/projects/:id', async (req, res) => {
  const project = await db.prepare(`SELECT * FROM projects WHERE id = ?`).get(req.params.id);
  if (!project) return res.status(404).json({ error: 'project not found' });
  const artifacts = await db.prepare(
    `SELECT id, kind, original_filename, parse_status, parse_error, sheet_roles, created_at FROM artifacts WHERE project_id = ?`,
  ).all(req.params.id);
  const runs = await db.prepare(
    `SELECT * FROM analysis_runs WHERE project_id = ? ORDER BY id DESC LIMIT 20`,
  ).all(req.params.id);
  const usage = await getProjectUsage(Number(req.params.id));
  res.json({
    ...project, artifacts, runs,
    flags: await projectFlags(Number(req.params.id)),
    usage: { ...usage, estimated_cost_usd: estimateCostUsd(usage) },
  });
});

// プロジェクト単位のトークン使用量・コスト（段階別内訳付き）
app.get('/api/projects/:id/usage', async (req, res) => {
  const usage = await getProjectUsage(Number(req.params.id));
  res.json({ ...usage, estimated_cost_usd: estimateCostUsd(usage), aiMode: aiAvailable() ? MODEL : 'mock' });
});

// プロジェクト削除: 関連レコード（成果物・解読・実行ログ等）とストレージを一括削除する
app.delete('/api/projects/:id', async (req, res) => {
  const projectId = Number(req.params.id);
  const project = await db.prepare(`SELECT id FROM projects WHERE id = ?`).get(projectId);
  if (!project) return res.status(404).json({ error: 'project not found' });
  // 外部キー制約のため子テーブルから順に削除する。
  // projects を参照する表を1つでも漏らすと pg では FK 違反で全体ロールバックし
  // 「削除ボタンが効かない」症状になる（chat_messages 等の追加漏れで実際に発生）。
  // 新しい project_id 参照表を足したら必ずここにも追加すること。
  await db.tx(async t => {
    await t.prepare(`DELETE FROM chat_messages WHERE project_id = ?`).run(projectId);
    await t.prepare(`DELETE FROM project_overviews WHERE project_id = ?`).run(projectId);
    await t.prepare(`DELETE FROM relation_graphs WHERE project_id = ?`).run(projectId);
    await t.prepare(`DELETE FROM ai_usage_logs WHERE project_id = ?`).run(projectId);
    await t.prepare(`DELETE FROM customer_questions WHERE project_id = ?`).run(projectId);
    await t.prepare(`DELETE FROM findings WHERE project_id = ?`).run(projectId);
    await t.prepare(`DELETE FROM analysis_runs WHERE project_id = ?`).run(projectId);
    await t.prepare(`DELETE FROM match_results WHERE project_id = ?`).run(projectId);
    await t.prepare(`DELETE FROM deliverables WHERE project_id = ?`).run(projectId);
    await t.prepare(`DELETE FROM project_scripts WHERE project_id = ?`).run(projectId);
    await t.prepare(`DELETE FROM project_flags WHERE project_id = ?`).run(projectId);
    await t.prepare(`DELETE FROM report_specs WHERE project_id = ?`).run(projectId);
    await t.prepare(`DELETE FROM report_chat_messages WHERE project_id = ?`).run(projectId);
    // file_relations は artifacts を参照するので artifacts より先に消す
    await t.prepare(`DELETE FROM file_relations WHERE project_id = ?`).run(projectId);
    await t.prepare(`DELETE FROM artifacts WHERE project_id = ?`).run(projectId);
    await t.prepare(`DELETE FROM projects WHERE id = ?`).run(projectId);
  });
  // アップロード原本・パース結果のファイルも削除（DB と独立しているため try で握りつぶす）
  try { removeObject(`project-${projectId}`); } catch { /* ストレージが無くても致命的でない */ }
  res.json({ ok: true });
});

// 原本を永続保存しないデプロイ運用（C3/C4）。ARTIFACT_EPHEMERAL=1 のとき有効。
// このとき原本バイト・パース結果 JSON はディスクに書かず、storage_key に Drive 参照だけを残し、
// 消費時に都度 Drive から取り直す。ローカル開発では無効（従来どおり保存）で検証容易性を保つ。
const ARTIFACT_EPHEMERAL = process.env.ARTIFACT_EPHEMERAL === '1';

// ファイル(buffer)を保存し前処理（§6.1）まで行う共通処理。アップロード／Google Sheet 取り込みで共用。
// driveFileId を渡し、かつ無保存モードのときは原本・パース結果を保存せず Drive 参照のみを記録する。
// source は「原本バイト」か「既に解析済みの構造」のいずれか。
// ネイティブ Google シートは xlsx 化をやめチャンク読みで直接解析するため原本バイトを持たない
// （2026-07-28: 78,942 行 × 99 列のシートで xlsx 直列化が OOM しプロセスが落ちた対策）。
type IngestSource = { kind: 'buffer'; buffer: Buffer } | { kind: 'parsed'; parsed: ParsedArtifact };

async function ingestArtifact(projectId: number, filename: string, source: IngestSource, kind: string, driveFileId?: string): Promise<number> {
  const ephemeral = ARTIFACT_EPHEMERAL && !!driveFileId;
  // 原本バイトが無い（ネイティブシート）場合はローカル保存できないので、常に Drive 参照キーにする
  const canStoreRaw = source.kind === 'buffer';
  const useDriveKey = (ephemeral || !canStoreRaw) && !!driveFileId;
  if (!canStoreRaw && !driveFileId) {
    throw new Error('原本バイトが無いアーティファクトには Drive 参照が必要です');
  }
  const rawKey = useDriveKey ? driveKey(driveFileId!) : `project-${projectId}/raw/${Date.now()}-${filename}`;
  if (!useDriveKey && source.kind === 'buffer') putObject(rawKey, source.buffer);
  const result = await db.prepare(`
    INSERT INTO artifacts (project_id, kind, original_filename, storage_key, parse_status)
    VALUES (?, ?, ?, ?, 'parsing')
  `).run(projectId, kind === 'auto' ? 'mixed' : kind, filename, rawKey);
  const artifactId = Number(result.lastInsertRowid);
  try {
    // パース自体は無保存モードでも一度は必要（シート役割の自動分類のため）。結果はメモリに留め永続化しない。
    // ネイティブシートは取得時点で解析が終わっているのでそれをそのまま使う。
    const parsed = source.kind === 'parsed' ? source.parsed : await parseArtifact(filename, source.buffer);
    let parsedKey: string | null = null;
    if (!ephemeral) {
      parsedKey = `project-${projectId}/parsed/${artifactId}.json`;
      putObject(parsedKey, JSON.stringify(parsed));
    }
    // 混在ファイルは参照グラフでシート役割を自動分類して保存する（役割は小さな派生結果なので保存可）
    const sheetRoles = kind === 'auto' ? JSON.stringify(classifySheetRoles(parsed)) : null;
    await db.prepare(`UPDATE artifacts SET parse_status = 'done', parsed_key = ?, sheet_roles = ? WHERE id = ?`)
      .run(parsedKey, sheetRoles, artifactId);
  } catch (e) {
    await db.prepare(`UPDATE artifacts SET parse_status = 'failed', parse_error = ? WHERE id = ?`).run(String(e), artifactId);
  }
  invalidateBooks(projectId); // Q&A 用ワークブックキャッシュを破棄（新規取込で内容が変わるため）
  await invalidateRelationGraph(projectId); // 関係グラフの保存キャッシュも破棄（アーティファクト変更で構造が変わる）
  // ファイルが増えたら分類の確認はやり直し。新しいファイルの役割は誰も見ていないため
  await clearProjectFlag(projectId, 'roles_confirmed');
  // 関係グラフの先行計算はここでは行わない（関係/要確認タブを開いた時に計算する）。
  // 以前は debounce 1.5 秒で「最後の取込の1回だけ」に纏める意図で呼んでいたが、取込1件が 1.5 秒より
  // 長いため実際には毎回発火し、そのたびにプロジェクト全ファイルを再取得・再パースしていた。
  // 実測: 8件バッチで先行計算に累積 135 秒（単発最大 37 秒）を費やし、しかも計算結果は次の取込の
  // invalidateRelationGraph が即破棄するため一度も使われない。無保存モードでは Drive 再ダウンロードも
  // 伴い、バッチ全体で数十回に達してレート制限の原因にもなっていた。
  return artifactId;
}

const VALID_KINDS = ['input_data', 'final_output', 'working_sheet', 'auto'];

// ---- アーティファクトアップロード（UC-02） ----
app.post('/api/projects/:id/artifacts', upload.single('file'), async (req, res) => {
  const projectId = Number(req.params.id);
  const kind = req.body.kind as string;
  // 無保存モードでは原本をサーバーに残さないため、参照先を持たないブラウザ直接アップロードは受け付けない
  // （取り込みは Drive 経由のみ）。C2/C3 の担保。
  if (ARTIFACT_EPHEMERAL) {
    return res.status(400).json({ error: 'このデプロイでは直接アップロードは無効です。Google ドライブから取り込んでください' });
  }
  if (!req.file) return res.status(400).json({ error: 'file は必須です' });
  if (!VALID_KINDS.includes(kind)) {
    return res.status(400).json({ error: 'kind は input_data / final_output / working_sheet / auto のいずれかです' });
  }
  const filename = Buffer.from(req.file.originalname, 'latin1').toString('utf-8');
  const artifactId = await ingestArtifact(projectId, filename, { kind: 'buffer', buffer: req.file.buffer }, kind);
  res.status(201).json(await db.prepare(
    `SELECT id, kind, original_filename, parse_status, parse_error, sheet_roles FROM artifacts WHERE id = ?`,
  ).get(artifactId));
});

// redirect_uri を組み立てる（OAuth クライアントに登録した値と完全一致させる）。
// 既定はサーバー自身のオリジン（例: http://localhost:8787/api/google/callback）。
function oauthRedirectUri(req: express.Request): string {
  return process.env.GOOGLE_OAUTH_REDIRECT || `${req.protocol}://${req.get('host')}/api/google/callback`;
}

// ---- Google Web ログイン（OAuth 2.0 認可コードフロー） ----
// 連携状態（UI のボタン出し分け用）
app.get('/api/google/status', async (_req, res) => {
  res.json(connectionStatus());
});

// ログイン開始 → Google 同意画面へリダイレクト
app.get('/api/google/auth', async (req, res) => {
  if (!oauthClientConfigured()) {
    return res.status(400).send('OAuth クライアント未設定です。server/.env に GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET を設定してサーバーを再起動してください。');
  }
  res.redirect(buildAuthUrl(oauthRedirectUri(req)));
});

// 同意後のコールバック → 認可コードを refresh_token に交換・保存し、Web アプリへ戻す
app.get('/api/google/callback', async (req, res) => {
  const webApp = process.env.WEB_APP_ORIGIN || 'http://localhost:5173';
  if (req.query.error) return res.redirect(`${webApp}/?google=denied`);
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  if (!code) return res.redirect(`${webApp}/?google=error`);
  try {
    await exchangeCodeAndStore(code, oauthRedirectUri(req));
    res.redirect(`${webApp}/?google=connected`);
  } catch (e) {
    res.redirect(`${webApp}/?google=error&msg=${encodeURIComponent(String(e))}`);
  }
});

// 連携解除（保存した refresh_token を破棄）
app.post('/api/google/disconnect', async (_req, res) => {
  disconnect();
  res.json({ ok: true });
});

// ドライブ内の Google スプレッドシート一覧（URL を貼らず選んで取り込むため）。名前検索は全ドライブ横断・平面。
app.get('/api/google/spreadsheets', async (req, res) => {
  if (!googleConfigured()) return res.status(400).json({ error: 'Google 連携が未設定です' });
  try {
    res.json(await listSpreadsheets(typeof req.query.q === 'string' ? req.query.q : undefined));
  } catch (e) {
    res.status(502).json({ error: String(e) });
  }
});

// フォルダ別ブラウズ: 指定フォルダ（既定=マイドライブ直下）のサブフォルダ + 表ファイルを返す。
app.get('/api/google/drive', async (req, res) => {
  if (!googleConfigured()) return res.status(400).json({ error: 'Google 連携が未設定です' });
  try {
    res.json(await listFolderChildren(typeof req.query.folder === 'string' ? req.query.folder : undefined));
  } catch (e) {
    res.status(502).json({ error: String(e) });
  }
});

// ---- Google スプレッドシート取り込み（リモート）----
// シート URL を受け取る。ネイティブシートは Sheets API を行チャンクで読みながら解析まで済ませ、
// アップロード済み xlsx / CSV は原本を落として通常のアップロードと同じ前処理に流す。
app.post('/api/projects/:id/import-sheet', async (req, res) => {
  const projectId = Number(req.params.id);
  const { url, kind } = req.body as { url?: string; kind?: string };
  if (!url) return res.status(400).json({ error: 'url は必須です' });
  const k = kind ?? 'auto';
  if (!VALID_KINDS.includes(k)) return res.status(400).json({ error: 'kind が不正です' });
  if (!googleConfigured()) {
    return res.status(400).json({ error: 'Google 連携が未設定です。対象アカウント本人が「Google でログイン」から同意し、Drive 連携を有効化してください' });
  }
  try {
    const art = await fetchDriveArtifact(url);
    // 無保存モードのために Drive のファイル ID を控える（storage_key を drive:<id> にして都度取得できるように）
    const driveFileId = extractSpreadsheetId(url) ?? undefined;
    const source: IngestSource = art.kind === 'parsed'
      ? { kind: 'parsed', parsed: art.parsed }
      : { kind: 'buffer', buffer: art.buffer };
    const artifactId = await ingestArtifact(projectId, art.filename, source, k, driveFileId);
    res.status(201).json(await db.prepare(
      `SELECT id, kind, original_filename, parse_status, parse_error, sheet_roles FROM artifacts WHERE id = ?`,
    ).get(artifactId));
  } catch (e) {
    res.status(502).json({ error: String(e) });
  }
});

// シート役割の手動修正（自動分類の検収）。body: { sheet_roles: { シート名: 役割 } }
app.patch('/api/artifacts/:id/roles', async (req, res) => {
  const { sheet_roles } = req.body as { sheet_roles?: Record<string, string> };
  if (!sheet_roles) return res.status(400).json({ error: 'sheet_roles は必須です' });
  // 語彙は classify.ts の SHEET_ROLE_LABELS を唯一の出典にする。
  // ここに配列を書き写すと役割を足したときに片方だけ古くなる（master_data 追加時に実際に起きた）。
  const valid = new Set(Object.keys(SHEET_ROLE_LABELS));
  for (const role of Object.values(sheet_roles)) {
    if (!valid.has(role)) {
      return res.status(400).json({ error: `役割が不正です: ${role}（${[...valid].join(' / ')} のいずれか）` });
    }
  }
  const row = await db.prepare(`SELECT sheet_roles FROM artifacts WHERE id = ?`).get(req.params.id) as { sheet_roles: string | null } | undefined;
  if (!row) return res.status(404).json({ error: 'artifact not found' });
  // 既存の分類結果（判定理由）を保ちつつ役割だけ上書きする。
  // 印は1回だけ付ける（保存ごとに足すと「（人が指定）（人が指定）…」と際限なく伸びる。
  // 新UI の「確定」は全シートを毎回保存するので、以前は実際に伸びていた）
  const MARK = '（人が指定）';
  const current = (row.sheet_roles ? JSON.parse(row.sheet_roles) : {}) as Record<string, SheetClassification>;
  for (const [name, role] of Object.entries(sheet_roles)) {
    const prev = current[name];
    const base = prev?.reason ? prev.reason.split(MARK)[0].trim() : '';
    const changed = !prev || prev.role !== role;
    current[name] = {
      role: role as SheetClassification['role'],
      // 役割を変えたときだけ印を付ける。自動判定のまま確定した行は理由をそのまま残す
      reason: base === '' ? MARK : changed || prev.reason.includes(MARK) ? `${base}${MARK}` : base,
      references: prev?.references ?? [],
      // 規模（行数・数式数）は取込時に入れた値をそのまま残す。ここで落とすと画面が
      // 原本を再パースして取り直すことになる
      rows: prev?.rows,
      formulas: prev?.formulas,
    };
  }
  await db.prepare(`UPDATE artifacts SET sheet_roles = ? WHERE id = ?`).run(JSON.stringify(current), req.params.id);
  res.json({ ok: true, sheet_roles: current });
});

app.delete('/api/artifacts/:id', async (req, res) => {
  const row = await db.prepare(`SELECT project_id FROM artifacts WHERE id = ?`).get(req.params.id) as { project_id: number } | undefined;
  // このファイルを端点に持つブック関係も一緒に消す（残すと FK 違反になり、宙に浮いた関係も無意味）
  await db.prepare(`DELETE FROM file_relations WHERE from_artifact_id = ? OR to_artifact_id = ?`)
    .run(req.params.id, req.params.id);
  await db.prepare(`DELETE FROM artifacts WHERE id = ?`).run(req.params.id);
  // 取消は「やり直す」意思表示なので、Drive ストリーミング読みの短期キャッシュも捨てて
  // 再取り込みが必ず最新のシートを読むようにする。
  clearStreamCache();
  if (row) { invalidateBooks(row.project_id); await invalidateRelationGraph(row.project_id); }
  res.json({ ok: true });
});

// シートプレビュー（SC-03 / SC-04 のシートビューア用）
app.get('/api/artifacts/:id/preview', async (req, res) => {
  const row = await db.prepare(`SELECT storage_key, parsed_key, original_filename, kind, sheet_roles FROM artifacts WHERE id = ?`)
    .get(req.params.id) as { storage_key: string; parsed_key: string | null; original_filename: string; kind: string; sheet_roles: string | null } | undefined;
  if (!row) return res.status(404).json({ error: 'artifact not found' });
  try {
    // 保存済みならその JSON、無保存モードなら Drive から取り直してメモリ上でパース
    const parsed = await materializeParsed(row);
    res.json({
      filename: row.original_filename,
      kind: row.kind,
      sheetRoles: row.sheet_roles ? JSON.parse(row.sheet_roles) : null,
      tableName: row.kind === 'input_data' ? tableNameOf(row.original_filename) : null,
      sheets: parsed.sheets.map(s => ({
        name: s.name,
        rowCount: s.rowCount,
        columnCount: s.columnCount,
        formulaCellCount: s.formulaCellCount,
        // プレビューは先頭 100 行に制限（巨大シート対策）
        rows: s.rows.slice(0, 100),
      })),
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

interface AiFinding { logic_type: string; kpiee_target: string; explanation: string; confidence: string; source_ref: string }
type LocalGraph = { regions: { id: string; sheet: string }[]; edges: { type: string; to: string }[]; [k: string]: unknown }

/** source_ref（例: "取込履歴!C2" / "階層構造レポート!A1 (GAS …)"）からシート名を取り出す */
function sheetOfRef(ref: string): string {
  return ref.split('!')[0].trim();
}

/**
 * ローカルの関係グラフ（骨格）に decode の findings を融合する。
 * - 各表領域(region)に、そのシートの AI解読項目を ai[] として添付（意味づけ）
 * - copy(値一致)辺には、提供先シートの AI解読をヒントとして添付（手修正誤検出の見極め用）
 * findings は decode 実行後に増えるためキャッシュせず毎回新しく合成する。
 */
async function attachAiFindings(base: LocalGraph, projectId: number): Promise<unknown> {
  const findings = await db.prepare(
    `SELECT source_ref, logic_type, kpiee_target, explanation, confidence FROM findings WHERE project_id = ?`,
  ).all(projectId) as AiFinding[];

  const bySheet = new Map<string, AiFinding[]>();
  for (const f of findings) {
    const sheet = sheetOfRef(f.source_ref);
    if (!bySheet.has(sheet)) bySheet.set(sheet, []);
    bySheet.get(sheet)!.push(f);
  }

  const regions = base.regions.map(r => {
    const fs = bySheet.get(r.sheet);
    return fs && fs.length ? { ...r, ai: fs } : r;
  });

  const regionSheetById = new Map(base.regions.map(r => [r.id, r.sheet]));
  const regionIdOf = (key: string) => key.slice(0, key.indexOf(':'));
  const edges = base.edges.map(e => {
    if (e.type !== 'copy') return e;
    const destSheet = regionSheetById.get(regionIdOf(e.to));
    const hint = destSheet ? bySheet.get(destSheet)?.[0]?.explanation : undefined;
    return hint ? { ...e, aiHint: hint } : e;
  });

  // 全体構造の自然言語サマリ（decode 実行時に生成・保存済み）を同梱する
  const ovRow = await db.prepare(`SELECT content FROM project_overviews WHERE project_id = ?`)
    .get(projectId) as { content: string } | undefined;
  const overview = ovRow ? JSON.parse(ovRow.content) : undefined;

  return { ...base, regions, edges, hasFindings: findings.length > 0, overview };
}

interface RelEdgeLike { from: string; to: string; type: string; confidence?: number; [k: string]: unknown }
interface CapGraph { regions: unknown[]; edges: RelEdgeLike[]; warnings?: unknown[]; [k: string]: unknown }

// 巨大ワークブック対策: 列レベルの辺が数万〜十数万件になるとレスポンスが数十MBになり
// ブラウザが描画不能(一覧テーブルが固まる)。小さいグラフ(<=上限)はそのまま、巨大グラフは
// 「(from領域→to領域, 種別)ごとに最も確信度の高い1辺」へ集約して一覧・転送量を圧縮する。
// SVG図は元々領域単位に集約して描くため、この圧縮後も構造は保たれる。
const EDGE_CAP = 2000;
const WARN_CAP = 300;
// 辺を「(from領域→to領域, 種別)ごとに最も確信度の高い1辺」へ集約する。上限以下なら素通し。
// キャッシュ保存前とレスポンス整形の両方で使う（＝巨大な生辺をメインで何度も舐めない）。
function collapseGraphEdges(edges: RelEdgeLike[]): { edges: RelEdgeLike[]; edgeTotal?: number; edgeCollapsed?: boolean } {
  if (edges.length <= EDGE_CAP) return { edges };
  const regionIdOf = (key: string) => key.slice(0, key.indexOf(':'));
  const best = new Map<string, RelEdgeLike>();
  for (const e of edges) {
    const k = `${regionIdOf(e.from)}->${regionIdOf(e.to)}:${e.type}`;
    const cur = best.get(k);
    if (!cur || (e.confidence ?? 0) > (cur.confidence ?? 0)) best.set(k, e);
  }
  let collapsed = [...best.values()];
  if (collapsed.length > EDGE_CAP) {
    collapsed = collapsed.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0)).slice(0, EDGE_CAP);
  }
  return { edges: collapsed, edgeTotal: edges.length, edgeCollapsed: true };
}

function capGraphForResponse(g: CapGraph): CapGraph {
  const warnings = (g.warnings ?? []) as unknown[];
  const { edges, edgeTotal, edgeCollapsed } = collapseGraphEdges(g.edges);
  const capWarn = warnings.length > WARN_CAP;
  if (!edgeCollapsed && !capWarn) return g;
  return {
    ...g,
    edges,
    ...(edgeCollapsed ? { edgeTotal, edgeCollapsed } : {}),
    ...(capWarn ? { warnings: warnings.slice(0, WARN_CAP), warningTotal: warnings.length } : {}),
  };
}

// 保存前に辺だけを集約する（warnings・sheetStructures は /要確認 が全件必要なのでそのまま）。
// これで巨大プロジェクトでもキャッシュ本体が小さくなり、キャッシュ命中時の JSON.parse と
// attachAiFindings/capGraphForResponse がメインを長く止めなくなる。
function collapseEdgesForCache(g: RelationGraph): RelationGraph {
  const { edges, edgeTotal, edgeCollapsed } = collapseGraphEdges(g.edges as unknown as RelEdgeLike[]);
  if (!edgeCollapsed) return g;
  return { ...g, edges: edges as unknown as RelationGraph['edges'], edgeTotal, edgeCollapsed };
}

// 関係グラフを（キャッシュ優先で）取得する共通処理。relations 表示と「要確認」集計で共用する。
// 関係グラフは「完成した派生結果物」（原本の数値を含まず、数式テキスト・構造のみ）なので DB に保存し、
// アーティファクト集合が変わらない限り再計算せず即返す（findings 等と同じ保存許容等級）。原本そのもの
// （raw バイト・全構造化 JSON）は保存しない方針（C3/C5）は不変で、キャッシュミス時のみ Drive から取り直す。
// 進行中の再計算（プロジェクト単位）。関係グラフの再計算は CPU 重量級で、複数タブ・複数人が
// 関係図/要確認を同時に開くと同じ計算が並走してイベントループを長時間塞ぎ、ヘルスチェック失敗
// →タスク再起動→また再計算… の悪循環になる（2026-07-15 の全体遅延の原因）。
// single-flight: 同じプロジェクトの再計算は 1 本だけ走らせ、後続リクエストはその完了を待って相乗りする。
const relationGraphInflight = new Map<number, Promise<{ graph: Awaited<ReturnType<typeof analyzeArtifacts>>; fileCount: number } | null>>();

async function loadProjectRelationGraph(projectId: number): Promise<{ graph: Awaited<ReturnType<typeof analyzeArtifacts>>; fileCount: number } | null> {
  const inflight = relationGraphInflight.get(projectId);
  if (inflight) return inflight;
  const p = loadProjectRelationGraphUncached(projectId)
    .finally(() => relationGraphInflight.delete(projectId));
  relationGraphInflight.set(projectId, p);
  return p;
}

// 取込後の関係グラフ先行計算（debounce 付き）。連続アップロードのたびに再計算しないよう、
// 最後の取込から一定時間後に1回だけワーカー計算を起動してキャッシュを温める。
/**
 * 関係分析ワーカーへ渡す1ファイル分を用意する。
 * ネイティブ Google シートは原本バイトを持たないので、Drive からチャンク読みして格子を作る。
 * 行を絞ったシートはヘッダー＋標本＋数式行だけの格子になり、表領域（ノード）としては登録されるが
 * 手修正指紋（列の値が長さ・順序込みで完全一致）は成立しないので計算対象から外す。
 * 実際の総行数は rowTotals で渡し、表の規模が実物どおり表示されるようにする。
 */
async function relationSourceOf(r: { storage_key: string; original_filename: string }): Promise<WorkerFile> {
  if (!isDriveKey(r.storage_key)) {
    return { filename: r.original_filename, buffer: await materializeBuffer(r.storage_key) };
  }
  const src = await fetchDriveForRelations(driveIdOf(r.storage_key), fileLabelOf(r.original_filename));
  if (src.kind === 'buffer') return { filename: r.original_filename, buffer: src.buffer };
  return {
    filename: r.original_filename,
    grids: src.grids,
    rowTotals: src.rowTotals,
    skipFingerprintSheets: src.truncatedSheets,
  };
}

async function loadProjectRelationGraphUncached(projectId: number): Promise<{ graph: Awaited<ReturnType<typeof analyzeArtifacts>>; fileCount: number } | null> {
  const rows = await db.prepare(
    `SELECT id, storage_key, original_filename FROM artifacts WHERE project_id = ? AND parse_status = 'done' AND storage_key IS NOT NULL`,
  ).all(projectId) as { id: number; storage_key: string; original_filename: string }[];
  const supported = rows.filter(r => /\.(xlsx|xlsm|csv)$/i.test(r.original_filename));
  if (supported.length === 0) return null;
  const signature = artifactSetSignature(supported);
  let graph = await getCachedRelationGraph(projectId, signature);
  if (!graph) {
    // キャッシュ無し／古い → 解析して保存。解析はワーカースレッドで行い、CPU 重量級の処理が
    // メインのイベントループ（一覧配信・ヘルスチェック）を止めないようにする。原本の取得は load() でメイン側。
    const full = await analyzeArtifactsInWorker(
      supported.map(r => ({ filename: r.original_filename, load: () => relationSourceOf(r) })),
    );
    // 巨大グラフは保存前に辺を集約（warnings/構造は全件維持）。キャッシュを小さく保ち、
    // 命中時の JSON.parse と後段処理がメインを詰まらせないようにする。
    graph = collapseEdgesForCache(full);
    await setCachedRelationGraph(projectId, signature, graph);
  }
  return { graph, fileCount: supported.length };
}

// ---- ブック（ファイル）関係: 担当者が確定した業務知識の層 ----
// 解析結果（キャッシュ）とは独立に持ち、読み出しのたびに重ねる。
// 宣言を編集しても CPU 重量級の再解析は起きない（relationsCache の署名には含めない）。
interface FileRelRow {
  id: number; from_artifact_id: number; to_artifact_id: number;
  rel_type: string; note: string; origin: string;
  // 作成手順の層（手順書をいただけた案件だけ入る）
  step: number | null; step_title: string | null; adds: string | null;
}

/** 解析対象になるアーティファクト（関係グラフの file ラベルと対応づくもの）を返す */
async function relationArtifacts(projectId: number): Promise<{ id: number; original_filename: string; kind: string; sheet_roles: string | null }[]> {
  const rows = await db.prepare(
    `SELECT id, original_filename, kind, sheet_roles FROM artifacts WHERE project_id = ? ORDER BY id`,
  ).all(projectId) as { id: number; original_filename: string; kind: string; sheet_roles: string | null }[];
  return rows.filter(r => /\.(xlsx|xlsm|csv)$/i.test(r.original_filename));
}

/**
 * artifacts.sheet_roles（`{シート名: {role}}` の JSON）を `{シート名: role}` へ平す。
 * 未設定（kind を全シートへ適用する従来動作）は undefined を返し、呼び出し側で kind を使わせる。
 * pipeline/orchestrator.ts の rolesOf() と同じ規則。
 */
function parseSheetRoles(raw: string | null): Record<string, string> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, { role: string }>;
    return Object.fromEntries(Object.entries(parsed).map(([name, c]) => [name, c.role]));
  } catch {
    return undefined;
  }
}

/** 登録済みブック関係を、関係グラフ側のキー（fileLabelOf ラベル）へ解決して返す */
async function loadDeclaredFileRels(projectId: number): Promise<DeclaredFileRel[]> {
  const [rows, arts] = await Promise.all([
    db.prepare(
      `SELECT id, from_artifact_id, to_artifact_id, rel_type, note, origin, step, step_title, adds
         FROM file_relations WHERE project_id = ? ORDER BY step NULLS LAST, id`,
    ).all(projectId) as Promise<FileRelRow[]>,
    relationArtifacts(projectId),
  ]);
  const labelOf = new Map(arts.map(a => [a.id, fileLabelOf(a.original_filename)]));
  const out: DeclaredFileRel[] = [];
  for (const r of rows) {
    const fromFile = labelOf.get(r.from_artifact_id);
    const toFile = labelOf.get(r.to_artifact_id);
    if (!fromFile || !toFile) continue; // 参照先が削除済み・解析対象外なら無視する
    out.push({
      id: r.id, fromFile, toFile,
      relType: (FILE_REL_TYPES as string[]).includes(r.rel_type) ? r.rel_type as FileRelType : 'unknown',
      note: r.note ?? '', origin: r.origin === 'auto' ? 'auto' : 'manual',
      // 0 や NaN は「未入力」と同じ扱いにする（レポート側はステップの有無で描き方を変える）
      step: Number(r.step) > 0 ? Number(r.step) : undefined,
      stepTitle: r.step_title?.trim() || undefined,
      adds: r.adds?.trim() || undefined,
    });
  }
  return out;
}

/** 関係グラフに確定済みブック関係を重ねて返す。関係表示・要確認・レポートの共通入口 */
async function loadRelationGraphWithDeclarations(projectId: number) {
  const loaded = await loadProjectRelationGraph(projectId);
  if (!loaded) return null;
  const declared = await loadDeclaredFileRels(projectId);
  return { ...loaded, graph: applyDeclaredFileRelations(loaded.graph, declared) };
}

// プロジェクト全体のシート関係性グラフ。アップロード済みの全ファイル(xlsx/csv)を1パスで解析し、
// ファイルをまたぐ手修正関係も検出する。ファイルが1つなら自然にそのファイル単体の解析になる。
app.get('/api/projects/:id/relations', async (req, res) => {
  const projectId = Number(req.params.id);
  try {
    const loaded = await loadRelationGraphWithDeclarations(projectId);
    if (!loaded) return res.json({ regions: [], edges: [], warnings: [], fileCount: 0 });
    const base: LocalGraph = { ...loaded.graph, fileCount: loaded.fileCount };
    // 骨格グラフに AI解読（findings）を融合し、巨大グラフは転送前に集約する。findings は独立に変わりうるため毎回融合する。
    res.json(capGraphForResponse((await attachAiFindings(base, projectId)) as CapGraph));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// 「要確認」集計: 関係グラフの警告（手入力混入など）を全件（キャップなし）、
// ファイル→シート→列 に集約して返す。フラットな数千行の羅列では確認不能なため、
// シート単位のカード＋列チップで俯瞰できる形に整えるのが目的（UI は AttentionPanel）。
app.get('/api/projects/:id/attention', async (req, res) => {
  const projectId = Number(req.params.id);
  try {
    const loaded = await loadRelationGraphWithDeclarations(projectId);
    if (!loaded) return res.json({ total: 0, kinds: [], groups: [] });
    const warnings = loaded.graph.warnings ?? [];
    // ref は `ファイル／シート#n:列`。region id は ':' を含まないので最初の ':' で列名を分離できる
    const parse = (ref: string) => {
      const ci = ref.indexOf(':');
      const regionId = ci >= 0 ? ref.slice(0, ci) : ref;
      const column = ci >= 0 ? ref.slice(ci + 1) : '';
      const m = /^(.*)／(.*)#\d+$/.exec(regionId);
      return { file: m?.[1] ?? '', sheet: m?.[2] ?? regionId, column };
    };
    const groups = new Map<string, { kind: string; file: string; sheet: string; count: number; columns: string[]; seen: Set<string> }>();
    const kindCount = new Map<string, number>();
    for (const w of warnings) {
      const { file, sheet, column } = parse(w.ref);
      kindCount.set(w.kind, (kindCount.get(w.kind) ?? 0) + 1);
      const key = `${w.kind}\u0000${file}\u0000${sheet}`;
      let g = groups.get(key);
      if (!g) { g = { kind: w.kind, file, sheet, count: 0, columns: [], seen: new Set() }; groups.set(key, g); }
      g.count++;
      if (column && !g.seen.has(column)) { g.seen.add(column); g.columns.push(column); }
    }
    res.json({
      total: warnings.length,
      fileCount: loaded.fileCount,
      kinds: [...kindCount.entries()].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count),
      groups: [...groups.values()]
        .map(({ seen: _seen, ...g }) => g)
        .sort((a, b) => b.count - a.count),
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// 顧客共有用「データ構造 分析レポート」(自己完結 HTML) のダウンロード。
// 画面の関係表示はそのまま、読み合わせ用のファイル出力だけを追加する位置づけ。
// 生成は保存済み関係グラフから決定的（AI 呼び出しなし）。原本の数値は含まれない。
app.get('/api/projects/:id/relations/report', async (req, res) => {
  const projectId = Number(req.params.id);
  try {
    const loaded = await loadRelationGraphWithDeclarations(projectId);
    if (!loaded) return res.status(404).json({ error: '関係分析できるファイル（.xlsx/.csv）がまだありません' });
    const project = await db.prepare(`SELECT customer_name FROM projects WHERE id = ?`)
      .get(projectId) as { customer_name: string } | undefined;
    const customerName = project?.customer_name ?? '';
    // 取込時の種別指定（kind）とシート役割（sheet_roles）を渡す。「どれが最終アウトプットか」
    // 「各シートが raw / 中間 / 帳票 のどれか」は業務知識であり自動推定で当てるものではないため、
    // 入力された内容をレポート 01 の正解として使う。
    const arts = await relationArtifacts(projectId);
    const html = buildRelationsReportHtml({
      customerName,
      generatedAt: new Date(),
      fileCount: loaded.fileCount,
      graph: loaded.graph,
      artifacts: arts.map(a => ({
        filename: a.original_filename,
        kind: a.kind,
        sheetRoles: parseSheetRoles(a.sheet_roles),
      })),
      declaredFileRels: loaded.graph.declaredFileRels,
      fileRelAudit: loaded.graph.fileRelAudit,
      // アウトプット相談で決めた構成。未登録なら既定（全部出す）＝従来と同じ内容
      spec: await loadReportSpec(projectId),
    });
    const date = new Date().toISOString().slice(0, 10);
    // ?inline=1 は画面プレビュー（iframe）用。ダウンロードさせずそのまま表示する
    if (req.query.inline !== '1') {
      // ファイル名に使えない文字を除去。ASCII フォールバック + RFC5987 の両方を付ける
      const safeName = `データ構造分析レポート_${customerName || `project${projectId}`}_${date}.html`.replace(/[\\/:*?"<>|]/g, '_');
      res.setHeader('Content-Disposition',
        `attachment; filename="relations-report-${projectId}-${date}.html"; filename*=UTF-8''${encodeURIComponent(safeName)}`);
    }
    res.type('html').send(html);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ---- アウトプット相談（レポートに何を載せるか）----
// 案件ごとに欲しい内容が違うため、デザイン固定・構成可変にする。指定は画面のチェックでも
// AI との相談でも作れる。生成時に relations/report が読んで反映する。

/** 相談の前提（解析結果の要約）。AI プロンプトと画面の要約に同じものを使う */
async function reportFacts(projectId: number): Promise<ProjectFacts> {
  const project = await db.prepare(`SELECT customer_name FROM projects WHERE id = ?`)
    .get(projectId) as { customer_name: string } | undefined;
  const arts = await relationArtifacts(projectId);
  const loaded = await loadRelationGraphWithDeclarations(projectId);
  const files = arts.map(a => ({
    filename: a.original_filename,
    kind: a.kind,
    sheetRoles: parseSheetRoles(a.sheet_roles) ?? null,
  }));
  if (!loaded) {
    return {
      customerName: project?.customer_name ?? '', files,
      regionCount: 0, edgeCount: 0, copyPairCount: 0, questionCount: 0,
      declaredRelCount: 0, multiFile: files.length > 1,
    };
  }
  const edges = loaded.graph.edges ?? [];
  const copyPairs = new Set(edges.filter(e => e.type === 'copy').map(e => `${e.from}\u0000${e.to}`));
  const q = summarizeReportQuestions({
    customerName: project?.customer_name ?? '',
    generatedAt: new Date(),
    fileCount: loaded.fileCount,
    graph: loaded.graph,
    artifacts: files.map(f => ({ filename: f.filename, kind: f.kind, sheetRoles: f.sheetRoles ?? undefined })),
    declaredFileRels: loaded.graph.declaredFileRels,
    fileRelAudit: loaded.graph.fileRelAudit,
  });
  return {
    customerName: project?.customer_name ?? '',
    files,
    regionCount: (loaded.graph.regions ?? []).length,
    edgeCount: loaded.graph.edgeTotal ?? edges.length,
    copyPairCount: copyPairs.size,
    questionCount: q.count,
    declaredRelCount: (loaded.graph.declaredFileRels ?? []).length,
    multiFile: loaded.fileCount > 1,
  };
}

/**
 * 現在の構成指定＋項目カタログ。DB を1行読むだけなので軽い。
 * 解析結果の要約（facts）はここに含めない — 関係グラフの読み込みと確認事項の再計算が入り、
 * チェックを1つ付け替えるたびに数秒待たされていた（画面は facts を別途1回だけ取る）。
 */
app.get('/api/projects/:id/report-spec', async (req, res) => {
  const projectId = Number(req.params.id);
  try {
    res.json({
      spec: await loadReportSpec(projectId),
      configured: await reportSpecConfigured(projectId),
      sectionLabels: REPORT_SECTION_LABELS,
      itemLabels: REPORT_ITEM_LABELS,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/** 解析結果の要約（重い。関係グラフを読む）。画面表示と AI 相談の前提に使う */
app.get('/api/projects/:id/report-facts', async (req, res) => {
  try {
    res.json({ facts: await reportFacts(Number(req.params.id)) });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/** 画面のチェック操作から直接保存する（部分指定可。AI 相談と同じ正規化を通る） */
app.put('/api/projects/:id/report-spec', async (req, res) => {
  try {
    res.json({ spec: await saveReportSpec(Number(req.params.id), req.body) });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/** 相談履歴。回答生成は非同期なので pending で状態を返す（Q&A と同じ方式） */
app.get('/api/projects/:id/report-chat', async (req, res) => {
  const projectId = Number(req.params.id);
  try {
    res.json({
      messages: await reportChatHistory(projectId),
      pending: reportChatPending(projectId),
      spec: await loadReportSpec(projectId),
      kickoff: REPORT_CHAT_KICKOFF,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post('/api/projects/:id/report-chat', async (req, res) => {
  const projectId = Number(req.params.id);
  const { message } = req.body as { message?: string };
  const text = message?.trim() || REPORT_CHAT_KICKOFF;
  try {
    res.status(202).json(await startReportChat(projectId, text, await reportFacts(projectId)));
  } catch (e) {
    res.status(409).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ---- ブック（ファイル）関係の登録 ----
// シート単位の自動解析より上位の入力段階。自動検出は初期案として提示するだけで、確定するのは人。
// 確定した関係は loadRelationGraphWithDeclarations で毎回グラフへ重ねられる（キャッシュは触らない）。

/** 一覧: 対象ファイル・登録済み関係・初期案・突き合わせ結果 */
app.get('/api/projects/:id/file-relations', async (req, res) => {
  const projectId = Number(req.params.id);
  try {
    const arts = await relationArtifacts(projectId);
    const files = arts.map(a => ({
      id: a.id,
      filename: a.original_filename,
      label: fileLabelOf(a.original_filename),
      kind: a.kind,
      sheetRoles: parseSheetRoles(a.sheet_roles) ?? null,
    }));
    const declared = await loadDeclaredFileRels(projectId);
    // ラベル → artifact id（画面から「確定」する時に id で投げ返せるようにする）
    const idOfLabel = new Map(files.map(f => [f.label, f.id]));
    const loaded = await loadProjectRelationGraph(projectId);
    const proposed = loaded
      ? proposeFileRelations(loaded.graph, declared).map(p => ({
          ...p,
          fromArtifactId: idOfLabel.get(p.fromFile) ?? null,
          toArtifactId: idOfLabel.get(p.toFile) ?? null,
        })).filter(p => p.fromArtifactId !== null && p.toArtifactId !== null)
      : [];
    const audit = loaded ? applyDeclaredFileRelations(loaded.graph, declared).fileRelAudit : [];
    res.json({ files, declared, proposed, audit, relTypes: FILE_REL_LABELS });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/** 1件の登録内容を検証する。問題があればメッセージ、無ければ null */
async function validateFileRel(projectId: number, fromId: number, toId: number, relType: string): Promise<string | null> {
  if (!Number.isFinite(fromId) || !Number.isFinite(toId)) return 'from / to のファイルを指定してください';
  if (fromId === toId) return '同じファイルどうしは登録できません（ファイル内の流れはシート関係で表示されます）';
  if (!(FILE_REL_TYPES as string[]).includes(relType)) {
    return `種別は ${FILE_REL_TYPES.join(' / ')} のいずれかです`;
  }
  const ids = (await relationArtifacts(projectId)).map(a => a.id);
  if (!ids.includes(fromId) || !ids.includes(toId)) return '指定されたファイルがこのプロジェクトにありません';
  return null;
}

/** 手順の入力を正規化する。ステップ番号は 1〜99 の整数だけ受け、それ以外は未入力とみなす */
function normStepInput(body: { step?: unknown; stepTitle?: unknown; adds?: unknown }): {
  step: number | null; stepTitle: string; adds: string;
} {
  const n = Math.trunc(Number(body.step));
  return {
    step: Number.isFinite(n) && n >= 1 && n <= 99 ? n : null,
    stepTitle: typeof body.stepTitle === 'string' ? body.stepTitle.trim().slice(0, 60) : '',
    adds: typeof body.adds === 'string' ? body.adds.trim().slice(0, 120) : '',
  };
}

app.post('/api/projects/:id/file-relations', async (req, res) => {
  const projectId = Number(req.params.id);
  const { fromArtifactId, toArtifactId, relType, note, origin } = req.body as {
    fromArtifactId?: number; toArtifactId?: number; relType?: string; note?: string; origin?: string;
  };
  const fromId = Number(fromArtifactId); const toId = Number(toArtifactId);
  const type = relType ?? 'unknown';
  const err = await validateFileRel(projectId, fromId, toId, type);
  if (err) return res.status(400).json({ error: err });
  const st = normStepInput(req.body as Record<string, unknown>);
  // 同じ向きの重複登録は作らない（初期案の「確定」を二度押しても増えない）
  const dup = await db.prepare(
    `SELECT id FROM file_relations WHERE project_id = ? AND from_artifact_id = ? AND to_artifact_id = ?`,
  ).get(projectId, fromId, toId) as { id: number } | undefined;
  if (dup) {
    await db.prepare(`UPDATE file_relations SET rel_type = ?, note = ?, step = ?, step_title = ?, adds = ? WHERE id = ?`)
      .run(type, note ?? '', st.step, st.stepTitle, st.adds, dup.id);
    return res.json({ ok: true, id: dup.id, updated: true });
  }
  const result = await db.prepare(
    `INSERT INTO file_relations (project_id, from_artifact_id, to_artifact_id, rel_type, note, origin, step, step_title, adds)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(projectId, fromId, toId, type, note ?? '', origin === 'auto' ? 'auto' : 'manual',
    st.step, st.stepTitle, st.adds);
  res.json({ ok: true, id: Number(result.lastInsertRowid) });
});

/** 手順書から読み取った1件の受け渡し（保存前の案） */
interface StepFlowProposal {
  step: number; stepTitle: string; fromFile: string; toFile: string;
  relType: string; adds: string; note: string;
}

/**
 * 手順書（業務資料）から作成手順を読み取り、ブック関係の案として返す。保存はしない。
 *
 * なぜ必要か:
 *   「①へ⑧から部門コードを付与」のような作業手順は数式にはどこにも残らない。ここを人が
 *   1件ずつ画面へ入れ直すのは、手順書を貰っているのに二度手間になる。資料はすでに
 *   「業務資料」として取り込めるので、その本文からステップ付きの受け渡しを起こす。
 *   確定は人が行う（自動保存しない）— 読み取り違いをそのまま顧客レポートへ載せないため。
 */
app.post('/api/projects/:id/file-relations/from-docs', async (req, res) => {
  const projectId = Number(req.params.id);
  try {
    if (!aiAvailable()) {
      return res.status(400).json({ error: 'ANTHROPIC_API_KEY が未設定のため、手順書の読み取りは使えません' });
    }
    const arts = await relationArtifacts(projectId);
    if (arts.length === 0) return res.status(400).json({ error: '関係を登録できるファイルがまだありません' });
    const docs = (await listProjectDocs(projectId)).filter(d => d.content.trim() !== '');
    if (docs.length === 0) {
      return res.status(400).json({ error: '業務資料が登録されていません。手順書（txt / docx / md）を先にアップロードしてください' });
    }
    const fileList = arts.map(a => `- ${a.original_filename}`).join('\n');
    const body = docs.map(d => `<doc name="${d.filename}">\n${d.content}\n</doc>`).join('\n');
    const instruction = [
      '次の業務資料から、ファイル間の受け渡しを「作成手順」として取り出してください。',
      '',
      '守ること:',
      '- fromFile / toFile は、下の受領ファイル一覧にある名前をそのまま使う（言い換え・省略をしない）',
      '- 資料に書かれていない受け渡しは作らない。書かれている順番をステップ番号にする',
      '- 「①に③から管理料を付与」のような書き方は、from=③ / to=① と読む（付与される側が to）',
      '- 一覧に無いファイルが出てきたら、そのファイル名のまま返す（こちらで突き合わせます）',
      '- adds には、その受け渡しで to 側に増える列・項目だけを書く。計算式の説明は note へ',
      '',
      `<received_files>\n${fileList}\n</received_files>`,
      `<docs>\n${body}\n</docs>`,
    ].join('\n');
    const result = await callStructured<{ steps: StepFlowProposal[] }>(
      projectId, 'step-flow', instruction, STEP_FLOW_SCHEMA as unknown as Record<string, unknown>,
    );

    // ファイル名 → artifact id へ解決する。完全一致 → ラベル一致 → 記号・空白を落とした一致の順。
    // 解決できなかったものは捨てずに返し、画面で「どのファイルか」を選べるようにする。
    const norm = (s: string) => s.replace(/\.[A-Za-z0-9]+$/, '').replace(/[\s　_\-.]/g, '').toLowerCase();
    const byExact = new Map(arts.map(a => [a.original_filename, a.id]));
    const byLabel = new Map(arts.map(a => [fileLabelOf(a.original_filename), a.id]));
    const byNorm = new Map(arts.map(a => [norm(a.original_filename), a.id]));
    const idOf = (name: string): number | null =>
      byExact.get(name) ?? byLabel.get(fileLabelOf(name)) ?? byNorm.get(norm(name)) ?? null;
    const proposals = result.data.steps.map(s => ({
      ...s,
      relType: (FILE_REL_TYPES as string[]).includes(s.relType) ? s.relType : 'unknown',
      fromArtifactId: idOf(s.fromFile),
      toArtifactId: idOf(s.toFile),
    }));
    res.json({
      proposals,
      // 読み取れたが受領ファイルに無い名前（未受領のファイルを指している可能性がある）
      unresolved: [...new Set(proposals.flatMap(p =>
        [p.fromArtifactId === null ? p.fromFile : '', p.toArtifactId === null ? p.toFile : ''].filter(Boolean)))],
      docCount: docs.length,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/** 初期案の一括確定（ファイルが多い案件で1件ずつ押させないため） */
app.post('/api/projects/:id/file-relations/accept-all', async (req, res) => {
  const projectId = Number(req.params.id);
  try {
    const loaded = await loadProjectRelationGraph(projectId);
    if (!loaded) return res.json({ ok: true, added: 0 });
    const arts = await relationArtifacts(projectId);
    const idOfLabel = new Map(arts.map(a => [fileLabelOf(a.original_filename), a.id]));
    const declared = await loadDeclaredFileRels(projectId);
    const proposals = proposeFileRelations(loaded.graph, declared);
    let added = 0;
    await db.tx(async t => {
      const insert = t.prepare(
        `INSERT INTO file_relations (project_id, from_artifact_id, to_artifact_id, rel_type, note, origin) VALUES (?, ?, ?, ?, ?, 'auto')`,
      );
      for (const p of proposals) {
        const fromId = idOfLabel.get(p.fromFile); const toId = idOfLabel.get(p.toFile);
        if (fromId === undefined || toId === undefined) continue;
        await insert.run(projectId, fromId, toId, p.relType, p.reason);
        added++;
      }
    });
    res.json({ ok: true, added });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.patch('/api/file-relations/:id', async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const relType = typeof body.relType === 'string' ? body.relType : undefined;
  const note = typeof body.note === 'string' ? body.note : undefined;
  const row = await db.prepare(
    `SELECT project_id, rel_type, note, step, step_title, adds FROM file_relations WHERE id = ?`,
  ).get(req.params.id) as {
    project_id: number; rel_type: string; note: string;
    step: number | null; step_title: string | null; adds: string | null;
  } | undefined;
  if (!row) return res.status(404).json({ error: 'file relation not found' });
  const type = relType ?? row.rel_type;
  if (!(FILE_REL_TYPES as string[]).includes(type)) {
    return res.status(400).json({ error: `種別は ${FILE_REL_TYPES.join(' / ')} のいずれかです` });
  }
  // 手順の3項目は、送られてきた項目だけを書き換える（説明だけ直したときにステップが消えないように）
  const st = normStepInput(body);
  const step = 'step' in body ? st.step : row.step;
  const stepTitle = 'stepTitle' in body ? st.stepTitle : (row.step_title ?? '');
  const adds = 'adds' in body ? st.adds : (row.adds ?? '');
  // 修正した時点で「人が確認したもの」になるので origin を manual に上げる
  await db.prepare(
    `UPDATE file_relations SET rel_type = ?, note = ?, step = ?, step_title = ?, adds = ?, origin = 'manual' WHERE id = ?`,
  ).run(type, note ?? row.note, step, stepTitle, adds, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/file-relations/:id', async (req, res) => {
  await db.prepare(`DELETE FROM file_relations WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

// （単一ファイル版。デバッグ・互換用。通常は上のプロジェクト全体版を使う）xlsx のみ
app.get('/api/artifacts/:id/relations', async (req, res) => {
  const row = await db.prepare(`SELECT storage_key, original_filename FROM artifacts WHERE id = ?`)
    .get(req.params.id) as { storage_key: string | null; original_filename: string } | undefined;
  if (!row?.storage_key) return res.status(404).json({ error: 'artifact not found' });
  if (!/\.(xlsx|xlsm)$/i.test(row.original_filename)) {
    return res.json({ filename: row.original_filename, supported: false, regions: [], edges: [], warnings: [] });
  }
  try {
    const graph = await analyzeBuffer(await materializeBuffer(row.storage_key));
    res.json({ filename: row.original_filename, supported: true, ...graph });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ---- Apps Script（GAS）等、xlsx に保存されない変換ロジックの登録 ----
// 例: シートを生成する .gs 関数。decode/generate 時に <apps_scripts> として AI へ渡す。
app.get('/api/projects/:id/scripts', async (req, res) => {
  res.json(await db.prepare(
    `SELECT id, name, code, created_at FROM project_scripts WHERE project_id = ? ORDER BY id`,
  ).all(req.params.id));
});

app.post('/api/projects/:id/scripts', async (req, res) => {
  const { name, code } = req.body as { name?: string; code?: string };
  if (!code || !code.trim()) return res.status(400).json({ error: 'code は必須です' });
  const result = await db.prepare(`INSERT INTO project_scripts (project_id, name, code) VALUES (?, ?, ?)`)
    .run(req.params.id, name ?? '', code);
  res.status(201).json(await db.prepare(`SELECT id, name, code, created_at FROM project_scripts WHERE id = ?`)
    .get(result.lastInsertRowid));
});

app.delete('/api/scripts/:id', async (req, res) => {
  await db.prepare(`DELETE FROM project_scripts WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

// ---- 業務資料（要件定義書・運用手順書・引継ぎメモ等）----
// データ（xlsx/csv）とは別の入り口。表構造を持たないので関係分析・シート役割判定には混ぜず、
// 本文だけを AI の解読・提案の前提として渡す（<reference_docs>）。
// 数式からは絶対に読み取れない業務ルール（読み替え・例外・手作業の手順）がここに書かれている。
app.get('/api/projects/:id/docs', async (req, res) => {
  const docs = await listProjectDocs(Number(req.params.id));
  // 一覧では本文を返さない（数十万字になりうるため）。長さだけ添えて「効いているか」を示す
  res.json(docs.map(d => ({
    id: d.id, filename: d.filename, byte_size: d.byte_size,
    text_length: d.content.length, extract_error: d.extract_error, created_at: d.created_at,
  })));
});

app.post('/api/projects/:id/docs', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file は必須です' });
  const projectId = Number(req.params.id);
  const filename = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
  try {
    const id = await addProjectDoc(projectId, filename, req.file.buffer);
    const doc = (await listProjectDocs(projectId)).find(d => d.id === id)!;
    res.status(201).json({
      id: doc.id, filename: doc.filename, byte_size: doc.byte_size,
      text_length: doc.content.length, extract_error: doc.extract_error, created_at: doc.created_at,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/** 本文の確認用（画面で「何が読み取れたか」を見せて確認してもらう） */
app.get('/api/docs/:id/text', async (req, res) => {
  const row = await db.prepare(`SELECT filename, content, extract_error FROM project_docs WHERE id = ?`)
    .get(req.params.id) as { filename: string; content: string; extract_error: string | null } | undefined;
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(row);
});

app.delete('/api/docs/:id', async (req, res) => {
  await deleteProjectDoc(Number(req.params.id));
  res.json({ ok: true });
});

// ---- パイプライン起動（UC-03 / UC-05 / UC-06） ----
// 各段階は fire-and-forget で起動し、進捗は GET /api/projects/:id の runs でポーリングする。
async function startStage(res: express.Response, projectId: number, stage: string, fn: () => Promise<unknown>): Promise<void> {
  const running = await db.prepare(
    `SELECT id FROM analysis_runs WHERE project_id = ? AND status = 'running'`,
  ).get(projectId);
  if (running) {
    res.status(409).json({ error: '別のパイプラインが実行中です' });
    return;
  }
  fn().catch(e => console.error(`[pipeline:${stage}] project=${projectId}`, e));
  res.status(202).json({ started: true, stage });
}

app.post('/api/projects/:id/pipeline/decode', async (req, res) => {
  await startStage(res, Number(req.params.id), 'decode', () => runDecode(Number(req.params.id)));
});
app.post('/api/projects/:id/pipeline/generate', async (req, res) => {
  await startStage(res, Number(req.params.id), 'generate', () => runGenerate(Number(req.params.id)));
});
app.post('/api/projects/:id/pipeline/match', async (req, res) => {
  await startStage(res, Number(req.params.id), 'match', () => runMatch(Number(req.params.id)));
});

// ---- 解読項目の検収（UC-04, SC-04） ----
app.get('/api/projects/:id/findings', async (req, res) => {
  res.json(await db.prepare(`SELECT * FROM findings WHERE project_id = ? ORDER BY id`).all(req.params.id));
});

app.patch('/api/findings/:id', async (req, res) => {
  const { review_status, modified_content } = req.body as { review_status?: string; modified_content?: string };
  if (review_status && !['pending', 'approved', 'modified', 'rejected'].includes(review_status)) {
    return res.status(400).json({ error: 'review_status が不正です' });
  }
  const current = await db.prepare(`SELECT * FROM findings WHERE id = ?`).get(req.params.id) as { project_id: number } | undefined;
  if (!current) return res.status(404).json({ error: 'finding not found' });
  await db.prepare(`UPDATE findings SET review_status = COALESCE(?, review_status), modified_content = COALESCE(?, modified_content) WHERE id = ?`)
    .run(review_status ?? null, modified_content ?? null, req.params.id);
  res.json(await db.prepare(`SELECT * FROM findings WHERE id = ?`).get(req.params.id));
});

// ---- 成果物（SC-05） ----
app.get('/api/projects/:id/deliverables', async (req, res) => {
  const latest = await db.prepare(`SELECT COALESCE(MAX(version), 0) AS v FROM deliverables WHERE project_id = ?`)
    .get(req.params.id) as { v: number };
  const version = req.query.version ? Number(req.query.version) : latest.v;
  const items = await db.prepare(`SELECT * FROM deliverables WHERE project_id = ? AND version = ?`)
    .all(req.params.id, version);
  res.json({ version, latestVersion: latest.v, items });
});

// ---- 数値照合結果（SC-06） ----
app.get('/api/projects/:id/match-results', async (req, res) => {
  const result = await db.prepare(
    `SELECT * FROM match_results WHERE project_id = ? ORDER BY id DESC LIMIT 1`,
  ).get(req.params.id) as { mismatches: string } | undefined;
  if (!result) return res.json(null);
  res.json({ ...result, mismatches: JSON.parse(result.mismatches) });
});

// ---- KPIEE 実装プレビュー（照合の拡張: report_config 層まで含めた再現・可否） ----
// Tier2: SQLジョブ出力 → KPIEE レポート再現 → 顧客帳票と突き合わせた構造化データ
app.get('/api/projects/:id/kpiee-preview', async (req, res) => {
  try {
    res.json(await buildKpieePreview(Number(req.params.id)));
  } catch (e) {
    res.status(502).json({ error: String(e) });
  }
});
// Tier1: 各解読項目・指標が KPIEE でどう実装されるか／実装不可かの分類
app.get('/api/projects/:id/kpiee-impl-report', async (req, res) => {
  try {
    res.json(await buildImplReport(Number(req.params.id)));
  } catch (e) {
    res.status(502).json({ error: String(e) });
  }
});

// ---- 顧客確認事項（UC-10, SC-07） ----
app.get('/api/projects/:id/questions', async (req, res) => {
  res.json(await db.prepare(`SELECT * FROM customer_questions WHERE project_id = ? ORDER BY id`).all(req.params.id));
});

app.post('/api/projects/:id/questions', async (req, res) => {
  const { question } = req.body as { question?: string };
  if (!question) return res.status(400).json({ error: 'question は必須です' });
  const result = await db.prepare(`INSERT INTO customer_questions (project_id, question) VALUES (?, ?)`)
    .run(req.params.id, question);
  res.status(201).json(await db.prepare(`SELECT * FROM customer_questions WHERE id = ?`).get(result.lastInsertRowid));
});

app.patch('/api/questions/:id', async (req, res) => {
  const { status, customer_answer } = req.body as { status?: string; customer_answer?: string };
  if (status && !['open', 'waiting', 'resolved'].includes(status)) {
    return res.status(400).json({ error: 'status が不正です' });
  }
  await db.prepare(`UPDATE customer_questions SET status = COALESCE(?, status), customer_answer = COALESCE(?, customer_answer) WHERE id = ?`)
    .run(status ?? null, customer_answer ?? null, req.params.id);
  res.json(await db.prepare(`SELECT * FROM customer_questions WHERE id = ?`).get(req.params.id));
});

// メール文面のエクスポート（SC-07）
app.get('/api/projects/:id/questions/export', async (req, res) => {
  const project = await db.prepare(`SELECT customer_name FROM projects WHERE id = ?`).get(req.params.id) as { customer_name: string } | undefined;
  const questions = await db.prepare(
    `SELECT question FROM customer_questions WHERE project_id = ? AND status != 'resolved' ORDER BY id`,
  ).all(req.params.id) as { question: string }[];
  const body = [
    `${project?.customer_name ?? ''} ご担当者様`,
    '',
    'いつもお世話になっております。',
    'KPIEE 移行作業にあたり、以下の点についてご確認をお願いいたします。',
    '',
    ...questions.map((q, i) => `${i + 1}. ${q.question}`),
    '',
    'お手数をおかけしますが、よろしくお願いいたします。',
  ].join('\n');
  res.type('text/plain').send(body);
});

// ---- 対話Q&A（解読済みシートへの自由質問。セル単位の根拠付き回答）----
// 回答生成は数分かかることがあるため非同期: POST は即 202 を返し、フロントは GET をポーリングして
// assistant メッセージの追記（=回答完了）と pending フラグで状態を検知する（ALB 60秒タイムアウト対策）。
app.get('/api/projects/:id/chat', async (req, res) => {
  const projectId = Number(req.params.id);
  res.json({ messages: await qaHistory(projectId), pending: qaIsPending(projectId) });
});

app.post('/api/projects/:id/chat', async (req, res) => {
  const { question } = req.body as { question?: string };
  if (!question?.trim()) return res.status(400).json({ error: 'question は必須です' });
  try {
    const result = await qaStartAsk(Number(req.params.id), question.trim());
    res.status(202).json(result);
  } catch (e) {
    res.status(409).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ---- パッケージ出力（UC-08）: 成果物一式の zip ダウンロード ----
// 先頭に AI 用の案内ファイル（00_）を同梱する。zip ごと AI アシスタント（Claude 等）へ添付すると、
// データフロー図（Mermaid）と平易な説明に自動で整理される、を狙った「貼るだけ」導線。
app.get('/api/projects/:id/package', async (req, res) => {
  const projectId = Number(req.params.id);
  const latest = await db.prepare(`SELECT COALESCE(MAX(version), 0) AS v FROM deliverables WHERE project_id = ?`)
    .get(projectId) as { v: number };
  if (latest.v === 0) return res.status(404).json({ error: '成果物がまだ生成されていません' });
  const items = await db.prepare(`SELECT kind, content FROM deliverables WHERE project_id = ? AND version = ?`)
    .all(projectId, latest.v) as { kind: string; content: string }[];

  const fileNames: Record<string, string> = {
    decode_report: '01_解読リポート.md',
    mapping: '02_マッピング表.md',
    sql: '03_sql_job.sql',
    master_csv: '04_master.csv',
    report_config_table: '05_レポート設定表.md',
    report_config_json: '05_レポート設定_api.json',
  };

  // AI 用案内ファイルの材料（顧客名・資料・解読件数・要確認件数）
  const project = await db.prepare(`SELECT customer_name FROM projects WHERE id = ?`).get(projectId) as { customer_name: string } | undefined;
  const artifacts = await db.prepare(`SELECT original_filename FROM artifacts WHERE project_id = ? AND parse_status = 'done'`)
    .all(projectId) as { original_filename: string }[];
  const findingStats = await db.prepare(
    `SELECT COUNT(*) AS total,
       SUM(CASE WHEN kpiee_target = 'needs_customer_confirmation' THEN 1 ELSE 0 END) AS needs_confirm
     FROM findings WHERE project_id = ?`,
  ).get(projectId) as { total: number; needs_confirm: number } | undefined;

  const readme = [
    `# KPIEE オンボーディング成果物パッケージ — ${project?.customer_name ?? ''}（v${latest.v}）`,
    '',
    '> **使い方**: この zip の中身（このファイルを含む全ファイル）を AI アシスタント（Claude など）に添付し、',
    '> このファイルの下部「AI への依頼文」をそのまま貼り付けてください。',
    '> データフロー図と平易な説明に自動で整理されます。',
    '',
    '## 同梱ファイル',
    '| ファイル | 内容 | 主な読者 |',
    '|---|---|---|',
    '| 00_整理資料_シート一覧・定義書・要確認.docx / .md | ①ファイル別シート一覧 ②テーブル定義書 ③手入力・要確認リストを見やすくまとめた資料（Word/Markdown） | 全員（まず最初に読む） |',
    '| 01_解読リポート.md | 顧客シートの数式ロジックを AI が解読した根拠つきレポート | 検収担当 |',
    '| 02_マッピング表.md | 元シートの各ロジック → KPIEE 機能 → **最終成果物での反映先** の対応表 | 全員（トレーサビリティの中心） |',
    '| 03_sql_job.sql | KPIEE データコネクタの SQL ジョブ（Snowflake 方言）。元データを集計データへ変換 | エンジニア |',
    '| 04_master.csv | レポート軸マスタ（分類表）。SQL が結合して使う | エンジニア |',
    '| 05_レポート設定表.md | 集計データを最終帳票の形に配置するレポート設定（人が読む表） | 全員 |',
    '| 05_レポート設定_api.json | 同上の API 投入用 JSON | エンジニア |',
    '',
    '## このプロジェクトについて',
    `- 顧客: ${project?.customer_name ?? '—'}`,
    `- 取り込んだ資料: ${artifacts.length} ファイル（${artifacts.map(a => a.original_filename).join(' / ') || '—'}）`,
    `- 解読項目: ${findingStats?.total ?? 0} 件（うち顧客確認待ち ${findingStats?.needs_confirm ?? 0} 件）`,
    '',
    '---',
    '',
    '## AI への依頼文（ここから下をそのまま AI に貼り付け）',
    '',
    'あなたはデータ移行内容の説明役です。添付の KPIEE オンボーディング成果物パッケージ',
    '（01_解読リポート / 02_マッピング表 / 03_sql_job.sql / 04_master.csv / 05_レポート設定表）を読み、',
    '非エンジニアの関係者が一目で理解できる形で、日本語で以下を出力してください。',
    '',
    '1. **全体データフロー図**（Mermaid flowchart・1枚）: 見やすさ最優先で、次のルールを厳守。',
    '   - `flowchart LR`（左→右）とし、段階ごとに subgraph で区切る:',
    '     「元データ（シート）」→「変換（SQLジョブ）」→「集計データ」→「レポート軸・指標」→「最終帳票」',
    '   - ノードは全体で **20 個以内**。繰り返し（月次列・部門別シート等）は「部門別シート×5」のように 1 ノードへ束ねる。',
    '   - ノードのラベルは業務の言葉で 10 文字前後。数式・SQL・列記号の羅列をラベルに書かない。',
    '   - 幹となる流れだけ実線（-->）で描き、マスタ結合・補助参照は点線（-.->）にして線の交差を減らす。',
    '   - classDef で段階ごとに配色する（元データ=青系 / 変換=橙系 / 集計・レポート=紫系 / 帳票=緑系）。',
    '   - 02_マッピング表の「シート要素（元の場所）」と「→ 最終成果物での反映先」の対応が図に現れること。',
    '2. **詳細フロー図（2〜3枚に分割）**: 全体図の「変換（SQLジョブ）」の中身を、主要な',
    '   CTE・結合・判定のまとまりごとに 1 枚ずつ。1 枚あたりノード **15 個以内**、同じ配色ルール。',
    '   各図の直後に「この図で起きていること」を業務の言葉で 3 行以内で添える。',
    '3. **成果物の平易な説明**: 各ファイルが何で、KPIEE のどこに投入されるかを表で。',
    '4. **元シート → 最終成果物の対応要約**: 重要なロジック 10 件程度を',
    '   「元の場所 → 何をしている → 最終的にどこへ」の3列表で。',
    '5. **人が確認すべき点**: 手入力の疑い・顧客確認待ち・検証 NG など、02 と 01 から拾って一覧に。',
    '',
    '図は必ず Mermaid コードブロックで出力すること。1 枚に詰め込むより、見やすい複数枚に',
    '分けること。ノード数上限を超えそうな場合は詳細を図に足すのではなく束ねて、',
    '補足は図の下の説明文に回す。専門用語（VLOOKUP・GROUP BY 等）は避けて業務の言葉で。',
    '',
  ].join('\n');

  // 整理資料（①ファイル別シート一覧 ②テーブル定義書 ③手入力・要確認リスト）を Word/Markdown で同梱。
  // 保存済みデータから決定的に生成（AI 呼び出しなし）。失敗しても本体パッケージは出せるよう握りつぶす。
  let summaryDocx: Buffer | null = null;
  let summaryMd = '';
  try {
    const summary = await gatherSummary(projectId);
    summaryMd = buildSummaryMarkdown(summary);
    summaryDocx = await buildSummaryDocx(summary);
  } catch (e) {
    summaryMd = `整理資料の生成に失敗しました: ${String(e)}`;
  }

  res.attachment(`kpiee-onboarding-package-v${latest.v}.zip`);
  const archive = new ZipArchive();
  archive.pipe(res);
  archive.append(readme, { name: '00_はじめに_AIで可視化.md' });
  if (summaryDocx) archive.append(summaryDocx, { name: '00_整理資料_シート一覧・定義書・要確認.docx' });
  if (summaryMd) archive.append(summaryMd, { name: '00_整理資料_シート一覧・定義書・要確認.md' });
  for (const item of items) {
    archive.append(item.content, { name: fileNames[item.kind] ?? `${item.kind}.txt` });
  }
  void archive.finalize();
});

// ---- 管理（SC-08）: トークン使用量・コスト ----
app.get('/api/admin/usage', async (_req, res) => {
  // 各行の推定コストを付与するヘルパ（列名は input_tokens / output_tokens / cache_read_tokens に統一）
  const cost = (r: Record<string, unknown>) => estimateCostUsd({
    input_tokens: Number(r.input_tokens ?? 0),
    output_tokens: Number(r.output_tokens ?? 0),
    cache_read_tokens: Number(r.cache_read_tokens ?? 0),
  });
  // pg の SUM/COUNT は bigint=文字列で返るため、数値へ強制変換してから返す（フロントの計算・整形用）
  const numify = (r: Record<string, unknown>) => ({
    ...r,
    input_tokens: Number(r.input_tokens ?? 0),
    output_tokens: Number(r.output_tokens ?? 0),
    cache_read_tokens: Number(r.cache_read_tokens ?? 0),
    request_count: Number(r.request_count ?? 0),
    estimated_cost_usd: cost(r),
  });
  const withCost = (rows: Record<string, unknown>[]) => rows.map(numify);

  // プロジェクト別（customer_name も GROUP BY に含める＝pg でも安全）
  const byProject = await db.prepare(`
    SELECT u.project_id, p.customer_name,
      SUM(u.input_tokens) AS input_tokens, SUM(u.output_tokens) AS output_tokens,
      SUM(u.cache_read_input_tokens) AS cache_read_tokens, COUNT(*) AS request_count
    FROM ai_usage_logs u LEFT JOIN projects p ON p.id = u.project_id
    GROUP BY u.project_id, p.customer_name ORDER BY u.project_id DESC
  `).all() as Record<string, unknown>[];

  // 段階（decode/generate/qa/match…）別
  const byStage = await db.prepare(`
    SELECT stage, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
      SUM(cache_read_input_tokens) AS cache_read_tokens, COUNT(*) AS request_count
    FROM ai_usage_logs GROUP BY stage ORDER BY 2 DESC
  `).all() as Record<string, unknown>[];

  // 日別トレンド（直近30日）。日付切り出しは方言差を吸収する
  const dayExpr = db.driver === 'pg' ? "to_char(created_at, 'YYYY-MM-DD')" : "substr(created_at, 1, 10)";
  const byDay = await db.prepare(`
    SELECT ${dayExpr} AS day, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
      SUM(cache_read_input_tokens) AS cache_read_tokens, COUNT(*) AS request_count
    FROM ai_usage_logs GROUP BY 1 ORDER BY 1 DESC LIMIT 30
  `).all() as Record<string, unknown>[];

  // 全体合計
  const totalsRow = await db.prepare(`
    SELECT SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
      SUM(cache_read_input_tokens) AS cache_read_tokens, COUNT(*) AS request_count
    FROM ai_usage_logs
  `).get() as Record<string, unknown> | undefined;
  const totals = totalsRow ?? { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, request_count: 0 };

  res.json({
    aiMode: aiAvailable() ? MODEL : 'mock',
    model: MODEL,
    totals: numify(totals),
    projects: withCost(byProject),
    byStage: withCost(byStage),
    byDay: withCost(byDay).reverse(), // 古い→新しいの並びで返す（グラフ描画用）
  });
});

// プロジェクトステータスの手動リセット（運用補助: 失敗時の再実行用）
app.post('/api/projects/:id/reset-status', async (req, res) => {
  const { status } = req.body as { status?: string };
  const allowed = ['draft', 'analyzing', 'reviewing', 'generating', 'matching', 'completed'];
  if (!status || !allowed.includes(status)) return res.status(400).json({ error: 'status が不正です' });
  setProjectStatus(Number(req.params.id), status as Parameters<typeof setProjectStatus>[1]);
  res.json({ ok: true });
});

// プロダクションは 1 プロセス化: ビルド済みフロント(web/dist)を同一オリジンで配信する。
// dist が存在しない開発時（vite を 5173 で別起動）は API のみで動く（従来どおり）。
const webDist = process.env.WEB_DIST
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  // SPA フォールバック（vue-router history モード）。/api 以外の GET は index.html を返す。
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
  console.log(`[kpiee-onboarding-ai] serving web from ${webDist}`);
}

// スキーマ作成 + 孤児ジョブ掃除を済ませてから listen する（トップレベル await / ESM）。
await initDb();

const PORT = Number(process.env.PORT ?? 8787);
// 明示的に 0.0.0.0 へバインドする。ECS/ALB のヘルスチェックはタスク ENI の IP へ来るため、
// localhost バインドだと到達できず unhealthy になる（DPB 手引きの既知の落とし穴）。
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[kpiee-onboarding-ai] API server: http://localhost:${PORT}`);
  console.log(`[kpiee-onboarding-ai] AI mode: ${aiAvailable() ? MODEL : 'mock（ANTHROPIC_API_KEY 未設定）'}`);
  // Google 連携済みなら接続を事前に温める（access_token 交換・DNS・TLS・ルート一覧を先に済ませ、
  // 最初の「ドライブから選択」でユーザーが初回コストを負わないようにする）。best-effort。
  void warmupDrive();
});

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
import { materializeBuffer, materializeParsed, driveKey } from './artifacts.js';
import { parseArtifact, type ParsedArtifact } from './preprocess/parse.js';
import { classifySheetRoles, type SheetClassification } from './preprocess/classify.js';
import { analyzeBuffer, analyzeArtifacts, type RelationGraph } from './preprocess/relations.js';
import { analyzeArtifactsInWorker } from './preprocess/analyzeInWorker.js';
import { artifactSetSignature, getCachedRelationGraph, setCachedRelationGraph, invalidateRelationGraph } from './relationsCache.js';
import { runDecode, runGenerate, runMatch, tableNameOf } from './pipeline/orchestrator.js';
import { buildKpieePreview, buildImplReport } from './match/kpieePreview.js';
import { gatherSummary, buildSummaryDocx, buildSummaryMarkdown } from './summaryDoc.js';
import { startAsk as qaStartAsk, isAskPending as qaIsPending, getHistory as qaHistory } from './qa/agent.js';
import { invalidateBooks } from './qa/tools.js';
import { aiAvailable, MODEL, estimateCostUsd } from './ai/client.js';
import {
  googleConfigured, fetchDriveFile, listSpreadsheets, listFolderChildren, extractSpreadsheetId,
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
  res.json({ ...project, artifacts, runs, usage: { ...usage, estimated_cost_usd: estimateCostUsd(usage) } });
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
async function ingestArtifact(projectId: number, filename: string, buffer: Buffer, kind: string, driveFileId?: string): Promise<number> {
  const ephemeral = ARTIFACT_EPHEMERAL && !!driveFileId;
  // 無保存モードは Drive 参照キー、通常モードはローカル保存キー
  const rawKey = ephemeral ? driveKey(driveFileId!) : `project-${projectId}/raw/${Date.now()}-${filename}`;
  if (!ephemeral) putObject(rawKey, buffer);
  const result = await db.prepare(`
    INSERT INTO artifacts (project_id, kind, original_filename, storage_key, parse_status)
    VALUES (?, ?, ?, ?, 'parsing')
  `).run(projectId, kind === 'auto' ? 'mixed' : kind, filename, rawKey);
  const artifactId = Number(result.lastInsertRowid);
  try {
    // パース自体は無保存モードでも一度は必要（シート役割の自動分類のため）。結果はメモリに留め永続化しない。
    const parsed = await parseArtifact(filename, buffer);
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
  // 取込後にワーカーで関係グラフを先行計算してキャッシュを温める（＝関係/要確認タブを開いた時に即表示）。
  // 複数ファイルの連続取込は debounce で最後の1回にまとめ、無駄な再計算を避ける。
  schedulePrecomputeRelations(projectId);
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
  const artifactId = await ingestArtifact(projectId, filename, req.file.buffer, kind);
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
// シート URL を受け取り、Drive API で xlsx 書き出し→通常のアップロードと同じ前処理に流す。
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
    const { filename, buffer } = await fetchDriveFile(url);
    // 無保存モードのために Drive のファイル ID を控える（storage_key を drive:<id> にして都度取得できるように）
    const driveFileId = extractSpreadsheetId(url) ?? undefined;
    const artifactId = await ingestArtifact(projectId, filename, buffer, k, driveFileId);
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
  const valid = new Set(['input_data', 'working_sheet', 'final_output', 'unknown']);
  for (const role of Object.values(sheet_roles)) {
    if (!valid.has(role)) return res.status(400).json({ error: `役割が不正です: ${role}` });
  }
  const row = await db.prepare(`SELECT sheet_roles FROM artifacts WHERE id = ?`).get(req.params.id) as { sheet_roles: string | null } | undefined;
  if (!row) return res.status(404).json({ error: 'artifact not found' });
  // 既存の分類結果（判定理由）を保ちつつ役割だけ上書きする
  const current = (row.sheet_roles ? JSON.parse(row.sheet_roles) : {}) as Record<string, SheetClassification>;
  for (const [name, role] of Object.entries(sheet_roles)) {
    current[name] = {
      role: role as SheetClassification['role'],
      reason: current[name] ? `${current[name].reason}（手動修正済み）` : '手動指定',
      references: current[name]?.references ?? [],
    };
  }
  await db.prepare(`UPDATE artifacts SET sheet_roles = ? WHERE id = ?`).run(JSON.stringify(current), req.params.id);
  res.json({ ok: true, sheet_roles: current });
});

app.delete('/api/artifacts/:id', async (req, res) => {
  const row = await db.prepare(`SELECT project_id FROM artifacts WHERE id = ?`).get(req.params.id) as { project_id: number } | undefined;
  await db.prepare(`DELETE FROM artifacts WHERE id = ?`).run(req.params.id);
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
 * - copy(値一致)辺には、提供先シートの AI解読をヒントとして添付（手コピー誤検出の見極め用）
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
const precomputeTimers = new Map<number, ReturnType<typeof setTimeout>>();
function schedulePrecomputeRelations(projectId: number): void {
  const prev = precomputeTimers.get(projectId);
  if (prev) clearTimeout(prev);
  const t = setTimeout(() => {
    precomputeTimers.delete(projectId);
    // ワーカーで計算しキャッシュへ保存（結果は捨てる）。失敗してもタブ表示時に再計算されるので致命的でない。
    loadProjectRelationGraph(projectId).catch(e => console.error(`[relations:precompute] project=${projectId}`, e));
  }, 1500);
  if (typeof t.unref === 'function') t.unref(); // 保留タイマーがプロセス終了を妨げないように
  precomputeTimers.set(projectId, t);
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
      supported.map(r => ({ filename: r.original_filename, load: () => materializeBuffer(r.storage_key) })),
    );
    // 巨大グラフは保存前に辺を集約（warnings/構造は全件維持）。キャッシュを小さく保ち、
    // 命中時の JSON.parse と後段処理がメインを詰まらせないようにする。
    graph = collapseEdgesForCache(full);
    await setCachedRelationGraph(projectId, signature, graph);
  }
  return { graph, fileCount: supported.length };
}

// プロジェクト全体のシート関係性グラフ。アップロード済みの全ファイル(xlsx/csv)を1パスで解析し、
// ファイルをまたぐ手コピー関係も検出する。ファイルが1つなら自然にそのファイル単体の解析になる。
app.get('/api/projects/:id/relations', async (req, res) => {
  const projectId = Number(req.params.id);
  try {
    const loaded = await loadProjectRelationGraph(projectId);
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
    const loaded = await loadProjectRelationGraph(projectId);
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
      const key = `${w.kind} ${file} ${sheet}`;
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

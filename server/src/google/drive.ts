// Google Drive/Sheets 連携（リモート取り込み・1段階目）。
// 認証は「対象アカウント本人による Web OAuth 同意」のみを使う。本人が一度ブラウザで同意すると
// refresh_token が得られ、以後はサーバーがその refresh_token で本人に代わって Drive を読む。
// 取得した buffer は通常のアップロードと同じ前処理を通る（パース・関係解析・AI解読を変えず再利用）。
//
// サービスアカウント(SA)鍵・gcloud ADC は使わない。単一アカウントのデータを別アカウント（SA 含む）へ
// 渡さない、という制約（デプロイ設計 C2）のため、本人ログインの OAuth 経路だけを残す。
//
// 必要な環境変数:
//   GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET … OAuth クライアント
//   GOOGLE_OAUTH_REFRESH_TOKEN                          … 本人同意で得たトークン（デプロイ時はタスク定義 env に設定）
import { google } from 'googleapis';
import { loadRefreshToken, saveRefreshToken, clearRefreshToken } from './tokenStore.js';
import { columnLetter, type ParsedArtifact } from '../preprocess/parse.js';
import { SheetAccumulator, type AccumCell } from '../preprocess/sheetAccum.js';

/** OAuth クライアント(CLIENT_ID/SECRET)が設定済みか。Web ログインフローの前提 */
export function oauthClientConfigured(): boolean {
  return !!(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET);
}

/** 現在使えるリフレッシュトークン（環境変数優先、無ければ保存済みファイル） */
function currentRefreshToken(): string | null {
  return process.env.GOOGLE_OAUTH_REFRESH_TOKEN || loadRefreshToken();
}

/** Drive へ実際にアクセスできる資格情報が揃っているか（Web OAuth 連携済みか） */
export function googleConfigured(): boolean {
  return oauthClientConfigured() && !!currentRefreshToken();
}

/** UI 表示用の連携状態 */
export function connectionStatus(): { clientConfigured: boolean; connected: boolean } {
  return { clientConfigured: oauthClientConfigured(), connected: googleConfigured() };
}

/** Google ドライブの URL / ID からファイルIDを取り出す（シート /spreadsheets/d/ も 通常ファイル /file/d/ も対応） */
export function extractSpreadsheetId(urlOrId: string): string | null {
  const s = urlOrId.trim();
  const m = s.match(/\/(?:spreadsheets|file)\/d\/([a-zA-Z0-9-_]+)/);
  if (m) return m[1];
  // 素の ID（URL でなく ID 直貼り）も許容
  if (/^[a-zA-Z0-9-_]{20,}$/.test(s)) return s;
  return null;
}

const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];

/** 同意画面 URL を生成する。redirectUri は OAuth クライアントに登録済みのものと完全一致が必須 */
export function buildAuthUrl(redirectUri: string): string {
  const oauth = new google.auth.OAuth2(process.env.GOOGLE_OAUTH_CLIENT_ID, process.env.GOOGLE_OAUTH_CLIENT_SECRET, redirectUri);
  return oauth.generateAuthUrl({
    access_type: 'offline', // refresh_token を取得する
    prompt: 'consent',      // 再連携時も確実に refresh_token を返させる
    scope: SCOPES,
  });
}

/** 認可コードを refresh_token に交換して保存する（Web ログインのコールバックで使用） */
export async function exchangeCodeAndStore(code: string, redirectUri: string): Promise<void> {
  const oauth = new google.auth.OAuth2(process.env.GOOGLE_OAUTH_CLIENT_ID, process.env.GOOGLE_OAUTH_CLIENT_SECRET, redirectUri);
  const { tokens } = await oauth.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error('refresh_token を取得できませんでした（同意画面でアクセスを許可したか確認してください）');
  }
  saveRefreshToken(tokens.refresh_token, tokens.scope ?? undefined);
}

/** Web OAuth 連携を解除する（保存トークンを破棄） */
export function disconnect(): void {
  clearRefreshToken();
  clearFolderCache(); // 別アカウントに切り替えたとき、前アカウントのフォルダ一覧が残らないように
  cachedOauth = null;  // 使い回している OAuth2 クライアント（＝前アカウントの access_token）も破棄
}

/** 認証クライアントを返す。対象アカウント本人の Web OAuth(refresh token) のみを使う（SA/ADC は廃止）。
 *
 * OAuth2 クライアントは refresh_token ごとに1個だけ生成して使い回す（シングルトン）。
 * googleapis は access_token（refresh_token をトークンエンドポイントで交換した短命トークン, ~1時間）を
 * このインスタンス内部にキャッシュし、期限が近づくと自動更新する。毎回 new すると access_token が捨てられ、
 * Drive 呼び出しのたびに「トークン交換の往復」が1回余計に走る（＝初回が遅い主因の一つ）。
 * インスタンスを固定すれば、その往復は実質「サーバー起動後の1回だけ」で済む。
 * refresh_token が変わったら（再連携時）鍵が変わるので自動で作り直す。 */
let cachedOauth: { token: string; client: InstanceType<typeof google.auth.OAuth2> } | null = null;
function authClient() {
  const refreshToken = currentRefreshToken();
  if (!oauthClientConfigured() || !refreshToken) {
    throw new Error('Google 連携が未設定です（OAuth クライアントと本人同意による refresh_token が必要です）');
  }
  if (cachedOauth && cachedOauth.token === refreshToken) return cachedOauth.client;
  const oauth = new google.auth.OAuth2(process.env.GOOGLE_OAUTH_CLIENT_ID, process.env.GOOGLE_OAUTH_CLIENT_SECRET);
  oauth.setCredentials({ refresh_token: refreshToken });
  cachedOauth = { token: refreshToken, client: oauth };
  return oauth;
}

/** リモート接続（access_token/TLS）を事前に温める。起動時に1回呼ぶと、最初のユーザー操作が
 * トークン交換・DNS・TLS の初回コストを負わずに済む。失敗しても致命的でないので握りつぶす。 */
export async function warmupDrive(): Promise<void> {
  if (!googleConfigured()) return;
  try {
    await listFolderChildren(); // ルート取得＝トークン交換＋TLS＋files.list を一括で温め、folderCache も充填
  } catch { /* 温めは best-effort。失敗は無視（本番の初回操作で取り直される） */ }
}

function gErr(e: unknown): string {
  const err = e as { response?: { data?: unknown }; message?: string };
  const data = err?.response?.data;
  if (data) {
    try {
      const txt = Buffer.isBuffer(data) ? data.toString('utf-8')
        : data instanceof ArrayBuffer ? Buffer.from(data).toString('utf-8')
        : typeof data === 'string' ? data : JSON.stringify(data);
      const parsed = JSON.parse(txt) as { error?: { message?: string } };
      if (parsed?.error?.message) return parsed.error.message;
    } catch { /* fallthrough */ }
  }
  return err?.message ?? String(e);
}

// 取り込み対象の MIME（ネイティブ Google シート / アップロード xlsx / CSV）
const MIME_NATIVE = 'application/vnd.google-apps.spreadsheet';
const MIME_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MIME_CSV = 'text/csv';
const MIME_FOLDER = 'application/vnd.google-apps.folder';

export interface DriveSheet { id: string; name: string; modifiedTime?: string; mimeType?: string }
export interface DriveFolder { id: string; name: string }

/** ログイン中アカウントがアクセスできる表ファイル一覧（Google シート + アップロード xlsx/CSV）。名前で絞り込み可 */
export async function listSpreadsheets(search?: string): Promise<DriveSheet[]> {
  const drive = google.drive({ version: 'v3', auth: authClient() });
  let q = `trashed=false and (mimeType='${MIME_NATIVE}' or mimeType='${MIME_XLSX}' or mimeType='${MIME_CSV}')`;
  if (search && search.trim()) {
    const s = search.trim().replace(/['\\]/g, '\\$&');
    q += ` and name contains '${s}'`;
  }
  try {
    const res = await drive.files.list({
      q,
      fields: 'files(id,name,modifiedTime,mimeType)',
      orderBy: 'modifiedTime desc',
      pageSize: 50,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
    });
    return (res.data.files ?? []).map(f => ({ id: f.id ?? '', name: f.name ?? '(無題)', modifiedTime: f.modifiedTime ?? undefined, mimeType: f.mimeType ?? undefined }));
  } catch (e) {
    throw new Error(`Google ドライブ一覧の取得に失敗: ${gErr(e)}`);
  }
}

/**
 * 指定フォルダ直下の「サブフォルダ + 表ファイル」を返す（フォルダ別ブラウズ用）。
 * folderId 未指定なら「マイドライブ」直下（'root'）。フォルダを先頭に、名前順で並べる。
 * 検索は listSpreadsheets（全ドライブ横断・平面）を使うので、ここは階層ナビ専用。
 */
// フォルダ内容の短期キャッシュ。同じフォルダの再表示・パンくずでの上下移動を即座にするため。
// Google Drive API の往復（~1秒）が体感遅延の主因で、コードでは短縮できないので、
// 一度取得した一覧を短時間だけ保持する。取り込みは既存ファイルの選択が主で、閲覧中に
// ドライブ側が更新されることは稀なため、短い TTL（45秒）なら実害はほぼない。
const folderCache = new Map<string, { at: number; data: { folders: DriveFolder[]; files: DriveSheet[] } }>();
const FOLDER_CACHE_TTL_MS = 45_000;

/** フォルダ内容キャッシュを破棄する（取り込み等でドライブ内容が変わり得るときに呼ぶ）。 */
export function clearFolderCache(): void {
  folderCache.clear();
}

export async function listFolderChildren(folderId?: string): Promise<{ folders: DriveFolder[]; files: DriveSheet[] }> {
  const cacheKey = folderId && folderId.trim() ? folderId.trim() : '__root__';
  const now = Date.now();
  const hit = folderCache.get(cacheKey);
  if (hit && now - hit.at < FOLDER_CACHE_TTL_MS) return hit.data;

  const drive = google.drive({ version: 'v3', auth: authClient() });
  const typeFilter = `(mimeType='${MIME_FOLDER}' or mimeType='${MIME_NATIVE}' or mimeType='${MIME_XLSX}' or mimeType='${MIME_CSV}')`;
  // ルート（フォルダ未指定）では「マイドライブ直下」に加え「自分に共有されたトップ項目」も見せる。
  // 実運用では対象データが共有フォルダ（例: ForAI / 各社実績データ）に置かれ、マイドライブ直下が空なことが多いため。
  // 特定フォルダ配下は通常どおり親 ID で辿る（共有フォルダの中も読み取り権限があれば辿れる）。
  const scope = folderId && folderId.trim()
    ? `'${folderId.trim().replace(/['\\]/g, '\\$&')}' in parents`
    : `('root' in parents or sharedWithMe=true)`;
  const q = `trashed=false and ${scope} and ${typeFilter}`;
  try {
    const res = await drive.files.list({
      q,
      fields: 'files(id,name,modifiedTime,mimeType)',
      orderBy: 'folder,name', // フォルダを先に、続いて名前順
      pageSize: 200,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
    });
    const folders: DriveFolder[] = [];
    const files: DriveSheet[] = [];
    for (const f of res.data.files ?? []) {
      if (f.mimeType === MIME_FOLDER) folders.push({ id: f.id ?? '', name: f.name ?? '(無題)' });
      else files.push({ id: f.id ?? '', name: f.name ?? '(無題)', modifiedTime: f.modifiedTime ?? undefined, mimeType: f.mimeType ?? undefined });
    }
    const data = { folders, files };
    folderCache.set(cacheKey, { at: now, data });
    return data;
  } catch (e) {
    throw new Error(`Google ドライブのフォルダ取得に失敗: ${gErr(e)}`);
  }
}

/** Drive のファイル情報（取り込み経路の分岐に使う） */
async function driveMeta(id: string): Promise<{ name: string; mimeType: string }> {
  const drive = google.drive({ version: 'v3', auth: authClient() });
  try {
    const meta = await drive.files.get({ fileId: id, fields: 'name,mimeType', supportsAllDrives: true });
    return { name: meta.data.name ?? id, mimeType: meta.data.mimeType ?? '' };
  } catch (e) {
    throw new Error(`ファイル情報の取得に失敗: ${gErr(e)}`);
  }
}

/** アップロード済み実ファイル（xlsx / CSV 等）の原本をそのままダウンロードする */
async function downloadRawFile(id: string, name: string, mimeType: string): Promise<{ filename: string; buffer: Buffer }> {
  const drive = google.drive({ version: 'v3', auth: authClient() });
  try {
    const res = await drive.files.get({ fileId: id, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' });
    const buffer = Buffer.from(res.data as ArrayBuffer);
    let filename = name;
    if (mimeType === MIME_CSV && !/\.csv$/i.test(filename)) filename += '.csv';
    else if (!/\.(xlsx|xlsm|csv)$/i.test(filename)) filename += '.xlsx';
    return { filename, buffer };
  } catch (e) {
    throw new Error(`Google ドライブ取得に失敗: ${gErr(e)}`);
  }
}

/**
 * ドライブのファイルを取り込み用に取得する（原本バイトが要る経路のための互換 API）。
 * ネイティブ Google シートには使えない（xlsx 化を廃止したため）。ネイティブシートは
 * fetchDriveArtifact / fetchDriveForRelations を使う。
 */
export async function fetchDriveFile(urlOrId: string): Promise<{ filename: string; buffer: Buffer }> {
  const id = extractSpreadsheetId(urlOrId);
  if (!id) throw new Error('Google ドライブの URL または ID を認識できませんでした');
  const { name, mimeType } = await driveMeta(id);
  if (mimeType === MIME_NATIVE) {
    throw new Error('ネイティブ Google シートは原本バイトを持ちません（fetchDriveArtifact を使ってください）');
  }
  return downloadRawFile(id, name, mimeType);
}

// ============================================================
// ネイティブ Google シートのチャンク読み
// ============================================================
// 旧実装は「全シートを1回の batchGet で取得 → ExcelJS でワークブックを組み立て → xlsx へ直列化」
// していた。同じデータの表現を同時に何벌も抱えるため、実測 78,942 行 × 99 列（780万セル）の
// シートで 4GB ヒープでも OOM しプロセスが落ちた（rss: batchGet 1,170MB → 組み立て 2,540MB → 直列化で死亡）。
// xlsx を作っていた理由は「既存の xlsx パーサに合流させる」ためだけで、batchGet の時点で
// 数式原文と値は既に手元にある。そこで xlsx を経由せず、行チャンクを受け取りながら
// SheetAccumulator に畳み込む方式に変える。ピークメモリはチャンク1個分に固定され、行数に依存しない。
// チャンク間に必ずネットワーク待ちが入るのでイベントループも解放され、取り込み中も /healthz が応答する。

/** チャンク1個の目標セル数。列が多いシートは自動的に1チャンクの行数が減る */
const CELLS_PER_CHUNK = 400_000;
const MIN_CHUNK_ROWS = 200;
const MAX_CHUNK_ROWS = 20_000;

interface NativeSheetMeta { title: string; rowCount: number; columnCount: number; merges: string[] }

/** GridRange（0始まり・終端排他）を "A1:C3" 形式へ */
function mergeRef(m: { startRowIndex?: number | null; endRowIndex?: number | null; startColumnIndex?: number | null; endColumnIndex?: number | null }): string {
  const r0 = (m.startRowIndex ?? 0) + 1;
  const c0 = (m.startColumnIndex ?? 0) + 1;
  const r1 = m.endRowIndex ?? r0;
  const c1 = m.endColumnIndex ?? c0;
  return `${columnLetter(c0)}${r0}:${columnLetter(c1)}${r1}`;
}

/** シート構成（枚数・グリッド寸法・結合セル）を1回で取る */
async function nativeSheetMetas(id: string): Promise<{ title: string; sheets: NativeSheetMeta[] }> {
  const sheetsApi = google.sheets({ version: 'v4', auth: authClient() });
  try {
    const res = await sheetsApi.spreadsheets.get({
      spreadsheetId: id,
      fields: 'properties.title,sheets(properties(title,gridProperties(rowCount,columnCount)),merges)',
    });
    const sheets: NativeSheetMeta[] = (res.data.sheets ?? []).map(s => ({
      title: s.properties?.title ?? 'Sheet',
      rowCount: s.properties?.gridProperties?.rowCount ?? 0,
      columnCount: s.properties?.gridProperties?.columnCount ?? 0,
      merges: (s.merges ?? []).map(mergeRef),
    }));
    return { title: res.data.properties?.title ?? id, sheets };
  } catch (e) {
    throw new Error(`Google スプレッドシートの構成取得に失敗: ${gErr(e)}`);
  }
}

/** 一時的な失敗（レート制限・5xx）と判断できるか */
function isTransient(e: unknown): boolean {
  const status = (e as { response?: { status?: number } })?.response?.status ?? 0;
  if (status === 429 || status >= 500) return true;
  return /rate ?limit|quota|backend ?error|internal error|try again/i.test(gErr(e));
}

/**
 * レート制限・一時障害を指数バックオフで再試行する。
 * Sheets API は「ユーザーあたり毎分 60 リクエスト」の枠があり、1シートの読み取りが
 * 数十リクエストに分かれる本方式では複数ファイルの連続取り込みで枠に触れる。枠は毎分回復するので
 * 待って再試行するのが正しい対処（実測でここに当たったため追加）。
 */
async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 6): Promise<T> {
  let waitMs = 2000;
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!isTransient(e) || i >= attempts) throw e;
      console.warn(`[drive] ${label} 一時失敗 (${i}/${attempts})、${waitMs}ms 待って再試行: ${gErr(e).slice(0, 140)}`);
      await new Promise(r => setTimeout(r, waitMs));
      waitMs = Math.min(waitMs * 2, 30_000);
    }
  }
}

/** 数式レンダリング結果に数式セルが1つでもあるか */
function hasAnyFormula(rows: unknown[][]): boolean {
  for (const row of rows) {
    for (const v of row) if (typeof v === 'string' && v.startsWith('=')) return true;
  }
  return false;
}

/**
 * 全シートを行チャンクで読み進め、シートごとに emit() の結果を返す。
 *
 * 1チャンクにつき、まず数式原文（FORMULA）を取る。そのチャンクに数式が1つも無ければ
 * 計算値（UNFORMATTED_VALUE）は取りに行かない — 数式が無いセルの FORMULA レンダリングは
 * 保存されている値そのものなので、値として使える。これで基幹システム出力のような
 * 「数式ゼロの大規模シート」ではリクエスト数が半分になる（毎分 60 リクエスト枠の節約）。
 * 数式が含まれるチャンクだけ計算値も取り、数式セルの結果を正確に持つ。
 *
 * 末尾に到達したら（返却行数がチャンク行数未満）そのシートを打ち切る。Sheets API は
 * 末尾の空行を返さないので、グリッド寸法が実データより大きくても無駄打ちは1回で済む。
 */
async function streamNativeSheets(id: string): Promise<StreamResult> {
  const sheetsApi = google.sheets({ version: 'v4', auth: authClient() });
  const meta = await nativeSheetMetas(id);
  const sheets: StreamResult['sheets'] = [];
  for (const sh of meta.sheets) {
    const acc = new SheetAccumulator(sh.title);
    const width = Math.max(1, sh.columnCount);
    const rowsPerChunk = Math.min(MAX_CHUNK_ROWS, Math.max(MIN_CHUNK_ROWS, Math.floor(CELLS_PER_CHUNK / width)));
    const endCol = columnLetter(width);
    const quoted = `'${sh.title.replace(/'/g, "''")}'`;
    const gridRows = Math.max(1, sh.rowCount);
    for (let start = 0; start < gridRows; start += rowsPerChunk) {
      const range = `${quoted}!A${start + 1}:${endCol}${Math.min(gridRows, start + rowsPerChunk)}`;
      const label = `シート「${sh.title}」${start + 1}行目`;
      let fRows: unknown[][] = [];
      let vRows: unknown[][] = [];
      try {
        const fRes = await withRetry(`${label} 数式取得`, () => sheetsApi.spreadsheets.values.get({
          spreadsheetId: id, range, valueRenderOption: 'FORMULA', majorDimension: 'ROWS',
        }));
        fRows = (fRes.data.values ?? []) as unknown[][];
        if (hasAnyFormula(fRows)) {
          const vRes = await withRetry(`${label} 値取得`, () => sheetsApi.spreadsheets.values.get({
            spreadsheetId: id, range, valueRenderOption: 'UNFORMATTED_VALUE', majorDimension: 'ROWS',
          }));
          vRows = (vRes.data.values ?? []) as unknown[][];
        } else {
          vRows = fRows; // 数式が無いチャンクは FORMULA の値がそのまま保存値
        }
      } catch (e) {
        throw new Error(`${label}からの取得に失敗: ${gErr(e)}`);
      }
      const got = Math.max(fRows.length, vRows.length);
      if (got === 0) break;                // これ以降にデータは無い
      acc.push(start, fRows, vRows);
      if (got < rowsPerChunk) break;       // 末尾に到達
    }
    sheets.push({ acc, meta: sh });
  }
  return { title: meta.title, sheets };
}

/** 1ファイル分のストリーミング読み結果（蓄積器のまま持つ。ここから解析済み構造も格子も導ける） */
interface StreamResult { title: string; sheets: { acc: SheetAccumulator; meta: NativeSheetMeta }[] }

// ストリーミング読みの結果を短時間だけ保持する。
// 取り込み → 役割分類 → プレビュー → 関係分析 → 解読 と同じシートを何度も読むが、
// Sheets API の「毎分 60 リクエスト/ユーザー」枠に対し 1 シートの読み取りが数十リクエストに
// 分かれるため、素直に読み直すと複数ファイルのバッチで確実に枠を超える（実測で超えた）。
// 蓄積器のまま保持することで、解析済み構造（取り込み用）と生格子（関係分析用）の両方を
// 1回の読み取りから導ける。保持するのは絞り込み後の軽い構造（実測 8,213 セル）だけで、
// 原本をディスクに残さない方針(C3/C4)は変えない。
const STREAM_CACHE_TTL_MS = 180_000;
const streamCache = new Map<string, { at: number; value: Promise<StreamResult> }>();

/** ストリーミング読みを1回に纏める。進行中の読み取りがあれば合流する（重複リクエストを防ぐ） */
function streamOnce(id: string): Promise<StreamResult> {
  const hit = streamCache.get(id);
  if (hit && Date.now() - hit.at <= STREAM_CACHE_TTL_MS) return hit.value;
  const p = streamNativeSheets(id);
  streamCache.set(id, { at: Date.now(), value: p });
  p.catch(() => streamCache.delete(id)); // 失敗は残さず、次回やり直せるようにする
  return p;
}

/** ストリーミング結果キャッシュを破棄する（アーティファクト削除・再取り込み時に呼ぶ） */
export function clearStreamCache(): void {
  streamCache.clear();
}

/** ネイティブシートの表示名。拡張子 .xlsx を保つ（下流の拡張子判定・テーブル名生成が依存している） */
function nativeFilename(title: string): string {
  return title.toLowerCase().endsWith('.xlsx') ? title : `${title}.xlsx`;
}

/** 取り込み結果。ネイティブシートは解析済み構造、実ファイルは原本バイト */
export type DriveArtifact =
  | { filename: string; kind: 'parsed'; parsed: ParsedArtifact }
  | { filename: string; kind: 'buffer'; buffer: Buffer };

/**
 * 取り込み用にドライブのファイルを取得する。
 * - ネイティブ Google シート → チャンク読みで ParsedArtifact を直接作る（xlsx を経由しない）
 * - アップロード済み xlsx / CSV → 原本バイトを返し、従来のパーサに任せる
 */
export async function fetchDriveArtifact(urlOrId: string): Promise<DriveArtifact> {
  const id = extractSpreadsheetId(urlOrId);
  if (!id) throw new Error('Google ドライブの URL または ID を認識できませんでした');
  const { name, mimeType } = await driveMeta(id);
  if (mimeType !== MIME_NATIVE) {
    const { filename, buffer } = await downloadRawFile(id, name, mimeType);
    return { filename, kind: 'buffer', buffer };
  }
  const { title, sheets } = await streamOnce(id);
  return {
    filename: nativeFilename(title),
    kind: 'parsed',
    parsed: { fileType: 'xlsx', sheets: sheets.map(s => s.acc.finishParsed(s.meta.merges)) },
  };
}

/** 関係分析用の生格子（relations.ts の RawGrid と構造互換） */
export interface DriveGrid { file: string; name: string; cells: AccumCell[]; maxR: number; maxC: number }

/** 関係分析用のドライブ取得結果 */
export type DriveRelationSource =
  | {
      kind: 'grids';
      grids: DriveGrid[];
      /** シート名 → 実際の総行数。絞り込んだシートの Region.dataRowCount を補正する */
      rowTotals: Record<string, number>;
      /** 絞り込んだシート名。手コピー指紋（列の全値一致）は成り立たないので計算を省く */
      truncatedSheets: string[];
    }
  | { kind: 'buffer'; buffer: Buffer };

/**
 * 関係分析用にドライブから取得する。
 * ネイティブシートはチャンク読みで格子を作る。絞り込んだシートはヘッダー＋標本＋数式行だけの
 * 格子になるので、表領域(Region)はノードとして登録されるが手コピー指紋は計算しない。
 */
export async function fetchDriveForRelations(urlOrId: string, file: string): Promise<DriveRelationSource> {
  const id = extractSpreadsheetId(urlOrId);
  if (!id) throw new Error('Google ドライブの URL または ID を認識できませんでした');
  const { name, mimeType } = await driveMeta(id);
  if (mimeType !== MIME_NATIVE) {
    const { buffer } = await downloadRawFile(id, name, mimeType);
    return { kind: 'buffer', buffer };
  }
  const { sheets } = await streamOnce(id);
  const grids: DriveGrid[] = [];
  const rowTotals: Record<string, number> = {};
  const truncatedSheets: string[] = [];
  for (const s of sheets) {
    const g = s.acc.finishGrid();
    grids.push({ file, name: s.meta.title, cells: g.cells, maxR: g.maxR, maxC: g.maxC });
    rowTotals[s.meta.title] = g.totalRows;
    if (g.truncated) truncatedSheets.push(s.meta.title);
  }
  return { kind: 'grids', grids, rowTotals, truncatedSheets };
}


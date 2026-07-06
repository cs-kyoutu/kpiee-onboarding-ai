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
import ExcelJS from 'exceljs';
import { loadRefreshToken, saveRefreshToken, clearRefreshToken } from './tokenStore.js';

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
}

/** 認証クライアントを返す。対象アカウント本人の Web OAuth(refresh token) のみを使う（SA/ADC は廃止）。 */
function authClient() {
  const refreshToken = currentRefreshToken();
  if (!oauthClientConfigured() || !refreshToken) {
    throw new Error('Google 連携が未設定です（OAuth クライアントと本人同意による refresh_token が必要です）');
  }
  const oauth = new google.auth.OAuth2(process.env.GOOGLE_OAUTH_CLIENT_ID, process.env.GOOGLE_OAUTH_CLIENT_SECRET);
  oauth.setCredentials({ refresh_token: refreshToken });
  return oauth;
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

export interface DriveSheet { id: string; name: string; modifiedTime?: string; mimeType?: string }

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
 * ドライブのファイルを取り込み用に取得する。
 * - ネイティブ Google シート → Sheets API で読んで xlsx 化（容量制限・クォータ回避）
 * - アップロード済み xlsx / CSV → Drive API で原本をそのままダウンロード
 */
export async function fetchDriveFile(urlOrId: string): Promise<{ filename: string; buffer: Buffer }> {
  const id = extractSpreadsheetId(urlOrId);
  if (!id) throw new Error('Google ドライブの URL または ID を認識できませんでした');
  const auth = authClient();
  const drive = google.drive({ version: 'v3', auth });

  let mimeType = ''; let name = id;
  try {
    const meta = await drive.files.get({ fileId: id, fields: 'name,mimeType', supportsAllDrives: true });
    mimeType = meta.data.mimeType ?? '';
    name = meta.data.name ?? id;
  } catch (e) {
    throw new Error(`ファイル情報の取得に失敗: ${gErr(e)}`);
  }

  // ネイティブ Google シートは Sheets API 経由（巨大シートも分割取得）
  if (mimeType === MIME_NATIVE) return readNativeSheet(auth, id, name);

  // アップロード済みファイル（xlsx / CSV 等）は原本をそのままダウンロード
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
 * ネイティブ Google シートを Sheets API で直接読み取り、xlsx の buffer に組み立てる。
 * Drive の export には容量制限があるため、values.batchGet で取得し自前で xlsx 化する。
 * 数式は Google ネイティブ原文（QUERY/IMPORTRANGE 等、__xludf 包装なし）で取得できる。
 */
async function readNativeSheet(auth: ReturnType<typeof authClient>, id: string, fileName: string): Promise<{ filename: string; buffer: Buffer }> {
  const sheetsApi = google.sheets({ version: 'v4', auth });
  try {
    const meta = await sheetsApi.spreadsheets.get({
      spreadsheetId: id,
      fields: 'properties.title,sheets.properties(title,gridProperties(rowCount,columnCount))',
    });
    const title = meta.data.properties?.title ?? fileName;
    const wb = new ExcelJS.Workbook();

    // Excel が禁止する文字を含むシート名を整える（Google export と同様）。
    // 元名→最終名のマップを作り、数式中の参照も合わせて置換して整合を保つ。
    const origNames = (meta.data.sheets ?? []).map(s => s.properties?.title ?? 'Sheet');
    const nameMap = new Map<string, string>();
    const used = new Set<string>();
    for (const orig of origNames) {
      let final = orig.replace(/[[\]:\\/*?]/g, '').slice(0, 31) || 'Sheet';
      if (used.has(final)) { let i = 2; while (used.has(`${final.slice(0, 28)}_${i}`)) i++; final = `${final.slice(0, 28)}_${i}`; }
      used.add(final);
      nameMap.set(orig, final);
    }
    const changed = [...nameMap.entries()].filter(([o, f]) => o !== f);
    const rewriteRefs = (formula: string): string => {
      let f = formula;
      for (const [orig, fin] of changed) f = f.split(`'${orig}'`).join(`'${fin}'`);
      return f;
    };

    // 全シートを2回の batchGet（数式原文 + 計算値）で取得 → API 呼び出しを最小化（分間クォータ対策）
    const ranges = origNames.map(n => `'${n.replace(/'/g, "''")}'`);
    const [fRes, vRes] = await Promise.all([
      sheetsApi.spreadsheets.values.batchGet({ spreadsheetId: id, ranges, valueRenderOption: 'FORMULA', majorDimension: 'ROWS' }),
      sheetsApi.spreadsheets.values.batchGet({ spreadsheetId: id, ranges, valueRenderOption: 'UNFORMATTED_VALUE', majorDimension: 'ROWS' }),
    ]);
    const fRanges = fRes.data.valueRanges ?? [];
    const vRanges = vRes.data.valueRanges ?? [];

    origNames.forEach((name, si) => {
      const ws = wb.addWorksheet(nameMap.get(name) ?? name);
      const fRows = (fRanges[si]?.values ?? []) as unknown[][];
      const vRows = (vRanges[si]?.values ?? []) as unknown[][];
      const n = Math.max(fRows.length, vRows.length);
      for (let r = 0; r < n; r++) {
        const fRow = fRows[r] ?? [];
        const vRow = vRows[r] ?? [];
        const width = Math.max(fRow.length, vRow.length);
        if (width === 0) continue;
        const row = ws.getRow(r + 1);
        for (let c = 0; c < width; c++) {
          const f = fRow[c];
          const v = vRow[c];
          const empty = (f === '' || f === undefined || f === null) && (v === '' || v === undefined || v === null);
          if (empty) continue;
          const cell = row.getCell(c + 1);
          if (typeof f === 'string' && f.startsWith('=')) {
            cell.value = { formula: rewriteRefs(f.slice(1)), result: (v as string | number | boolean) ?? undefined } as ExcelJS.CellValue;
          } else {
            cell.value = (v ?? f) as ExcelJS.CellValue;
          }
        }
      }
    });

    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    const filename = title.toLowerCase().endsWith('.xlsx') ? title : `${title}.xlsx`;
    return { filename, buffer };
  } catch (e) {
    throw new Error(`Google スプレッドシート取得に失敗: ${gErr(e)}`);
  }
}

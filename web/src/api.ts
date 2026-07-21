// API クライアント。バックエンド（Express :8787）との通信ヘルパー。
const BASE = '/api'

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

export function get<T>(path: string): Promise<T> {
  return fetch(`${BASE}${path}`).then(res => handle<T>(res))
}

export function post<T>(path: string, body?: unknown): Promise<T> {
  return fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).then(res => handle<T>(res))
}

export function patch<T>(path: string, body: unknown): Promise<T> {
  return fetch(`${BASE}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(res => handle<T>(res))
}

export function del<T>(path: string): Promise<T> {
  return fetch(`${BASE}${path}`, { method: 'DELETE' }).then(res => handle<T>(res))
}

export function deleteProject(projectId: number): Promise<{ ok: boolean }> {
  return del<{ ok: boolean }>(`/projects/${projectId}`)
}

/** Google スプレッドシートを URL/ID で取り込む（サーバーが Drive API 経由で取得） */
export function importSheet(projectId: number, url: string, kind: string): Promise<Artifact> {
  return post<Artifact>(`/projects/${projectId}/import-sheet`, { url, kind })
}

/** アップロード済みアーティファクトを削除（誤投入の取り消し用） */
export function deleteArtifact(artifactId: number): Promise<{ ok: boolean }> {
  return del<{ ok: boolean }>(`/artifacts/${artifactId}`)
}

/** ドライブ内の Google スプレッドシート一覧（名前で絞り込み可。全ドライブ横断・平面） */
export interface DriveSheet { id: string; name: string; modifiedTime?: string }
export function listDriveSheets(q?: string): Promise<DriveSheet[]> {
  return get<DriveSheet[]>(`/google/spreadsheets${q ? `?q=${encodeURIComponent(q)}` : ''}`)
}

/** フォルダ別ブラウズ: 指定フォルダ（未指定=マイドライブ直下）のサブフォルダ + 表ファイル */
export interface DriveFolder { id: string; name: string }
export function browseDrive(folderId?: string): Promise<{ folders: DriveFolder[]; files: DriveSheet[] }> {
  return get<{ folders: DriveFolder[]; files: DriveSheet[] }>(`/google/drive${folderId ? `?folder=${encodeURIComponent(folderId)}` : ''}`)
}

// ---- Google Web ログイン（OAuth）----
export interface GoogleStatus {
  clientConfigured: boolean  // OAuth クライアント(ID/SECRET)が設定済みか
  connected: boolean         // ユーザーが Web ログイン済み（refresh token 保有）か
}
export function googleStatus(): Promise<GoogleStatus> {
  return get<GoogleStatus>('/google/status')
}
export function googleDisconnect(): Promise<{ ok: boolean }> {
  return post<{ ok: boolean }>('/google/disconnect')
}
/** Google ログイン開始 URL。全画面リダイレクトで使う。
 * 本番(1プロセス)は同一オリジン、開発は別ポートの API サーバー(:8787)へ直接ナビゲートする。 */
export function googleAuthUrl(): string {
  const origin = import.meta.env.VITE_API_ORIGIN
    || (import.meta.env.DEV ? `${window.location.protocol}//${window.location.hostname}:8788` : window.location.origin)
  return `${origin}/api/google/auth`
}

export function uploadFile<T>(path: string, file: File, kind: string): Promise<T> {
  const form = new FormData()
  form.append('file', file)
  form.append('kind', kind)
  return fetch(`${BASE}${path}`, { method: 'POST', body: form }).then(res => handle<T>(res))
}

// ---- 型定義（バックエンドのレスポンス形状） ----
export interface Project {
  id: number
  customer_name: string
  description: string
  status: string
  created_at: string
  match_rate?: number | null
}

export interface Artifact {
  id: number
  kind: string
  original_filename: string
  parse_status: string
  parse_error?: string | null
  sheet_roles?: string | null
}

/** シート役割の自動分類結果（混在ファイル対応） */
export interface SheetClassification {
  role: 'input_data' | 'working_sheet' | 'final_output' | 'unknown'
  reason: string
  references: string[]
}

export interface AnalysisRun {
  id: number
  stage: string
  status: string
  model: string
  error?: string | null
  started_at: string
  finished_at?: string | null
}

export interface ProjectDetailData extends Project {
  artifacts: Artifact[]
  runs: AnalysisRun[]
}

export interface Finding {
  id: number
  source_ref: string
  formula_raw?: string | null
  logic_type: string
  kpiee_target: string
  explanation: string
  confidence: string
  review_status: string
  modified_content?: string | null
  needs_customer_confirmation: number
}

export interface Deliverable {
  id: number
  kind: string
  version: number
  content: string
  validation_status: string
  validation_errors?: string | null
}

export interface MatchResult {
  id: number
  deliverable_version: number
  total_cells: number
  matched_cells: number
  mismatches: {
    cell_ref: string
    row_label: string
    column: string
    expected: number
    actual: number | null
    cause_category: string
    explanation: string
  }[]
}

// ---- KPIEE 実装プレビュー（照合の拡張） ----
type Cell = string | number | null

export interface KpieePreview {
  available: boolean
  message?: string
  reportName?: string
  sql?: string
  dataFile?: { columns: string[]; rows: Cell[][] }
  rendered?: { groupCol: string; metricNames: string[]; rows: { key: string; cells: (number | null)[] }[] }
  finalOutput?: { header: string[]; rows: Cell[][] } | null
  comparison?: {
    total: number
    matched: number
    matchRate: number
    missingColumns: string[]
    mismatches: { label: string; column: string; expected: number; actual: number | null }[]
  } | null
  notes?: string[]
}

export interface ImplItem { source: string; kpieeTarget: string; status: 'ok' | 'warn' | 'blocked'; how: string }
export interface ImplReport {
  available: boolean
  message?: string
  items: ImplItem[]
  summary: { ok: number; warn: number; blocked: number }
  markdown: string
}

export function getKpieePreview(projectId: number): Promise<KpieePreview> {
  return get<KpieePreview>(`/projects/${projectId}/kpiee-preview`)
}
export function getKpieeImplReport(projectId: number): Promise<ImplReport> {
  return get<ImplReport>(`/projects/${projectId}/kpiee-impl-report`)
}

export interface CustomerQuestion {
  id: number
  finding_id?: number | null
  question: string
  status: string
  customer_answer?: string | null
}

// ---- Apps Script（GAS）等、xlsx に保存されない変換ロジック ----
export interface ProjectScript {
  id: number
  name: string
  code: string
  created_at: string
}

export function getScripts(projectId: number): Promise<ProjectScript[]> {
  return get<ProjectScript[]>(`/projects/${projectId}/scripts`)
}

export function addScript(projectId: number, name: string, code: string): Promise<ProjectScript> {
  return post<ProjectScript>(`/projects/${projectId}/scripts`, { name, code })
}

export function deleteScript(scriptId: number): Promise<{ ok: boolean }> {
  return del<{ ok: boolean }>(`/scripts/${scriptId}`)
}

// ---- シート関係性グラフ ----
export type RelType = 'lookup-join' | 'filter-key' | 'filtered-agg' | 'aggregation' | 'passthrough' | 'derived' | 'copy'

export interface RelRegionColumn { c: number; name: string; hasFormula: boolean; mixedFormula: boolean }
/** decode の解読項目（AI解読の融合用） */
export interface RelAiFinding { logic_type: string; kpiee_target: string; explanation: string; confidence: string; source_ref: string }
export interface RelRegion {
  id: string; file: string; sheet: string
  r0: number; r1: number; c0: number; c1: number
  headerRow: number | null
  columns: RelRegionColumn[]
  dataRowCount: number
  ai?: RelAiFinding[]   // このシートに対する AI解読（decode 実行後に付与）
}
export interface RelEdge {
  from: string; to: string; type: RelType
  evidence: string; confidence: number
  needsConfirmation?: boolean
  aiHint?: string       // copy(値一致)辺に付く、提供先シートの AI解読ヒント
}
export interface RelWarning { kind: string; ref: string; message: string }

// シート内部の階層フロー構造（入力→計算→出力。反復列はグループに集約）
export interface SheetStructNode { id: string; layer: number; label: string; colCount: number; cols: string[]; samples: { col: string; formula: string }[] }
export interface SheetStructEdge { from: string; to: string; types: RelType[] }
export interface SheetStructure { regionId: string; layerCount: number; nodes: SheetStructNode[]; edges: SheetStructEdge[]; truncated: boolean }

// シート構成: あるシートが「どのシートからどう作られるか」
export interface SheetComposition {
  sheet: string
  role: '入力' | '中間集計' | '最終出力' | 'その他'
  composed_of: string[]
  method: string
  description: string
}

// テーブル定義書: 同一レイアウトのシート群に対する列・計算行の定義
export interface TableDefinition {
  title: string
  applies_to: string[]
  columns: { position: string; item: string; type: string; definition: string }[]
  calc_rows: { label: string; definition: string }[]
}

// 全体構造の解説（decode 時に AI が生成。シート構成＋テーブル定義書）
export interface StructureOverview {
  summary: string
  sheet_composition?: SheetComposition[]
  table_definitions?: TableDefinition[]
  caveats: string[]
  // 旧形式（過去の解読結果）との互換用。再解読すると新形式に置き換わる
  inputs?: { name: string; description: string }[]
  steps?: { title: string; description: string }[]
  outputs?: { name: string; description: string }[]
}

export interface RelationGraph {
  regions: RelRegion[]
  edges: RelEdge[]
  warnings: RelWarning[]
  fileCount: number
  hasFindings?: boolean // decode 済みで AI解読が融合されているか
  overview?: StructureOverview // 全体構造の自然言語サマリ（decode 実行後に付与）
  edgeTotal?: number    // 集約前の総関係数（巨大グラフで edges を代表のみに圧縮した場合に設定）
  edgeCollapsed?: boolean // 領域ペア単位に集約済みか（巨大グラフ対策）
  warningTotal?: number // 集約前の総注意件数
  sheetStructures?: SheetStructure[] // シート内部の階層フロー構造
}

/** プロジェクト全体（全ファイル横断）のシート関係グラフ */
export function getProjectRelations(projectId: number): Promise<RelationGraph> {
  return get<RelationGraph>(`/projects/${projectId}/relations`)
}

/** Blob/File を任意 kind でアップロード（Google Drive 取得ファイルの投入にも使う） */
export function uploadBlob<T>(path: string, blob: Blob, filename: string, kind: string): Promise<T> {
  const form = new FormData()
  form.append('file', blob, filename)
  form.append('kind', kind)
  return fetch(`${BASE}${path}`, { method: 'POST', body: form }).then(res => handle<T>(res))
}

// ---- 対話Q&A（解読済みシートへの自由質問。セル単位の根拠付き回答）----
export interface ChatMessage {
  id: number
  role: 'user' | 'assistant'
  content: string
  tool_trace?: string | null   // AI が辿ったツール呼び出し（[{tool, input}] の JSON）
  created_at: string
}
/** Q&A は非同期処理: POST は受付のみ（202）、回答は GET のポーリングで届く（ALB タイムアウト対策） */
export interface ChatState { messages: ChatMessage[]; pending: boolean }

export function getChat(projectId: number): Promise<ChatState> {
  return get<ChatState>(`/projects/${projectId}/chat`)
}
export function askChat(projectId: number, question: string): Promise<{ pending: boolean }> {
  return post<{ pending: boolean }>(`/projects/${projectId}/chat`, { question })
}

export interface SheetPreview {
  filename: string
  kind: string
  sheetRoles: Record<string, SheetClassification> | null
  tableName: string | null
  sheets: {
    name: string
    rowCount: number
    columnCount: number
    formulaCellCount: number
    rows: { rowNumber: number; cells: { ref: string; value: string | number | null; formula?: string }[]; compressedRange?: { from: number; to: number; count: number } }[]
  }[]
}

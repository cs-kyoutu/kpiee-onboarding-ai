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

/**
 * フォルダ別ブラウズ: 指定フォルダ（未指定=マイドライブ直下）のサブフォルダ + ファイル。
 * kind='docs' では表ではなく業務資料（txt / md / docx / pdf / Google ドキュメント）を並べる。
 * 手順書は案件データと同じフォルダに置かれていることが多いため、同じ辿り方で拾える。
 */
export interface DriveFolder { id: string; name: string }
export function browseDrive(
  folderId?: string, kind: 'sheets' | 'docs' = 'sheets',
): Promise<{ folders: DriveFolder[]; files: DriveSheet[] }> {
  const q = new URLSearchParams()
  if (folderId) q.set('folder', folderId)
  if (kind === 'docs') q.set('kind', 'docs')
  const s = q.toString()
  return get<{ folders: DriveFolder[]; files: DriveSheet[] }>(`/google/drive${s ? `?${s}` : ''}`)
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
  role: 'input_data' | 'master_data' | 'working_sheet' | 'final_output' | 'unknown'
  reason: string
  references: string[]
  /** 取込時に保存した規模。古いデータには無い */
  rows?: number
  formulas?: number
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
  /** 「人が確認した」印。roles_confirmed = シート分類を確定済み（自動分類では立たない） */
  flags?: string[]
}

/** 人が確認した印を立てる（新UI のステップ完了に使う） */
export function setProjectFlag(projectId: number, flag: string): Promise<{ ok: boolean; flags: string[] }> {
  return post<{ ok: boolean; flags: string[] }>(`/projects/${projectId}/flags/${flag}`)
}

/** 確認の印を外す（確定後に直したくなったときのロック解除） */
export function clearProjectFlag(projectId: number, flag: string): Promise<{ ok: boolean; flags: string[] }> {
  return del<{ ok: boolean; flags: string[] }>(`/projects/${projectId}/flags/${flag}`)
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

// ---- 業務資料（要件定義シート・手順書・引継ぎメモ）----
// データ（xlsx/csv）とは置き場所を分ける。資料は「データがどう作られるか」を書いた文書で、
// 関係分析やシート役割判定へ混ぜると判定を汚すだけ。一方で中身は AI の解読・要件の読み取りに効かせる。
/**
 * 資料の種別。doc=要件定義書・手順書（解読プロンプトに入る）／
 * sql-columns=Redash の物理カラム一覧（クエリ145/147 の書き出し。SQL構築チャットだけが読む）
 */
export type ProjectDocKind = 'doc' | 'sql-columns'

export interface ProjectDoc {
  id: number
  filename: string
  kind: ProjectDocKind
  byte_size: number
  /** 抽出できた本文の文字数。0 なら「入れたのに効いていない」ので画面で警告する */
  text_length: number
  extract_error: string | null
  created_at: string
}

export function getProjectDocs(projectId: number): Promise<ProjectDoc[]> {
  return get<ProjectDoc[]>(`/projects/${projectId}/docs`)
}

export function uploadProjectDoc(projectId: number, file: File, kind: ProjectDocKind = 'doc'): Promise<ProjectDoc> {
  return uploadFile<ProjectDoc>(`/projects/${projectId}/docs`, file, kind)
}

/** ドライブにある資料（手順書 txt・ロジックのメモ等）をそのまま取り込む */
export function importDocFromDrive(projectId: number, url: string): Promise<ProjectDoc> {
  return post<ProjectDoc>(`/projects/${projectId}/docs/from-drive`, { url })
}

/** 何が読み取れたかの確認用（本文をそのまま返す） */
export function getProjectDocText(docId: number): Promise<{
  filename: string; content: string; extract_error: string | null
}> {
  return get<{ filename: string; content: string; extract_error: string | null }>(`/docs/${docId}/text`)
}

export function deleteProjectDoc(docId: number): Promise<{ ok: boolean }> {
  return del<{ ok: boolean }>(`/docs/${docId}`)
}

/** 資料が指定しているシート役割（分類確認の当て込みに使う） */
export interface RoleHint {
  file: string
  /** 受領ファイルへ解決できた場合の artifact id。null なら未受領のファイルを指している */
  artifactId: number | null
  sheet: string
  /** 資料の指すシートが実在したか。false なら当て込めない（シート名の言い換えか未受領） */
  sheetFound: boolean
  role: string
  reason: string
}

export interface RequirementsDraft {
  docCount: number
  docNames: string[]
  /** そのまま saveReportSpec へ渡せる形（画面で確認・編集してから保存する） */
  spec: {
    reproduce: { label: string; text: string }[]
    howMade: string[]
    howMadeSource: string
    assumptions: string[]
    fileNotes: { file: string; note: string }[]
  }
  roleHints: RoleHint[]
  /** 資料に出てきたが受領ファイルに無い名前（未受領の可能性） */
  unresolved: string[]
}

/** 業務資料から案件の要件を読み取る。保存はせず、案を返すだけ */
export function extractRequirements(projectId: number): Promise<RequirementsDraft> {
  return post<RequirementsDraft>(`/projects/${projectId}/requirements/extract`)
}

// ---- SQL構築チャット ----
// レポート読み合わせ後の工程。AI がナレッジ（kpiee-sql-builder）の4ターン運用で SQLジョブを組み立て、
// 検証・本体・検算を取込済みの実データ（DuckDB サンドボックス）で自分で流す。
export interface SqlToolTrace {
  tool: string
  /** run_sql の目的 / read_reference の名前 / save_sql の成果物名 */
  label: string
  sql?: string
  result?: { columns: string[]; rows: string[][]; totalRows: number; truncated: boolean }
  error?: string
}

export interface SqlChatMessage {
  id: number
  role: 'user' | 'assistant'
  content: string
  /** SqlToolTrace[] の JSON。AI がどの SQL を流してどんな結果を見たかを会話に沿って出す */
  tool_trace: string | null
  created_at: string
}

export interface SqlJob {
  id: number
  name: string
  sql: string
  note: string
  /** 出力仕様（順番→別名→予測物理名→原本の列→下流での用途）。Markdown */
  output_spec: string
  updated_at: string
}

export interface SqlChatState {
  messages: SqlChatMessage[]
  pending: boolean
  jobs: SqlJob[]
  /** 構築ナレッジ全文をプロンプトへ常時入れるか。既定 OFF（大前提＋契約だけの軽量運転） */
  knowledgeOn: boolean
}

export function getSqlChat(projectId: number): Promise<SqlChatState> {
  return get<SqlChatState>(`/projects/${projectId}/sql-chat`)
}

/** 物理カラムの対応1行（SQL構築 ステップ1で人が確定するもの） */
export interface SqlColumnRow {
  id?: number
  table_name: string
  physical_column: string
  logical_name: string
  asset_name: string
  note: string
}

/** 添付済みの Redash 書き出しから初期案を起こす（保存はしない。確定は人） */
export function parseSqlColumns(projectId: number): Promise<{ rows: SqlColumnRow[]; notes: string[] }> {
  return post<{ rows: SqlColumnRow[]; notes: string[] }>(`/projects/${projectId}/sql-columns/parse`)
}

export function getSqlColumns(projectId: number): Promise<{ rows: SqlColumnRow[]; confirmed: boolean }> {
  return get<{ rows: SqlColumnRow[]; confirmed: boolean }>(`/projects/${projectId}/sql-columns`)
}

/** 対応表を確定する（丸ごと置き換え）。rows 空でも確定できる＝物理名なしで進む（取込前） */
export function saveSqlColumns(projectId: number, rows: SqlColumnRow[]): Promise<{ rows: SqlColumnRow[]; confirmed: boolean }> {
  return fetch(`${BASE}/projects/${projectId}/sql-columns`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rows }),
  }).then(res => handle<{ rows: SqlColumnRow[]; confirmed: boolean }>(res))
}

export function sendSqlChat(projectId: number, message: string): Promise<{ pending: boolean }> {
  return post<{ pending: boolean }>(`/projects/${projectId}/sql-chat`, { message })
}

export function deleteSqlJob(jobId: number): Promise<{ ok: boolean }> {
  return del<{ ok: boolean }>(`/sql-jobs/${jobId}`)
}

// ---- シート関係性グラフ ----
export type RelType = 'lookup-join' | 'filter-key' | 'filtered-agg' | 'aggregation' | 'passthrough' | 'derived' | 'copy'

export interface RelColumnStats { filled: number; uniq: number; text: number }
export interface RelRegionColumn { c: number; name: string; hasFormula: boolean; mixedFormula: boolean; stats?: RelColumnStats }
/** decode の解読項目（AI解読の融合用） */
export interface RelAiFinding { logic_type: string; kpiee_target: string; explanation: string; confidence: string; source_ref: string }
/** キー・軸の推定。primary=単独で行を一意に定める列 / axis=複合軸の構成列（部署 × 月 等） */
// role: primary=単独で1行を決める / axis=複合軸の構成列（組合せで1行） / join=数式が照合に使う列
//（join は結合キーの候補だが1行を決めるとは限らない。relations.ts の KeyRole と揃える）
export interface RelRegionKey { column: string; c: number; role: 'primary' | 'axis' | 'join'; confidence: number; evidence: string[] }
export interface RelRegionKeys { keys: RelRegionKey[]; axisNote?: string; colAxis?: string; joinKeysOmitted?: number }
export interface RelRegion {
  id: string; file: string; sheet: string
  r0: number; r1: number; c0: number; c1: number
  headerRow: number | null
  columns: RelRegionColumn[]
  dataRowCount: number
  keys?: RelRegionKeys  // 主キー・軸の推定（値の一意性＋数式のキー利用から）
  ai?: RelAiFinding[]   // このシートに対する AI解読（decode 実行後に付与）
}
/** 表と表を結ぶキー列の対応（a=数式側, b=参照される側, via=引き当て先の列） */
export interface RelKeyLink { a: string; b: string; via: string; fn: string; evidence: string; count: number }
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
  keyLinks?: RelKeyLink[] // 表と表を結ぶキー列の対応（VLOOKUP/SUMIFS 等の引数位置から抽出）
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

// ---- ブック（ファイル）関係 ----
// シート単位の自動解析より上位の入力。自動検出を初期案として提示し、担当者が確定する。
export type FileRelType = 'aggregate' | 'reference' | 'transcribe' | 'manual_copy' | 'unknown'

/** 関係登録の対象ファイル（解析対象の xlsx/csv のみ） */
export interface FileRelFile {
  id: number
  filename: string
  label: string            // 拡張子なし。関係グラフ側のファイルラベルと一致する
  kind: string
  sheetRoles: Record<string, string> | null
}

export interface FileRelation {
  id: number
  fromFile: string
  toFile: string
  relType: FileRelType
  note: string
  origin: 'auto' | 'manual'
  /** 作成手順の層（手順書がある案件だけ入る）。レポート 02 をステップの帯で描くのに使う */
  step?: number
  stepTitle?: string
  adds?: string
}

/** 手順書から読み取った受け渡しの案（保存前。ファイル名は解決できないことがある） */
export interface StepFlowProposal {
  step: number
  stepTitle: string
  fromFile: string
  toFile: string
  relType: FileRelType
  adds: string
  note: string
  fromArtifactId: number | null
  toArtifactId: number | null
}

/** 自動検出されたが未登録のファイル対（初期案） */
export interface ProposedFileRelation {
  fromFile: string
  toFile: string
  relType: FileRelType
  total: number
  reason: string
  fromArtifactId: number
  toArtifactId: number
}

export type FileRelVerdict = 'matched' | 'declared_not_detected' | 'detected_not_declared' | 'direction_conflict'

export interface FileRelAudit {
  fromFile: string
  toFile: string
  verdict: FileRelVerdict
  relType?: FileRelType
  note?: string
  detectedTotal: number
}

export interface FileRelationsData {
  files: FileRelFile[]
  declared: FileRelation[]
  proposed: ProposedFileRelation[]
  audit: FileRelAudit[]
  relTypes: Record<FileRelType, string>
}

export function getFileRelations(projectId: number): Promise<FileRelationsData> {
  return get<FileRelationsData>(`/projects/${projectId}/file-relations`)
}

export function addFileRelation(projectId: number, body: {
  fromArtifactId: number; toArtifactId: number; relType: FileRelType; note?: string
  origin?: 'auto' | 'manual'; step?: number | null; stepTitle?: string; adds?: string
}): Promise<{ ok: boolean; id: number }> {
  return post(`/projects/${projectId}/file-relations`, body)
}

/** 業務資料（手順書）から作成手順を読み取る。保存はせず、案を返すだけ */
export function extractFileRelationsFromDocs(projectId: number): Promise<{
  proposals: StepFlowProposal[]; unresolved: string[]; docCount: number
}> {
  return post(`/projects/${projectId}/file-relations/from-docs`)
}

export function acceptAllFileRelations(projectId: number): Promise<{ ok: boolean; added: number }> {
  return post(`/projects/${projectId}/file-relations/accept-all`)
}

export function updateFileRelation(id: number, body: {
  relType?: FileRelType; note?: string; step?: number | null; stepTitle?: string; adds?: string
}): Promise<{ ok: boolean }> {
  return patch(`/file-relations/${id}`, body)
}

export function deleteFileRelation(id: number): Promise<{ ok: boolean }> {
  return del(`/file-relations/${id}`)
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

// ---- アウトプット相談（レポートに何を載せるか）----
// デザインと骨格は固定。案件ごとに変えるのは「どの節・どの項目を載せるか」だけ。
// 関係図（ノード形式）は指定対象に無く、常に載る。
export interface ReportSpecSections {
  inventory: boolean; flow: boolean; questions: boolean; nextSteps: boolean
}
export interface ReportSpecItems {
  fileTable: boolean; sheetDetails: boolean; declaredAudit: boolean
  fileFlow: boolean; erDiagram: boolean; detailLogic: boolean; interactiveGraph: boolean
}
/** 02-1「再現するもの」の1件。02 の入口で「何を作り直すのか」を帳票の単位で並べる */
export interface ReportOverviewItem { label: string; text: string }
/** 01 でファイルを開いた先頭に出す補足（そのブックの読み方） */
export interface ReportFileNote { file: string; note: string }

// 要件定義シート由来の指定（reproduce / howMade / assumptions / fileNotes）は、
// 数式からは出てこない「伺った内容」。サーバーの ReportSpec と同じ名前で持ち、
// 画面から直接確認・編集できるようにする（従来は AI 相談かスクリプト転記しか経路が無かった）。
export interface ReportSpec {
  title: string
  focus: string
  sections: ReportSpecSections
  items: ReportSpecItems
  notes: string[]
  /** 02-1「再現するもの」。kpiee で再現する帳票 */
  reproduce: ReportOverviewItem[]
  /** 02-1「作られ方」。どのファイルから何を付与するか（1行ずつ） */
  howMade: string[]
  /** 02-1 の導入で名前を出す出典（例: 要件定義シート（○○様_△△pjt）と試算手順） */
  howMadeSource: string
  /** 02-2「再現するうえでの前提」。配賦の例外・未受領データの扱いなど */
  assumptions: string[]
  /** 01 のファイルごとの補足（種別・更新頻度・対象タブなど） */
  fileNotes: ReportFileNote[]
}

/** 相談の前提として画面にも出す解析結果の要約 */
export interface ReportFacts {
  customerName: string
  files: { filename: string; kind: string; sheetRoles: Record<string, string> | null }[]
  regionCount: number
  edgeCount: number
  copyPairCount: number
  questionCount: number
  declaredRelCount: number
  multiFile: boolean
}

export interface ReportSpecData {
  spec: ReportSpec
  /** 構成を一度保存したか（＝相談ステップを通ったか）。未保存なら既定＝全部出す */
  configured: boolean
  sectionLabels: Record<keyof ReportSpecSections, string>
  itemLabels: Record<keyof ReportSpecItems, string>
}

export interface ReportChatMessage {
  id: number
  role: 'user' | 'assistant'
  content: string
  spec_patch?: string | null
  created_at: string
}

export interface ReportChatState {
  messages: ReportChatMessage[]
  pending: boolean
  spec: ReportSpec
  kickoff: string
}

export function getReportSpec(projectId: number): Promise<ReportSpecData> {
  return get<ReportSpecData>(`/projects/${projectId}/report-spec`)
}

/** 解析結果の要約。関係グラフを読むので重い。画面では1回だけ取る */
export function getReportFacts(projectId: number): Promise<{ facts: ReportFacts }> {
  return get<{ facts: ReportFacts }>(`/projects/${projectId}/report-facts`)
}

/** 部分指定で保存（省略した項目は現状維持） */
export function saveReportSpec(projectId: number, patch: Partial<ReportSpec>): Promise<{ spec: ReportSpec }> {
  return fetch(`${BASE}/projects/${projectId}/report-spec`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  }).then(res => handle<{ spec: ReportSpec }>(res))
}

export function getReportChat(projectId: number): Promise<ReportChatState> {
  return get<ReportChatState>(`/projects/${projectId}/report-chat`)
}

/** message 省略で「提案から始めて」の初手を送る */
export function sendReportChat(projectId: number, message?: string): Promise<{ pending: boolean }> {
  return post<{ pending: boolean }>(`/projects/${projectId}/report-chat`, { message })
}

/** レポート HTML の URL。inline はプレビュー（iframe）用でダウンロードさせない */
export function reportUrl(projectId: number, inline = false): string {
  return `${BASE}/projects/${projectId}/relations/report${inline ? '?inline=1' : ''}`
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

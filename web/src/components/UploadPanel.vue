<script setup lang="ts">
// SC-03 アーティファクトアップロード。
// 資料3種（インプットデータ / 最終帳票 / 中間シート）の種別指定アップロードに加え、
// 1ファイルに raw / 中間 / 帳票 が混在するワークブック向けの「自動分類」に対応する。
// 自動分類はシート間の数式参照グラフによる推定のため、プレビューで確認・修正できる。
import { ref, computed, onMounted } from 'vue'
import { uploadFile, importSheet, listDriveSheets, browseDrive, deleteArtifact, googleStatus, googleAuthUrl, googleDisconnect, get, patch, type Artifact, type SheetPreview, type SheetClassification, type DriveSheet, type DriveFolder, type GoogleStatus } from '../api'
import SheetViewer from './SheetViewer.vue'

const props = defineProps<{ projectId: number; artifacts: Artifact[] }>()
const emit = defineEmits<{ changed: [] }>()

const kind = ref<'auto' | 'input_data' | 'final_output' | 'working_sheet'>('auto')
const uploading = ref(false)
const error = ref('')
const importing = ref(false)
// ドライブ参照（自分のドライブから選んで取り込む）
const showDrive = ref(false)
const driveSheets = ref<DriveSheet[]>([])
const driveQuery = ref('')
const driveLoading = ref(false)
// フォルダ別ブラウズ: 'browse'=階層ナビ / 'search'=名前検索（全ドライブ横断・平面）
const driveMode = ref<'browse' | 'search'>('browse')
const driveFolders = ref<DriveFolder[]>([])
// パンくず。空配列＝マイドライブ直下。各要素 { id, name } はそのフォルダを表す
const folderStack = ref<{ id: string; name: string }[]>([])
// 複数選択して一括取り込み（チェックした分だけまとめて投入）
const selectedDriveIds = ref<string[]>([])
// 一括取り込みの進捗（done / total）。null のとき非表示
const importProgress = ref<{ done: number; total: number } | null>(null)
// 全件選択トグルの状態（一覧の全 ID が選択済みか）
const allDriveSelected = computed(() =>
  driveSheets.value.length > 0 && selectedDriveIds.value.length === driveSheets.value.length)
// Google Web ログイン状態
const googleConn = ref<GoogleStatus>({ clientConfigured: false, connected: false })
const googleMsg = ref('')

async function refreshGoogleStatus() {
  try { googleConn.value = await googleStatus() } catch { /* 未起動時などは無視 */ }
}

// 連携済みなら、ボタンを押す前にルート（マイドライブ＋共有）を裏で先読みしておく。
// これで「Google ドライブから選択」を押した瞬間にキャッシュから即表示できる。
function prefetchRoot() {
  if (!googleConn.value.connected || clientFolderCache.has(rootKey)) return
  browseDrive().then(d => {
    clientFolderCache.set(rootKey, d)
    prefetchSubfolders(d.folders) // 直下フォルダも先読み（1階層先まで温める）
  }).catch(() => { /* noop */ })
}

onMounted(async () => {
  await refreshGoogleStatus()
  prefetchRoot()
  // OAuth コールバックからの戻り（?google=connected/denied/error）を処理
  const params = new URLSearchParams(window.location.search)
  const g = params.get('google')
  if (g) {
    googleMsg.value = g === 'connected' ? '✓ Google ドライブに接続しました'
      : g === 'denied' ? 'Google へのアクセスが拒否されました'
      : `Google 接続でエラーが発生しました${params.get('msg') ? '：' + params.get('msg') : ''}`
    window.history.replaceState({}, '', window.location.pathname) // URL からパラメータ除去
    if (g === 'connected') { await refreshGoogleStatus(); prefetchRoot() }
  }
})

// ドライブボタンのラベル（連携状態で出し分け）
const driveButtonLabel = computed(() => {
  if (googleConn.value.connected) return showDrive.value ? 'Google ドライブを閉じる' : 'Google ドライブから選択'
  if (googleConn.value.clientConfigured) return 'Google でログイン'
  return 'Google ドライブ（未設定）'
})

// ドライブボタン押下: 連携済みなら一覧表示、未連携ならログインへ遷移
function onDriveButton() {
  if (googleConn.value.connected) { void toggleDrive(); return }
  if (googleConn.value.clientConfigured) { window.location.href = googleAuthUrl(); return }
  error.value = 'Google 連携が未設定です。server/.env に OAuth クライアント(GOOGLE_OAUTH_CLIENT_ID / SECRET)を設定してください（docs/google-drive-setup.md 参照）'
}

async function doDisconnect() {
  await googleDisconnect()
  showDrive.value = false
  driveSheets.value = []
  driveFolders.value = []
  folderStack.value = []
  googleMsg.value = 'Google 連携を解除しました'
  await refreshGoogleStatus()
}
const preview = ref<SheetPreview | null>(null)
const previewArtifactId = ref<number | null>(null)
const editedRoles = ref<Record<string, string>>({})
const rolesSaved = ref(false)

const KIND_LABELS: Record<string, string> = {
  input_data: 'インプットデータ',
  final_output: '最終帳票',
  working_sheet: '中間スプレッドシート',
  mixed: '混在（自動分類）',
}

const ROLE_LABELS: Record<string, string> = {
  input_data: 'インプット（raw）',
  working_sheet: '中間シート',
  final_output: '最終帳票',
  unknown: '⚠ 判定不能',
}

async function onFileSelected(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  error.value = ''
  uploading.value = true
  try {
    const uploaded = await uploadFile<Artifact>(`/projects/${props.projectId}/artifacts`, file, kind.value)
    emit('changed')
    // 自動分類した場合は結果をすぐ確認できるようプレビューを開く
    if (kind.value === 'auto' && uploaded.parse_status === 'done') await showPreview(uploaded.id)
  } catch (err) {
    error.value = String(err)
  } finally {
    uploading.value = false
    input.value = ''
  }
}

// Google スプレッドシートを URL/ID で取り込む（サーバーが Drive API で xlsx 化して投入）
async function doImport(urlOrId: string) {
  if (!urlOrId.trim()) return
  error.value = ''
  importing.value = true
  try {
    const imported = await importSheet(props.projectId, urlOrId.trim(), kind.value)
    emit('changed')
    if (kind.value === 'auto' && imported.parse_status === 'done') await showPreview(imported.id)
  } catch (err) {
    error.value = String(err)
  } finally {
    importing.value = false
  }
}

// クライアント側キャッシュ（フォルダID→中身）。同一セッション内の再訪・戻る操作を即時にする。
// さらに、表示中フォルダの「サブフォルダ」を裏で先読みしておき、クリック時に待ち時間ゼロで開けるようにする。
// 体感遅延の主因は Google Drive API の往復(~1秒)で、これは1回ごとには縮められないため、
// 「次に開きそうなフォルダを前もって取っておく」ことで実質的に待たせない。
type FolderData = { folders: DriveFolder[]; files: DriveSheet[] }
const clientFolderCache = new Map<string, FolderData>()
const rootKey = '__root__'
const keyOf = (folderId?: string) => folderId || rootKey

// サブフォルダの中身を裏で先読み（失敗は無視。本命操作時に取り直される）
function prefetchSubfolders(folders: DriveFolder[]) {
  for (const f of folders.slice(0, 30)) {
    if (clientFolderCache.has(f.id)) continue
    browseDrive(f.id).then(d => clientFolderCache.set(f.id, d)).catch(() => { /* noop */ })
  }
}

// 現在のフォルダ（パンくず末尾。空ならマイドライブ直下）の中身を表示する。
// キャッシュにあればスピナーなしで即表示。無ければ取得してキャッシュ。どちらの場合もサブフォルダを先読み。
async function loadFolder(folderId?: string) {
  driveMode.value = 'browse'
  error.value = ''
  selectedDriveIds.value = []
  const cached = clientFolderCache.get(keyOf(folderId))
  if (cached) {
    driveFolders.value = cached.folders
    driveSheets.value = cached.files
    prefetchSubfolders(cached.folders)
    return
  }
  driveLoading.value = true
  try {
    const data = await browseDrive(folderId)
    clientFolderCache.set(keyOf(folderId), data)
    driveFolders.value = data.folders
    driveSheets.value = data.files
    prefetchSubfolders(data.folders)
  } catch (err) {
    error.value = String(err)
  } finally {
    driveLoading.value = false
  }
}

// フォルダへ入る（パンくずに積む）
async function enterFolder(f: DriveFolder) {
  folderStack.value.push({ id: f.id, name: f.name })
  await loadFolder(f.id)
}

// パンくずの指定位置へ戻る（index<0 でマイドライブ直下）
async function goToCrumb(index: number) {
  folderStack.value = index < 0 ? [] : folderStack.value.slice(0, index + 1)
  const top = folderStack.value[folderStack.value.length - 1]
  await loadFolder(top?.id)
}

// 検索ボタン: 検索語があれば全ドライブ横断の平面検索、空ならフォルダ表示へ戻る
async function loadDriveSheets() {
  if (!driveQuery.value.trim()) { folderStack.value = []; await loadFolder(); return }
  driveMode.value = 'search'
  driveLoading.value = true
  error.value = ''
  selectedDriveIds.value = []
  try {
    driveFolders.value = []
    driveSheets.value = await listDriveSheets(driveQuery.value)
  } catch (err) {
    error.value = String(err)
  } finally {
    driveLoading.value = false
  }
}

// 検索結果からフォルダ表示へ戻る
async function backToBrowse() {
  driveQuery.value = ''
  folderStack.value = []
  await loadFolder()
}

async function toggleDrive() {
  showDrive.value = !showDrive.value
  if (showDrive.value && driveFolders.value.length === 0 && driveSheets.value.length === 0) await loadFolder()
}

async function pickDriveSheet(s: DriveSheet) {
  await doImport(s.id)
}

// チェックボックスの選択トグル
function toggleDriveSelect(id: string) {
  const i = selectedDriveIds.value.indexOf(id)
  if (i >= 0) selectedDriveIds.value.splice(i, 1)
  else selectedDriveIds.value.push(id)
}

// 全件選択 / 全解除
function toggleSelectAll() {
  selectedDriveIds.value = allDriveSelected.value ? [] : driveSheets.value.map(s => s.id)
}

// 選択した複数シートを順に取り込む（1件ずつ失敗しても続行せず中断・報告）
async function importSelected() {
  const ids = [...selectedDriveIds.value]
  if (ids.length === 0) return
  error.value = ''
  importing.value = true
  importProgress.value = { done: 0, total: ids.length }
  try {
    let last: Artifact | undefined
    for (const id of ids) {
      last = await importSheet(props.projectId, id, kind.value)
      importProgress.value.done++
      emit('changed')
    }
    selectedDriveIds.value = []
    // 自動分類のときは最後に取り込んだファイルの分類結果を確認できるよう開く
    if (kind.value === 'auto' && last?.parse_status === 'done') await showPreview(last.id)
  } catch (err) {
    error.value = String(err)
  } finally {
    importing.value = false
    importProgress.value = null
  }
}

// アップロード済みアーティファクトの取り消し（誤投入の削除）
async function removeArtifact(a: Artifact) {
  if (!window.confirm(`「${a.original_filename}」をアップロード一覧から削除します。よろしいですか？`)) return
  error.value = ''
  try {
    await deleteArtifact(a.id)
    // 削除対象のプレビューを開いていたら閉じる
    if (previewArtifactId.value === a.id) {
      preview.value = null
      previewArtifactId.value = null
    }
    emit('changed')
  } catch (err) {
    error.value = String(err)
  }
}

async function showPreview(artifactId: number) {
  preview.value = await get<SheetPreview>(`/artifacts/${artifactId}/preview`)
  previewArtifactId.value = artifactId
  rolesSaved.value = false
  // 役割修正フォームの初期値は現在の分類結果
  editedRoles.value = Object.fromEntries(
    Object.entries(preview.value.sheetRoles ?? {}).map(([name, c]) => [name, c.role]),
  )
}

async function saveRoles() {
  if (!previewArtifactId.value) return
  const res = await patch<{ sheet_roles: Record<string, SheetClassification> }>(
    `/artifacts/${previewArtifactId.value}/roles`,
    { sheet_roles: editedRoles.value },
  )
  if (preview.value) preview.value.sheetRoles = res.sheet_roles
  rolesSaved.value = true
  emit('changed')
}

/** アーティファクト一覧に出す役割サマリ（混在ファイル用） */
function rolesSummary(a: Artifact): string {
  if (!a.sheet_roles) return ''
  const roles = JSON.parse(a.sheet_roles) as Record<string, SheetClassification>
  return Object.entries(roles)
    .map(([name, c]) => `${name}→${ROLE_LABELS[c.role] ?? c.role}`)
    .join(' / ')
}
</script>

<template>
  <div class="panel">
    <h2>資料アップロード（UC-02）</h2>
    <p class="muted">
      顧客から受領した資料をアップロードしてください。xlsx / csv に対応。数式は自動抽出されます。<br />
      <strong>「自動分類」</strong>を選ぶと、1ファイルに raw・中間・帳票が混在するワークブックでも、
      シート間の数式参照からシートごとの役割を自動推定します（プレビューで修正可能）。
    </p>
    <p v-if="error" class="error-box">{{ error }}</p>
    <div class="toolbar">
      <select v-model="kind" style="width: 280px">
        <option value="auto">🔍 自動分類（混在ファイル / 迷ったらこれ）</option>
        <option value="input_data">① インプットデータ（基幹CSV等）</option>
        <option value="final_output">② 最終帳票（再現対象）</option>
        <option value="working_sheet">③ 中間スプレッドシート（数式入り）</option>
      </select>
      <label class="source-btn primary">
        {{ uploading ? 'アップロード中…' : 'PC からファイルを選択' }}
        <input type="file" accept=".xlsx,.xlsm,.csv" style="display: none" :disabled="uploading" @change="onFileSelected" />
      </label>
      <button class="source-btn" @click="onDriveButton">
        <svg viewBox="0 0 87.3 78" width="16" height="16" aria-hidden="true">
          <path d="m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8h-27.5c0 1.55.4 3.1 1.2 4.5z" fill="#0066da" />
          <path d="m43.65 25-13.75-23.8c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44c-.8 1.4-1.2 2.95-1.2 4.5h27.5z" fill="#00ac47" />
          <path d="m73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5h-27.502l5.852 11.5z" fill="#ea4335" />
          <path d="m43.65 25 13.75-23.8c-1.35-.8-2.9-1.2-4.5-1.2h-18.5c-1.6 0-3.15.45-4.5 1.2z" fill="#00832d" />
          <path d="m59.8 53h-32.3l-13.75 23.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z" fill="#2684fc" />
          <path d="m73.4 26.5-12.7-22c-.8-1.4-1.95-2.5-3.3-3.3l-13.75 23.8 16.15 28h27.45c0-1.55-.4-3.1-1.2-4.5z" fill="#ffba00" />
        </svg>
        {{ driveButtonLabel }}
      </button>
      <span v-if="googleConn.connected" class="gconn">
        連携済み <a href="#" @click.prevent="doDisconnect">解除</a>
      </span>
    </div>
    <p v-if="googleMsg" class="muted" style="margin:4px 0 0">{{ googleMsg }}</p>

    <div v-if="showDrive" class="drive-browse">
      <div class="toolbar" style="margin-bottom:8px">
        <input v-model="driveQuery" type="text" placeholder="名前で検索（空欄でフォルダ表示）" style="max-width:360px" @keyup.enter="loadDriveSheets" />
        <button @click="loadDriveSheets" :disabled="driveLoading">{{ driveLoading ? '検索中…' : '検索' }}</button>
      </div>

      <!-- パンくず（フォルダ別ブラウズ時のみ）。マイドライブ→サブフォルダの経路を表示・移動 -->
      <div v-if="driveMode === 'browse'" class="drive-crumbs">
        <a href="#" @click.prevent="goToCrumb(-1)">📁 ドライブ（マイドライブ＋共有）</a>
        <template v-for="(c, i) in folderStack" :key="c.id">
          <span class="sep">›</span>
          <a href="#" @click.prevent="goToCrumb(i)">{{ c.name }}</a>
        </template>
      </div>
      <!-- 検索モードの案内＋フォルダ表示へ戻る導線 -->
      <div v-else class="drive-crumbs">
        <span class="muted">「{{ driveQuery }}」の検索結果（全ドライブ横断）</span>
        <span class="sep">·</span>
        <a href="#" @click.prevent="backToBrowse">📁 フォルダ表示に戻る</a>
      </div>

      <!-- 読み込み中の明示（Google Drive API 応答待ち。1秒前後かかるため無反応に見せない） -->
      <p v-if="driveLoading" class="muted" style="padding:10px 6px">⏳ Google ドライブを読み込み中…</p>

      <!-- サブフォルダ（クリックで移動）。ブラウズ時のみ -->
      <ul v-if="!driveLoading && driveMode === 'browse' && driveFolders.length > 0" class="drive-list folders">
        <li v-for="f in driveFolders" :key="f.id" class="folder-row" @click="enterFolder(f)">
          <div class="ds-icon">📁</div>
          <div class="ds-name">{{ f.name }}</div>
          <div class="ds-meta">フォルダ</div>
          <button @click.stop="enterFolder(f)">開く</button>
        </li>
      </ul>
      <!-- 複数選択して一括取り込み。チェックした分だけまとめて投入できる -->
      <div v-if="!driveLoading && driveSheets.length > 0" class="drive-bulk">
        <label class="ds-check">
          <input type="checkbox" :checked="allDriveSelected" @change="toggleSelectAll" />
          すべて選択
        </label>
        <span class="muted">{{ selectedDriveIds.length }} 件選択中</span>
        <span class="grow"></span>
        <span v-if="importProgress" class="muted">取り込み中… {{ importProgress.done }}/{{ importProgress.total }}</span>
        <button class="primary" :disabled="importing || selectedDriveIds.length === 0" @click="importSelected">
          選択した {{ selectedDriveIds.length }} 件を取り込む
        </button>
      </div>
      <ul v-if="!driveLoading" class="drive-list">
        <li v-for="s in driveSheets" :key="s.id" :class="{ picked: selectedDriveIds.includes(s.id) }">
          <label class="ds-check">
            <input type="checkbox" :checked="selectedDriveIds.includes(s.id)" :disabled="importing" @change="toggleDriveSelect(s.id)" />
          </label>
          <div class="ds-name">{{ s.name }}</div>
          <div class="ds-meta">{{ (s.modifiedTime || '').slice(0, 10) }}</div>
          <button :disabled="importing" @click="pickDriveSheet(s)">単独で取り込む</button>
        </li>
        <li v-if="!driveLoading && driveSheets.length === 0 && driveFolders.length === 0" class="muted" style="justify-content:center">
          {{ driveMode === 'search' ? '該当するスプレッドシートがありません' : 'このフォルダに表ファイル・サブフォルダはありません' }}
        </li>
      </ul>
    </div>

    <table>
      <thead>
        <tr><th>種別</th><th>ファイル名</th><th>シート役割</th><th>解析状態</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="a in artifacts" :key="a.id">
          <td>{{ KIND_LABELS[a.kind] ?? a.kind }}</td>
          <td>{{ a.original_filename }}</td>
          <td class="muted">{{ rolesSummary(a) }}</td>
          <td>
            <span class="badge" :class="a.parse_status === 'done' ? 'ok' : a.parse_status === 'failed' ? 'ng' : 'warn'">
              {{ a.parse_status === 'done' ? '解析済' : a.parse_status === 'failed' ? '解析失敗' : '解析中' }}
            </span>
            <span v-if="a.parse_error" class="muted"> {{ a.parse_error }}</span>
          </td>
          <td class="row-actions">
            <button :disabled="a.parse_status !== 'done'" @click="showPreview(a.id)">プレビュー</button>
            <button class="danger" @click="removeArtifact(a)">取消</button>
          </td>
        </tr>
        <tr v-if="artifacts.length === 0"><td colspan="5" class="muted">まだアップロードされていません</td></tr>
      </tbody>
    </table>
  </div>

  <!-- 自動分類の結果確認・修正（混在ファイルのみ表示） -->
  <div v-if="preview?.sheetRoles" class="panel" style="border-left: 4px solid #1b6ec2">
    <h2>シート役割の自動分類結果 — 確認・修正</h2>
    <p class="muted">数式の参照方向（誰が誰を参照するか）から推定しています。誤っていれば修正して保存してください。</p>
    <table>
      <thead>
        <tr><th>シート</th><th>役割</th><th>判定理由</th></tr>
      </thead>
      <tbody>
        <tr v-for="(c, name) in preview.sheetRoles" :key="name">
          <td><strong>{{ name }}</strong></td>
          <td>
            <select v-model="editedRoles[name]" style="width: 180px">
              <option value="input_data">インプット（raw）</option>
              <option value="working_sheet">中間シート</option>
              <option value="final_output">最終帳票</option>
              <option value="unknown">判定不能（除外）</option>
            </select>
          </td>
          <td class="muted">{{ c.reason }}</td>
        </tr>
      </tbody>
    </table>
    <div class="toolbar" style="margin-top: 10px; margin-bottom: 0">
      <button class="primary" @click="saveRoles">役割を保存</button>
      <span v-if="rolesSaved" class="badge ok">保存しました</span>
    </div>
  </div>

  <div v-if="preview" class="panel">
    <h2>{{ preview.filename }} <span v-if="preview.tableName" class="badge info">テーブル名: {{ preview.tableName }}</span></h2>
    <SheetViewer :sheets="preview.sheets" />
  </div>
</template>

<style scoped>
/* PC / Google ドライブ ボタンを同じ寸法に揃える */
.source-btn {
  display: inline-flex; align-items: center; gap: 7px;
  height: 34px; padding: 0 14px; box-sizing: border-box;
  font: inherit; font-size: 13px; line-height: 1;
  border: 1px solid var(--border); border-radius: 6px;
  background: #fff; color: var(--text); cursor: pointer;
}
.source-btn:hover { background: #f3f4f6; }
.source-btn.primary { background: var(--primary); border-color: var(--primary); color: #fff; }
.source-btn.primary:hover { background: var(--primary-dark); }
.drive-browse { margin-top: 10px; padding: 12px; border: 1px solid var(--border); border-radius: 8px; background: #fafbfc; }
.drive-list { list-style: none; margin: 0; padding: 0; max-height: 320px; overflow-y: auto; display: flex; flex-direction: column; }
.drive-list li { display: flex; align-items: center; gap: 12px; padding: 8px 6px; border-bottom: 1px solid #eef1f4; font-size: 13px; }
.drive-list li:last-child { border-bottom: none; }
.ds-name { flex: 1; word-break: break-all; }
.ds-meta { color: var(--muted); font-size: 12px; white-space: nowrap; }
.drive-list li.picked { background: #eef5ff; }
.ds-check { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; cursor: pointer; }
.drive-bulk { display: flex; align-items: center; gap: 12px; padding: 8px 6px; border-bottom: 1px solid #eef1f4; font-size: 13px; }
.drive-bulk .grow { flex: 1; }
/* フォルダ別ブラウズ: パンくず・フォルダ行 */
.drive-crumbs { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-bottom: 8px; font-size: 13px; }
.drive-crumbs a { color: #1b6ec2; text-decoration: none; }
.drive-crumbs a:hover { text-decoration: underline; }
.drive-crumbs .sep { color: var(--muted); }
.drive-list.folders { max-height: none; margin-bottom: 4px; }
.folder-row { cursor: pointer; }
.folder-row:hover { background: #f0f4f8; }
.ds-icon { width: 20px; text-align: center; }
.row-actions { display: flex; gap: 6px; }
.row-actions .danger { border-color: #dc3545; color: #dc3545; background: #fff; }
.row-actions .danger:hover { background: #fdecee; }
.gconn { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); }
.gconn a { color: var(--primary); }
</style>

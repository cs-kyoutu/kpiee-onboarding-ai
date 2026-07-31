<script setup lang="ts">
// 新UI ステップ1: Google ドライブから案件のファイルを選んで取り込む。
//
// 従来UI（UploadPanel.vue）と同じ API を使うが、画面は「選ぶ→取り込む」に絞る。
// 従来UI は 2つのUI を比べるあいだ残すため、共通化ではなく必要な処理だけをこちらに持つ
// （UploadPanel を触ると従来UI の挙動が変わり、比較にならなくなる）。
import { computed, onMounted, ref } from 'vue'
import {
  browseDrive, listDriveSheets, importSheet, uploadFile, deleteArtifact,
  googleStatus, googleAuthUrl, type Artifact, type DriveFolder, type DriveSheet, type GoogleStatus,
} from '../../api'

const props = defineProps<{ projectId: number; artifacts: Artifact[] }>()
const emit = defineEmits<{ changed: [] }>()

const conn = ref<GoogleStatus>({ clientConfigured: false, connected: false })
const mode = ref<'browse' | 'search'>('browse')
const folders = ref<DriveFolder[]>([])
const files = ref<DriveSheet[]>([])
const crumbs = ref<{ id: string; name: string }[]>([])
const query = ref('')
const loading = ref(false)
const importing = ref(false)
const progress = ref<{ done: number; total: number } | null>(null)
const selected = ref<string[]>([])
const error = ref('')
const showLocal = ref(false)

// 取り込みは常に自動分類（kind=auto）。役割は次のステップでまとめて確認・修正する
const IMPORT_KIND = 'auto'

const allSelected = computed(() => files.value.length > 0 && selected.value.length === files.value.length)

// フォルダID→取得 Promise のキャッシュ。先読みとクリックを1本の取得に合流させる
const cache = new Map<string, Promise<{ folders: DriveFolder[]; files: DriveSheet[] }>>()
const ROOT = '__root__'
const keyOf = (id?: string) => id || ROOT

function fetchFolder(id?: string) {
  const key = keyOf(id)
  const hit = cache.get(key)
  if (hit) return hit
  const p = browseDrive(id)
  cache.set(key, p)
  p.catch(() => cache.delete(key))
  return p
}

async function loadFolder(id?: string) {
  mode.value = 'browse'
  error.value = ''
  selected.value = []
  loading.value = !cache.has(keyOf(id))
  try {
    const data = await fetchFolder(id)
    folders.value = data.folders
    files.value = data.files
    // 次に開きそうなサブフォルダを裏で温めておく（Drive API の往復が体感遅延の主因）
    for (const f of data.folders.slice(0, 30)) if (!cache.has(f.id)) fetchFolder(f.id).catch(() => {})
  } catch (e) {
    error.value = String(e)
  } finally {
    loading.value = false
  }
}

async function enterFolder(f: DriveFolder) {
  crumbs.value.push({ id: f.id, name: f.name })
  await loadFolder(f.id)
}

async function goToCrumb(index: number) {
  crumbs.value = index < 0 ? [] : crumbs.value.slice(0, index + 1)
  await loadFolder(crumbs.value[crumbs.value.length - 1]?.id)
}

async function search() {
  if (!query.value.trim()) { crumbs.value = []; await loadFolder(); return }
  mode.value = 'search'
  loading.value = true
  error.value = ''
  selected.value = []
  try {
    folders.value = []
    files.value = await listDriveSheets(query.value)
  } catch (e) {
    error.value = String(e)
  } finally {
    loading.value = false
  }
}

function toggle(id: string) {
  const i = selected.value.indexOf(id)
  if (i >= 0) selected.value.splice(i, 1)
  else selected.value.push(id)
}

function toggleAll() {
  selected.value = allSelected.value ? [] : files.value.map(f => f.id)
}

/** 選択分を順に取り込む。1件失敗したらそこで止めて件数を残す（黙って飛ばさない） */
async function importSelected() {
  const ids = [...selected.value]
  if (ids.length === 0) return
  error.value = ''
  importing.value = true
  progress.value = { done: 0, total: ids.length }
  try {
    for (const id of ids) {
      await importSheet(props.projectId, id, IMPORT_KIND)
      progress.value.done++
      emit('changed')
    }
    selected.value = []
  } catch (e) {
    error.value = `${progress.value.done}/${ids.length} 件まで取り込んで中断しました: ${e}`
  } finally {
    importing.value = false
    progress.value = null
  }
}

async function onLocalFile(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  error.value = ''
  importing.value = true
  try {
    await uploadFile<Artifact>(`/projects/${props.projectId}/artifacts`, file, IMPORT_KIND)
    emit('changed')
  } catch (err) {
    error.value = String(err)
  } finally {
    importing.value = false
    input.value = ''
  }
}

function login() {
  window.location.href = googleAuthUrl()
}

async function remove(a: Artifact) {
  if (!window.confirm(`「${a.original_filename}」を取り込み一覧から削除します。よろしいですか？`)) return
  try {
    await deleteArtifact(a.id)
    emit('changed')
  } catch (e) {
    error.value = String(e)
  }
}

onMounted(async () => {
  try { conn.value = await googleStatus() } catch { /* サーバー未起動時は未接続扱い */ }
  if (conn.value.connected) await loadFolder()
  // OAuth コールバックからの戻り（?google=connected）を拾う
  const g = new URLSearchParams(window.location.search).get('google')
  if (g === 'connected') {
    window.history.replaceState({}, '', window.location.pathname)
    try { conn.value = await googleStatus() } catch { /* noop */ }
    if (conn.value.connected) await loadFolder()
  }
})
</script>

<template>
  <div class="wz-body">
    <p class="wz-lede">
      この案件で使うファイルを Google ドライブから選びます。取り込んだ時点でシートの役割を自動判定し、
      次のステップで確認・修正できます。
    </p>

    <p v-if="error" class="error-box">{{ error }}</p>

    <!-- 未接続: ログイン導線だけを出す -->
    <div v-if="!conn.connected" class="wz-card">
      <p v-if="conn.clientConfigured">Google ドライブに接続すると、フォルダを辿ってファイルを選べます。</p>
      <p v-else class="muted">
        Google 連携が未設定です。server/.env に GOOGLE_OAUTH_CLIENT_ID / SECRET を設定してください
        （docs/google-drive-setup.md 参照）。ローカルファイルの取り込みは下から行えます。
      </p>
      <button v-if="conn.clientConfigured" class="primary" @click="login">Google でログイン</button>
    </div>

    <!-- 接続済み: フォルダ参照 / 名前検索 -->
    <div v-else class="wz-card">
      <div class="wz-drive-bar">
        <div class="wz-crumbs">
          <button class="link" @click="goToCrumb(-1)">マイドライブ</button>
          <template v-for="(c, i) in crumbs" :key="c.id">
            <span class="sep">/</span>
            <button class="link" @click="goToCrumb(i)">{{ c.name }}</button>
          </template>
        </div>
        <div class="wz-search">
          <input v-model="query" placeholder="ファイル名で検索（全ドライブ横断）" @keyup.enter="search">
          <button @click="search">検索</button>
        </div>
      </div>

      <p v-if="loading" class="muted">読み込み中…</p>

      <div v-else class="wz-drive-list">
        <button
          v-for="f in folders" :key="f.id" class="wz-row wz-folder" @click="enterFolder(f)"
        >📁 {{ f.name }}</button>

        <label v-for="f in files" :key="f.id" class="wz-row wz-file">
          <input type="checkbox" :checked="selected.includes(f.id)" @change="toggle(f.id)">
          <span class="nm">📊 {{ f.name }}</span>
          <span v-if="f.modifiedTime" class="muted">{{ f.modifiedTime.slice(0, 10) }}</span>
        </label>

        <p v-if="folders.length === 0 && files.length === 0" class="muted">
          {{ mode === 'search' ? '該当するファイルがありません。' : 'このフォルダに表ファイルはありません。' }}
        </p>
      </div>

      <div class="wz-actions">
        <button v-if="files.length > 0" @click="toggleAll">
          {{ allSelected ? '全解除' : `全 ${files.length} 件を選択` }}
        </button>
        <button class="primary" :disabled="selected.length === 0 || importing" @click="importSelected">
          {{ importing ? `取り込み中… ${progress?.done ?? 0}/${progress?.total ?? 0}` : `選択した ${selected.length} 件を取り込む` }}
        </button>
      </div>
    </div>

    <!-- 取り込み済み -->
    <div class="wz-card">
      <h3 class="wz-h">取り込み済み（{{ props.artifacts.length }} 件）</h3>
      <p v-if="props.artifacts.length === 0" class="muted">まだありません。</p>
      <ul v-else class="wz-arts">
        <li v-for="a in props.artifacts" :key="a.id">
          <span class="nm">{{ a.original_filename }}</span>
          <span class="badge" :class="a.parse_status === 'done' ? 'ok' : a.parse_status === 'failed' ? 'ng' : 'warn'">
            {{ a.parse_status === 'done' ? '解析済' : a.parse_status === 'failed' ? '解析失敗' : '処理中' }}
          </span>
          <span v-if="a.parse_error" class="muted">{{ a.parse_error }}</span>
          <button class="link danger" @click="remove(a)">削除</button>
        </li>
      </ul>
    </div>

    <details class="wz-more" :open="showLocal">
      <summary>ローカルの Excel / CSV を取り込む</summary>
      <p class="muted">ドライブに置いていないファイルはここから。取り込み方は同じです。</p>
      <input type="file" accept=".xlsx,.xlsm,.csv" :disabled="importing" @change="onLocalFile">
    </details>
  </div>
</template>

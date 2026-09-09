<script setup lang="ts">
// 新UI ステップ1の後半: 業務資料（要件定義シート・手順書・引継ぎメモ）の取り込み。
//
// データ（xlsx/csv）とは受け口を分ける。資料は「データがどう作られるか」を書いた文書で、
// 表構造を持たない。関係分析やシート役割の自動判定へ混ぜると判定を汚すだけ。
// 一方で中身は AI の解読と要件の読み取り（分類の当て込み・レポートの前提）に効かせたい。
//
// 受け口は2つ。要件定義書は手元から上げることが多いが、手順書の txt やロジックのメモは
// 案件データと同じドライブフォルダに一緒に置かれている。そのため、データ取り込みで
// 今見ているフォルダをそのまま初期表示にして、同じ辿り方で拾えるようにする。
//
// 抽出できた文字数を必ず出す。0 文字は「資料を入れたのに何も変わらない」状態そのもので、
// 黙って一覧に並べると気づけないため、警告として見せる。
import { onMounted, ref, watch } from 'vue'
import {
  getProjectDocs, uploadProjectDoc, importDocFromDrive, getProjectDocText, deleteProjectDoc,
  browseDrive, googleStatus,
  type ProjectDoc, type DriveFolder, type DriveSheet, type GoogleStatus,
} from '../../api'
import ScriptsPanel from '../ScriptsPanel.vue'

const props = defineProps<{
  projectId: number
  /** データ取り込みで開いているフォルダ。資料は同じフォルダにあることが多いので初期表示に使う */
  folderId?: string
  folderName?: string
}>()

const docs = ref<ProjectDoc[]>([])
const loading = ref(true)
const error = ref('')
const busy = ref('')
/** 本文の確認中の資料（何が読み取れたかをその場で見せる） */
const opened = ref<{ id: number; filename: string; content: string } | null>(null)

// ---- ドライブ側 ----
const conn = ref<GoogleStatus>({ clientConfigured: false, connected: false })
const folders = ref<DriveFolder[]>([])
const files = ref<DriveSheet[]>([])
const crumbs = ref<{ id: string; name: string }[]>([])
const driveLoading = ref(false)
/** 人が自分でフォルダを移動したら、データ側の移動に追従しない（勝手に戻されると操作を奪う） */
const navigated = ref(false)

async function load() {
  loading.value = true
  error.value = ''
  try {
    // Redash の物理カラム一覧（sql-columns）はステップ5の添付欄で扱う。ここは業務資料だけ
    docs.value = (await getProjectDocs(props.projectId)).filter(d => d.kind === 'doc')
  } catch (e) {
    error.value = String(e)
  } finally {
    loading.value = false
  }
}

async function loadFolder(id?: string) {
  if (!conn.value.connected) return
  driveLoading.value = true
  error.value = ''
  try {
    const data = await browseDrive(id, 'docs')
    folders.value = data.folders
    files.value = data.files
  } catch (e) {
    error.value = String(e)
  } finally {
    driveLoading.value = false
  }
}

async function enterFolder(f: DriveFolder) {
  navigated.value = true
  crumbs.value.push({ id: f.id, name: f.name })
  await loadFolder(f.id)
}

async function goToCrumb(index: number) {
  navigated.value = true
  crumbs.value = index < 0 ? [] : crumbs.value.slice(0, index + 1)
  await loadFolder(crumbs.value[crumbs.value.length - 1]?.id)
}

/** ドライブの資料を1件取り込む */
async function importFromDrive(f: DriveSheet) {
  busy.value = f.name
  error.value = ''
  try {
    await importDocFromDrive(props.projectId, f.id)
    await load()
  } catch (e) {
    error.value = `${f.name}: ${String(e)}`
  } finally {
    busy.value = ''
  }
}

/** 複数選択されても1件ずつ順に送る（並列にすると抽出でサーバーを取り合うだけ） */
async function pick(ev: Event) {
  const input = ev.target as HTMLInputElement
  const picked = [...(input.files ?? [])]
  input.value = '' // 同じファイルを続けて選び直せるように毎回クリアする
  error.value = ''
  for (const f of picked) {
    busy.value = f.name
    try {
      await uploadProjectDoc(props.projectId, f)
    } catch (e) {
      error.value = `${f.name}: ${String(e)}`
    }
  }
  busy.value = ''
  await load()
}

async function openText(d: ProjectDoc) {
  if (opened.value?.id === d.id) { opened.value = null; return }
  try {
    const r = await getProjectDocText(d.id)
    opened.value = { id: d.id, filename: r.filename, content: r.content }
  } catch (e) {
    error.value = String(e)
  }
}

async function remove(d: ProjectDoc) {
  if (!window.confirm(`業務資料「${d.filename}」を削除します。よろしいですか？`)) return
  try {
    await deleteProjectDoc(d.id)
    if (opened.value?.id === d.id) opened.value = null
    await load()
  } catch (e) {
    error.value = String(e)
  }
}

const kb = (n: number) => `${Math.max(1, Math.round(n / 1024)).toLocaleString()} KB`
/** 取り込み済みかどうか（同じ資料を二度入れると AI へ二重に渡ってしまう） */
const alreadyIn = (name: string) =>
  docs.value.some(d => d.filename === name || d.filename.replace(/\.[^.]+$/, '') === name)

// データ取り込みでフォルダを移動したら、まだ自分で動かしていない間は追従する
watch(() => props.folderId, async id => {
  if (navigated.value) return
  crumbs.value = id && props.folderName ? [{ id, name: props.folderName }] : []
  await loadFolder(id)
})

onMounted(async () => {
  await load()
  try { conn.value = await googleStatus() } catch { /* サーバー未起動時は未接続扱い */ }
  if (conn.value.connected) {
    if (props.folderId && props.folderName) crumbs.value = [{ id: props.folderId, name: props.folderName }]
    await loadFolder(props.folderId)
  }
})
</script>

<template>
  <div class="wz-card">
    <h3 class="wz-h">要件定義書・手順書の取り込み（業務資料）</h3>
    <p class="muted">
      <b>要件定義書はここで入れます。</b>データ（Excel / CSV）ではなく、
      <b>データの作り方を書いた文書</b>の受け口です。
      「何がアウトプットか」「どのファイルから何を付与するか」「配賦の例外」は数式には残らないため、
      これが唯一の根拠になります。入れると <b>AI 解読</b>と、次のステップの
      <b>分類の当て込み・レポートの前提</b>に効きます。
    </p>

    <p v-if="error" class="error-box">{{ error }}</p>

    <!-- ① 手元から。一番使う入り口なので先頭に置く -->
    <div class="wz-actions">
      <label class="wz-filebtn">
        <input
          type="file" multiple
          accept=".txt,.md,.markdown,.csv,.tsv,.json,.yaml,.yml,.log,.docx,.pdf,.xlsx,.xlsm"
          @change="pick"
        >
        <span>＋ 要件定義書・手順書を追加</span>
      </label>
      <span v-if="busy" class="muted">{{ busy }} を取り込み中…</span>
      <span v-else-if="!loading" class="muted">登録済み {{ docs.length }} 件</span>
    </div>
    <p class="muted">
      対応形式: xlsx（要件定義シートはそのままで OK。本文をテキストに抜き出します）/
      txt / md / csv / docx / pdf / Google ドキュメント。
      取り込んだら「本文を見る」で、中身が読み取れているか確かめられます。
    </p>

    <!-- ② ドライブから: 手順書・ロジックのメモはデータと同じフォルダにあることが多い -->
    <div v-if="conn.connected" class="wz-sub">
      <div class="wz-drive-bar">
        <div class="wz-crumbs">
          <button class="link" @click="goToCrumb(-1)">マイドライブ</button>
          <template v-for="(c, i) in crumbs" :key="c.id">
            <span class="sep">/</span>
            <button class="link" @click="goToCrumb(i)">{{ c.name }}</button>
          </template>
        </div>
        <span v-if="!navigated && props.folderName" class="muted">データと同じフォルダを見ています</span>
      </div>

      <p v-if="driveLoading" class="muted">読み込み中…</p>
      <div v-else class="wz-drive-list">
        <button
          v-for="f in folders" :key="f.id" class="wz-row wz-folder" @click="enterFolder(f)"
        >📁 {{ f.name }}</button>

        <div v-for="f in files" :key="f.id" class="wz-row wz-file">
          <span class="nm">📄 {{ f.name }}</span>
          <span v-if="f.modifiedTime" class="muted">{{ f.modifiedTime.slice(0, 10) }}</span>
          <span v-if="alreadyIn(f.name)" class="badge ok">取り込み済み</span>
          <button v-else class="link" :disabled="busy !== ''" @click="importFromDrive(f)">
            {{ busy === f.name ? '取り込み中…' : '資料として取り込む' }}
          </button>
        </div>

        <p v-if="folders.length === 0 && files.length === 0" class="muted">
          このフォルダに資料（txt / md / docx / pdf / ドキュメント）はありません。
        </p>
      </div>
    </div>

    <p v-if="loading" class="muted">読み込み中…</p>

    <table v-else-if="docs.length > 0" class="wz-table">
      <thead>
        <tr><th>資料</th><th>読み取れた文字数</th><th>サイズ</th><th>操作</th></tr>
      </thead>
      <tbody>
        <tr v-for="d in docs" :key="d.id" :class="{ warn: d.extract_error !== null || d.text_length === 0 }">
          <td class="nm">
            {{ d.filename }}
            <em v-if="d.extract_error" class="muted">{{ d.extract_error }}</em>
          </td>
          <td class="num">
            <span v-if="d.text_length > 0">{{ d.text_length.toLocaleString() }} 字</span>
            <span v-else class="badge ng">読み取れませんでした</span>
          </td>
          <td class="num">{{ kb(d.byte_size) }}</td>
          <td>
            <button class="link" :disabled="d.text_length === 0" @click="openText(d)">
              {{ opened?.id === d.id ? '閉じる' : '本文を見る' }}
            </button>
            <button class="link danger" @click="remove(d)">削除</button>
          </td>
        </tr>
      </tbody>
    </table>
    <p v-else class="muted">
      まだありません。要件定義書・手順書があれば入れてください（無くても先へ進めます）。
    </p>

    <!-- 何が読み取れたかをその場で確認できるようにする。読み取り違いはここで気づける -->
    <div v-if="opened" class="wz-doctext">
      <h4 class="wz-h4">{{ opened.filename }}</h4>
      <pre class="wz-pre">{{ opened.content }}</pre>
    </div>

    <details class="wz-more">
      <summary>Apps Script（GAS）の原文も渡す</summary>
      <ScriptsPanel :project-id="props.projectId" />
    </details>
  </div>
</template>

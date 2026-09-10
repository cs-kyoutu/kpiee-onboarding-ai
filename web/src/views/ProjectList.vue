<script setup lang="ts">
// SC-01 プロジェクト一覧。顧客名・進行段階・照合一致率をカード表示する。
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { get, post, deleteProject, type Project } from '../api'

const router = useRouter()
const projects = ref<Project[]>([])
const loading = ref(true) // 初回読込中フラグ。読込中に「プロジェクトがありません」を誤表示しないため
const showForm = ref(false)
const customerName = ref('')
const description = ref('')
const error = ref('')

// 検索。案件が増えるとカードを目で探せなくなる。顧客名・概要・番号（#30 / 30）で絞る。
// 一覧 API は全件返すので、クライアント側の絞り込みで足りる（数十件規模）
const query = ref('')
const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return projects.value
  const idQ = q.replace(/^#/, '')
  return projects.value.filter(p =>
    p.customer_name.toLowerCase().includes(q)
    || (p.description ?? '').toLowerCase().includes(q)
    || String(p.id) === idQ)
})

const STATUS_LABELS: Record<string, string> = {
  draft: '下書き',
  analyzing: 'AI解読中',
  reviewing: '検収中',
  generating: '生成中',
  matching: '照合中',
  completed: '完了',
}

async function load() {
  loading.value = true
  try {
    projects.value = await get<Project[]>('/projects')
  } finally {
    loading.value = false
  }
}

async function createProject() {
  error.value = ''
  try {
    const p = await post<Project>('/projects', {
      customer_name: customerName.value,
      description: description.value,
    })
    showForm.value = false
    customerName.value = ''
    description.value = ''
    await router.push(`/projects/${p.id}`)
  } catch (e) {
    error.value = String(e)
  }
}

async function removeProject(p: Project) {
  if (!confirm(`プロジェクト「${p.customer_name}」を削除します。\nアップロード資料・解読結果・成果物もすべて削除され、元に戻せません。よろしいですか？`)) return
  try {
    await deleteProject(p.id)
    await load()
  } catch (e) {
    error.value = String(e)
  }
}

onMounted(load)
</script>

<template>
  <h1>オンボーディングプロジェクト</h1>

  <!-- 読み込みが終わるまで操作は出さない。空に見える一覧＋新規ボタンだけが並ぶと、
       「プロジェクトが無い」と誤解して重複作成につながる -->
  <div v-if="!loading" class="toolbar">
    <button class="primary" @click="showForm = !showForm">＋ 新規プロジェクト</button>
    <input
      v-model="query" class="project-search" type="search"
      placeholder="顧客名・概要・番号で検索"
    >
    <span v-if="query" class="muted">{{ filtered.length }} / {{ projects.length }} 件</span>
  </div>

  <!-- 削除失敗などフォーム外の操作エラーもここで見えるように、フォームの外に置く -->
  <p v-if="error" class="error-box">{{ error }}</p>

  <div v-if="showForm" class="panel">
    <h2>プロジェクト作成（UC-01）</h2>
    <div style="display: grid; gap: 8px; max-width: 480px">
      <label>顧客名 <input v-model="customerName" type="text" placeholder="例: 株式会社サンプル" /></label>
      <label>概要 <textarea v-model="description" rows="2" placeholder="例: 月次予実管理帳票の移行" /></label>
      <div><button class="primary" :disabled="!customerName" @click="createProject">作成</button></div>
    </div>
  </div>

  <!-- 読み込み中はカードの骨組みを出す（場所が分かり、空一覧と見分けがつく） -->
  <div v-if="loading" class="card-grid">
    <div v-for="i in 6" :key="i" class="project-card">
      <p class="sk" style="width: 60%"></p>
      <p class="sk" style="width: 90%; margin-top: 10px"></p>
      <p class="sk" style="width: 40%; margin-top: 10px"></p>
    </div>
  </div>

  <div v-else class="card-grid">
    <div v-for="p in filtered" :key="p.id" class="project-card" @click="router.push(`/projects/${p.id}`)">
      <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px">
        <strong>{{ p.customer_name }}</strong>
        <div style="display: flex; align-items: center; gap: 6px">
          <span class="badge info">{{ STATUS_LABELS[p.status] ?? p.status }}</span>
          <button class="ng" title="プロジェクトを削除" style="padding: 2px 8px" @click.stop="removeProject(p)">🗑</button>
        </div>
      </div>
      <p class="muted" style="min-height: 2em">{{ p.description || '（概要なし）' }}</p>
      <div style="display: flex; justify-content: space-between; align-items: center">
        <span class="muted">#{{ p.id }} · {{ p.created_at?.slice(0, 10) }}</span>
        <span v-if="p.match_rate != null" class="badge" :class="p.match_rate >= 0.99 ? 'ok' : p.match_rate >= 0.8 ? 'warn' : 'ng'">
          照合一致率 {{ (p.match_rate * 100).toFixed(1) }}%
        </span>
      </div>
    </div>
  </div>

  <p v-if="!loading && projects.length === 0" class="muted">プロジェクトがありません。「＋ 新規プロジェクト」から作成してください。</p>
  <p v-else-if="!loading && filtered.length === 0" class="muted">「{{ query }}」に一致するプロジェクトはありません。</p>
</template>

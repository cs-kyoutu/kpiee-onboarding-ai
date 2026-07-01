<script setup lang="ts">
// Apps Script（GAS）等、xlsx に保存されない変換ロジックの登録。
// 例: シートを生成する .gs 関数。登録すると decode/generate 時に AI へ渡され、
// 「数式ゼロなのに値だけあるシート」の出所・ロジックが解読に反映される。
import { onMounted, ref } from 'vue'
import { getScripts, addScript, deleteScript, type ProjectScript } from '../api'

const props = defineProps<{ projectId: number }>()

const scripts = ref<ProjectScript[]>([])
const name = ref('')
const code = ref('')
const error = ref('')
const saving = ref(false)

async function load() {
  scripts.value = await getScripts(props.projectId)
}

async function add() {
  error.value = ''
  if (!code.value.trim()) return
  saving.value = true
  try {
    await addScript(props.projectId, name.value.trim(), code.value)
    name.value = ''
    code.value = ''
    await load()
  } catch (e) {
    error.value = String(e)
  } finally {
    saving.value = false
  }
}

async function remove(s: ProjectScript) {
  await deleteScript(s.id)
  await load()
}

onMounted(load)
</script>

<template>
  <div class="panel">
    <h2>変換スクリプト（Apps Script / GAS）</h2>
    <p class="muted">
      Excel/スプレッドシートに<strong>保存されない</strong>変換ロジック（Apps Script の .gs 関数・マクロ等）をここに貼り付けてください。
      「数式が無いのに値だけあるシート」は、こうしたスクリプトが生成している場合があります。
      登録すると AI解読・成果物生成の入力に含まれ、シートの出所とロジックが解読されます。
    </p>

    <div style="display: flex; flex-direction: column; gap: 8px; max-width: 760px">
      <input v-model="name" type="text" placeholder="スクリプト名（任意。例: createHierarchy / 階層構造レポート生成）" />
      <textarea
        v-model="code" rows="12" spellcheck="false"
        placeholder="function createHierarchy() { ... } の中身を貼り付け"
        style="font-family: monospace; font-size: 12px; white-space: pre"
      ></textarea>
      <div class="toolbar" style="margin: 0">
        <button class="primary" :disabled="!code.trim() || saving" @click="add">
          {{ saving ? '登録中…' : '＋ スクリプトを登録' }}
        </button>
      </div>
      <p v-if="error" class="error-box">{{ error }}</p>
    </div>

    <table style="margin-top: 16px">
      <thead>
        <tr><th style="width: 30%">名前</th><th>コード（先頭）</th><th style="width: 80px">操作</th></tr>
      </thead>
      <tbody>
        <tr v-for="s in scripts" :key="s.id">
          <td>{{ s.name || '（無名）' }}</td>
          <td><code style="font-size: 12px">{{ s.code.slice(0, 120).replace(/\s+/g, ' ') }}…</code></td>
          <td><button class="ng" @click="remove(s)">削除</button></td>
        </tr>
        <tr v-if="scripts.length === 0"><td colspan="3" class="muted">登録済みスクリプトはありません</td></tr>
      </tbody>
    </table>
  </div>
</template>

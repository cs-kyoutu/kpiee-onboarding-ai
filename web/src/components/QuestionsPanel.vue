<script setup lang="ts">
// SC-07 顧客確認事項一覧（UC-10）。
// 解読不能項目が自動登録されるほか、手動追加・状態管理・メール文面エクスポートができる。
import { onMounted, ref } from 'vue'
import { get, post, patch, type CustomerQuestion } from '../api'

const props = defineProps<{ projectId: number }>()

const questions = ref<CustomerQuestion[]>([])
const newQuestion = ref('')
const mailBody = ref('')

const STATUS_LABELS: Record<string, string> = {
  open: '未確認',
  waiting: '回答待ち',
  resolved: '解決済',
}

async function load() {
  questions.value = await get<CustomerQuestion[]>(`/projects/${props.projectId}/questions`)
}

async function add() {
  if (!newQuestion.value) return
  await post(`/projects/${props.projectId}/questions`, { question: newQuestion.value })
  newQuestion.value = ''
  await load()
}

async function setStatus(q: CustomerQuestion, status: string) {
  const updated = await patch<CustomerQuestion>(`/questions/${q.id}`, { status })
  Object.assign(q, updated)
}

async function saveAnswer(q: CustomerQuestion) {
  await patch(`/questions/${q.id}`, { customer_answer: q.customer_answer, status: 'resolved' })
  await load()
}

async function exportMail() {
  const res = await fetch(`/api/projects/${props.projectId}/questions/export`)
  mailBody.value = await res.text()
}

onMounted(load)
</script>

<template>
  <div class="panel">
    <h2>顧客確認事項（UC-10）</h2>
    <div class="toolbar">
      <input v-model="newQuestion" type="text" placeholder="確認したい内容を入力" style="max-width: 480px" @keyup.enter="add" />
      <button class="primary" :disabled="!newQuestion" @click="add">追加</button>
      <button @click="exportMail">📧 メール文面を生成</button>
    </div>

    <table>
      <thead>
        <tr><th style="width: 45%">確認内容</th><th>状態</th><th>顧客回答</th><th>操作</th></tr>
      </thead>
      <tbody>
        <tr v-for="q in questions" :key="q.id">
          <td>{{ q.question }}</td>
          <td>
            <span class="badge" :class="q.status === 'resolved' ? 'ok' : q.status === 'waiting' ? 'warn' : 'ng'">
              {{ STATUS_LABELS[q.status] }}
            </span>
          </td>
          <td>
            <input v-model="q.customer_answer" type="text" placeholder="回答を記録" @keyup.enter="saveAnswer(q)" />
          </td>
          <td>
            <div class="toolbar" style="margin: 0">
              <button @click="setStatus(q, 'waiting')">照会中</button>
              <button class="ok" @click="saveAnswer(q)">解決</button>
            </div>
          </td>
        </tr>
        <tr v-if="questions.length === 0"><td colspan="4" class="muted">確認事項はありません</td></tr>
      </tbody>
    </table>
  </div>

  <div v-if="mailBody" class="panel">
    <h2>メール文面（コピーして使用）</h2>
    <pre class="code" style="white-space: pre-wrap">{{ mailBody }}</pre>
  </div>
</template>

<script setup lang="ts">
// アプリ全体レイアウト。ヘッダーに AI モード（実 API / モック）を表示する。
import { onMounted, ref } from 'vue'
import { get } from './api'

const aiMode = ref('')
onMounted(async () => {
  try {
    const health = await get<{ aiMode: string }>('/health')
    aiMode.value = health.aiMode
  } catch {
    aiMode.value = 'サーバー未接続'
  }
})
</script>

<template>
  <header class="app-header">
    <router-link to="/" class="brand">KPIEE オンボーディング AI</router-link>
    <nav>
      <router-link to="/">プロジェクト</router-link>
      <router-link to="/admin">管理</router-link>
    </nav>
    <span class="ai-mode" :class="{ mock: aiMode === 'mock' }">
      AI: {{ aiMode === 'mock' ? 'モックモード' : aiMode }}
    </span>
  </header>
  <main class="app-main">
    <router-view />
  </main>
</template>

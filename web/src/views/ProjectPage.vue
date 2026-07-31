<script setup lang="ts">
// プロジェクト画面の入口。新UI（5ステップ）と従来UI（タブ）を切り替える。
//
// どちらが使いやすいか実際に触って決めるため、当面は両方を残す。選択はブラウザに覚えさせ、
// URL の ?ui=wizard / ?ui=tabs でも指定できる（他の人に「こっちで見て」と渡せるように）。
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import ProjectDetail from './ProjectDetail.vue'
import ProjectWizard from './ProjectWizard.vue'

const route = useRoute()
const projectId = computed(() => Number(route.params.id))

type Mode = 'wizard' | 'tabs'
const KEY = 'kpiee-ui-mode'

function initialMode(): Mode {
  const q = route.query.ui
  if (q === 'wizard' || q === 'tabs') return q
  const saved = localStorage.getItem(KEY)
  return saved === 'tabs' ? 'tabs' : 'wizard' // 既定は新UI（比較のため。従来UI はいつでも1クリックで戻れる）
}

const mode = ref<Mode>(initialMode())
watch(mode, m => {
  try { localStorage.setItem(KEY, m) } catch { /* プライベートモード等では覚えない */ }
})
</script>

<template>
  <div class="ui-switch">
    <span class="muted">画面の作り</span>
    <div class="ui-switch-btns">
      <button :class="{ on: mode === 'wizard' }" @click="mode = 'wizard'">新UI（5ステップ）</button>
      <button :class="{ on: mode === 'tabs' }" @click="mode = 'tabs'">従来UI（タブ）</button>
    </div>
    <span class="muted">
      {{ mode === 'wizard'
        ? '取り込み → 分類 → 解析 → 相談 → 生成 の順に進みます'
        : '機能ごとのタブ。どの順でも操作できます' }}
    </span>
  </div>

  <ProjectWizard v-if="mode === 'wizard'" :key="`w${projectId}`" :project-id="projectId" />
  <ProjectDetail v-else :key="`t${projectId}`" />
</template>

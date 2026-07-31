import { createApp } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'
import './style.css'
import App from './App.vue'
import ProjectList from './views/ProjectList.vue'
import ProjectPage from './views/ProjectPage.vue'
import AdminView from './views/AdminView.vue'
import UsageView from './views/UsageView.vue'

// 画面構成（設計書 §5）: SC-01 一覧 / SC-02〜07 プロジェクト詳細 / SC-08 管理
// プロジェクト画面は新UI（5ステップ）と従来UI（タブ）を持ち、ProjectPage が切り替える。
const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: ProjectList },
    { path: '/projects/:id', component: ProjectPage },
    { path: '/usage', component: UsageView },
    { path: '/admin', component: AdminView },
  ],
})

createApp(App).use(router).mount('#app')

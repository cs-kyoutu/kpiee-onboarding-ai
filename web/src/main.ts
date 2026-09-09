import { createApp } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'
import './style.css'
import App from './App.vue'
import ProjectList from './views/ProjectList.vue'
import ProjectWizard from './views/ProjectWizard.vue'
import AdminView from './views/AdminView.vue'
import UsageView from './views/UsageView.vue'

// 画面構成: 一覧 / プロジェクト（4ステップ）/ 使用量 / 管理。
// 機能ごとのタブを並べた従来UI は畳んだ（レポート作成の流れに関係しない入口だったため）。
const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: ProjectList },
    {
      path: '/projects/:id',
      component: ProjectWizard,
      // ルートパラメータを props へ。ProjectWizard は projectId を受け取る作りのため
      props: route => ({ projectId: Number(route.params.id) }),
    },
    { path: '/usage', component: UsageView },
    { path: '/admin', component: AdminView },
  ],
})

createApp(App).use(router).mount('#app')

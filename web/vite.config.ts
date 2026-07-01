import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// ローカル API サーバー（Express :8787）へのプロキシ設定
export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8787',
    },
  },
})

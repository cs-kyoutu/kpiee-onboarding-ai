/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Google OAuth クライアント ID（Web アプリ）。設定すると Google ドライブ連携が有効化される */
  readonly VITE_GOOGLE_CLIENT_ID?: string
  /** Google API キー（Picker 用 developer key） */
  readonly VITE_GOOGLE_API_KEY?: string
  /** 任意: GCP プロジェクト番号（App ID）。Picker の所有アプリ判定に使われる */
  readonly VITE_GOOGLE_APP_ID?: string
  /** 任意: API サーバーのオリジン（既定 http://localhost:8787）。Google ログインの全画面遷移先に使う */
  readonly VITE_API_ORIGIN?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

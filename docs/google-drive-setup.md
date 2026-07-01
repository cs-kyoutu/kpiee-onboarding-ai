# Google ドライブ連携の設定手順

資料アップロード画面で「Google ドライブから選択」を使えるようにするための設定です。
**設定しなくてもアプリは動きます**（その場合は PC からのファイル選択のみ）。

実装方式は **Google Picker API + OAuth (Google Identity Services)** です。
ユーザーが自分の Google アカウントでログイン → ドライブ内の Excel / スプレッドシートを選択 →
ブラウザがファイルをダウンロードしてアプリのサーバへ投入します（サーバ側に資格情報は保存しません）。

---

## 1. Google Cloud プロジェクトを用意

1. <https://console.cloud.google.com/> にアクセスし、プロジェクトを作成（または既存を選択）。
2. プロジェクト番号（App ID）を控える（任意設定 `VITE_GOOGLE_APP_ID` に使う）。

## 2. API を有効化

「API とサービス」→「ライブラリ」で以下を有効化:

- **Google Picker API**
- **Google Drive API**

## 3. OAuth 同意画面

「API とサービス」→「OAuth 同意画面」:

- User Type: 社内のみなら **内部**、それ以外は **外部**。
- スコープに `.../auth/drive.readonly` を追加。
- 外部 + テスト中の場合は「テストユーザー」に利用者の Google アカウントを追加。

## 4. 認証情報を作成

「API とサービス」→「認証情報」→「認証情報を作成」:

### (a) OAuth クライアント ID
- アプリケーションの種類: **ウェブアプリケーション**
- **承認済みの JavaScript 生成元** に開発 URL を追加:
  - `http://localhost:5173`
- 作成後に出る **クライアント ID** を控える → `VITE_GOOGLE_CLIENT_ID`

### (b) API キー
- 「認証情報を作成」→「API キー」。
- 推奨: キーの制限で「ウェブサイトの制限」に `http://localhost:5173/*` を、
  「API の制限」で Picker API / Drive API のみに絞る。
- 控える → `VITE_GOOGLE_API_KEY`

## 5. web/.env に設定

`web/.env.example` をコピーして `web/.env` を作成し、値を貼り付け:

```
VITE_GOOGLE_CLIENT_ID=xxxxxxxx.apps.googleusercontent.com
VITE_GOOGLE_API_KEY=AIzaSy........
VITE_GOOGLE_APP_ID=123456789012
```

フロントを再起動（`npm run dev`）すると「Google ドライブから選択」が有効になります。

---

## 動作

- **Google スプレッドシート** を選ぶと自動的に `.xlsx` へエクスポートして取り込みます。
- アップロード済みの **.xlsx** はそのままダウンロードして取り込みます。
- 取り込んだ後の流れ（自動分類・解読・関係分析）は PC アップロードと同じです。

## 本番公開する場合の注意

- JavaScript 生成元・API キーの制限に本番ドメインを追加。
- OAuth 同意画面を「本番」へ公開（外部の場合は Google の審査が必要なことがある）。
- `drive.readonly` は広い権限です。選択ファイルのみで良ければ将来 `drive.file` スコープ + Picker の
  組み合わせに狭めることを検討してください。

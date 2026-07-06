# デプロイ手順（既存 ECS クラスタへ相乗り）

DPB（data-palette-builder）が動いている既存 ECS クラスタに、**別サービス・別タスク定義**として本アプリを載せる。
ランタイムが Node（DPB は Python）なので同一コンテナには同居できないが、**クラスタ・RDS・ALB は再利用**する。

- イメージ: `ghcr.io/cs-kyoutu/kpiee-onboarding-ai:latest`（GHCR public。ECS は pull 認証不要）
  - main への push で GitHub Actions が自動ビルド＆push（`docker-build` ワークフロー）
  - 固定したい場合は `sha-<短縮>` タグを使う
- コンテナ: 1 プロセスで API と静的フロント(`/`)を同一オリジン配信。listen ポート **8080**、ヘルスチェック **`/api/health`**
- タスク定義テンプレート: [`deploy/task-definition.json`](deploy/task-definition.json)

## 前提（デプロイ前に用意するもの）

1. **RDS に onboarding 用 DB とユーザーを作成**（DPB と同一インスタンスに相乗り）
   ```sql
   CREATE DATABASE onboarding;
   CREATE USER onboarding WITH PASSWORD '<DB_PASSWORD>';
   GRANT ALL PRIVILEGES ON DATABASE onboarding TO onboarding;
   ```
   - スキーマ（テーブル）はアプリ起動時に `initDb()` が自動作成するので手動 DDL 不要
   - オンボーディングのタスク SG を RDS の SG インバウンドに追加（または DPB と同じ SG を付与）
   - `PGPOOL_MAX` は小さめ（既定 5）。DPB の接続数と合わせて上限に注意

2. **Google OAuth の refresh_token を1回だけ取得**（対象アカウント本人が同意）
   - OAuth クライアント（client_id/secret）で同意フローを1回通し、`refresh_token` を得てタスク定義の env に入れる
   - **OAuth 同意画面は「内部(Internal)」または「本番(In production)」にすること**。テスト状態だと refresh_token が 7 日で失効する
   - コールバック URL `https://<APP_HOST>/api/google/callback` を Google Cloud Console の「承認済みリダイレクト URI」に登録

3. **ALB**（既存を再利用）
   - オンボーディング用ターゲットグループ（HTTP 8080、ヘルスチェックパス `/api/health`）を作成し、
     リスナールール（ホスト or パスベース）でオンボーディングサービスへルーティング
   - 社内向け内部 ALB（外部非公開）想定。担当者は社内網/VPN から接続

## デプロイ

1. `deploy/task-definition.json` の `<...>` を全て埋めて登録
   ```bash
   aws ecs register-task-definition --cli-input-json file://deploy/task-definition.json
   ```
2. 既存クラスタにサービス作成（awsvpc・上記ターゲットグループに紐付け、desired count = 1）
   - **desired count は 1 固定**。インプロセスキャッシュ（QA 用ワークブック等）を持つため水平スケール不可
3. デプロイ後、対象アカウント本人が `https://<APP_HOST>` から「Google でログイン」→ 同意 →
   得られた refresh_token をタスク定義 env（`GOOGLE_OAUTH_REFRESH_TOKEN`）へ反映して再デプロイ
   （Fargate はファイルシステムが揮発するため、トークンはファイルでなく env で保持する）

## 環境変数リファレンス

| 変数 | 必須 | 説明 |
|---|---|---|
| `DATABASE_URL` | ✅ | `postgres://onboarding:<pass>@<rds>:5432/onboarding`。設定時は pg、未設定だと SQLite（ローカル用） |
| `ARTIFACT_EPHEMERAL` | ✅(本番) | `1` で原本無保存モード（Drive 都度取得・直接アップロード無効）。C3/C4 |
| `ANTHROPIC_API_KEY` | ✅ | 未設定だと mock モード（実 AI 応答なし） |
| `GOOGLE_OAUTH_CLIENT_ID` / `_SECRET` / `_REFRESH_TOKEN` | ✅ | Drive 連携（対象アカウント本人 OAuth）。SA/ADC は廃止 |
| `GOOGLE_OAUTH_REDIRECT` | ✅ | `https://<APP_HOST>/api/google/callback`。Console 登録値と完全一致 |
| `WEB_APP_ORIGIN` | ✅ | OAuth コールバック後の戻り先。`https://<APP_HOST>` |
| `CORS_ORIGIN` | 任意 | 同一オリジン配信なら通常不要。指定時はそのオリジンに限定 |
| `PORT` | — | 既定 8080（Dockerfile 設定済み） |
| `WEB_DIST` | — | 既定 `/app/web/dist`（Dockerfile 設定済み） |
| `PGPOOL_MAX` | — | pg コネクションプール上限。既定 5 |

## 注意（既知の制約）

- **シークレットはタスク定義 env に平文**（Secrets Manager 未使用＝権限制約 C6）。タスク定義を閲覧できる人・`ecs execute-command` 可能な人の範囲、ログへのトークン出力に注意
- **重いシート解析は単一イベントループ**。多人数同時解析なら `worker_threads` 分離が必要（未実装。実同時利用数の実測後に判断）
- **原本無保存の再取得コスト**: 作業ごとに Drive から取り直すため、大きなワークブックはレイテンシが出る。PoC で実測

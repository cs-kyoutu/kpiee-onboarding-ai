# デプロイ手順（DPB と同一クラスタへ相乗り・ゼロからやり直し版）

DPB（data-palette-builder）が動いている既存 ECS クラスタに、**別サービス・別タスク定義**として本アプリを載せる。
クラスタ・RDS・ALB・VPC・実行ロールは再利用し、アプリ固有リソース（ターゲットグループ・サービス・タスク定義・ロググループ）だけ新規作成する。

前提: AWS 変更は **コンソールのみ**（IAM 計 `dax-seongjin-park` は CLI/アクセスキー/ECR/SSM/Secrets Manager すべて不可）。参照元は DPB リポの
`docs/dpb-aws-setup-handoff.md`（インフラ台帳）と `docs/onboarding-ai-handoff.md`（2026-07-10 の 503 事故メモ）。

---

## 0. ポートは 8080 に全経路統一（最重要）

過去のヘルスチェック失敗の主因は「アプリが listen するポート」と「ターゲットグループがチェックするポート」の不一致だった。
以下の 4 箇所を **すべて 8080** に揃える。1 つでもずれると永遠に unhealthy になる。

1. アプリの listen ポート … `PORT` 環境変数（未指定なら Dockerfile の `ENV PORT=8080`）
2. タスク定義の `containerPort` … `8080`
3. ECS サービス作成時に選ぶ「コンテナのポート」… `8080`
4. ターゲットグループ `tg-onboarding-ai` のポート/ヘルスチェックポート … `8080`

アプリは `0.0.0.0:8080` にバインド済み（`index.ts`）。ヘルスチェックパスは **`/healthz`**（認証なし・DB 非依存・即 200。DPB と同じパス）。

---

## 1. 再利用するリソース（DPB 台帳より）

| 項目 | 値 |
|---|---|
| AWS 計 / リージョン | `472709934419` / `ap-northeast-1` |
| 実行ロール | `arn:aws:iam::472709934419:role/ecsTaskExecutionRole` |
| VPC | `vpc-8cfa0ceb` |
| Public サブネット | `subnet-a2a566f9`（1c）/ `subnet-ba9c16f3`（1a）|
| ECS クラスタ | `data-palette-builder` |
| ALB | `dpb-alb` / `http://dpb-alb-1673181131.ap-northeast-1.elb.amazonaws.com` |
| ALB SG | `sg-0cec8f65b0609ec3c`（`dpb-alb-sg`, 80 in）|
| RDS | `data-palette-builder-db.cczskye8qhhc.ap-northeast-1.rds.amazonaws.com:5432`（private）|
| RDS SG | `sg-0e9b75711db04e58b`（`dpb-rds-sg`, 5432 from app-sg）|
| イメージ | `ghcr.io/cs-kyoutu/kpiee-onboarding-ai:latest`（GHCR public。main push で CI 自動ビルド）|

新規に作るもの: ロググループ `/ecs/kpiee-onboarding-ai`、ターゲットグループ `tg-onboarding-ai`（8080 /healthz）、
オンボーディング用 SG（or DPB app-sg に 8080 追加）、ECS サービス、ALB リスナー規則（オンボーディング用）。

---

## 2. スモーク優先（変数を全部そぎ落として「起動して healthy」だけを先に取る）

ヘルスチェックが緑にならない原因を切り分けるため、まず **DB もシークレットも入れない** 構成で起動確認する。
これで healthy になれば「イメージ pull・コンテナ起動・8080 listen・ALB→タスクの SG・/healthz 200」が全部 OK と確定できる。
DB / RDS SG / OAuth はこの後に足す。

使うタスク定義: [`deploy/task-definition.smoke.json`](deploy/task-definition.smoke.json)（`DATABASE_URL` なし=SQLite、シークレットなし=mock）

手順:

1. **ロググループを手動作成**: CloudWatch → ロググループ → `/ecs/kpiee-onboarding-ai` を作成。**retention は変更しない**（権限なし＝Never expire のまま）。
   ⚠ これを作らず `awslogs-create-group:true` も付けないと、タスクがログを書けず起動失敗する（両タスク定義とも create-group は入れていない）。
2. **オンボーディング用 SG**: ALB SG `sg-0cec8f65b0609ec3c` からの **TCP 8080 インバウンド** を許可する SG を用意（DPB app-sg に 8080 を足して流用してもよい）。ポート番号を目視で確認すること。
3. **ターゲットグループ作成** `tg-onboarding-ai`: target type = **IP**、protocol HTTP、**port 8080**、ヘルスチェックパス **`/healthz`**、成功コード 200。
   （既存の `tg-onboarding-ai` がある場合は削除して作り直すのが確実。ポート/パスが 8080・/healthz か再確認。）
4. **スモーク用タスク定義を登録**: コンソールの JSON エディタに `deploy/task-definition.smoke.json` を貼り付けて登録（family: `kpiee-onboarding-ai-smoke`）。
   ⚠ 貼り付けはターミナル画面幅で改行が混入するので、ファイルをメモ帳で開いてコピーする。
5. **ECS サービス作成**: クラスタ `data-palette-builder`、Launch type FARGATE、サブネット `subnet-a2a566f9`(+`subnet-ba9c16f3`)、上記 SG、**public IP = ON**（GHCR pull に外向き通信が要る）。
   - ⚠ **ロードバランサはサービス「作成時」に付ける。** 後付け不可。作成画面で **コンテナ `onboarding-ai` : ポート 8080** を選び、ターゲットグループ `tg-onboarding-ai` に紐付ける。desired count = **1**。
6. **判定**: ターゲットグループ `tg-onboarding-ai` → ターゲット タブが **healthy** になれば成功。
   - Active 表示後も反映に最大 ~10 分かかることがある（DPB は ~7 分で安定）。
   - unhealthy のときの点検順: ①CloudWatch `/ecs/kpiee-onboarding-ai` にアプリ起動ログ（`API server: http://localhost:8080`）が出ているか → ②SG に ALB SG からの 8080 インバウンドがあるか → ③ターゲットグループのポート/パスが 8080・/healthz か → ④ECS サービス「イベント」タブ。

---

## 3. ルーティング（ブラウザで実際に開く）

`dpb-alb` の HTTP:80 リスナーは DPB と共有。**規則の設定を誤ると DPB が 503 になる**（2026-07-10 に実際に発生）。

⚠ 前提: ALB は経路接頭辞（例 `/onboarding`）を**そのまま**バックエンドへ渡す。本アプリはルート(`/`)基準（フロント資産は `/assets`、API は `/api`）なので、
`/onboarding*` 規則だけでは内部リンクが規則に掛からず DPB 側へ漏れて壊れる。ルーティング方式は 2 択（別途決定）:

- **ホスト基準（サブドメイン, 推奨）**: `onboarding.<社内ドメイン>` を ALB に向け、リスナー規則を「Host ヘッダ一致 → `tg-onboarding-ai`」にする。アプリ改修ほぼ不要。DNS 名が必要。
- **経路基準（base-path）**: `/onboarding` 配下で動くようフロント base・`/api` プレフィックス・OAuth redirect を全面改修。DNS 不要だが改修多数で壊れやすい。

いずれにせよ **既定(Default)規則 → `dpb-tg` は絶対に触らない**。オンボーディング規則は DPB より小さい優先度で、DPB 経路と重ならない条件のみ追加する。

（スモーク段階ではこのルーティングは不要。ターゲットグループの healthy 判定は ALB がタスク IP の `/healthz` を直接叩くので、リスナー規則とは無関係に確認できる。）

---

## 4. 本番構成へ切替（スモークが緑になってから）

使うタスク定義: [`deploy/task-definition.json`](deploy/task-definition.json)

1. **RDS に DB とユーザーを用意**（DPB と同一インスタンスに相乗り。アプリ起動時に `initDb()` が DB を自動作成できるが、専用ユーザーは事前に作る）
   ```sql
   CREATE USER onboarding WITH PASSWORD '<DB_PASSWORD>' CREATEDB;
   -- DB(onboarding) はアプリ起動時に ensurePgDatabase が自動作成（CREATEDB 権限が要る）
   ```
2. **RDS SG にインバウンド追加**: `sg-0e9b75711db04e58b`（dpb-rds-sg）に、オンボーディング SG からの **5432** を許可。
   ⚠ これを開けないと `initDb()` が RDS に繋げず、`app.listen` 前に落ちてコンテナが起動ループ→ずっと unhealthy になる（＝過去のもう一つの失敗パターン）。
3. **`task-definition.json` の `<...>` を全部埋めて登録**。`DATABASE_URL` は `...:5432/onboarding?sslmode=no-verify` を厳守（`sslmode` を付けないと自己署名 CA で `SELF_SIGNED_CERT_IN_CHAIN` 起動失敗）。
4. サービスのタスク定義を smoke → フルへ更新して再デプロイ。
5. **Google OAuth**: `WEB_APP_ORIGIN`/`GOOGLE_OAUTH_REDIRECT` を実ホストに合わせ、Console の「承認済みリダイレクト URI」に `https://<APP_HOST>/api/google/callback` を登録。対象アカウント本人が 1 回ログイン→同意し、得た `refresh_token` を env に入れて再デプロイ。同意画面は **Internal/本番** にする（Testing だと 7 日で失効）。

---

## 5. 環境変数リファレンス

| 変数 | 必須 | 説明 |
|---|---|---|
| `PORT` | — | 既定 8080（Dockerfile）。全経路で 8080 に統一 |
| `DATABASE_URL` | 本番✅ / スモークは付けない | `postgres://onboarding:<pass>@<rds>:5432/onboarding?sslmode=no-verify`。未設定だと SQLite（スモーク/ローカル用）|
| `ARTIFACT_EPHEMERAL` | 本番✅ | `1` で原本無保存（Drive 都度取得・直接アップロード無効）|
| `ANTHROPIC_API_KEY` | 本番✅ | 未設定は mock モード |
| `GOOGLE_OAUTH_CLIENT_ID`/`_SECRET`/`_REFRESH_TOKEN` | 本番✅ | Drive 連携（対象アカウント本人 OAuth）|
| `GOOGLE_OAUTH_REDIRECT` / `WEB_APP_ORIGIN` | 本番✅ | 実ホストに一致させる |
| `CORS_ORIGIN` | 任意 | 同一オリジン配信なら不要 |
| `WEB_DIST` / `PGPOOL_MAX` | — | 既定 `/app/web/dist` / `5`（Dockerfile 済）|

---

## 6. 既知の落とし穴（DPB が実際に踏んだもの）

| 症状 | 原因 | 対処 |
|---|---|---|
| ずっと unhealthy | ポート不一致（listen/containerPort/サービスLB/TG の 4 箇所）| すべて 8080 に統一 |
| ずっと unhealthy | `initDb()` が RDS に繋げず起動前に落ちる | まずスモーク(SQLite)で緑を取り、その後 RDS SG 5432 を開ける |
| タスク起動失敗ループ | ロググループ未作成 / `awslogs-create-group:true` | ロググループ手動作成・該当オプションは入れない |
| イメージ pull 失敗 | GHCR パッケージが private | パッケージを Public に |
| サービスに ALB を付けられない | ALB なしで作ったサービスは後付け不可 | サービス削除→ALB 込みで再作成 |
| DPB サイトが 503 | オンボーディング規則がルート `/` を奪う | 規則をサブパス/ホスト条件に限定・既定規則は触らない |
| シークレット平文 | SSM/Secrets Manager 権限なし | タスク定義 env に平文（閲覧権限者・ログ出力に注意）|

# KPIEE オンボーディング自動化 AI（ローカル版）

設計書 `../kpiee-onboarding-ai-webapp-design.md`（v0.1）の Phase 1 MVP をローカルで動作するように実装したもの。
顧客資料3種（インプットデータ / 最終帳票 / 中間スプレッドシート）から、AI が変換ロジックを逆算して
KPIEE 投入物（SQLジョブ用 SQL / マスタ CSV / レポート設定）を自動生成する。

## 設計書からのローカル向け置き換え

| 設計書 | ローカル実装 | 備考 |
|---|---|---|
| Vue 3 + TypeScript + Vite | そのまま | `web/` |
| Rails 8 (API mode) | Node.js + Express + TypeScript | `server/`（Ruby 未導入環境のため） |
| MySQL 8 | SQLite (better-sqlite3) | スキーマ構造は設計書 §8 と同一 |
| S3 | ローカルディレクトリ `server/data/storage/` | キー体系は S3 移行を想定 |
| Sidekiq + Redis | インプロセス非同期実行 + ポーリング | 段階別に analysis_runs へ記録 |
| rubyXL / openpyxl | exceljs | 数式原文の抽出に対応 |
| DuckDB シミュレーション | そのまま（@duckdb/node-api） | P4 数値照合 |
| Anthropic Ruby SDK | 公式 TypeScript SDK | claude-opus-4-8 / adaptive thinking / 構造化出力 / プロンプトキャッシュ |
| Cognito SSO | なし（ローカルのため省略） | |

## 起動方法

```sh
# 1. API サーバー（ポート 8787）
cd server
npm install
npm run dev

# 2. フロントエンド（ポート 5173）
cd web
npm install
npm run dev
# → http://localhost:5173 を開く
```

### AI モード

- `ANTHROPIC_API_KEY` を設定して API サーバーを起動すると **実 AI モード**（claude-opus-4-8）で動作する
- 未設定の場合は **モックモード**: 数式ヒューリスティックによる決定的な解読・生成で全フローを体験できる

```powershell
$env:ANTHROPIC_API_KEY = "sk-ant-..."; npm run dev
```

> ⚠ 実 AI モードでは顧客データが Anthropic API へ送信される。実顧客データの投入前に
> 設計書 §9.1 / リスク R1（法務・顧客同意）の確認が必須。

## 動作確認用サンプルデータ

```sh
cd server
npx tsx scripts/make-sample-data.ts
# → server/sample-data/ に3ファイル生成
#    売上データ.csv        … input_data としてアップロード
#    中間集計シート.xlsx    … working_sheet としてアップロード（SUMIF・四則演算の数式入り）
#    月次帳票.xlsx          … final_output としてアップロード（大阪の利益に手入力調整が混入）
```

### 混在ファイル（1ワークブックに raw / 中間 / 帳票 が同居）

アップロード時に種別「🔍 自動分類」を選ぶと、シート間の数式参照グラフから
シートごとの役割を自動推定する（出発点=raw / 経由点=中間 / 終着点=帳票）。
推定結果はアップロード画面のプレビューで確認・修正できる。判定不能シート（数式なし・参照なし）は
解読時に「顧客確認」へ自動エスカレーションされる。
デモ: `予実管理_統合ワークブック.xlsx` を kind=auto でアップロード。

フロー: プロジェクト作成 → 3ファイルアップロード → 「AI解読」→ 検収タブで承認 →
「成果物生成」→「数値照合」→ パッケージ出力。
サンプルでは売上・費用は 100% 一致し、「利益」列が不一致（logic_missing）として検出される
（→ 検収修正・再生成ループ UC-07 のデモになる）。

## テスト

```sh
cd server
npx tsx scripts/test-scanner.ts   # SQL 静的検証器（query_scanner 移植）のテスト
npx tsc --noEmit                  # 型チェック
cd ../web && npx vue-tsc --noEmit
```

## 構成

```
server/src/
  index.ts                 … Express API（プロジェクト/アップロード/パイプライン/成果物/照合/確認事項/管理）
  db.ts                    … SQLite スキーマ（設計書 §8）
  storage.ts               … ローカルストレージ（S3 相当）
  preprocess/parse.ts      … xlsx/CSV → 構造化 JSON（数式原文抽出・同一パターン行圧縮・SJIS判別）§6.1
  validator/queryScanner.ts… SQL 静的検証（atlas-core query_scanner.rb 移植）§6.3
  ai/client.ts             … Claude API クライアント（§7.1）
  ai/prompts.ts            … 制約プロンプト（§7.3）
  ai/schemas.ts            … 構造化出力スキーマ（§7.4）
  ai/mock.ts               … モック AI（API キーなしで全フロー動作）
  pipeline/orchestrator.ts … P1解読→P2生成→P3検証(最大3回再生成)→P4照合→P5パッケージ（§7.2）
  match/simulate.ts        … DuckDB ローカルシミュレーション照合（§6.5）
web/src/
  views/ProjectList.vue    … SC-01 プロジェクト一覧
  views/ProjectDetail.vue  … SC-02 進行ボード（ステッパー＋タブ）
  views/AdminView.vue      … SC-08 AI 使用量ダッシュボード
  components/UploadPanel.vue       … SC-03 アップロード＋シートプレビュー
  components/ReviewPanel.vue       … SC-04 解読検収（左:シート/右:解読項目）
  components/DeliverablesPanel.vue … SC-05 成果物ビューア（検証バッジ付き）
  components/MatchPanel.vue        … SC-06 数値照合結果
  components/QuestionsPanel.vue    … SC-07 顧客確認事項（メール文面出力）
  components/SheetViewer.vue       … 数式ハイライト付きシートビューア
```

## Phase 2 以降（未実装・設計書 §10）

- atlas SQL Job プレビュー API による実 Snowflake 検証（query_scanner 規則の乖離リスク R4 の解消）
- KPIEE 検証ワークスペースへの自動投入（dx-kpiee / atlas API）
- 不一致 → 自動再生成ループの完全自動化

# syntax=docker/dockerfile:1
#
# KPIEE オンボーディング AI — 本番用マルチステージイメージ。
# 方針:
#  - alpine 不可: better-sqlite3 / @duckdb/node-api がネイティブ(glibc)前提のため bookworm-slim を使う。
#  - 1 プロセス: フロント(web/dist)を Express が同一オリジンで配信する（WEB_DIST）。
#  - コアダンプ無効化(ulimit -c 0)は原本無保存の担保として ECS タスク定義側で設定する（本ファイルでは扱わない）。

# --- フロントビルド ---
FROM node:22-bookworm-slim AS web-build
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build   # vue-tsc -b && vite build → /app/web/dist

# --- サーバー依存（ネイティブモジュールを linux/glibc 向けにビルド） ---
FROM node:22-bookworm-slim AS server-deps
WORKDIR /app/server
# better-sqlite3 等のネイティブビルドに必要なツールチェーン
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY server/package.json server/package-lock.json ./
RUN npm ci

# --- 実行イメージ ---
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app/server
# 依存（ビルド済みネイティブ含む）→ サーバーソース → ビルド済みフロント の順にコピー
COPY --from=server-deps /app/server/node_modules ./node_modules
COPY server/ ./
COPY --from=web-build /app/web/dist /app/web/dist
ENV WEB_DIST=/app/web/dist
ENV PORT=8080
# DATA_DIR は SQLite/一時保存用。Postgres 移行までの暫定（コンテナ内は揮発）。
ENV DATA_DIR=/app/data
EXPOSE 8080
# tsx で TS を直接実行（現行運用と同じ）。将来 tsc コンパイルへ差し替え可。
CMD ["npx", "tsx", "src/index.ts"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

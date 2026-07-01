// .env ローダー。
// API キーをシェル環境変数で管理しなくて済むよう、server/.env から読み込む。
// 形式: KEY=VALUE（# 始まりはコメント）。既存の環境変数を上書きしない。
// このモジュールは index.ts の先頭で import し、他モジュールの評価前に実行されること。
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.resolve(__dirname, '../.env');

if (existsSync(ENV_PATH)) {
  for (const line of readFileSync(ENV_PATH, 'utf-8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    // 値の前後の引用符は除去する（KEY="value" 形式の許容）
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = value;
  }
}

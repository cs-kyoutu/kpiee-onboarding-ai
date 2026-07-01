// アーティファクト・成果物のストレージ層。
// ローカル動作のため S3 の代わりにローカルディレクトリを使用。キー体系は S3 移行を想定した相対パス。
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './db.js';

const STORAGE_ROOT = path.join(DATA_DIR, 'storage');

/** ストレージキーから絶対パスへ解決する（ディレクトリトラバーサル防止のため正規化チェック付き） */
export function resolveKey(key: string): string {
  const abs = path.resolve(STORAGE_ROOT, key);
  if (!abs.startsWith(path.resolve(STORAGE_ROOT))) {
    throw new Error(`invalid storage key: ${key}`);
  }
  return abs;
}

export function putObject(key: string, body: Buffer | string): string {
  const abs = resolveKey(key);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, body);
  return key;
}

export function getObject(key: string): Buffer {
  return readFileSync(resolveKey(key));
}

export function getJson<T>(key: string): T {
  return JSON.parse(getObject(key).toString('utf-8')) as T;
}

/** キー（ファイル）またはプレフィックス（ディレクトリ）配下を削除する。存在しなくてもエラーにしない */
export function removeObject(key: string): void {
  rmSync(resolveKey(key), { recursive: true, force: true });
}

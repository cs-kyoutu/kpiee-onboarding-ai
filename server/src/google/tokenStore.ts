// Google OAuth のリフレッシュトークン保管（ローカルファイル）。
// ユーザーがブラウザで一度同意すると refresh_token が得られ、ここに保存する。
// 以後はサーバーが refresh_token から access_token を自動更新するため再ログイン不要
// （gcloud ADC のような reauth 期限切れが起きない）。
// 保存先は DATA_DIR 配下（.gitignore 済み・顧客データと同じ扱い）。
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../db.js';

const TOKEN_PATH = path.join(DATA_DIR, 'google-oauth.json');

interface StoredToken {
  refresh_token: string;
  scope?: string;
  obtained_at: string;
}

/** 保存済みリフレッシュトークンを返す（無ければ null） */
export function loadRefreshToken(): string | null {
  if (!existsSync(TOKEN_PATH)) return null;
  try {
    const data = JSON.parse(readFileSync(TOKEN_PATH, 'utf-8')) as StoredToken;
    return data.refresh_token || null;
  } catch {
    return null;
  }
}

/** リフレッシュトークンを保存する */
export function saveRefreshToken(refreshToken: string, scope?: string): void {
  mkdirSync(DATA_DIR, { recursive: true });
  const data: StoredToken = { refresh_token: refreshToken, scope, obtained_at: new Date().toISOString() };
  writeFileSync(TOKEN_PATH, JSON.stringify(data, null, 2));
}

/** 保存済みトークンを破棄する（連携解除） */
export function clearRefreshToken(): void {
  rmSync(TOKEN_PATH, { force: true });
}

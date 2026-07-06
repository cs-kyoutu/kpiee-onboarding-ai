// アーティファクト実体（原本バイト / パース結果）の取得を一箇所に集約する層。
//
// storage_key を「参照の種類」を表す形にして、取得元を隠蔽する:
//   - ローカル保存:  project-<id>/raw/...        → ローカルディスクから読む（従来動作）
//   - Drive 無保存:  drive:<fileId>              → その都度 Google Drive から取得（デプロイ設計 C3）
//
// これにより「原本をサーバーに永続保存しない」への切り替えが、各消費側の散在した getObject を
// 書き換えることなく、この層と取り込み時のキー付与だけで完結する。
import { getObject, getJson } from './storage.js';
import { fetchDriveFile } from './google/drive.js';
import { parseArtifact, type ParsedArtifact } from './preprocess/parse.js';

const DRIVE_PREFIX = 'drive:';

/** storage_key が Drive 参照（無保存・都度取得）か */
export function isDriveKey(storageKey: string): boolean {
  return storageKey.startsWith(DRIVE_PREFIX);
}

/** Drive 参照キーを組み立てる（取り込み時に付与） */
export function driveKey(fileId: string): string {
  return `${DRIVE_PREFIX}${fileId}`;
}

/** storage_key から原本バイトを取得する。Drive 参照なら都度 fetch（作業終了後は呼び出し側で破棄される） */
export async function materializeBuffer(storageKey: string): Promise<Buffer> {
  if (isDriveKey(storageKey)) {
    const { buffer } = await fetchDriveFile(storageKey.slice(DRIVE_PREFIX.length));
    return buffer;
  }
  return getObject(storageKey);
}

/**
 * アーティファクトのパース結果を取得する。
 * ローカル保存モードは保存済み JSON（parsed_key）を読む。無保存モードは parsed_key を持たないので、
 * 原本を都度取得してメモリ上でパースし直す（原本相当の構造化物も永続保存しない=C4）。
 */
export async function materializeParsed(row: { storage_key: string; parsed_key: string | null; original_filename: string }): Promise<ParsedArtifact> {
  if (row.parsed_key) return getJson<ParsedArtifact>(row.parsed_key);
  const buffer = await materializeBuffer(row.storage_key);
  return parseArtifact(row.original_filename, buffer);
}

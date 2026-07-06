// 非同期 DB アダプタ（SQLite→Postgres 移行の土台）。
// 既存コードは better-sqlite3 の同期 API に依存しているため、移行では全呼び出しを
// この非同期インターフェース（get/all/run/tx）へ寄せる。バックエンドは env で切替:
//   - DATABASE_URL があれば Postgres（本番 / CI）
//   - なければ SQLite（ローカル開発。Docker 不要のまま従来どおり動く）
//
// これにより「ローカルは SQLite のまま・本番は pg」を両立し、pg 側の検証は
// GitHub Actions の Postgres サービスコンテナで行える（ローカル Docker 不要）。
import Database from 'better-sqlite3';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import pg from 'pg';

export interface Db {
  driver: 'pg' | 'sqlite';
  /** 1 行取得（無ければ undefined） */
  get<T>(sql: string, params?: unknown[]): Promise<T | undefined>;
  /** 全行取得 */
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  /** INSERT/UPDATE/DELETE 等。INSERT は lastInsertRowid を返す（pg は RETURNING id 経由） */
  run(sql: string, params?: unknown[]): Promise<{ lastInsertRowid: number; changes: number }>;
  /** トランザクション。fn 内では同じ接続を使う t を渡す */
  tx<T>(fn: (t: Db) => Promise<T>): Promise<T>;
  /** 生 DDL 実行（スキーマ作成用。複数文可） */
  exec(sql: string): Promise<void>;
}

// ? プレースホルダを $1,$2… へ変換（pg 用）。文字列リテラル内の ? は本アプリでは使わない前提。
function toPgPlaceholders(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

const isInsert = (sql: string) => /^\s*insert\b/i.test(sql);
const hasReturning = (sql: string) => /\breturning\b/i.test(sql);

// ───────────────────────── Postgres ─────────────────────────
function makePgDb(pool: pg.Pool, client?: pg.PoolClient): Db {
  const q = (sql: string, params: unknown[] = []) =>
    (client ?? pool).query(toPgPlaceholders(sql), params as unknown[]);
  return {
    driver: 'pg',
    async get<T>(sql: string, params: unknown[] = []) {
      const r = await q(sql, params);
      return r.rows[0] as T | undefined;
    },
    async all<T>(sql: string, params: unknown[] = []) {
      const r = await q(sql, params);
      return r.rows as T[];
    },
    async run(sql: string, params: unknown[] = []) {
      // INSERT で lastInsertRowid が要る箇所のため、RETURNING が無ければ id を補って取得する
      const finalSql = isInsert(sql) && !hasReturning(sql) ? `${sql} RETURNING id` : sql;
      const r = await q(finalSql, params);
      const idRow = r.rows[0] as { id?: number } | undefined;
      return { lastInsertRowid: Number(idRow?.id ?? 0), changes: r.rowCount ?? 0 };
    },
    async tx<T>(fn: (t: Db) => Promise<T>) {
      if (client) return fn(makePgDb(pool, client)); // 既にトランザクション中ならネストせず再利用
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const out = await fn(makePgDb(pool, c));
        await c.query('COMMIT');
        return out;
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      } finally {
        c.release();
      }
    },
    async exec(sql: string) { await q(sql); },
  };
}

// ───────────────────────── SQLite ─────────────────────────
function makeSqliteDb(sdb: Database.Database): Db {
  return {
    driver: 'sqlite',
    async get<T>(sql: string, params: unknown[] = []) {
      return sdb.prepare(sql).get(...params) as T | undefined;
    },
    async all<T>(sql: string, params: unknown[] = []) {
      return sdb.prepare(sql).all(...params) as T[];
    },
    async run(sql: string, params: unknown[] = []) {
      const r = sdb.prepare(sql).run(...params);
      return { lastInsertRowid: Number(r.lastInsertRowid), changes: r.changes };
    },
    async tx<T>(fn: (t: Db) => Promise<T>) {
      // better-sqlite3 の transaction() は同期専用のため、手動 BEGIN/COMMIT で async fn を包む。
      // SQLite 呼び出しは同期なので await 中に別クエリが割り込む余地はない（単一リクエスト前提）。
      sdb.exec('BEGIN');
      try {
        const out = await fn(makeSqliteDb(sdb));
        sdb.exec('COMMIT');
        return out;
      } catch (e) {
        sdb.exec('ROLLBACK');
        throw e;
      }
    },
    async exec(sql: string) { sdb.exec(sql); },
  };
}

// ───────────────────────── ファクトリ ─────────────────────────
export function createDb(): Db {
  const url = process.env.DATABASE_URL;
  if (url) {
    const pool = new pg.Pool({ connectionString: url, max: Number(process.env.PGPOOL_MAX ?? 5) });
    return makePgDb(pool);
  }
  const dir = process.env.DATA_DIR || path.resolve(process.cwd(), 'data');
  mkdirSync(dir, { recursive: true });
  const sdb = new Database(path.join(dir, 'app.db'));
  sdb.pragma('journal_mode = WAL');
  return makeSqliteDb(sdb);
}

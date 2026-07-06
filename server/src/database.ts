// 非同期 DB アダプタ（SQLite→Postgres 移行の土台）。
// 既存コードは better-sqlite3 の同期 API（db.prepare(sql).get/all/run(...)）に依存するため、
// 同じ形の非同期版 prepare() を提供して「await を付けるだけ」で移行できるようにする。
// バックエンドは env で切替:
//   - DATABASE_URL があれば Postgres（本番 / CI）
//   - なければ SQLite（ローカル開発。Docker 不要のまま従来どおり動く）
// pg 側の検証は GitHub Actions の Postgres サービスコンテナで行う（ローカル Docker 不要）。
import Database from 'better-sqlite3';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import pg from 'pg';

export interface Stmt {
  get<T>(...params: unknown[]): Promise<T | undefined>;
  all<T>(...params: unknown[]): Promise<T[]>;
  run(...params: unknown[]): Promise<{ lastInsertRowid: number; changes: number }>;
}

export interface Db {
  driver: 'pg' | 'sqlite';
  /** better-sqlite3 と同形の文（ただし各メソッドは非同期） */
  prepare(sql: string): Stmt;
  /** 生 DDL 実行（スキーマ作成用。複数文可） */
  exec(sql: string): Promise<void>;
  /** トランザクション。fn 内では同じ接続を使う t を渡す */
  tx<T>(fn: (t: Db) => Promise<T>): Promise<T>;
}

// ? プレースホルダを $1,$2… へ変換（pg 用）。文字列リテラル内の ? は本アプリでは使わない前提。
function toPgPlaceholders(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

const isInsert = (sql: string) => /^\s*insert\b/i.test(sql);
const hasReturning = (sql: string) => /\breturning\b/i.test(sql);
// id 列を持たないテーブルへの INSERT には RETURNING id を付けない（project_overviews は project_id が PK）
const noIdTable = (sql: string) => /\binto\s+project_overviews\b/i.test(sql);

// ───────────────────────── Postgres ─────────────────────────
function makePgDb(pool: pg.Pool, client?: pg.PoolClient): Db {
  const q = (sql: string, params: unknown[]) =>
    (client ?? pool).query(toPgPlaceholders(sql), params as unknown[]);
  return {
    driver: 'pg',
    prepare(sql: string): Stmt {
      return {
        async get<T>(...params: unknown[]) { return (await q(sql, params)).rows[0] as T | undefined; },
        async all<T>(...params: unknown[]) { return (await q(sql, params)).rows as T[]; },
        async run(...params: unknown[]) {
          // INSERT で lastInsertRowid が要る箇所のため、RETURNING が無ければ id を補って取得する
          const finalSql = isInsert(sql) && !hasReturning(sql) && !noIdTable(sql) ? `${sql} RETURNING id` : sql;
          const r = await q(finalSql, params);
          const idRow = r.rows[0] as { id?: number } | undefined;
          return { lastInsertRowid: Number(idRow?.id ?? 0), changes: r.rowCount ?? 0 };
        },
      };
    },
    async exec(sql: string) { await q(sql, []); },
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
  };
}

// ───────────────────────── SQLite ─────────────────────────
function makeSqliteDb(sdb: Database.Database): Db {
  return {
    driver: 'sqlite',
    prepare(sql: string): Stmt {
      // 遅延コンパイル: better-sqlite3 は prepare 時に SQL を即コンパイルしテーブル未作成だと落ちる。
      // pg と同様に「実行時までコンパイルしない」ことで、initDb 前のモジュール評価時 prepare でも落ちない。
      let st: Database.Statement | undefined;
      const stmt = () => (st ??= sdb.prepare(sql));
      return {
        async get<T>(...params: unknown[]) { return stmt().get(...params) as T | undefined; },
        async all<T>(...params: unknown[]) { return stmt().all(...params) as T[]; },
        async run(...params: unknown[]) {
          const r = stmt().run(...params);
          return { lastInsertRowid: Number(r.lastInsertRowid), changes: r.changes };
        },
      };
    },
    async exec(sql: string) { sdb.exec(sql); },
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
  };
}

/**
 * pg: 対象データベースが無ければ作成する。メンテナンス DB(postgres) に接続して CREATE DATABASE する。
 * VPC 内で起動するアプリ自身が作れるので、プライベート RDS へ手動接続して作る必要がない。
 * DATABASE_URL の資格情報に CREATEDB 権限（マスターユーザー等）が必要。失敗しても致命的にしない
 * （対象 DB が既に存在し直接到達できるケースを壊さないため、initDb 側で warn して継続する）。
 */
export async function ensurePgDatabase(url: string): Promise<void> {
  const target = new URL(url);
  const dbName = decodeURIComponent(target.pathname.replace(/^\//, '')) || 'onboarding';
  if (dbName === 'postgres') return; // メンテナンス DB 自体なら作成不要
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const r = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (r.rowCount === 0) {
      // DB 名は自前管理値。二重引用符で囲んで識別子として扱う
      await client.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
    }
  } finally {
    await client.end();
  }
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
  sdb.pragma('foreign_keys = ON');
  return makeSqliteDb(sdb);
}

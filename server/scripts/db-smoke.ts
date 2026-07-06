// DB アダプタ(database.ts)の疎通・方言・トランザクション検証スモーク。
// DATABASE_URL があれば Postgres、なければ SQLite に対して同じ検証を走らせる。
// CI(GitHub Actions)では Postgres サービスコンテナに対して実行し、ローカル Docker 無しで pg を検証する。
import { createDb } from '../src/database.js';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

async function main() {
  const db = createDb();
  console.log(`driver = ${db.driver}`);

  // 方言差（AUTOINCREMENT/SERIAL, datetime/now）を吸収した DDL
  const ddl = db.driver === 'pg'
    ? `CREATE TABLE IF NOT EXISTS smoke_t (
         id SERIAL PRIMARY KEY,
         name TEXT NOT NULL,
         created_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`
    : `CREATE TABLE IF NOT EXISTS smoke_t (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         name TEXT NOT NULL,
         created_at TEXT NOT NULL DEFAULT (datetime('now'))
       )`;
  await db.exec('DROP TABLE IF EXISTS smoke_t');
  await db.exec(ddl);

  // INSERT → lastInsertRowid（pg は RETURNING id 経由）
  const a = await db.run(`INSERT INTO smoke_t (name) VALUES (?)`, ['alpha']);
  const b = await db.run(`INSERT INTO smoke_t (name) VALUES (?)`, ['beta']);
  assert(a.lastInsertRowid > 0, 'insert returns lastInsertRowid');
  assert(b.lastInsertRowid === a.lastInsertRowid + 1, 'autoincrement sequential');

  // get / all
  const row = await db.get<{ id: number; name: string }>(`SELECT id, name FROM smoke_t WHERE id = ?`, [a.lastInsertRowid]);
  assert(row?.name === 'alpha', 'get by id');
  const all = await db.all<{ id: number }>(`SELECT id FROM smoke_t ORDER BY id`);
  assert(all.length === 2, 'all returns 2 rows');

  // トランザクション: ロールバック（件数不変）
  try {
    await db.tx(async t => {
      await t.run(`INSERT INTO smoke_t (name) VALUES (?)`, ['gamma']);
      throw new Error('force rollback');
    });
  } catch { /* expected */ }
  const afterRollback = await db.all<{ id: number }>(`SELECT id FROM smoke_t`);
  assert(afterRollback.length === 2, 'rollback leaves 2 rows');

  // トランザクション: コミット（件数増加）
  await db.tx(async t => {
    await t.run(`INSERT INTO smoke_t (name) VALUES (?)`, ['delta']);
  });
  const afterCommit = await db.all<{ id: number }>(`SELECT id FROM smoke_t`);
  assert(afterCommit.length === 3, 'commit adds 1 row');

  // UPDATE の changes
  const upd = await db.run(`UPDATE smoke_t SET name = ? WHERE name = ?`, ['ALPHA', 'alpha']);
  assert(upd.changes === 1, 'update reports 1 change');

  await db.exec('DROP TABLE IF EXISTS smoke_t');
  console.log('DB SMOKE: PASS ✅');
  process.exit(0);
}

main().catch(e => { console.error('DB SMOKE: FAIL ❌'); console.error(e); process.exit(1); });

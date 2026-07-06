// DB アダプタ(database.ts) + 実スキーマ(schema.ts) の疎通・方言・トランザクション検証スモーク。
// DATABASE_URL があれば Postgres、なければ SQLite に対して同じ検証を走らせる。
// CI(GitHub Actions)では Postgres サービスコンテナに対して実行し、ローカル Docker 無しで pg を検証する。
import { createDb } from '../src/database.js';
import { initSchema } from '../src/schema.js';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

async function main() {
  const db = createDb();
  console.log(`driver = ${db.driver}`);

  // 実スキーマをそのドライバの方言で作成できるか（AUTOINCREMENT/SERIAL, datetime/now など）
  await initSchema(db);

  // INSERT → lastInsertRowid（pg は RETURNING id 経由）
  const p = await db.prepare(`INSERT INTO projects (customer_name) VALUES (?)`).run('smoke-cust');
  assert(p.lastInsertRowid > 0, 'projects insert returns id');
  const pid = p.lastInsertRowid;

  const a = await db.prepare(
    `INSERT INTO artifacts (project_id, kind, original_filename, storage_key, parse_status) VALUES (?, ?, ?, ?, 'done')`,
  ).run(pid, 'input_data', 'x.xlsx', 'drive:abc');
  assert(a.lastInsertRowid > 0, 'artifacts insert returns id');

  // get / all
  const proj = await db.prepare(`SELECT customer_name FROM projects WHERE id = ?`).get<{ customer_name: string }>(pid);
  assert(proj?.customer_name === 'smoke-cust', 'get by id');
  const arts = await db.prepare(`SELECT id FROM artifacts WHERE project_id = ?`).all<{ id: number }>(pid);
  assert(arts.length === 1, 'all returns inserted artifact');

  // id 列を持たないテーブル（project_overviews）への INSERT が RETURNING id 無しで通る
  // （pg では RETURNING id を付けないこと、sqlite では PK が rowid 別名になることの両対応確認）
  const ov = await db.prepare(`INSERT INTO project_overviews (project_id, content) VALUES (?, ?)`).run(pid, '{}');
  assert(ov.changes === 1, 'no-id table insert ok (changes=1)');

  // トランザクション: ロールバック（件数不変）
  try {
    await db.tx(async t => {
      await t.prepare(`INSERT INTO projects (customer_name) VALUES (?)`).run('rollback-me');
      throw new Error('force rollback');
    });
  } catch { /* expected */ }
  const afterRollback = await db.prepare(`SELECT id FROM projects WHERE customer_name = ?`).all(['rollback-me']);
  assert(afterRollback.length === 0, 'rollback leaves no row');

  // トランザクション: コミット
  await db.tx(async t => {
    await t.prepare(`INSERT INTO projects (customer_name) VALUES (?)`).run('commit-me');
  });
  const afterCommit = await db.prepare(`SELECT id FROM projects WHERE customer_name = ?`).all(['commit-me']);
  assert(afterCommit.length === 1, 'commit adds row');

  // 集計（getProjectUsage 相当の COALESCE/SUM/GROUP BY が両方言で通るか）
  await db.prepare(
    `INSERT INTO ai_usage_logs (project_id, stage, model, input_tokens, output_tokens) VALUES (?, 'decode', 'm', 10, 5)`,
  ).run(pid);
  const agg = await db.prepare(`
    SELECT COALESCE(SUM(input_tokens), 0) AS input_tokens, COUNT(*) AS request_count
    FROM ai_usage_logs WHERE project_id = ?
  `).get<{ input_tokens: number; request_count: number }>(pid);
  assert(Number(agg?.input_tokens) === 10, 'aggregate sum works');

  // UPDATE の changes
  const upd = await db.prepare(`UPDATE projects SET status = ? WHERE id = ?`).run('completed', pid);
  assert(upd.changes === 1, 'update reports 1 change');

  console.log('DB SMOKE: PASS ✅');
  process.exit(0);
}

main().catch(e => { console.error('DB SMOKE: FAIL ❌'); console.error(e); process.exit(1); });

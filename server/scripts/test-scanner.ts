// SQL 静的検証器の動作確認スクリプト（ネガティブテスト含む）。
// 実行: npx tsx scripts/test-scanner.ts
import { scanQuery } from '../src/validator/queryScanner.js';

const cases: { sql: string; expectOk: boolean }[] = [
  { sql: 'DROP TABLE x', expectOk: false },
  { sql: 'SELECT * FROM secret_table', expectOk: false },          // 未登録テーブル
  { sql: 'SELECT CURRENT_USER FROM a', expectOk: false },          // 括弧省略形 context 関数
  { sql: 'SELECT current_user() FROM a', expectOk: false },        // 関数呼び出し形
  { sql: 'SELECT * FROM @stage1', expectOk: false },               // stage 参照
  { sql: 'SELECT 1; SELECT 2', expectOk: false },                  // 複数 statement
  { sql: 'SELECT db.fn(1) FROM a', expectOk: false },              // 修飾付き関数
  { sql: "SELECT 'use this -- not a keyword' FROM a", expectOk: true }, // 文字列内は無視
  { sql: 'WITH t AS (SELECT * FROM a) SELECT * FROM t', expectOk: true },
  { sql: 'WITH t AS (DELETE FROM a) SELECT * FROM t', expectOk: false }, // CTE 本体の DML
  { sql: 'SELECT "拠点", SUM("売上") FROM a GROUP BY "拠点"', expectOk: true },
];

let failed = 0;
for (const c of cases) {
  const r = scanQuery(c.sql, ['a']);
  const pass = r.ok === c.expectOk;
  if (!pass) failed++;
  console.log(`${pass ? 'PASS' : 'FAIL'} ok=${r.ok} expect=${c.expectOk} :: ${c.sql} :: ${r.errors.map(e => e.code).join(',')}`);
}
console.log(failed === 0 ? '全テスト合格' : `${failed} 件失敗`);
process.exit(failed === 0 ? 0 : 1);

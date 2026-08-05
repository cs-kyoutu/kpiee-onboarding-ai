// 指定プロジェクトについて HEAD と作業コピーの辺集合を突き合わせ、増減の中身を出す。
// 使い方: npx tsx scripts/diff-vs-head.ts <project-dir名> [表示件数]
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const proj = process.argv[2];
const SHOW = Number(process.argv[3] ?? 6);
const dir = join('data/storage', proj, 'raw');
if (!existsSync(dir)) { console.error(`no such project: ${proj}`); process.exit(2); }
const files = readdirSync(dir).map(f => join(dir, f));

const run = (script: string, mode: string) =>
  spawnSync('npx', ['tsx', script, mode, `${proj}-diff`, ...files],
    { encoding: 'utf8', shell: true, maxBuffer: 1 << 28 });

const cap = run('.regress-head/server/scripts/golden-relations.ts', 'capture');
if (cap.status !== 0) { console.error('HEAD 側の解析に失敗:\n' + cap.stderr.slice(-1500)); process.exit(1); }
const goldenPath = join('scripts/.golden', `${proj}-diff.json`);
// 「手コピー」→「手修正」の語彙変更は挙動ではないので、比較前に HEAD 側の表記を寄せる。
// これをしないと全 copy 辺が「変化」に見えて、本当の増減が埋もれる。
const RENAMED = (s: string) => s.split('手コピー').join('手修正');
const head = JSON.parse(RENAMED(readFileSync(goldenPath, 'utf8'))) as { edges: Record<string, unknown>[] };

// 作業コピー側は capture で別ラベルへ書き出して読む
const cap2 = spawnSync('npx', ['tsx', 'scripts/golden-relations.ts', 'capture', `${proj}-now`, ...files],
  { encoding: 'utf8', shell: true, maxBuffer: 1 << 28 });
if (cap2.status !== 0) { console.error('作業コピー側の解析に失敗:\n' + cap2.stderr.slice(-1500)); process.exit(1); }
const now = JSON.parse(readFileSync(join('scripts/.golden', `${proj}-now.json`), 'utf8')) as { edges: Record<string, unknown>[] };

const key = (e: Record<string, unknown>) => JSON.stringify(e);
const hSet = new Map(head.edges.map(e => [key(e), e]));
const nSet = new Map(now.edges.map(e => [key(e), e]));
const lost = [...hSet.keys()].filter(k => !nSet.has(k));
const added = [...nSet.keys()].filter(k => !hSet.has(k));

console.log(`${proj}: HEAD ${head.edges.length} 辺 → 作業コピー ${now.edges.length} 辺`);
console.log(`  失われた: ${lost.length} / 増えた: ${added.length}\n`);

const byType = (keys: string[]) => {
  const m = new Map<string, number>();
  for (const k of keys) {
    const t = (JSON.parse(k) as { type: string }).type;
    m.set(t, (m.get(t) ?? 0) + 1);
  }
  return [...m].map(([t, n]) => `${t}=${n}`).join(' ');
};
console.log(`失われた辺の種類: ${byType(lost) || '(なし)'}`);
console.log(`増えた辺の種類  : ${byType(added) || '(なし)'}\n`);

/** 失われた辺と増えた辺が「同じ列ペアで向きだけ逆」なら、それは向きの修正 */
const undirectedKey = (e: Record<string, unknown>) => {
  const a = String(e.from), b = String(e.to);
  return `${a < b ? a + '::' + b : b + '::' + a}|${e.type}`;
};
const lostU = new Set(lost.map(k => undirectedKey(JSON.parse(k))));
const flipped = added.filter(k => lostU.has(undirectedKey(JSON.parse(k))));
console.log(`うち「向きが反転しただけ」の辺: ${flipped.length}\n`);

console.log(`--- 失われた辺（先頭 ${SHOW}）---`);
for (const k of lost.slice(0, SHOW)) console.log('  ' + k);
console.log(`\n--- 増えた辺（先頭 ${SHOW}）---`);
for (const k of added.slice(0, SHOW)) console.log('  ' + k);

// HEAD と作業コピーで解析結果が一致するかをプロジェクト単位で突き合わせる回帰チェック。
//
// 目的: 外部通合文書参照を持たないファイルでは挙動が一切変わらないことを示す
//       （変わったら既存ケースの回帰）。外部参照を持つプロジェクトは意図的に変わるので
//       「変化あり」が期待値になる。
//
// 前提: `git worktree add server/.regress-head HEAD` で HEAD 版を用意し、
//       scripts/golden-relations.ts をそこへコピーしておく（HEAD には未追跡のため存在しない）。
// 使い方: npx tsx scripts/regress-vs-head.ts
import { readdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const HEAD_SCRIPT = '.regress-head/server/scripts/golden-relations.ts';
if (!existsSync(HEAD_SCRIPT)) {
  console.error(`HEAD 版が無い。先に:\n  git worktree add server/.regress-head HEAD\n  cp server/scripts/golden-relations.ts server/.regress-head/server/scripts/`);
  process.exit(2);
}

const run = (script: string, args: string[]) =>
  spawnSync('npx', ['tsx', script, ...args], { encoding: 'utf8', shell: true, maxBuffer: 1 << 28 });

const base = 'data/storage';
const projects = readdirSync(base).filter(p => existsSync(join(base, p, 'raw')));

let regressions = 0;
const changed: string[] = [];
for (const p of projects) {
  const dir = join(base, p, 'raw');
  const files = readdirSync(dir).map(f => join(dir, f));
  if (files.length === 0) continue;

  const cap = run(HEAD_SCRIPT, ['capture', p, ...files]);
  if (cap.status !== 0) { console.log(`  SKIP ${p}（HEAD 側で解析できず）`); continue; }

  // 「手コピー」→「手修正」の語彙変更は挙動ではないので、golden 側の表記を寄せてから比べる。
  // これをしないと全 copy 辺が「変化」に見えて、本当の増減が埋もれる。
  const goldenPath = join('scripts/.golden', `${p}.json`);
  writeFileSync(goldenPath, readFileSync(goldenPath, 'utf8').split('手コピー').join('手修正'));

  const cmp = run('scripts/golden-relations.ts', ['compare', p, ...files]);
  const summary = (cap.stdout.split('\n')[0] ?? '').trim();
  if (cmp.status === 0) {
    console.log(`  同一   ${p}  ${summary}`);
  } else {
    // 差分の中身（何がどれだけ増えたか）を1行にまとめる
    const detail = cmp.stderr.split('\n').filter(l => /^\s+- /.test(l)).map(l => l.trim()).join(' / ');
    console.log(`  変化   ${p}  ${detail || '(詳細なし)'}`);
    changed.push(p);
    regressions++;
  }
}

console.log('\n--- まとめ ---');
console.log(`変化したプロジェクト: ${changed.length ? changed.join(', ') : 'なし'}`);
console.log('外部参照を持つのは project-23 のみ（他は変化してはいけない）');
process.exit(changed.filter(p => p !== 'project-23').length === 0 ? 0 : 1);

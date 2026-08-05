// 特定の表について、キーの role 別内訳と根拠を見る（キー特定の品質確認用）。
// 使い方: npx tsx scripts/probe-keys-detail.ts [プロジェクトdir名] [シート名の一部]
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeArtifacts, type RelationInput } from '../src/preprocess/relations.js';

const proj = process.argv[2] ?? 'project-23';
const needle = process.argv[3] ?? '就労支援';
const dir = join('data/storage', proj, 'raw');
const arts: RelationInput[] = readdirSync(dir).map(f => ({
  filename: f.replace(/^\d{10,}-/, ''), load: async () => readFileSync(join(dir, f)),
}));
const g = await analyzeArtifacts(arts);

// role 別の全体分布
const dist = new Map<string, number>();
let regionsWithKeys = 0, manyPrimary = 0;
for (const r of g.regions) {
  const ks = r.keys?.keys ?? [];
  if (ks.length > 0) regionsWithKeys++;
  if (ks.filter(k => k.role === 'primary').length > 1) manyPrimary++;
  for (const k of ks) dist.set(k.role, (dist.get(k.role) ?? 0) + 1);
}
console.log('=== role 別のキー総数（全表） ===');
for (const [r, n] of [...dist].sort((a, b) => b[1] - a[1])) console.log(`  ${r.padEnd(8)} ${n}`);
console.log(`キーを持つ表: ${regionsWithKeys} / ${g.regions.length}`);
console.log(`主キーが2本以上ある表: ${manyPrimary}  ← 1表に主キーが複数あるのは要注意`);

const target = g.regions.filter(r => r.sheet.includes(needle) && (r.keys?.keys?.length ?? 0) > 3)
  .sort((a, b) => (b.keys!.keys.length) - (a.keys!.keys.length))[0];
if (!target) { console.log(`\n「${needle}」を含む表は見つからず`); process.exit(0); }

const ks = target.keys!.keys;
console.log(`\n=== ${target.sheet}（${target.dataRowCount}行 × ${target.columns.length}列）===`);
console.log(`grain: ${target.keys!.grain ?? '(なし)'} / colAxis: ${target.keys!.colAxis ?? '(なし)'}`);
for (const role of ['primary', 'axis', 'join'] as const) {
  const of = ks.filter(k => k.role === role);
  console.log(`\n  [${role}] ${of.length} 本: ${of.slice(0, 12).map(k => k.column).join('、')}${of.length > 12 ? ` …他${of.length - 12}` : ''}`);
  for (const k of of.slice(0, 3)) console.log(`     ${k.column}: ${k.evidence.slice(0, 2).join(' / ').slice(0, 120)}`);
}

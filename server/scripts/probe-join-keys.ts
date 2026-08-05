// ファイル間の関係が「キーで結合」なのか「セル位置で対応」なのかを実データで確かめる。
// kpiee（SQL）で再現するには JOIN のキーが必要なので、ここが分かれ目になる。
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeArtifacts, type RelationInput, type Edge } from '../src/preprocess/relations.js';

const proj = process.argv[2] ?? 'project-23';
const dir = join('data/storage', proj, 'raw');
const nameOf = (f: string) => f.replace(/^\d{10,}-/, '');
const arts: RelationInput[] = readdirSync(dir).map(f => ({
  filename: nameOf(f), load: async () => readFileSync(join(dir, f)),
}));
const g = await analyzeArtifacts(arts);

const fileOf = new Map(g.regions.map(r => [r.id, r.file]));
const regionOf = (k: string) => k.slice(0, k.lastIndexOf(':'));
const isCross = (e: Edge) => {
  const f = fileOf.get(regionOf(e.from)), t = fileOf.get(regionOf(e.to));
  return f && t && f !== t;
};

const byType = new Map<string, number>();
for (const e of g.edges as Edge[]) {
  if (!isCross(e)) continue;
  byType.set(e.type, (byType.get(e.type) ?? 0) + 1);
}
console.log(`${proj}\n\n=== ファイルをまたぐ関係の種別 ===`);
for (const [t, n] of [...byType].sort((a, b) => b[1] - a[1])) console.log(`  ${t.padEnd(14)} ${n}`);

// filter-key / lookup-join = キーで引き当てている関係。これがあれば JOIN のキーがある
const keyish = ['filter-key', 'lookup-join'];
const crossKeyish = [...byType].filter(([t]) => keyish.includes(t)).reduce((s, [, n]) => s + n, 0);
const crossTotal = [...byType.values()].reduce((a, b) => a + b, 0);
console.log(`\nファイル間 ${crossTotal} 本のうち、キーで引き当てているもの: ${crossKeyish} 本`);

// キーの対応（keyLinks）はファイル内・ファイル間のどちらにあるか
const links = g.keyLinks ?? [];
let intra = 0, cross = 0;
for (const l of links) {
  const fa = fileOf.get(regionOf(l.a)), fb = fileOf.get(regionOf(l.b));
  if (fa && fb && fa !== fb) cross++; else intra++;
}
console.log(`\n=== キーの対応（ER 図の線）===`);
console.log(`  合計 ${links.length} 組  … ファイル内 ${intra} / ファイルをまたぐ ${cross}`);

console.log(`\n=== ファイル間の代表的な数式 ===`);
const seen = new Set<string>();
for (const e of g.edges as Edge[]) {
  if (!isCross(e) || !e.evidence || seen.has(e.evidence)) continue;
  seen.add(e.evidence);
  console.log(`  ${e.type.padEnd(12)} ${e.evidence.slice(0, 56)}`);
  if (seen.size >= 8) break;
}

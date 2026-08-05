// project-23 の「ファイル間の関係」と「手修正推定」の件数を数える。
// HEAD 版と作業コピー版の両方で同じ数え方をして before/after を比べるために使う。
// 使い方: npx tsx scripts/count-crossfile.ts [プロジェクトdir名]
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeArtifacts, type RelationInput } from '../src/preprocess/relations.js';

const proj = process.argv[2] ?? 'project-23';
const dir = join('data/storage', proj, 'raw');
// 本番は artifacts.original_filename を渡すので、storage の timestamp 接頭辞を落として合わせる
const arts: RelationInput[] = readdirSync(dir).map(f => ({
  filename: f.replace(/^\d{10,}-/, ''),
  load: async () => readFileSync(join(dir, f)),
}));

const t0 = Date.now();
const g = await analyzeArtifacts(arts);
const secs = ((Date.now() - t0) / 1000).toFixed(1);

const fileOfRegion = new Map(g.regions.map(r => [r.id, r.file]));
const fileOf = (key: string) => fileOfRegion.get(key.slice(0, key.lastIndexOf(':')));
const cross = g.edges.filter(e => {
  const f = fileOf(e.from), t = fileOf(e.to);
  return f && t && f !== t;
});
const copy = g.edges.filter(e => e.type === 'copy');
const crossFormula = cross.filter(e => e.type !== 'copy');

// レポートの「手作業の転記と推定されるつながりが N 組」は表ペア単位の数
const copyPairs = new Set(copy.map(e => `${e.from.slice(0, e.from.lastIndexOf(':'))}>${e.to.slice(0, e.to.lastIndexOf(':'))}`));

const linked = new Set<string>();
for (const e of cross) { linked.add(fileOf(e.from)!); linked.add(fileOf(e.to)!); }
const isolated = arts.map(a => a.filename.replace(/\.[^.]+$/, '')).filter(l => !linked.has(l));

const shared = g.sharedTemplates ?? [];
console.log(JSON.stringify({
  proj, secs, rssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
  regions: g.regions.length, edges: g.edges.length,
  crossFileTotal: cross.length, crossFileFormula: crossFormula.length,
  copyEdges: copy.length, copyRegionPairs: copyPairs.size,
  sharedTemplateColumns: shared.length,
  sharedTemplateTop: shared
    .slice()
    .sort((a, b) => b.places.length - a.places.length)
    .slice(0, 5)
    .map(t => `${t.columnName} (${new Set(t.places.map(p => p.file)).size}ブック / ${t.rowCount}行)`),
  isolatedFiles: isolated.length,
}, null, 1));

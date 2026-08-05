// 02 節を「ロジック単位のブロック」へ分割する案を、実データで計算して確認するための下見スクリプト。
//
// 狙い: ER 図を1枚の巨大な図として出すのをやめ、「全体関係図のこの部分の話です」→「そのロジック」
//      →「関係する表のキーと定義」→「だからこのER」の順に、ブロックごとに説明できるようにする。
// ここではブロックの切り方（＝どこで分けると説明の順序が自然になるか）だけを検証する。
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeArtifacts, fileLabelOf, type RelationInput, type Edge } from '../src/preprocess/relations.js';
import { aggregatePairs, aggregateFilePairs, dominantFileGroup, GROUP_META } from '../src/relations/fileGraph.js';

const proj = process.argv[2] ?? 'project-23';
const dir = join('data/storage', proj, 'raw');
const nameOf = (f: string) => f.replace(/^\d{10,}-/, '');
const short = (l: string) => l.replace(/^業績管理表2603期 /, '').replace(/ 2601 0213$/, '');

const arts: RelationInput[] = readdirSync(dir).map(f => ({
  filename: nameOf(f), load: async () => readFileSync(join(dir, f)),
}));
const graph = await analyzeArtifacts(arts);
const regions = graph.regions;
const pairs = aggregatePairs(graph.edges as Edge[]);
const filePairs = aggregateFilePairs(regions, pairs);

const fileOfRegion = new Map(regions.map(r => [r.id, r.file]));


// 最終アウトプット = 流入があって流出が無いファイル（本体の resolveOutputFiles と同じ考え方）
const inF = new Map<string, Set<string>>(), outF = new Map<string, Set<string>>();
for (const p of filePairs) {
  (outF.get(p.from) ?? outF.set(p.from, new Set()).get(p.from)!).add(p.to);
  (inF.get(p.to) ?? inF.set(p.to, new Set()).get(p.to)!).add(p.from);
}
const allFiles = [...new Set(regions.map(r => r.file))];
const outputs = allFiles.filter(f => (inF.get(f)?.size ?? 0) > 0 && (outF.get(f)?.size ?? 0) === 0);

console.log(`${proj}\n最終アウトプット: ${outputs.map(short).join(', ') || '(未特定)'}\n`);
console.log('=== 提案するブロック（この順に説明する） ===\n');

let n = 0;
for (const out of outputs) {
  const ups = [...(inF.get(out) ?? [])];
  // 関係の本数が多い順＝説明の重みが大きい順
  const ranked = ups.map(u => {
    const ps = filePairs.filter(p => p.from === u && p.to === out);
    return { file: u, total: ps.reduce((s, p) => s + p.total, 0), ps };
  }).sort((a, b) => b.total - a.total);

  for (const u of ranked) {
    n++;
    const grp = u.ps.length > 0 ? dominantFileGroup(u.ps[0]) : undefined;
    // このブロックに登場する表（PairAgg の from/to は列キーではなく region.id そのもの）
    const regionPairs = pairs.filter(p => fileOfRegion.get(p.from) === u.file
      && fileOfRegion.get(p.to) === out);
    const srcRegions = new Set(regionPairs.map(p => p.from));
    const dstRegions = new Set(regionPairs.map(p => p.to));
    const rep = regionPairs[0]?.best;
    const repEv = rep ? (Object.values(rep).find(e => e && e.evidence)?.evidence ?? '') : '';
    const keyed = [...srcRegions, ...dstRegions]
      .map(id => regions.find(r => r.id === id))
      .filter(r => r && (r.keys?.keys?.length ?? 0) > 0);

    console.log(`【${n}】${short(u.file)}  →  ${short(out)}`);
    console.log(`      関係 ${u.total} 本 / 種別 ${grp ? GROUP_META[grp].label : '—'}`);
    console.log(`      登場する表: 元 ${srcRegions.size} 表 → 先 ${dstRegions.size} 表`);
    console.log(`      代表の数式: ${repEv.slice(0, 60)}`);
    console.log(`      キーが分かっている表: ${keyed.length} / ${srcRegions.size + dstRegions.size}`);
    console.log();
  }
}

// どのブロックにも入らないファイル
const inBlock = new Set<string>([...outputs, ...outputs.flatMap(o => [...(inF.get(o) ?? [])])]);
const rest = allFiles.filter(f => !inBlock.has(f));
if (rest.length > 0) {
  console.log(`【残り】どのブロックにも入らないファイル: ${rest.map(short).join(', ')}`);
  console.log('      → 「つながりが未検出」として別枠で扱う（03 の確認事項と紐づける）');
}
console.log(`\nブロック数: ${n}（＋残り ${rest.length} ファイル）`);

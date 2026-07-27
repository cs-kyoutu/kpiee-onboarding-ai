// 分析レポート HTML を手元で生成して見た目を確認する診断スクリプト。
// 使い方: npx tsx scripts/gen-relations-report.ts <出力先.html> <xlsx/csv パス...>
// 宛名は環境変数 CUSTOMER で差し替えられる（既定: サンプル）。
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { analyzeArtifacts } from '../src/preprocess/relations.js';
import { buildRelationsReportHtml } from '../src/relationsReport.js';

const [out, ...inputs] = process.argv.slice(2);
if (!out || inputs.length === 0) {
  console.error('usage: npx tsx scripts/gen-relations-report.ts <out.html> <file...>');
  process.exit(1);
}

const graph = await analyzeArtifacts(
  inputs.map(p => ({ filename: basename(p), load: async () => readFileSync(p) })),
);
const html = buildRelationsReportHtml({
  customerName: process.env.CUSTOMER ?? 'サンプル',
  generatedAt: new Date(),
  fileCount: inputs.length,
  graph,
});
writeFileSync(out, html, 'utf8');
console.log(`${out} (${html.length} bytes) / regions=${graph.regions.length} edges=${graph.edgeTotal ?? 0}`);

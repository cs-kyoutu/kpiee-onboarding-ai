// 分析レポート HTML を手元で生成して見た目を確認する診断スクリプト。
// 使い方: npx tsx scripts/gen-relations-report.ts <出力先.html> <xlsx/csv パス...>
// 宛名は環境変数 CUSTOMER で差し替えられる（既定: サンプル）。
//
// 環境変数:
//   FINAL_OUTPUTS  最終帳票のファイル名（カンマ区切り）
//   FILE_RELATIONS 担当者が確定したブック関係。`元>先:種別:説明` をカンマ区切りで並べる。
//                  元/先は拡張子なしのファイル名（＝レポート内のブックラベル）。
//                  例: FILE_RELATIONS="売上データ>中間集計シート:aggregate:日次を月次へ集約"
//                  UI を立てずに 01 の突き合わせ表と 02 の「担当者の説明」を確認するために使う。
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { analyzeArtifacts, fileLabelOf } from '../src/preprocess/relations.js';
import { buildRelationsReportHtml } from '../src/relationsReport.js';
import {
  applyDeclaredFileRelations, FILE_REL_TYPES, type DeclaredFileRel, type FileRelType,
} from '../src/relations/declared.js';

const [out, ...inputs] = process.argv.slice(2);
if (!out || inputs.length === 0) {
  console.error('usage: npx tsx scripts/gen-relations-report.ts <out.html> <file...>');
  process.exit(1);
}

// storage 上のファイル名は「<timestamp>-<元の名前>」。本番は artifacts.original_filename（元の名前）を
// 渡すので、ここでも接頭辞を落として合わせる。外部通合文書参照の解決は参照先ファイル名で
// 突き合わせるため、接頭辞が付いたままだと本番と違ってリンクが解決できない。
const originalName = (p: string) => basename(p).replace(/^\d{10,}-/, '');

const baseGraph = await analyzeArtifacts(
  inputs.map(p => ({ filename: originalName(p), load: async () => readFileSync(p) })),
);

/** FILE_RELATIONS を DeclaredFileRel[] へ解釈する（不正な指定はその場で止める＝黙って無視しない） */
function parseDeclared(spec: string): DeclaredFileRel[] {
  return spec.split(',').map(s => s.trim()).filter(Boolean).map((entry, i) => {
    const m = /^([^>]+)>([^:]+)(?::([^:]*))?(?::(.*))?$/.exec(entry);
    if (!m) throw new Error(`FILE_RELATIONS の書式が不正です: ${entry}（元>先:種別:説明）`);
    const relType = (m[3] || 'unknown') as FileRelType;
    if (!FILE_REL_TYPES.includes(relType)) {
      throw new Error(`FILE_RELATIONS の種別が不正です: ${relType}（${FILE_REL_TYPES.join(' / ')}）`);
    }
    return {
      id: i + 1,
      fromFile: fileLabelOf(m[1].trim()),
      toFile: fileLabelOf(m[2].trim()),
      relType,
      note: (m[4] ?? '').trim(),
      origin: 'manual' as const,
    };
  });
}

const declared = parseDeclared(process.env.FILE_RELATIONS ?? '');
const graph = applyDeclaredFileRelations(baseGraph, declared);

// 最終アウトプット（取込時の kind=final_output 相当）は FINAL_OUTPUTS にファイル名をカンマ区切りで渡す
const finals = new Set((process.env.FINAL_OUTPUTS ?? '').split(',').map(s => s.trim()).filter(Boolean));
const html = buildRelationsReportHtml({
  customerName: process.env.CUSTOMER ?? 'サンプル',
  generatedAt: new Date(),
  fileCount: inputs.length,
  graph,
  artifacts: inputs.map(p => ({
    filename: basename(p),
    kind: finals.has(basename(p)) ? 'final_output' : 'input_data',
  })),
  declaredFileRels: graph.declaredFileRels,
  fileRelAudit: graph.fileRelAudit,
});
writeFileSync(out, html, 'utf8');
console.log(`${out} (${html.length} bytes) / regions=${graph.regions.length}`
  + ` edges=${graph.edgeTotal ?? graph.edges.length} declared=${declared.length}`
  + ` audit=${graph.fileRelAudit.map(a => a.verdict).join(',') || 'none'}`);

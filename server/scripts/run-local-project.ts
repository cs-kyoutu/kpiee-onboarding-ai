// 実ファイル群を、本番の取込経路と同じ順序でローカル実行してレポートまで作る検証ハーネス。
//
// 本番の流れ:
//   ① 取込   parseArtifact → classifySheetRoles でシート役割を自動判定し sheet_roles に保存
//   ②（人が分類確認画面で役割を直す。ここは FINAL_SHEETS で再現する）
//   ③ 解析   analyzeArtifacts（ファイル1つずつ。ピークメモリを最大単一ファイルに抑える）
//   ④ 出力   buildRelationsReportHtml（AI は使わない。決定的に組み立てる）
//
// 使い方:
//   npx tsx --max-old-space-size=8192 scripts/run-local-project.ts <出力.html> <入力ファイル...>
// 環境変数:
//   CUSTOMER      宛名
//   FINAL_SHEETS  「最終帳票」として指定するシート名（カンマ区切り）。分類確認で人が直した状態を再現する
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parseArtifact } from '../src/preprocess/parse.js';
import { classifySheetRoles } from '../src/preprocess/classify.js';
import { analyzeArtifacts, type RelationInput } from '../src/preprocess/relations.js';
import { buildRelationsReportHtml, type ReportArtifact } from '../src/relationsReport.js';

const [out, ...inputs] = process.argv.slice(2);
if (!out || inputs.length === 0) {
  console.error('usage: npx tsx scripts/run-local-project.ts <out.html> <file...>');
  process.exit(1);
}
const finalSheets = new Set((process.env.FINAL_SHEETS ?? '').split(',').map(s => s.trim()).filter(Boolean));
const log = (s: string) => process.stdout.write(`${new Date().toISOString().slice(11, 19)}  ${s}\n`);
const mb = () => `${Math.round(process.memoryUsage().rss / 1048576)}MB`;

// ---- ① 取込相当: シート役割の自動判定 ----
log(`取込: ${inputs.length} ファイル`);
const artifacts: ReportArtifact[] = [];
for (const p of inputs) {
  const name = basename(p);
  const t = Date.now();
  try {
    const parsed = await parseArtifact(name, readFileSync(p));
    const cls = classifySheetRoles(parsed);
    const roles: Record<string, string> = {};
    for (const [sheet, c] of Object.entries(cls)) {
      // ② 分類確認で人が「最終帳票」に直した状態を再現する
      roles[sheet] = finalSheets.has(sheet) ? 'final_output' : c.role;
    }
    artifacts.push({ filename: name, kind: 'mixed', sheetRoles: roles });
    const marked = Object.entries(roles).filter(([, r]) => r === 'final_output').map(([s]) => s);
    log(`  ${name}  ${parsed.sheets.length}シート  ${((Date.now() - t) / 1000).toFixed(1)}s  rss=${mb()}`
      + (marked.length > 0 ? `  最終帳票: ${marked.join('、')}` : ''));
  } catch (e) {
    log(`  ${name}  取込失敗: ${String(e).slice(0, 120)}`);
    artifacts.push({ filename: name, kind: 'mixed' });
  }
}

// ---- ③ 関係解析 ----
log('関係解析（ファイル1つずつ）…');
const t0 = Date.now();
const arts: RelationInput[] = inputs.map(p => ({
  filename: basename(p), load: async () => readFileSync(p),
}));
const graph = await analyzeArtifacts(arts);
log(`解析完了 ${((Date.now() - t0) / 1000).toFixed(1)}s  表${graph.regions.length} 辺${graph.edges.length} rss=${mb()}`);

// ---- ④ レポート ----
const html = buildRelationsReportHtml({
  customerName: process.env.CUSTOMER ?? 'ローカル検証',
  generatedAt: new Date(),
  fileCount: inputs.length,
  graph,
  artifacts,
});
writeFileSync(out, html, 'utf8');
log(`レポート: ${out} (${Math.round(html.length / 1024)}KB)`);

// ---- 要点だけ標準出力にも出す ----
const txt = html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, '|')
  .replace(/\|+/g, '|');
const pick = (re: RegExp) => (re.exec(txt) ?? [])[0]?.replace(/\|/g, ' ').replace(/\s+/g, ' ').trim() ?? '(なし)';
console.log('\n=== 最終アウトプットの判定 ===');
console.log('  ' + pick(/最終アウトプットは[\s\S]{0,180}/));
console.log('\n=== ご確認いただきたい点 ===');
for (const m of txt.matchAll(/(Q-\d\d)\|優先度 (高|中)\|([^|]+)\|([^|]{0,110})/g)) {
  console.log(`  ${m[1]} [${m[2]}/${m[3]}] ${m[4].trim().slice(0, 95)}`);
}
console.log('\n=== ファイル役割 ===');
for (const m of txt.matchAll(/([^|]+\.xlsx)\|(\d+)\|(\d+)\|([\d,]+)\|[^|]*\|?(最終アウトプット|中間ファイル|元データ|独立)/g)) {
  console.log(`  ${m[5].padEnd(8)} ${m[1].trim().slice(0, 46)}  ${m[2]}シート ${m[3]}表 ${m[4]}行`);
}

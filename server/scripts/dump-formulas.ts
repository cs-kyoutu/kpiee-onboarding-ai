// 指定シート・指定列の数式サンプルを実ファイルから取り出す検証スクリプト。
// 使い方: npx tsx scripts/dump-formulas.ts "<xlsx>" "<シート名>" AO,AP,AQ,A,CC
import { readFileSync } from 'node:fs';
import { buildGridsFromBuffer, colLetter } from '../src/preprocess/relations.js';

const [, , path, sheetName, colsArg] = process.argv;
const wantCols = (colsArg ?? '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const colNum = (s: string) => { let n = 0; for (const ch of s.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64); return n; };
const wantNums = new Set(wantCols.map(colNum));

const grids = await buildGridsFromBuffer(readFileSync(path), 'f');
const g = grids.find(x => x.name === sheetName);
if (!g) { console.log('시트 없음. 사용 가능:', grids.map(x => x.name).join(' / ')); process.exit(0); }

for (const cn of [...wantNums].sort((a, b) => a - b)) {
  const cells = g.cells.filter(c => c.c === cn && c.formula).sort((a, b) => a.r - b.r);
  const noFormula = g.cells.filter(c => c.c === cn && !c.formula);
  console.log(`\n=== ${colLetter(cn)}列 (수식셀 ${cells.length}개 / 값만 ${noFormula.length}개) ===`);
  // 先頭ヘッダ候補（最初の数行の値）
  const head = g.cells.filter(c => c.c === cn && c.r <= 3).sort((a, b) => a.r - b.r).map(c => `r${c.r}:${JSON.stringify(c.value)}`);
  console.log('  상단:', head.join('  '));
  // 数式サンプル（重複パターンを除いて最大5種）
  const seen = new Set<string>(); let shown = 0;
  for (const c of cells) {
    const pat = (c.formula ?? '').replace(/\d+/g, '#');
    if (seen.has(pat)) continue; seen.add(pat);
    console.log(`  r${c.r}: =${c.formula}`);
    if (++shown >= 5) break;
  }
}

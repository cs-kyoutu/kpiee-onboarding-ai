// 業務資料の取り込み（本文抽出）の検証。
// txt / md / docx / pdf を実際に通し、AI へ渡す <reference_docs> ブロックまで作れるか確かめる。
import { readFileSync, existsSync } from 'node:fs';
import { extractDocText } from '../src/projectDocs.js';

const cases: { name: string; buf: Buffer; expectText: boolean }[] = [];

// テキスト（BOM 付き。Windows 保存の資料でよくある）
cases.push({
  name: '手順書.md',
  buf: Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(
    '# 局データの変換\n\n末尾0の組織は「局管理」の課組織に読み替える\n例外：9970はそのままで、読み替えしない\n', 'utf8')]),
  expectText: true,
});

// 実物の PDF（あれば）
const pdf = 'C:/Users/seongjin.park/Downloads/KPIEE オンボーディング AI.pdf';
if (existsSync(pdf)) cases.push({ name: 'KPIEE オンボーディング AI.pdf', buf: readFileSync(pdf), expectText: true });

// 非対応形式は「失敗として保存」される（黙って空にしない）
cases.push({ name: '写真.png', buf: Buffer.from([0x89, 0x50, 0x4E, 0x47]), expectText: false });

let ok = true;
for (const c of cases) {
  const r = await extractDocText(c.name, c.buf);
  const got = r.content.trim().length > 0;
  const pass = got === c.expectText && (c.expectText ? r.error === null : r.error !== null);
  if (!pass) ok = false;
  console.log(`${pass ? '  OK ' : '  NG '} ${c.name.padEnd(30)} 本文 ${String(r.content.length).padStart(6)} 字`
    + (r.error ? `  error: ${r.error.slice(0, 50)}` : ''));
  if (got) console.log(`        冒頭: ${r.content.replace(/\s+/g, ' ').slice(0, 70)}`);
}

// BOM が落ちているか（残っていると先頭の見出しが化ける）
const md = await extractDocText('a.md', Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('# 見出し', 'utf8')]));
const bomOk = md.content.startsWith('# ');
console.log(`${bomOk ? '  OK ' : '  NG '} BOM を除去して読む`);
if (!bomOk) ok = false;

process.exit(ok ? 0 : 1);

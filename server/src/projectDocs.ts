// 業務資料（要件定義書・運用手順書・引継ぎメモ等）の取り込みと本文抽出。
//
// なぜ artifacts（xlsx/csv）と分けるか:
//   資料は「データ」ではなく「データがどう作られるか」を書いた文書で、表構造を持たない。
//   関係分析やシート役割判定へ混ぜると判定を汚すだけなので、置き場所から分ける。
//   一方で中身は AI の解読・提案の前提として効かせたい（数式からは読み取れない業務ルール、
//   例:「末尾0の組織は局管理の課組織に読み替える。ただし 9970 は読み替えない」が書かれている）。
//
// 抽出できない形式は、失敗として保存して画面に出す。黙って空で保存すると
// 「資料を入れたのに何も変わらない」という分からない状態になる。
import JSZip from 'jszip';
import { db } from './db.js';

export interface ProjectDoc {
  id: number;
  filename: string;
  content: string;
  extract_error: string | null;
  byte_size: number;
  created_at: string;
}

/** 本文をそのまま持つテキスト形式 */
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|ya?ml|log)$/i;

/** BOM を落として UTF-8 として読む。Windows で保存された資料は BOM 付きのことが多い */
const asUtf8 = (b: Buffer): string => b.toString('utf8').replace(/^﻿/, '');

/** docx（zip 内の word/document.xml）から本文を抜く。段落・改行タグを改行へ写す */
async function extractDocx(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const parts = Object.keys(zip.files)
    .filter(n => /^word\/(document|header\d*|footer\d*)\.xml$/.test(n))
    .sort();
  let out = '';
  for (const p of parts) {
    const xml = await zip.file(p)!.async('string');
    out += xml
      .replace(/<w:br\b[^>]*\/?>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
      + '\n';
  }
  return out;
}

/** pdf からテキストを抜く。pdf-parse v2 は PDFParse クラス経由 */
async function extractPdf(buffer: Buffer): Promise<string> {
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    return (await parser.getText()).text;
  } finally {
    await parser.destroy();
  }
}

/** 空行の潰し込みと長さの上限。AI へ渡す前提なので青天井にはしない */
const MAX_CHARS = 200_000;
const tidy = (s: string): string => {
  const t = s.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return t.length > MAX_CHARS ? `${t.slice(0, MAX_CHARS)}\n…（以下省略）` : t;
};

/** ファイルから本文を抽出する。抽出できない形式は error を返す（例外にしない） */
export async function extractDocText(
  filename: string, buffer: Buffer,
): Promise<{ content: string; error: string | null }> {
  try {
    if (TEXT_EXT.test(filename)) return { content: tidy(asUtf8(buffer)), error: null };
    if (/\.docx$/i.test(filename)) return { content: tidy(await extractDocx(buffer)), error: null };
    if (/\.pdf$/i.test(filename)) return { content: tidy(await extractPdf(buffer)), error: null };
    return {
      content: '',
      error: `本文を取り出せない形式です（対応: txt / md / csv / json / yaml / docx / pdf）。`
        + `テキストに変換してから入れてください。`,
    };
  } catch (e) {
    return { content: '', error: `本文の取り出しに失敗しました: ${String(e).slice(0, 200)}` };
  }
}

export async function addProjectDoc(
  projectId: number, filename: string, buffer: Buffer,
): Promise<number> {
  const { content, error } = await extractDocText(filename, buffer);
  const row = await db.prepare(
    `INSERT INTO project_docs (project_id, filename, content, extract_error, byte_size)
     VALUES (?, ?, ?, ?, ?) RETURNING id`,
  ).get(projectId, filename, content, error, buffer.length) as { id: number };
  return row.id;
}

export async function listProjectDocs(projectId: number): Promise<ProjectDoc[]> {
  return await db.prepare(
    `SELECT id, filename, content, extract_error, byte_size, created_at
       FROM project_docs WHERE project_id = ? ORDER BY id`,
  ).all(projectId) as ProjectDoc[];
}

export async function deleteProjectDoc(id: number): Promise<void> {
  await db.prepare(`DELETE FROM project_docs WHERE id = ?`).run(id);
}

/**
 * AI プロンプトへ差し込む資料ブロック。scriptsBlock（Apps Script 原文）と同じ考え方で、
 * 「数式からは読み取れない前提」を解読の材料として渡す。資料が無ければ空文字。
 */
export async function docsBlock(projectId: number): Promise<string> {
  const docs = (await listProjectDocs(projectId)).filter(d => d.content.trim() !== '');
  if (docs.length === 0) return '';
  const body = docs.map(d => `<doc name="${d.filename}">\n${d.content}\n</doc>`).join('\n');
  return `\n\n<reference_docs>\n`
    + `顧客からいただいた業務資料（要件定義書・運用手順書等）です。数式には現れない業務ルール\n`
    + `（読み替え・例外・手作業の手順）が書かれていることがあります。解読の前提として使ってください。\n`
    + `${body}\n</reference_docs>`;
}

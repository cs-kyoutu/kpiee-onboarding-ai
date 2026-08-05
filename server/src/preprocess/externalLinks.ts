// xlsx の「外部通合文書参照」を実ファイルへ解決するための索引。
//
// 業務のブックは、ファイルをまたぐ集計を外部参照で書く（数式に `[1]` のような番号が入る）:
//   =SUM([1]top:end!E6)          ← 別ブックのシート範囲 top〜end の E6 を合計
//   ='[2]FY 介護事業'!C10        ← 別ブックの単一シート
//   ='C:\...\[book.xlsx]Sheet'!A1 ← リンクが解決されていない絶対パス形式
//
// relations.ts は長らくこの `[n]` を解釈できず、数式参照は「同一ファイル内で解決する」前提で
// 動いていた。そのためファイル間の流れが1本も検出されず（＝全ファイルが「独立」）、さらに
// 悪いことに `[1]` とシート名が脱落した残骸（上記 `E6`）が自シート参照として解決され、
// 実在しない自ファイル内の辺が確信度 0.95 で作られていた。ここはその前提を外すための土台。
//
// `[n]` の n は workbook.xml の <externalReferences> の並び順（1始まり）。r:id →
// workbook.xml.rels → externalLinks/externalLinkN.xml と辿るのが正しい対応で、n と N は
// 必ずしも一致しない（実測では一致していたが、規約上の保証はない）。
import JSZip from 'jszip';

export interface ExternalBook {
  /** 数式中の `[n]` の n（1始まり） */
  index: number;
  /** 参照先ファイル名（ベース名）。参照先パスは作成者PCの絶対パスなのでベース名で突き合わせる */
  filename: string;
  /**
   * 参照先ブックのシート名（記録順）。`top:end` のようなシート範囲を展開するのに使う。
   * xlsx にキャッシュされたこの並びは参照先ブックの実シート順と一致する（project-23 の実データ
   * 5ブックすべてで完全一致を確認済み）。
   */
  sheetNames: string[];
}

const attr = (s: string, name: string): string | undefined =>
  (new RegExp(`${name}="([^"]*)"`).exec(s) ?? [])[1];

/** パス（`file:///C:\dir\book.xlsx` / `../book.xlsx` 等）からファイル名だけを取り出す */
export function basenameOf(target: string): string {
  let t = target;
  try { t = decodeURIComponent(t); } catch { /* 不正なエスケープはそのまま扱う */ }
  return t.split(/[\\/]/).pop() ?? t;
}

/**
 * xlsx バッファから外部通合文書の索引を読む。
 * 外部参照が無いブック・zip として開けないブックでは空配列を返す（呼び出し側は解決失敗として扱う）。
 */
export async function readExternalBooks(buffer: Buffer): Promise<ExternalBook[]> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    return []; // xlsx でない・壊れている等。関係分析自体は他経路で続行する
  }
  const read = async (path: string): Promise<string | null> => {
    const f = zip.file(path);
    return f ? f.async('string') : null;
  };

  const wbXml = await read('xl/workbook.xml');
  if (!wbXml) return [];
  const block = /<externalReferences[\s\S]*?<\/externalReferences>/.exec(wbXml);
  if (!block) return [];
  const rIds = [...block[0].matchAll(/r:id="([^"]+)"/g)].map(m => m[1]);
  if (rIds.length === 0) return [];

  const relsXml = await read('xl/_rels/workbook.xml.rels');
  if (!relsXml) return [];
  const partOf = new Map<string, string>();
  for (const m of relsXml.matchAll(/<Relationship\b([^>]*)>/g)) {
    const id = attr(m[1], 'Id');
    const target = attr(m[1], 'Target');
    if (id && target) partOf.set(id, target);
  }

  const books: ExternalBook[] = [];
  for (let i = 0; i < rIds.length; i++) {
    const target = partOf.get(rIds[i]);
    if (!target) continue;
    // Target は "externalLinks/externalLink1.xml"（xl/ 相対）または "/xl/externalLinks/..."（絶対）
    const part = target.startsWith('/') ? target.replace(/^\//, '') : `xl/${target}`;
    const n = (/externalLink(\d+)\.xml/.exec(part) ?? [])[1];
    if (!n) continue;

    const linkRels = await read(`xl/externalLinks/_rels/externalLink${n}.xml.rels`);
    const linkTarget = linkRels ? attr(linkRels, 'Target') : undefined;
    if (!linkTarget) continue;

    const linkXml = await read(part);
    const sheetNames = linkXml
      ? [...linkXml.matchAll(/<sheetName val="([^"]*)"/g)].map(m => m[1])
      : [];

    books.push({ index: i + 1, filename: basenameOf(linkTarget), sheetNames });
  }
  return books;
}

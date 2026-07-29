// シートを「行チャンク単位」で受け取りながら蓄積する器。
//
// なぜ必要か（2026-07-28 の OOM 事故）:
//   基幹システム出力の Google シート（実測: 78,942 行 × 99 列 = 780万セル、数式 0 個）を
//   従来経路（全シート一括 batchGet → ExcelJS 組み立て → xlsx 直列化 → 再パース）に流すと、
//   同じデータの表現を同時に何벌も抱えて 4GB ヒープでも OOM しプロセスが死ぬ。
//   実測: batchGet 2回で rss 1,170MB / ExcelJS 組み立てで 2,540MB / xlsx 直列化で OOM。
//   原因はデータ量ではなく表現方式で、セル1個を JS オブジェクト1個＋一意な参照文字列にすると
//   実測 87 バイト/セル かかる（値そのものは 10〜20 バイト）。780万セルで表現1벌が約 680MB。
//
// 方針（必要なものだけ残し、チャンクは捨てる）:
//   - 数式セル … 全量保持。これがこのアプリの成果物そのもので、かつ疎なので安い。
//   - データ行 … ヘッダー HEADER_ROWS 行＋先頭 SAMPLE_ROWS 行だけ保持。
//                AI は shape.ts の DATA_SHEET_CAPS で 9 行しか見ず、プレビューは 100 行しか出さない。
//   - 残り     … オブジェクト化せず「列統計」と「行数」に畳む。型推定・キー推定・手修正検出の材料は
//                全行を通して数えるので、絞っても判定材料は失われない。
//
// これでピークメモリが「チャンク1個分」に固定され、行数に依存しなくなる。
// また、チャンク間で必ず await（ネットワーク往復）が入るためイベントループが自然に解放され、
// 取り込み中も /healthz が応答できる（ワーカーを使わずに ALB ヘルスチェック落ちを避けられる）。
import {
  columnLetter, compressFormulaRows, MANUAL_REF_CAP, UNIQ_CAP,
  type ParsedCell, type ParsedColumnStat, type ParsedRow, type ParsedSheet,
} from './parse.js';

/** 蓄積中のセル（参照文字列を持たない = ParsedCell より軽い）。RawGrid の RawCell と構造互換 */
export interface AccumCell { r: number; c: number; value: string | number | null; formula?: string }

/** 絞り込みの方針値 */
export interface AccumPolicy {
  /** この行数を超えたら絞り込みに入る。これ以下は従来どおり全行保持 */
  rowLimit: number;
  /** 絞り込み時に残すデータ行数（プレビューの 100 行に合わせる） */
  sampleRows: number;
  /** 常に残す先頭行数（ヘッダー） */
  headerRows: number;
  /** 保持行の絶対上限。数式が密な巨大シートでも破綻しないための安全弁 */
  hardCap: number;
}

export const DEFAULT_POLICY: AccumPolicy = { rowLimit: 3000, sampleRows: 100, headerRows: 3, hardCap: 20_000 };

/** Sheets API の生値を JSON 化可能なプリミティブへ正規化する */
function norm(x: unknown): string | number | null {
  if (x === null || x === undefined || x === '') return null;
  if (typeof x === 'number') return x;
  if (typeof x === 'boolean') return x ? 1 : 0;
  return String(x);
}

/**
 * FORMULA レンダリングと UNFORMATTED_VALUE レンダリングの同一セルから、値と数式を取り出す。
 * FORMULA 側が "=" 始まりなら数式セル（Google ネイティブ原文。__xludf 包装は無い）。
 */
function cellOf(f: unknown, v: unknown): { value: string | number | null; formula?: string } {
  if (typeof f === 'string' && f.startsWith('=')) return { value: norm(v), formula: f.slice(1) };
  return { value: norm(v === null || v === undefined || v === '' ? f : v) };
}

/** 保持対象として抱えている1行 */
interface KeptRow { rowNumber: number; hasFormula: boolean; cells: AccumCell[] }

export class SheetAccumulator {
  private readonly policy: AccumPolicy;
  private kept: KeptRow[] = [];
  private stats = new Map<number, ParsedColumnStat>();
  /** 一意値の計数用。UNIQ_CAP に達した列は Set を捨てて数えるのを止める */
  private uniqSets = new Map<number, Set<string> | null>();
  private headerNames: string[] = [];
  private truncating = false;
  private droppedFormulaRows = 0;
  private totalRows = 0;
  private maxCol = 0;
  private formulaCellCount = 0;

  constructor(public readonly name: string, policy: Partial<AccumPolicy> = {}) {
    this.policy = { ...DEFAULT_POLICY, ...policy };
  }

  /** 絞り込みに入ったか（呼び出し側が「もう全行は要らない」と判断する材料にもなる） */
  get isTruncating(): boolean { return this.truncating; }

  /**
   * 1チャンク投入する。fRows / vRows は同じ矩形の行×列配列（Sheets API の values 形式）。
   * startRow は 0 始まりのチャンク開始行（シート先頭からのオフセット）。
   */
  push(startRow: number, fRows: unknown[][], vRows: unknown[][]): void {
    const n = Math.max(fRows.length, vRows.length);
    for (let i = 0; i < n; i++) {
      const rowNumber = startRow + i + 1; // 1 始まり
      const fRow = fRows[i] ?? [];
      const vRow = vRows[i] ?? [];
      const width = Math.max(fRow.length, vRow.length);
      if (width === 0) continue; // 完全な空行は従来経路（includeEmpty:false）と同様に飛ばす
      if (width > this.maxCol) this.maxCol = width;
      if (rowNumber > this.totalRows) this.totalRows = rowNumber;
      if (rowNumber === 1) this.captureHeader(fRow, vRow, width);

      // 先にセルを組み立てて統計を採る。ここで作る AccumCell は「保持しない行」では即捨てられる。
      const cells: AccumCell[] = [];
      let hasFormula = false;
      for (let c = 0; c < width; c++) {
        const { value, formula } = cellOf(fRow[c], vRow[c]);
        if (value === null && formula === undefined) continue;
        if (formula !== undefined) { hasFormula = true; this.formulaCellCount++; }
        this.bump(c + 1, rowNumber, value, formula);
        cells.push(formula === undefined ? { r: rowNumber, c: c + 1, value } : { r: rowNumber, c: c + 1, value, formula });
      }
      if (cells.length === 0) continue;
      if (this.shouldKeep(rowNumber, hasFormula)) this.kept.push({ rowNumber, hasFormula, cells });
      else if (hasFormula) this.droppedFormulaRows++;
      // 全行保持のまま上限を越えたら、ここで絞り込みへ切り替えて既存分を間引く
      if (!this.truncating && this.kept.length > this.policy.rowLimit) this.enterTruncating();
    }
  }

  /** 保持すべき行か。絞り込み前は全部、絞り込み後はヘッダー・標本・数式行だけ */
  private shouldKeep(rowNumber: number, hasFormula: boolean): boolean {
    if (!this.truncating) return true;
    if (this.kept.length >= this.policy.hardCap) return false;
    if (rowNumber <= this.policy.headerRows) return true;
    if (hasFormula) return true;
    return this.countKeptDataRows() < this.policy.sampleRows;
  }

  /** ヘッダー行を除いた保持済みデータ行数（数式行は標本枠を消費しない） */
  private countKeptDataRows(): number {
    let n = 0;
    for (const k of this.kept) if (k.rowNumber > this.policy.headerRows && !k.hasFormula) n++;
    return n;
  }

  /** 絞り込みへ切り替え、既に抱えている行をヘッダー＋標本＋数式行だけに間引く */
  private enterTruncating(): void {
    this.truncating = true;
    const trimmed: KeptRow[] = [];
    let dataRows = 0;
    for (const k of this.kept) {
      if (k.rowNumber <= this.policy.headerRows || k.hasFormula) { trimmed.push(k); continue; }
      if (dataRows < this.policy.sampleRows) { trimmed.push(k); dataRows++; }
    }
    this.kept = trimmed;
  }

  /** 1行目をヘッダー名として控える（列統計の名前に使う） */
  private captureHeader(fRow: unknown[], vRow: unknown[], width: number): void {
    for (let c = 0; c < width; c++) {
      const { value } = cellOf(fRow[c], vRow[c]);
      this.headerNames[c] = value === null ? '' : String(value);
    }
  }

  /** 列統計を1セル分進める。オブジェクトを作らずに数えるのがここの要点 */
  private bump(c: number, rowNumber: number, value: string | number | null, formula: string | undefined): void {
    let s = this.stats.get(c);
    if (!s) {
      const name = this.headerNames[c - 1];
      s = {
        c, name: name && name.trim() ? name : columnLetter(c),
        filled: 0, numeric: 0, text: 0, formulaCells: 0,
        manualNumeric: 0, manualNumericRefs: [], uniq: 0, uniqCapped: false,
      };
      this.stats.set(c, s);
      this.uniqSets.set(c, new Set());
    }
    if (value !== null) {
      s.filled++;
      if (typeof value === 'number') s.numeric++; else s.text++;
      const set = this.uniqSets.get(c);
      if (set) {
        set.add(typeof value === 'number' ? `n${value}` : `s${value}`);
        if (set.size >= UNIQ_CAP) { s.uniq = set.size; s.uniqCapped = true; this.uniqSets.set(c, null); }
        else s.uniq = set.size;
      }
    }
    if (formula !== undefined) { s.formulaCells++; return; }
    // 手修正（数式列への手入力上書き）候補。ヘッダー行は対象外。
    // ここで数える manualNumeric は「数式なしの数値セル」で、relations.ts の同名判定と同じ材料。
    if (typeof value === 'number' && rowNumber > 1) {
      s.manualNumeric++;
      if (s.manualNumericRefs.length < MANUAL_REF_CAP) s.manualNumericRefs.push(`${columnLetter(c)}${rowNumber}`);
    }
  }

  private columnStats(): ParsedColumnStat[] {
    return [...this.stats.values()].sort((a, b) => a.c - b.c);
  }

  private truncation(keptRows: number) {
    if (!this.truncating) return undefined;
    const dropped = this.droppedFormulaRows > 0
      ? `数式行 ${this.droppedFormulaRows} 行は保持上限(${this.policy.hardCap})超過で省略。` : '';
    return {
      totalRows: this.totalRows,
      keptRows,
      reason: `全 ${this.totalRows} 行のうちヘッダー ${this.policy.headerRows} 行＋標本 ${this.policy.sampleRows} 行`
        + `＋数式を含む行のみ保持。残りは列統計に集約（値は失っていない=総数・型・手修正候補は全行から算出）。${dropped}`,
    };
  }

  /** 取り込み用の ParsedSheet にする（数式行の圧縮は従来経路と同じ扱いに揃える） */
  finishParsed(merges: string[]): ParsedSheet {
    const rows: ParsedRow[] = this.kept.map(k => ({
      rowNumber: k.rowNumber,
      cells: k.cells.map(c => {
        const cell: ParsedCell = { ref: `${columnLetter(c.c)}${c.r}`, value: c.value };
        if (c.formula !== undefined) cell.formula = c.formula;
        return cell;
      }),
    }));
    const compressed = compressFormulaRows(rows);
    return {
      name: this.name,
      rowCount: this.totalRows,
      columnCount: this.maxCol,
      formulaCellCount: this.formulaCellCount,
      merges,
      rows: compressed,
      ...(this.truncating ? { truncated: this.truncation(compressed.length)! } : {}),
      columnStats: this.columnStats(),
    };
  }

  /**
   * 関係分析用の生格子にする。領域検出は行圧縮しない格子を要求するので圧縮しない。
   * maxR は「実際に保持している最大行」。総行数は totalRows で別に返し、
   * 呼び出し側が Region.dataRowCount を実際の総計へ補正できるようにする。
   */
  finishGrid(): { cells: AccumCell[]; maxR: number; maxC: number; totalRows: number; truncated: boolean; columnStats: ParsedColumnStat[] } {
    const cells: AccumCell[] = [];
    let maxR = 0;
    for (const k of this.kept) {
      cells.push(...k.cells);
      if (k.rowNumber > maxR) maxR = k.rowNumber;
    }
    return { cells, maxR, maxC: this.maxCol, totalRows: this.totalRows, truncated: this.truncating, columnStats: this.columnStats() };
  }
}

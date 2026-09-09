// 数値照合エンジン（設計書 §6.5）。
// Phase 1 は KPIEE 非接続のため、生成された SQL を DuckDB 上でローカル実行（シミュレーション）し、
// 顧客の最終帳票とセル単位で突き合わせる。
import { DuckDBInstance } from '@duckdb/node-api';
import type { ParsedArtifact } from '../preprocess/parse.js';
import { mockClassifyCause } from '../ai/mock.js';

export interface Mismatch {
  cell_ref: string;
  row_label: string;
  column: string;
  expected: number;
  actual: number | null;
  cause_category: string;
  explanation: string;
}

export interface MatchOutcome {
  totalCells: number;
  matchedCells: number;
  mismatches: Mismatch[];
}

/** SQL 文字列リテラル用エスケープ */
function q(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

/** DuckDB の戻り値（BigInt / Decimal 等）を JS number へ正規化する */
function toNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string') {
    const n = Number(v);
    return isNaN(n) ? null : n;
  }
  // DuckDBDecimalValue 等は toString 経由で数値化する
  const n = Number(String(v));
  return isNaN(n) ? null : n;
}

/**
 * ヘッダー名を CREATE TABLE で使える形に正規化する。
 * 空文字は列位置（col1, col2, …）で補い、重複は「売上_2」式の連番接尾辞で一意化する。
 * ヘッダーが数式のみ・タイトル行混入・同名列などの実務ファイルでも
 * 「Column with name X already exists」で照合全体が落ちないようにする防波堤。
 */
function uniquifyHeader(names: string[]): string[] {
  const used = new Map<string, number>();
  return names.map((raw, i) => {
    const base = raw.trim() !== '' ? raw.trim() : `col${i + 1}`;
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    return n === 0 ? base : `${base}_${n + 1}`;
  });
}

/** 解析済みアーティファクトの先頭シートをヘッダー＋データ行列へ変換する */
function toGrid(parsed: ParsedArtifact): { header: string[]; data: (string | number | null)[][] } {
  const sheet = parsed.sheets[0];
  const colIdx = (ref: string): number => {
    const letters = ref.replace(/\d+/g, '');
    let n = 0;
    for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  };
  const header = uniquifyHeader((sheet.rows[0]?.cells ?? []).map(c => String(c.value ?? '')));
  const data = sheet.rows.slice(1).map(r => {
    const arr: (string | number | null)[] = new Array(header.length).fill(null);
    for (const c of r.cells) {
      const i = colIdx(c.ref);
      if (i < header.length) arr[i] = c.value;
    }
    return arr;
  });
  return { header, data };
}

/**
 * Snowflake 方言の最小ポリフィル。
 *
 * 本番の SQLジョブは Snowflake で動くが、ローカル検証は DuckDB。
 * ナレッジ（kpiee-sql-builder）が必ず使わせる関数（TRY_TO_DECIMAL 等）が DuckDB に無く、
 * そのままだと「正しい SQL がローカルでだけ落ちる」状態になるため、意味の等しいマクロで埋める。
 * 埋めるのは決定的に等価にできるものだけ。挙動が違う関数は埋めない（黙って違う結果を出すより
 * エラーで気づけるほうがよい）。
 */
const SNOWFLAKE_POLYFILLS: string[] = [
  // 金額・率の数値化。TRY_TO_NUMBER の既定 scale=0（小数切り捨て）も Snowflake に合わせる
  `CREATE MACRO TRY_TO_DECIMAL(x, p, s) AS TRY_CAST(REPLACE(REPLACE(TRIM(CAST(x AS VARCHAR)), ',', ''), '¥', '') AS DECIMAL(38, 10))`,
  `CREATE MACRO TRY_TO_NUMBER(x) AS TRY_CAST(TRY_CAST(REPLACE(REPLACE(TRIM(CAST(x AS VARCHAR)), ',', ''), '¥', '') AS DECIMAL(38, 10)) AS BIGINT)`,
  // 日付は書式明示の2引数版のみ（1引数版はナレッジ側が禁止している。ここでも用意しない）
  `CREATE MACRO TRY_TO_DATE(x, fmt) AS TRY_CAST(try_strptime(CAST(x AS VARCHAR),
     REPLACE(REPLACE(REPLACE(REPLACE(fmt, 'YYYY', '%Y'), 'MM', '%m'), 'DD', '%d'), 'HH24:MI:SS', '%H:%M:%S')) AS DATE)`,
  `CREATE MACRO IFF(c, a, b) AS (CASE WHEN c THEN a ELSE b END)`,
  `CREATE MACRO NVL(a, b) AS COALESCE(a, b)`,
  `CREATE MACRO ZEROIFNULL(x) AS COALESCE(x, 0)`,
  `CREATE MACRO DIV0(a, b) AS (CASE WHEN b = 0 OR b IS NULL THEN 0 ELSE a / b END)`,
];

/** ポリフィルを登録する。DuckDB 側に同名が既にあるものは黙って飛ばす */
async function installPolyfills(conn: { run(sql: string): Promise<unknown> }): Promise<void> {
  for (const ddl of SNOWFLAKE_POLYFILLS) {
    try {
      await conn.run(ddl);
    } catch { /* 既存の組み込みと衝突したら組み込み側を使う */ }
  }
}

/**
 * SQL のローカル実行サンドボックス。
 *
 * インプットデータを DuckDB のテーブルとして一度だけ登録し、複数の SQL を続けて流せる。
 * SQL構築チャットは1回の質問処理で「事前検証 → 本体 → 検算」と何本も実行するため、
 * 毎回テーブルを作り直すと大きな取込データで待ち時間が実行本数ぶん倍になる。
 */
export class SqlSandbox {
  private constructor(
    private readonly instance: DuckDBInstance,
    private readonly conn: Awaited<ReturnType<DuckDBInstance['connect']>>,
    /** 登録できたテーブル（名前と列。AI へ「何が FROM に書けるか」を示すために持つ） */
    readonly tables: { name: string; columns: string[]; rowCount: number }[],
  ) {}

  static async create(inputs: { tableName: string; parsed: ParsedArtifact }[]): Promise<SqlSandbox> {
    const instance = await DuckDBInstance.create(':memory:');
    const conn = await instance.connect();
    const tables: { name: string; columns: string[]; rowCount: number }[] = [];
    try {
      await installPolyfills(conn);
      for (const input of inputs) {
        const { header, data } = toGrid(input.parsed);
        if (header.length === 0) continue;
        // 列型は数値率で推定（過半が数値なら DOUBLE）
        const types = header.map((_, i) => {
          const vals = data.map(r => r[i]).filter(v => v !== null && v !== '');
          const numCount = vals.filter(v => typeof v === 'number').length;
          return vals.length > 0 && numCount > vals.length / 2 ? 'DOUBLE' : 'VARCHAR';
        });
        const cols = header.map((h, i) => `"${h.replace(/"/g, '""')}" ${types[i]}`).join(', ');
        await conn.run(`CREATE TABLE "${input.tableName}" (${cols})`);
        if (data.length > 0) {
          const values = data.map(r =>
            `(${r.map((v, i) => {
              if (v === null || v === '') return 'NULL';
              return types[i] === 'DOUBLE' ? String(Number(v)) : q(String(v));
            }).join(', ')})`,
          ).join(',\n');
          await conn.run(`INSERT INTO "${input.tableName}" VALUES ${values}`);
        }
        tables.push({ name: input.tableName, columns: header, rowCount: data.length });
      }
      return new SqlSandbox(instance, conn, tables);
    } catch (e) {
      conn.closeSync();
      throw e;
    }
  }

  /** SQL を1本実行する。Snowflake 方言との差異はポリフィルの範囲まで（それ以外はエラーで返る） */
  async run(sql: string): Promise<{ columns: string[]; rows: Record<string, unknown>[] }> {
    const reader = await this.conn.runAndReadAll(sql);
    return { columns: reader.columnNames(), rows: reader.getRowObjects() as Record<string, unknown>[] };
  }

  close(): void {
    this.conn.closeSync();
  }
}

/**
 * インプットデータを DuckDB のテーブルとして登録し、生成 SQL を実行して結果グリッドを返す。
 * （1本だけ流す従来 API。照合パイプラインが使う）
 */
export async function runSqlSimulation(
  inputs: { tableName: string; parsed: ParsedArtifact }[],
  sql: string,
): Promise<{ columns: string[]; rows: Record<string, unknown>[] }> {
  const sandbox = await SqlSandbox.create(inputs);
  try {
    return await sandbox.run(sql);
  } finally {
    sandbox.close();
  }
}

/**
 * 帳票（最終アウトプット）と SQL 実行結果をセル単位で照合する。
 * 突き合わせ規則: 帳票の1列目を行ラベル、1行目を列ヘッダーとし、
 * SQL 結果の（1列目の値, 列名）で対応セルを引き当てる。
 */
export async function matchAgainstFinalOutput(
  inputs: { tableName: string; parsed: ParsedArtifact }[],
  sql: string,
  finalOutput: ParsedArtifact,
): Promise<MatchOutcome> {
  const { columns, rows } = await runSqlSimulation(inputs, sql);
  const keyColumn = columns[0];

  // SQL 結果を（行ラベル → 列名 → 値）の索引にする
  const index = new Map<string, Map<string, number | null>>();
  for (const row of rows) {
    const label = String(row[keyColumn] ?? '');
    const m = new Map<string, number | null>();
    for (const col of columns) m.set(col, toNumber(row[col]));
    index.set(label, m);
  }

  const { header, data } = toGrid(finalOutput);
  const sheet = finalOutput.sheets[0];
  let total = 0;
  let matched = 0;
  const mismatches: Mismatch[] = [];

  for (let r = 0; r < data.length; r++) {
    const rowLabel = String(data[r][0] ?? '');
    if (rowLabel === '') continue;
    for (let c = 1; c < header.length; c++) {
      const expected = data[r][c];
      if (typeof expected !== 'number') continue;
      total++;
      const actual = index.get(rowLabel)?.get(header[c]) ?? null;
      // 相対誤差 1e-6 までは一致とみなす（浮動小数点の揺らぎ吸収）
      const isMatch = actual !== null && Math.abs(actual - expected) <= Math.max(1e-6, Math.abs(expected) * 1e-6);
      if (isMatch) {
        matched++;
      } else {
        const cause = mockClassifyCause(expected, actual);
        mismatches.push({
          cell_ref: `${sheet.name}!${columnLetterOf(c + 1)}${r + 2}`,
          row_label: rowLabel,
          column: header[c],
          expected,
          actual,
          ...cause,
        });
      }
    }
  }

  return { totalCells: total, matchedCells: matched, mismatches };
}

function columnLetterOf(n: number): string {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

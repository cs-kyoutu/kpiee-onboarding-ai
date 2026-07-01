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

/** 解析済みアーティファクトの先頭シートをヘッダー＋データ行列へ変換する */
function toGrid(parsed: ParsedArtifact): { header: string[]; data: (string | number | null)[][] } {
  const sheet = parsed.sheets[0];
  const colIdx = (ref: string): number => {
    const letters = ref.replace(/\d+/g, '');
    let n = 0;
    for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  };
  const header = (sheet.rows[0]?.cells ?? []).map(c => String(c.value ?? ''));
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
 * インプットデータを DuckDB のテーブルとして登録し、生成 SQL を実行して結果グリッドを返す。
 */
export async function runSqlSimulation(
  inputs: { tableName: string; parsed: ParsedArtifact }[],
  sql: string,
): Promise<{ columns: string[]; rows: Record<string, unknown>[] }> {
  const instance = await DuckDBInstance.create(':memory:');
  const conn = await instance.connect();
  try {
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
    }

    // Snowflake 方言と DuckDB の差異はローカル検証の限界として許容する（Phase 2 で実 API 検証へ移行）
    const reader = await conn.runAndReadAll(sql);
    const columns = reader.columnNames();
    const rows = reader.getRowObjects() as Record<string, unknown>[];
    return { columns, rows };
  } finally {
    conn.closeSync();
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

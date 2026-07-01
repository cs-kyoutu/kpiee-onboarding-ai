// SQL 静的検証器（設計書 §6.3）。
// atlas-core rails/app/services/sql_jobs/query_scanner.rb の契約を TypeScript へ移植したもの。
// SQL parser 全体を実装するのではなく、SQLジョブに必要な契約だけを検査する:
//   - 単一の SELECT / WITH statement のみ
//   - DDL/DML/USE 禁止
//   - Snowflake stage（@）参照禁止
//   - schema 修飾付き関数呼び出し禁止
//   - context / metadata 系関数禁止（関数呼び出し形・括弧省略形の両方）
//   - FROM/JOIN の参照テーブルは登録済みアセット名のみ（プロジェクト固有チェック）

const TOP_LEVEL_START_KEYWORDS = ['select', 'with'];
const PROHIBITED_STATEMENT_KEYWORDS = ['insert', 'update', 'delete', 'merge', 'create', 'drop', 'alter', 'truncate', 'use'];
const SUBQUERY_INTRODUCER_KEYWORDS = ['as', 'from', 'join', 'exists', 'in', 'lateral'];

// 原本 query_scanner.rb の PROHIBITED_FUNCTION_NAMES と同一リスト
const PROHIBITED_FUNCTION_NAMES = new Set([
  'get_ddl', 'generate_column_description', 'result_scan', 'last_query_id', 'last_transaction',
  'current_session', 'current_statement', 'current_transaction', 'current_account', 'current_account_name',
  'current_organization_name', 'current_organization_user', 'current_user', 'current_role', 'current_role_type',
  'current_available_roles', 'current_secondary_roles', 'current_warehouse', 'current_database', 'current_schema',
  'current_schemas', 'current_version', 'current_client', 'current_ip_address', 'current_region',
  'all_user_names', 'sys_context', 'set_sys_context', 'getvariable', 'policy_context',
  'get_condition_query_uuid', 'invoker_role', 'invoker_share', 'is_role_activated', 'is_role_in_session',
  'is_granted_to_invoker_role', 'is_application_role_activated', 'is_application_role_in_session',
  'is_database_role_in_session', 'is_instance_role_in_session', 'is_group_activated', 'is_group_imported',
  'is_user_imported', 'is_organization_user', 'is_organization_user_group', 'is_organization_user_group_in_session',
  'explain_privileges', 'explain_grantable_privileges',
]);
const PROHIBITED_FUNCTION_PREFIXES = ['system$'];

// 括弧省略形（bare identifier）でも呼び出せる context 関数の denylist（原本と同一）
const PROHIBITED_NILADIC_FUNCTION_NAMES = new Set([
  'current_account', 'current_account_name', 'current_organization_name', 'current_organization_user',
  'current_user', 'current_role', 'current_role_type', 'current_warehouse', 'current_database',
  'current_schema', 'current_session', 'current_statement', 'current_transaction', 'current_region',
  'current_ip_address',
]);

export interface ScanError {
  code: string;
  message: string;
}

export interface ScanResult {
  ok: boolean;
  errors: ScanError[];
  relationReferences: string[]; // FROM/JOIN から参照されたテーブル名（CTE 除外済み・小文字正規化）
  cteNames: string[];
}

type TokenType = 'identifier' | 'quoted_identifier' | 'number' | 'string' | 'symbol';
interface Token { type: TokenType; text: string; norm: string }

/** SQL を文字列・コメントを除外しながらトークン化する */
function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    if (/\s/.test(ch)) { i++; continue; }
    // 行コメント
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }
    // ブロックコメント
    if (ch === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    // 文字列リテラル
    if (ch === "'") {
      let j = i + 1;
      let s = '';
      while (j < n) {
        if (sql[j] === "'" && sql[j + 1] === "'") { s += "'"; j += 2; continue; }
        if (sql[j] === "'") break;
        s += sql[j]; j++;
      }
      tokens.push({ type: 'string', text: s, norm: s.toLowerCase() });
      i = j + 1;
      continue;
    }
    // 引用付き識別子
    if (ch === '"' || ch === '`') {
      const quote = ch;
      let j = i + 1;
      while (j < n && sql[j] !== quote) j++;
      const text = sql.slice(i, j + 1);
      tokens.push({ type: 'quoted_identifier', text, norm: unquote(text).toLowerCase() });
      i = j + 1;
      continue;
    }
    // 識別子・キーワード
    if (/[A-Za-z_$-￿]/.test(ch)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$-￿]/.test(sql[j])) j++;
      const text = sql.slice(i, j);
      tokens.push({ type: 'identifier', text, norm: text.toLowerCase() });
      i = j;
      continue;
    }
    // 数値
    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < n && /[0-9.]/.test(sql[j])) j++;
      tokens.push({ type: 'number', text: sql.slice(i, j), norm: sql.slice(i, j) });
      i = j;
      continue;
    }
    tokens.push({ type: 'symbol', text: ch, norm: ch });
    i++;
  }
  return tokens;
}

function unquote(name: string): string {
  let s = name;
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith('`') && s.endsWith('`'))) {
    s = s.slice(1, -1);
  }
  return s.replace(/""/g, '"');
}

/** セミコロンで statement を分割する（文字列・コメントは tokenize 済みなので単純分割で安全） */
function splitStatements(tokens: Token[]): Token[][] {
  const statements: Token[][] = [];
  let cur: Token[] = [];
  for (const t of tokens) {
    if (t.type === 'symbol' && t.text === ';') {
      statements.push(cur);
      cur = [];
    } else cur.push(t);
  }
  statements.push(cur);
  return statements.filter(s => s.length > 0);
}

/** `(` を読み飛ばし、対応する `)` の次の index を返す */
function skipParenthesized(tokens: Token[], openIdx: number): number {
  let depth = 0;
  let i = openIdx;
  while (i < tokens.length) {
    if (tokens[i].text === '(') depth++;
    if (tokens[i].text === ')') depth--;
    i++;
    if (depth === 0) break;
  }
  return i;
}

/** WITH 句の CTE 名一覧を抽出する */
function extractCteNames(tokens: Token[]): string[] {
  const names: string[] = [];
  let i = 0;
  if (tokens[i]?.norm !== 'with') return names;
  i++;
  if (tokens[i]?.norm === 'recursive') i++;
  for (;;) {
    const t = tokens[i];
    if (!t || (t.type !== 'identifier' && t.type !== 'quoted_identifier')) break;
    names.push(unquote(t.text).toLowerCase());
    i++;
    // CTE 名直後の任意の column list を読み飛ばす
    if (tokens[i]?.text === '(') i = skipParenthesized(tokens, i);
    if (tokens[i]?.norm !== 'as') break;
    i++;
    if (tokens[i]?.text !== '(') break;
    i = skipParenthesized(tokens, i);
    if (tokens[i]?.text !== ',') break;
    i++;
  }
  return [...new Set(names)];
}

/** statement 開始位置（top-level / subquery / CTE 本体）の index 集合を収集する */
function statementStartIndexes(tokens: Token[]): Set<number> {
  const indexes = new Set<number>();
  for (let i = 0; i < tokens.length; i++) {
    let isStart = false;
    if (i === 0) isStart = true;
    else if (i >= 2 && tokens[i - 1]?.text === '(' &&
      tokens[i - 2]?.type === 'identifier' && SUBQUERY_INTRODUCER_KEYWORDS.includes(tokens[i - 2].norm)) {
      isStart = true;
    }
    if (!isStart) continue;
    indexes.add(i);
    if (tokens[i].norm === 'with') {
      const bodyIdx = cteBodyStartIndex(tokens, i);
      if (bodyIdx !== null) indexes.add(bodyIdx);
    }
  }
  return indexes;
}

/** WITH 句の CTE 定義を読み飛ばし、本体 statement の開始 index を返す */
function cteBodyStartIndex(tokens: Token[], withIdx: number): number | null {
  let i = withIdx + 1;
  if (tokens[i]?.norm === 'recursive') i++;
  for (;;) {
    const t = tokens[i];
    if (!t || (t.type !== 'identifier' && t.type !== 'quoted_identifier')) break;
    i++;
    if (tokens[i]?.text === '(') i = skipParenthesized(tokens, i);
    if (tokens[i]?.norm !== 'as') break;
    i++;
    if (tokens[i]?.text !== '(') break;
    i = skipParenthesized(tokens, i);
    if (tokens[i]?.text === ',') { i++; continue; }
    return i;
  }
  return null;
}

/** FROM / JOIN 直後の relation 参照を抽出する（CTE は除外） */
function extractRelationReferences(tokens: Token[], cteNames: string[]): string[] {
  const refs: string[] = [];
  const cteSet = new Set(cteNames);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== 'identifier' || (t.norm !== 'from' && t.norm !== 'join')) continue;
    const next = tokens[i + 1];
    if (!next) continue;
    if (next.text === '(') continue; // サブクエリ
    if (next.type !== 'identifier' && next.type !== 'quoted_identifier') continue;
    // schema.table 形式は最後の識別子をテーブル名として扱う
    let name = unquote(next.text).toLowerCase();
    let j = i + 2;
    while (tokens[j]?.text === '.' && tokens[j + 1]) {
      name = unquote(tokens[j + 1].text).toLowerCase();
      j += 2;
    }
    if (!cteSet.has(name)) refs.push(name);
  }
  return [...new Set(refs)];
}

/**
 * SQL を検査して契約違反を列挙する。
 * @param sql 検査対象 SQL
 * @param allowedTables 参照を許可するテーブル名（登録済みデータファイル名）。省略時はテーブル名チェックをスキップ
 */
export function scanQuery(sql: string, allowedTables?: string[]): ScanResult {
  const errors: ScanError[] = [];
  const allTokens = tokenize(sql);
  const statements = splitStatements(allTokens);

  if (statements.length === 0) {
    return { ok: false, errors: [{ code: 'empty_query', message: 'query is blank' }], relationReferences: [], cteNames: [] };
  }
  if (statements.length > 1) {
    errors.push({ code: 'multiple_statements_not_allowed', message: 'multiple statements are not allowed' });
  }
  const tokens = statements[0];

  // statement 開始位置にある DDL/DML/USE keyword を検査
  const startIdx = statementStartIndexes(tokens);
  for (const idx of startIdx) {
    const t = tokens[idx];
    if (t?.type === 'identifier' && PROHIBITED_STATEMENT_KEYWORDS.includes(t.norm)) {
      const code = t.norm === 'use' ? 'use_statement_not_allowed' : 'data_mutation_not_allowed';
      errors.push({ code, message: `keyword ${t.norm} is not allowed` });
    }
  }

  // top-level は SELECT / WITH のみ
  const firstKeyword = tokens.find(t => t.type === 'identifier')?.norm;
  if (!firstKeyword || !TOP_LEVEL_START_KEYWORDS.includes(firstKeyword)) {
    errors.push({ code: 'invalid_statement_start', message: 'top-level statement must start with SELECT or WITH' });
  }

  // stage（@）参照禁止
  const atIdx = tokens.findIndex(t => t.type === 'symbol' && t.text === '@');
  if (atIdx >= 0) {
    errors.push({ code: 'stage_reference_not_allowed', message: 'stage reference (@) is not allowed' });
  }

  // 関数検査
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const isFunctionCall =
      (t.type === 'identifier' || t.type === 'quoted_identifier') && tokens[i + 1]?.text === '(';
    if (isFunctionCall) {
      // schema 修飾付き関数呼び出し（schema.func()）は関数名に関係なく拒否
      if (i >= 2 && tokens[i - 1]?.text === '.' &&
        (tokens[i - 2]?.type === 'identifier' || tokens[i - 2]?.type === 'quoted_identifier')) {
        errors.push({ code: 'qualified_function_not_allowed', message: `qualified function ${tokens[i - 2].text}.${t.text} is not allowed` });
      }
      if (t.type === 'identifier' &&
        (PROHIBITED_FUNCTION_NAMES.has(t.norm) || PROHIBITED_FUNCTION_PREFIXES.some(p => t.norm.startsWith(p)))) {
        errors.push({ code: 'snowflake_function_not_allowed', message: `function ${t.norm} is not allowed` });
      }
    } else if (t.type === 'identifier' && PROHIBITED_NILADIC_FUNCTION_NAMES.has(t.norm)) {
      // 括弧省略形の context 関数（SELECT CURRENT_USER など）。quoted は column 参照として許容
      errors.push({ code: 'snowflake_function_not_allowed', message: `function ${t.norm} is not allowed (niladic form)` });
    }
  }

  const cteNames = extractCteNames(tokens);
  const relationReferences = extractRelationReferences(tokens, cteNames);

  // テーブル参照は登録済みデータファイル名のみ許可（設計書 §6.3 のプロジェクト固有チェック）
  if (allowedTables) {
    const allowed = new Set(allowedTables.map(t => t.toLowerCase()));
    for (const ref of relationReferences) {
      if (!allowed.has(ref)) {
        errors.push({
          code: 'unknown_relation_reference',
          message: `table "${ref}" is not a registered data file (allowed: ${allowedTables.join(', ') || 'none'})`,
        });
      }
    }
  }

  return { ok: errors.length === 0, errors, relationReferences, cteNames };
}

// 構造化出力スキーマ（設計書 §7.4）。
// output_config.format（json_schema）でスキーマを強制し、パースエラーを排除する。

export const LOGIC_TYPES = [
  'join', 'union', 'arithmetic', 'allocation', 'filter', 'aggregate',
  'manual_input', 'format_only', 'unknown',
] as const;

export const KPIEE_TARGETS = [
  'sql_job', 'report_metric', 'report_axis', 'master', 'custom_row',
  'allocation', 'needs_customer_confirmation',
] as const;

/** P1 解読: 解読項目リスト＋全体構造の自然言語サマリのスキーマ */
export const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    // 全体構造の解説（テーブル定義書スタイル）。
    // まず「どのシートが合わさってどのシートになるか」（シート構成）を示し、
    // 次に各シートの列・計算行を定義書として示す。同一レイアウトのシートは1つの定義書にまとめる。
    overview: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: '全体像を平易な日本語で2〜4文。専門用語は避け、関係者（非エンジニア）が読んで分かる表現で' },
        sheet_composition: {
          type: 'array',
          description: '各シートが「どのシートからどう作られるか」の一覧。処理の流れが追える順（入力→中間→最終出力）に並べる',
          items: {
            type: 'object',
            properties: {
              sheet: { type: 'string', description: '対象シート名（ファイル名が要る場合は「ファイル名!シート名」）' },
              role: { enum: ['入力', '中間集計', '最終出力', 'その他'], description: 'このシートの役割' },
              composed_of: {
                type: 'array',
                description: '構成元のシート名。入力シート（手入力・取込）は空配列',
                items: { type: 'string' },
              },
              method: { type: 'string', description: '構成元からの作られ方。例: 3-D参照 SUM(top:end!〃) による同一位置セルの合算 / SUMIF集計 / 値の手コピー。入力シートは「手入力」等' },
              description: { type: 'string', description: 'このシートが何の表かを平易に1文で' },
            },
            required: ['sheet', 'role', 'composed_of', 'method', 'description'],
            additionalProperties: false,
          },
        },
        table_definitions: {
          type: 'array',
          description: 'シートのテーブル定義書。同一レイアウトのシート群は1つの定義書にまとめ、applies_to に適用シートを列挙する',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: '定義書名（例: 部門別業績シート（共通レイアウト） / FY 集計シート）' },
              applies_to: { type: 'array', description: 'このレイアウトが適用されるシート名の一覧', items: { type: 'string' } },
              columns: {
                type: 'array',
                description: '列（横方向）の定義。反復する列群（月次×実績/予算/前期 等）は1行にまとめてよい',
                items: {
                  type: 'object',
                  properties: {
                    position: { type: 'string', description: '列位置（例: B列 / E〜AN列）' },
                    item: { type: 'string', description: '項目名（例: 勘定科目コード / 月次 実績・予算・前期）' },
                    type: { type: 'string', description: 'データ型・内容（例: 数値 / 文字列 / 日付）' },
                    definition: { type: 'string', description: '定義・出所。手入力なのか、数式（=SUM(top:end!〃) 等）なら何を意味するのかを平易に' },
                  },
                  required: ['position', 'item', 'type', 'definition'],
                  additionalProperties: false,
                },
              },
              calc_rows: {
                type: 'array',
                description: '行方向の集計行・計算行の定義（例: 売上高(P1000)＝SUM(E6:E47)＝明細行の合計）。無ければ空配列',
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string', description: '行ラベル（例: 売上高(P1000)）' },
                    definition: { type: 'string', description: '計算の定義を平易に（数式と意味）' },
                  },
                  required: ['label', 'definition'],
                  additionalProperties: false,
                },
              },
            },
            required: ['title', 'applies_to', 'columns', 'calc_rows'],
            additionalProperties: false,
          },
        },
        caveats: {
          type: 'array',
          description: '関係者が注意すべき点（手入力混入・出所不明・要顧客確認など）。なければ空配列',
          items: { type: 'string' },
        },
      },
      required: ['summary', 'sheet_composition', 'table_definitions', 'caveats'],
      additionalProperties: false,
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          source_ref: { type: 'string', description: 'タブ名!セル範囲' },
          formula_raw: { type: 'string' },
          logic_type: { enum: [...LOGIC_TYPES] },
          kpiee_target: { enum: [...KPIEE_TARGETS] },
          explanation: { type: 'string', description: '日本語での解読説明' },
          confidence: { enum: ['high', 'medium', 'low'] },
        },
        required: ['id', 'source_ref', 'logic_type', 'kpiee_target', 'explanation', 'confidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['overview', 'findings'],
  additionalProperties: false,
} as const;

export interface Finding {
  id: string;
  source_ref: string;
  formula_raw?: string;
  logic_type: typeof LOGIC_TYPES[number];
  kpiee_target: typeof KPIEE_TARGETS[number];
  explanation: string;
  confidence: 'high' | 'medium' | 'low';
}

/** シート構成: あるシートが「どのシートからどう作られるか」 */
export interface SheetComposition {
  sheet: string;
  role: '入力' | '中間集計' | '最終出力' | 'その他';
  composed_of: string[];
  method: string;
  description: string;
}

/** テーブル定義書: 同一レイアウトのシート群に対する列・計算行の定義 */
export interface TableDefinition {
  title: string;
  applies_to: string[];
  columns: { position: string; item: string; type: string; definition: string }[];
  calc_rows: { label: string; definition: string }[];
}

/** 全体構造の解説（テーブル定義書スタイル: シート構成＋定義書） */
export interface StructureOverview {
  summary: string;
  sheet_composition: SheetComposition[];
  table_definitions: TableDefinition[];
  caveats: string[];
}

/** P1 解読の結果（解読項目＋全体構造サマリ） */
export interface DecodeResult {
  overview: StructureOverview;
  findings: Finding[];
}

/** P2 生成: SQL・マスタCSV・レポート設定（中間表現）のスキーマ */
export const GENERATION_SCHEMA = {
  type: 'object',
  properties: {
    sql: { type: 'string', description: 'SQLジョブ用の単一 SELECT/WITH 文（Snowflake 方言）' },
    sql_explanation: { type: 'string' },
    master_csv: { type: 'string', description: 'マスタ CSV の内容（ヘッダー行含む）' },
    report_config: {
      type: 'object',
      properties: {
        report_name: { type: 'string' },
        x_axis: {
          type: 'object',
          properties: {
            type: { enum: ['period_daily', 'period_weekly', 'period_monthly', 'period_yearly', 'master', 'calc_column'] },
            label: { type: 'string' },
          },
          required: ['type', 'label'],
          additionalProperties: false,
        },
        y_axis: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { enum: ['master', 'calc_row'] },
              label: { type: 'string' },
              custom_formula: { type: 'string', description: '+ - * / ^ 括弧 数値 [指標名] のみ' },
            },
            required: ['type', 'label'],
            additionalProperties: false,
          },
        },
        metrics: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              source_column: { type: 'string' },
              aggregation: { enum: ['sum', 'count', 'avg', 'max', 'min'] },
              custom_formula: { type: 'string' },
            },
            required: ['name', 'source_column', 'aggregation'],
            additionalProperties: false,
          },
        },
        value_filters: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              column: { type: 'string' },
              operator: { enum: ['gte', 'lte', 'gt', 'lt', 'eq', 'neq', 'btw', 'nbtw'] },
              value: { type: 'string' },
            },
            required: ['column', 'operator', 'value'],
            additionalProperties: false,
          },
        },
      },
      required: ['report_name', 'x_axis', 'y_axis', 'metrics', 'value_filters'],
      additionalProperties: false,
    },
    finding_outputs: {
      type: 'array',
      description: '承認済み解読項目（findings）それぞれが最終成果物のどこに反映されたかの対応表。全項目分を必ず出す',
      items: {
        type: 'object',
        properties: {
          finding_id: { type: 'integer', description: '解読項目の id（findings JSON の id）' },
          output: {
            type: 'string',
            description: '反映先を具体的に。例: SQL列「PL_BS判定」（hierarchy CTE） / レポート指標「取込金額」 / Y軸計算行「売上総利益」 / マスタCSV（勘定科目） / 反映不要（表示用のため） / 顧客確認待ちのため未反映',
          },
        },
        required: ['finding_id', 'output'],
        additionalProperties: false,
      },
    },
  },
  required: ['sql', 'sql_explanation', 'master_csv', 'report_config', 'finding_outputs'],
  additionalProperties: false,
} as const;

export interface ReportConfig {
  report_name: string;
  x_axis: { type: string; label: string };
  y_axis: { type: string; label: string; custom_formula?: string }[];
  metrics: { name: string; source_column: string; aggregation: string; custom_formula?: string }[];
  value_filters: { column: string; operator: string; value: string }[];
}

export interface GenerationResult {
  sql: string;
  sql_explanation: string;
  master_csv: string;
  report_config: ReportConfig;
  /** 各解読項目 → 最終成果物のどこに反映されたか（トレーサビリティ。マッピング表の「→ 最終成果物」列になる） */
  finding_outputs: { finding_id: number; output: string }[];
}

/** P4 照合: 不一致原因分類のスキーマ */
export const MISMATCH_CAUSE_SCHEMA = {
  type: 'object',
  properties: {
    causes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          cell_ref: { type: 'string' },
          cause_category: { enum: ['rounding', 'manual_input', 'logic_missing', 'data_issue', 'unknown'] },
          explanation: { type: 'string' },
        },
        required: ['cell_ref', 'cause_category', 'explanation'],
        additionalProperties: false,
      },
    },
  },
  required: ['causes'],
  additionalProperties: false,
} as const;

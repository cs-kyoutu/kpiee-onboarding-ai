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
    // 全体構造の解説（関係者が一読して把握できる平易な日本語の要約）。
    // 「どんなデータが・どう加工され・何として出力されるか」をストーリーとして示す。
    overview: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: '全体像を平易な日本語で2〜4文。専門用語は避け、関係者（非エンジニア）が読んで分かる表現で' },
        inputs: {
          type: 'array',
          description: '出発点となる入力データ（基幹CSV・手入力シート等）',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'データ名（ファイル名・シート名など）' },
              description: { type: 'string', description: 'どんなデータか（何が何件くらい入っているか）を平易に' },
            },
            required: ['name', 'description'],
            additionalProperties: false,
          },
        },
        steps: {
          type: 'array',
          description: '入力から出力に至るまでの加工ステップ（処理の流れ順）',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'このステップの短い見出し（例: 売上を拠点別に集計）' },
              description: { type: 'string', description: '何を・どう加工するかを平易な日本語で1〜2文' },
            },
            required: ['title', 'description'],
            additionalProperties: false,
          },
        },
        outputs: {
          type: 'array',
          description: '最終的に出力される帳票・レポート',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '出力物の名前（帳票名・レポート名）' },
              description: { type: 'string', description: '誰が何のために見る何の表か、を平易に' },
            },
            required: ['name', 'description'],
            additionalProperties: false,
          },
        },
        caveats: {
          type: 'array',
          description: '関係者が注意すべき点（手入力混入・出所不明・要顧客確認など）。なければ空配列',
          items: { type: 'string' },
        },
      },
      required: ['summary', 'inputs', 'steps', 'outputs', 'caveats'],
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

/** 全体構造の自然言語サマリ（どんなデータが・どう加工され・何として出力されるか） */
export interface StructureOverview {
  summary: string;
  inputs: { name: string; description: string }[];
  steps: { title: string; description: string }[];
  outputs: { name: string; description: string }[];
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

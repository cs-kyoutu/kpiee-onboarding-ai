// 顧客共有レポート（データ構造 分析レポート）の「何を載せるか」の指定。
//
// 案件ごとに欲しいアウトプットが少しずつ違うため、デザインは固定したまま構成要素だけを
// 出し入れできるようにする。指定は画面のチェックでも、AI との相談（reportChat.ts）でも作れる。
//
// 設計上の約束:
//   - 関係図（ノード形式）は必須。これが顧客と構造合意する本体なので外せない項目にしない。
//   - 既定は「全部出す」。指定が無い案件（既存プロジェクト含む）は従来と同じ内容になる。
//   - 保存値は信用しない。normalizeReportSpec を通し、未知キーは捨てて既定で埋める
//     （AI がツール経由で書くため、想定外の形が入り得る）。
export interface ReportSpecSections {
  /** 01 受領データ一覧 */
  inventory: boolean;
  /** 02 全体の流れと詳細ロジック */
  flow: boolean;
  /** 03 ご確認いただきたい点 */
  questions: boolean;
  /** 04 今後の進め方 */
  nextSteps: boolean;
}

export interface ReportSpecItems {
  /** 01 ファイルごとの役割と中身（開閉ブロックの一覧そのもの） */
  fileTable: boolean;
  /** 01 開閉ブロックの中身（シートの役割・表と列の構成）。false なら見出し行だけ */
  sheetDetails: boolean;
  /** 02 ご登録のブック関係と自動解析の突き合わせ（全体関係図の下） */
  declaredAudit: boolean;
  /** 02 全体関係図（ブック間）。1ブック案件では指定に関わらず出ない */
  fileFlow: boolean;
  /** 02 キー関係図（ER） */
  erDiagram: boolean;
  /** 02 詳細ロジック表（元・キー・処理・先・根拠・確度） */
  detailLogic: boolean;
  /** 02 操作版の関係グラフ（クリック掘り下げ）。false でも静的なノード図は出る */
  interactiveGraph: boolean;
}

export interface ReportSpec {
  /** レポート表題。空なら既定（ご提供データの構造分析レポート） */
  title: string;
  /** この案件で特に確認したいこと。表紙のリード文へ1行入る */
  focus: string;
  sections: ReportSpecSections;
  items: ReportSpecItems;
  /** 01 の「この案件の前提」へ足す補足（案件固有の前提など） */
  notes: string[];
}

export const DEFAULT_REPORT_SPEC: ReportSpec = {
  title: '',
  focus: '',
  sections: { inventory: true, flow: true, questions: true, nextSteps: true },
  items: {
    fileTable: true, sheetDetails: true, declaredAudit: true,
    fileFlow: true, erDiagram: true, detailLogic: true, interactiveGraph: true,
  },
  notes: [],
};

/** 画面・AI に出す項目カタログ（ラベルと説明）。UI と AI プロンプトで同じ語を使う */
export const REPORT_SECTION_LABELS: Record<keyof ReportSpecSections, string> = {
  inventory: '01 受領データ一覧',
  flow: '02 全体の流れと詳細ロジック',
  questions: '03 ご確認いただきたい点',
  nextSteps: '04 今後の進め方',
};

export const REPORT_ITEM_LABELS: Record<keyof ReportSpecItems, string> = {
  fileTable: 'ファイルごとの役割と中身（一覧）',
  sheetDetails: '一覧を開いたときの中身（シートの役割・列構成）',
  declaredAudit: 'ご登録のブック関係との突き合わせ',
  fileFlow: '全体関係図（ブックどうしの流れ）',
  erDiagram: 'キー関係図（ER）',
  detailLogic: '詳細ロジック表',
  interactiveGraph: '操作版の関係グラフ（クリック掘り下げ）',
};

const MAX_TITLE = 80;
const MAX_FOCUS = 200;
const MAX_NOTES = 8;
const MAX_NOTE_LEN = 200;

const asBool = (v: unknown, dflt: boolean): boolean => (typeof v === 'boolean' ? v : dflt);
const asText = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';

/** 任意の入力を ReportSpec へ正規化する（未知キーは無視し、欠けは base で埋める） */
export function normalizeReportSpec(raw: unknown, base: ReportSpec = DEFAULT_REPORT_SPEC): ReportSpec {
  const o = (raw ?? {}) as Record<string, unknown>;
  const s = (o.sections ?? {}) as Record<string, unknown>;
  const i = (o.items ?? {}) as Record<string, unknown>;
  const notes = Array.isArray(o.notes)
    ? o.notes.map(n => asText(n, MAX_NOTE_LEN)).filter(n => n !== '').slice(0, MAX_NOTES)
    : base.notes;
  return {
    title: o.title === undefined ? base.title : asText(o.title, MAX_TITLE),
    focus: o.focus === undefined ? base.focus : asText(o.focus, MAX_FOCUS),
    sections: {
      inventory: asBool(s.inventory, base.sections.inventory),
      flow: asBool(s.flow, base.sections.flow),
      questions: asBool(s.questions, base.sections.questions),
      nextSteps: asBool(s.nextSteps, base.sections.nextSteps),
    },
    items: {
      fileTable: asBool(i.fileTable, base.items.fileTable),
      sheetDetails: asBool(i.sheetDetails, base.items.sheetDetails),
      declaredAudit: asBool(i.declaredAudit, base.items.declaredAudit),
      fileFlow: asBool(i.fileFlow, base.items.fileFlow),
      erDiagram: asBool(i.erDiagram, base.items.erDiagram),
      detailLogic: asBool(i.detailLogic, base.items.detailLogic),
      interactiveGraph: asBool(i.interactiveGraph, base.items.interactiveGraph),
    },
    notes,
  };
}

/** 現在の指定を人が読める1行群にする（AI へ現状を渡すとき・画面の要約に使う） */
export function describeReportSpec(spec: ReportSpec): string[] {
  const on = (b: boolean) => (b ? '出す' : '出さない');
  return [
    `表題: ${spec.title || '（既定）'}`,
    `重点: ${spec.focus || '（未指定）'}`,
    ...Object.entries(REPORT_SECTION_LABELS).map(([k, label]) =>
      `${label}: ${on(spec.sections[k as keyof ReportSpecSections])}`),
    ...Object.entries(REPORT_ITEM_LABELS).map(([k, label]) =>
      `${label}: ${on(spec.items[k as keyof ReportSpecItems])}`),
    `補足メモ: ${spec.notes.length > 0 ? spec.notes.join(' / ') : '（なし）'}`,
  ];
}

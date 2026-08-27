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
  /**
   * 03 ロジックの確認（帳票ごとの読み方・でき方・確認欄）。
   * 02 再現するアウトプットの確認は、reproduce / howMade / assumptions / sheetGuide が
   * 入っているかで出し入れするので、ここには持たない。
   */
  flow: boolean;
  /** 04 ご確認いただきたい点 */
  questions: boolean;
  /** 05 今後の進め方 */
  nextSteps: boolean;
}

export interface ReportSpecItems {
  /** 01 ファイルごとの役割と中身（開閉ブロックの一覧そのもの） */
  fileTable: boolean;
  /** 01 「表と列の構成」の付録（列名の一覧）。読み合わせでは細かいので案件によって外す */
  sheetDetails: boolean;
  /** 03 ご登録のブック関係と自動解析の突き合わせ（全体関係図の下の1行） */
  declaredAudit: boolean;
  /** 03 全体関係図（ブック間）。1ブック案件では指定に関わらず出ない */
  fileFlow: boolean;
  /** 03 各ロジックブロックの中のキー関係図（ER） */
  erDiagram: boolean;
  /** 03 レシピの下に置く関係の一覧（元・キー・処理・先・根拠・確度） */
  detailLogic: boolean;
  /** 03 操作版の関係グラフ（クリック掘り下げ）。false でも静的なノード図は出る */
  interactiveGraph: boolean;
}

/** 表紙直後の「はじめに」に並べる、こちらが読み取った全体像の1項目 */
export interface ReportOverviewItem {
  /** 左に出る見出し語（例: 4本グラフ、予算の2段階） */
  label: string;
  /** その項目の説明。<b> は使える（エスケープしない） */
  text: string;
}

/** 2-1「タブの役割とデータ元」の1行。いただいた指示メモの内容をそのまま載せる */
export interface ReportSheetGuideRow {
  /** シート（タブ）名。「シート見出しが緑色のタブ全て」のような書き方も入る */
  tab: string;
  /** そのタブが何のためのものか */
  note: string;
  /** どこから作られるか（元のファイル名・システム名など） */
  source: string;
}

/** 01 のファイル1つ分の補足。開閉ブロックを開いた先頭に出す（そのブックの読み方） */
export interface ReportFileNote {
  /** 対象ファイル名（受領時のファイル名） */
  file: string;
  /** そのブックについての一言。<b> は使える */
  note: string;
}

/** ファイル1つ分の「タブの役割とデータ元」 */
export interface ReportSheetGuideFile {
  /** 対象ファイル名（受領時のファイル名そのまま） */
  file: string;
  rows: ReportSheetGuideRow[];
  /** 表の下に付ける補足（今後の追加予定など） */
  note: string;
}

/** 数式からは入手元をたどれないシートの、伺った対応（最終アウトプットの節に出す） */
export interface ReportSheetOrigin {
  /** 対象ファイル名 */
  file: string;
  /** 「⑥月初見込・⑧第1週〜⑪第4週」のようにまとめた書き方も入る */
  items: { sheets: string; from: string }[];
}

/**
 * 手順の1行につける札の色。何をしている段なのかを、色で見分けられるようにする。
 *   base   … 土台（もとからある数字）
 *   direct … そのまま付ける（比率を使わない付与・数式で足すもの）
 *   ratio  … 比率で配る（配賦・按分）
 *   manual … 手入力（数式が無く、kpiee では入力としていただくもの）
 *   result … でき上がり（最終の指標）
 */
export type ReportStepTone = 'base' | 'direct' | 'ratio' | 'manual' | 'result';

/** 手順の1行（左に札、右に説明）。図の下の読み方と、ステップの内訳カードで同じ形を使う */
export interface ReportStepLine {
  /** 左に出る札（例: ステップ2、②演算） */
  tag: string;
  tone: ReportStepTone;
  /** その段で何をしているか。<b> は使える */
  text: string;
}

/**
 * 02-1 に置く「作られ方（イメージ）」の図。
 *
 * 貼り付けで受け渡している案件では数式が残らないため、自動生成のレシピ図が出せない。
 * その場合でも「1行（得意先1行など）に、段ごとにどんな列が足されて最後の指標になるのか」は
 * 伺った手順から描ける。例の値を入れた1行を絵にして、読み合わせの入口に置く。
 */
export interface ReportHowMadeFigure {
  /** 図の見出し。空なら「作られ方（イメージ）」 */
  title: string;
  /** 見出しに添える注記（例: 数値は説明のための例（単位：万円）です。実際の値ではございません。） */
  note: string;
  /** 左から並べる列のかたまり。かたまりの間は「＋」、最後の result の前は「＝」でつなぐ */
  groups: {
    /** かたまりの上に出る札（例: ①68期実績（土台）、ステップ2・訪問比率） */
    label: string;
    tone: ReportStepTone;
    /** そのかたまりに並ぶ列。sample は説明のための例の値（実データではない） */
    columns: { name: string; sample: string }[];
  }[];
  /** 図の下に置く読み方 */
  steps: ReportStepLine[];
}

/**
 * 03「ロジックの確認」で、最終アウトプットの節に置く1ブロック。
 *
 * 数式から読み取れるのは「どのセルがどこから来たか」までで、帳票の読み方（何が縦で何が横か、
 * どの行がどのタブから来ているか、どこを足して全社にしているか）は、こちらが読み取って
 * 言葉にする部分になる。そこを毎回 HTML へ手で足していたため、入力として受け取れるようにする。
 *
 * 並べる順番は配列の順。自動生成分（レシピ図・関係図）も flow / graph として同じ列に並べる。
 */
export type ReportOutputBlock =
  /** 箇条書き（この帳票の形・組織の足し上げ など） */
  | { kind: 'bullets'; title: string; items: string[]; notes: string[] }
  /**
   * 表（縦の行の作り方・シートごとの作り方 など）。
   * groups[].label は左端のまとめ列（rowspan）。全グループの label が空なら、その列は出さない。
   */
  | { kind: 'table'; title: string; lede: string; head: string[];
      groups: { label: string; note: string; rows: string[][] }[]; notes: string[];
      /** 各行を最終帳票の行として色づけるか（表紙のタイルと同じ赤） */ emphasize: boolean }
  /** 白いカード（内訳と差異の分け方 など） */
  | { kind: 'summary'; title: string; items: string[] }
  /** ここをご確認ください（03-A…）。記号は本文に出てくる順に振る */
  | { kind: 'check'; question: string; detail: string[] }
  /**
   * 「何から何ができるか」の流れ図。左にタブ、真ん中に突き合わせるもの、右に段階を積む。
   * repeat に指標を並べると、同じ形の図を指標ごとに繰り返す（{名} が指標名に置き換わる）。
   */
  | { kind: 'flow'; lede: string; repeat: string[]; title: string; text: string;
      key: string; sourceNote: string; sources: string[];
      stages: { title: string; note: string }[]; note: string }
  /**
   * ステップごとの内訳カード。1つの流れ図では潰れてしまう手順（集計 → 演算 → 配賦のように
   * 段の中がさらに分かれているもの）を、ステップ単位のカードに分けて書く。
   */
  | { kind: 'steps'; title: string;
      cards: { title: string; text: string; steps: ReportStepLine[]; note: string }[] }
  /** 自動生成のレシピ図（数式から起こした「でき方」）を差し込む位置 */
  | { kind: 'recipes' }
  /** 自動生成の関係図（付録・開閉ブロック）を差し込む位置 */
  | { kind: 'graph' };

/** 最終アウトプット1つ分の、03 に並べる中身 */
export interface ReportOutputPlan {
  /** 対象ファイル名（受領時のファイル名。前方一致で節を選ぶ） */
  file: string;
  /** この帳票の読み方・確認したいこと。空なら自動生成分だけを従来の順で並べる */
  blocks: ReportOutputBlock[];
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
  /**
   * 表紙直後の「はじめに」に置く全体像。空なら節そのものを出さない。
   * 結論を 02 の導入に置くと、読む側は 01 のファイル一覧を通り過ぎるまで
   * 全体像に出会えない。先に答えを置き、01 以降をその根拠として読ませる。
   */
  overview: ReportOverviewItem[];
  /**
   * 02 の先頭に置く「タブの役割とデータ元」。解析結果ではなく、いただいた指示メモの写し。
   * 数式の残らない受け渡し（貼り付け・システム出力）は、ご説明が唯一の根拠になる。
   */
  sheetGuide: ReportSheetGuideFile[];
  /** 「タブの役割とデータ元」の導入に足す一文（出典の資料名など）。空なら既定の説明だけ */
  sheetGuideNote: string;
  /** 数式からは入手元をたどれなかったシートの対応。最終アウトプットの節に出す */
  sheetOrigins: ReportSheetOrigin[];
  /**
   * 02-1「再現するもの」。kpiee で何を再現するのかを、帳票の単位で並べる。
   * 空なら overview（従来の「はじめに」の全体像）をそのまま使う。
   */
  reproduce: ReportOverviewItem[];
  /** 02-1「作られ方」。どのタブに何を入れて、どこがそれを拾うのかの説明。<b> は使える */
  howMade: string[];
  /**
   * 02-1 の「作られ方」を絵で見せる指定。箇条書き（howMade）の下に置く。
   * 図と同じ内容を箇条書きにも書くと二度読ませることになるので、
   * 図に寄せた項目は howMade から外し、手順の文は図の下の steps に書く。
   */
  howMadeFigure: ReportHowMadeFigure | null;
  /** 02-1 の導入で名前を出す出典（例: 指示メモ（0. 20260807 受け渡しデータ））。空なら既定文だけ */
  howMadeSource: string;
  /**
   * 02-2「再現するうえでの前提」。いただいた資料の読み方と、kpiee 側の作りとして置いている前提。
   * 「今回の前提」だと何の前提か分からないので、再現作業の前提であることを名前に出す。
   * 空なら notes（案件の前提）をそのまま使う。
   */
  assumptions: string[];
  /** 03 の最終アウトプットごとに並べる中身。指定の無いファイルは自動生成分だけになる */
  outputPlans: ReportOutputPlan[];
  /** 01 のファイルごとの補足（そのブックの中で何が行われているか） */
  fileNotes: ReportFileNote[];
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
  overview: [],
  sheetGuide: [],
  sheetGuideNote: '',
  sheetOrigins: [],
  reproduce: [],
  howMade: [],
  howMadeFigure: null,
  howMadeSource: '',
  assumptions: [],
  outputPlans: [],
  fileNotes: [],
};

/** 画面・AI に出す項目カタログ（ラベルと説明）。UI と AI プロンプトで同じ語を使う */
// 番号は「02 再現するアウトプットの確認」が出るときの並び。02 は reproduce / howMade /
// assumptions / sheetGuide のいずれかがあるときだけ出るため、無い案件では番号が繰り上がる。
export const REPORT_SECTION_LABELS: Record<keyof ReportSpecSections, string> = {
  inventory: '01 受領データ一覧',
  flow: '03 ロジックの確認',
  questions: '04 ご確認いただきたい点',
  nextSteps: '05 今後の進め方',
};

export const REPORT_ITEM_LABELS: Record<keyof ReportSpecItems, string> = {
  fileTable: 'ファイルごとの役割と中身（一覧）',
  sheetDetails: '表と列の構成（列名の一覧・付録）',
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
// 「はじめに」は表紙の次に読む要点。増やすほど要点でなくなるので上限を低く置く
const MAX_OVERVIEW = 6;
const MAX_OVERVIEW_LABEL = 20;
const MAX_OVERVIEW_TEXT = 300;
// タブ一覧はいただいた資料の写しなので、シート数の多いブックでも収まる程度に取る
const MAX_GUIDE_FILES = 8;
const MAX_GUIDE_ROWS = 60;
const MAX_GUIDE_CELL = 120;
const MAX_ORIGIN_FILES = 6;
const MAX_ORIGIN_ITEMS = 20;
// 02 の3つの箱。読み合わせで頭から読む内容なので、箱ごとの行数は絞る
const MAX_REPRODUCE = 6;
const MAX_HOWMADE = 8;
const MAX_ASSUMPTIONS = 8;
// 02 の箇条書きは、ファイル名を並べる行があると1行でも長くなる
const MAX_LINE = 1200;
// 03 の帳票の読み方。1帳票あたりのブロック数と、表の行数の上限
const MAX_PLANS = 6;
const MAX_BLOCKS = 12;
const MAX_BLOCK_ITEMS = 12;
const MAX_TABLE_GROUPS = 12;
const MAX_TABLE_ROWS = 24;
const MAX_TABLE_COLS = 6;
const MAX_FLOW_SOURCES = 8;
const MAX_FLOW_STAGES = 5;
const MAX_REPEAT = 5;
// 「作られ方（イメージ）」の図。1行を横に伸ばして描くので、かたまりも列も増やせない
const MAX_FIG_GROUPS = 6;
const MAX_FIG_COLUMNS = 4;
const MAX_FIG_LABEL = 24;
const MAX_STEP_TAG = 12;
const MAX_STEP_LINES = 8;
const MAX_STEP_CARDS = 8;

const asBool = (v: unknown, dflt: boolean): boolean => (typeof v === 'boolean' ? v : dflt);
const asText = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';
/** 箇条書き1本ぶん。空行は落とす */
const asLines = (v: unknown, cap: number, max = MAX_LINE): string[] =>
  Array.isArray(v) ? v.map(x => asText(x, max)).filter(x => x !== '').slice(0, cap) : [];
const asRecord = (v: unknown): Record<string, unknown> => (v ?? {}) as Record<string, unknown>;
const STEP_TONES: ReportStepTone[] = ['base', 'direct', 'ratio', 'manual', 'result'];
/** 知らない色名は「土台」に寄せる（色が付かないより、既定の色で並んでいた方が読める） */
const asTone = (v: unknown): ReportStepTone =>
  STEP_TONES.find(t => t === v) ?? 'base';
/** 手順の行。札か本文のどちらかが空の行は、札としても文としても読めないので落とす */
const asStepLines = (v: unknown): ReportStepLine[] =>
  Array.isArray(v)
    ? v.map(x => {
        const r = asRecord(x);
        return { tag: asText(r.tag, MAX_STEP_TAG), tone: asTone(r.tone), text: asText(r.text, MAX_LINE) };
      }).filter(s => s.tag !== '' && s.text !== '').slice(0, MAX_STEP_LINES)
    : [];

/** 02-1 の「作られ方（イメージ）」。列が1つも無い図は絵にならないので null にする */
function normalizeHowMadeFigure(raw: unknown): ReportHowMadeFigure | null {
  if (raw === null || raw === undefined) return null;
  const o = asRecord(raw);
  const groups = Array.isArray(o.groups)
    ? o.groups.map(g => {
        const r = asRecord(g);
        const columns = Array.isArray(r.columns)
          ? r.columns.map(c => {
              const x = asRecord(c);
              return { name: asText(x.name, MAX_FIG_LABEL), sample: asText(x.sample, MAX_FIG_LABEL) };
            }).filter(c => c.name !== '').slice(0, MAX_FIG_COLUMNS)
          : [];
        return { label: asText(r.label, MAX_FIG_LABEL), tone: asTone(r.tone), columns };
      }).filter(g => g.columns.length > 0).slice(0, MAX_FIG_GROUPS)
    : [];
  if (groups.length === 0) return null;
  return {
    title: asText(o.title, MAX_GUIDE_CELL), note: asText(o.note, MAX_NOTE_LEN),
    groups, steps: asStepLines(o.steps),
  };
}

/** 03 のブロック1つ。kind が知らない値・中身が空のものは呼び出し側で落とす */
function normalizeOutputBlock(raw: unknown): ReportOutputBlock | null {
  const o = asRecord(raw);
  switch (o.kind) {
    case 'bullets': {
      const items = asLines(o.items, MAX_BLOCK_ITEMS);
      if (items.length === 0) return null;
      return { kind: 'bullets', title: asText(o.title, MAX_GUIDE_CELL), items, notes: asLines(o.notes, 4) };
    }
    case 'table': {
      const groups = Array.isArray(o.groups)
        ? o.groups.map(g => {
            const r = asRecord(g);
            const rows = Array.isArray(r.rows)
              ? r.rows
                  .map(row => asLines(row, MAX_TABLE_COLS))
                  .filter(row => row.length > 0)
                  .slice(0, MAX_TABLE_ROWS)
              : [];
            return { label: asText(r.label, MAX_GUIDE_CELL), note: asText(r.note, MAX_LINE), rows };
          }).filter(g => g.rows.length > 0).slice(0, MAX_TABLE_GROUPS)
        : [];
      if (groups.length === 0) return null;
      return {
        kind: 'table', title: asText(o.title, MAX_GUIDE_CELL), lede: asText(o.lede, MAX_LINE),
        head: asLines(o.head, MAX_TABLE_COLS), groups, notes: asLines(o.notes, 4),
        emphasize: asBool(o.emphasize, false),
      };
    }
    case 'summary': {
      const items = asLines(o.items, MAX_BLOCK_ITEMS);
      if (items.length === 0) return null;
      return { kind: 'summary', title: asText(o.title, MAX_GUIDE_CELL), items };
    }
    case 'check': {
      const question = asText(o.question, MAX_LINE);
      if (question === '') return null;
      return { kind: 'check', question, detail: asLines(o.detail, 8) };
    }
    case 'flow': {
      const sources = asLines(o.sources, MAX_FLOW_SOURCES, MAX_GUIDE_CELL);
      const stages = Array.isArray(o.stages)
        ? o.stages.map(s => {
            const r = asRecord(s);
            return { title: asText(r.title, MAX_GUIDE_CELL), note: asText(r.note, MAX_GUIDE_CELL) };
          }).filter(s => s.title !== '').slice(0, MAX_FLOW_STAGES)
        : [];
      if (sources.length === 0 || stages.length === 0) return null;
      return {
        kind: 'flow', lede: asText(o.lede, MAX_LINE), repeat: asLines(o.repeat, MAX_REPEAT, MAX_OVERVIEW_LABEL),
        title: asText(o.title, MAX_GUIDE_CELL), text: asText(o.text, MAX_LINE),
        key: asText(o.key, MAX_OVERVIEW_LABEL), sourceNote: asText(o.sourceNote, MAX_OVERVIEW_LABEL),
        sources, stages, note: asText(o.note, MAX_LINE * 2),
      };
    }
    case 'steps': {
      const cards = Array.isArray(o.cards)
        ? o.cards.map(c => {
            const r = asRecord(c);
            return {
              title: asText(r.title, MAX_GUIDE_CELL), text: asText(r.text, MAX_LINE),
              steps: asStepLines(r.steps), note: asText(r.note, MAX_LINE),
            };
          }).filter(c => c.text !== '' || c.steps.length > 0).slice(0, MAX_STEP_CARDS)
        : [];
      if (cards.length === 0) return null;
      return { kind: 'steps', title: asText(o.title, MAX_GUIDE_CELL), cards };
    }
    case 'recipes': return { kind: 'recipes' };
    case 'graph': return { kind: 'graph' };
    default: return null;
  }
}

/** 任意の入力を ReportSpec へ正規化する（未知キーは無視し、欠けは base で埋める） */
export function normalizeReportSpec(raw: unknown, base: ReportSpec = DEFAULT_REPORT_SPEC): ReportSpec {
  const o = (raw ?? {}) as Record<string, unknown>;
  const s = (o.sections ?? {}) as Record<string, unknown>;
  const i = (o.items ?? {}) as Record<string, unknown>;
  const notes = Array.isArray(o.notes)
    ? o.notes.map(n => asText(n, MAX_NOTE_LEN)).filter(n => n !== '').slice(0, MAX_NOTES)
    : base.notes;
  // 見出し語と本文が両方そろっている項目だけを採る（片方だけでは札として読めない）
  const overview = Array.isArray(o.overview)
    ? o.overview
        .map(v => {
          const r = (v ?? {}) as Record<string, unknown>;
          return { label: asText(r.label, MAX_OVERVIEW_LABEL), text: asText(r.text, MAX_OVERVIEW_TEXT) };
        })
        .filter(v => v.label !== '' && v.text !== '')
        .slice(0, MAX_OVERVIEW)
    : base.overview;
  // タブ名だけの行（摘要も入手元も空）は表として意味がないので落とす
  const sheetGuide = Array.isArray(o.sheetGuide)
    ? o.sheetGuide
        .map(v => {
          const r = (v ?? {}) as Record<string, unknown>;
          const rows = Array.isArray(r.rows)
            ? r.rows
                .map(x => {
                  const g = (x ?? {}) as Record<string, unknown>;
                  return {
                    tab: asText(g.tab, MAX_GUIDE_CELL),
                    note: asText(g.note, MAX_GUIDE_CELL),
                    source: asText(g.source, MAX_GUIDE_CELL),
                  };
                })
                .filter(x => x.tab !== '' && (x.note !== '' || x.source !== ''))
                .slice(0, MAX_GUIDE_ROWS)
            : [];
          return { file: asText(r.file, MAX_GUIDE_CELL), rows, note: asText(r.note, MAX_NOTE_LEN) };
        })
        .filter(v => v.file !== '' && v.rows.length > 0)
        .slice(0, MAX_GUIDE_FILES)
    : base.sheetGuide;
  const sheetOrigins = Array.isArray(o.sheetOrigins)
    ? o.sheetOrigins
        .map(v => {
          const r = (v ?? {}) as Record<string, unknown>;
          const items = Array.isArray(r.items)
            ? r.items
                .map(x => {
                  const g = (x ?? {}) as Record<string, unknown>;
                  return { sheets: asText(g.sheets, MAX_GUIDE_CELL), from: asText(g.from, MAX_GUIDE_CELL) };
                })
                .filter(x => x.sheets !== '' && x.from !== '')
                .slice(0, MAX_ORIGIN_ITEMS)
            : [];
          return { file: asText(r.file, MAX_GUIDE_CELL), items };
        })
        .filter(v => v.file !== '' && v.items.length > 0)
        .slice(0, MAX_ORIGIN_FILES)
    : base.sheetOrigins;
  const reproduce = Array.isArray(o.reproduce)
    ? o.reproduce
        .map(v => {
          const r = asRecord(v);
          return { label: asText(r.label, MAX_OVERVIEW_LABEL), text: asText(r.text, MAX_OVERVIEW_TEXT) };
        })
        .filter(v => v.label !== '' && v.text !== '')
        .slice(0, MAX_REPRODUCE)
    : base.reproduce;
  const outputPlans = Array.isArray(o.outputPlans)
    ? o.outputPlans
        .map(v => {
          const r = asRecord(v);
          const blocks = Array.isArray(r.blocks)
            ? r.blocks.map(normalizeOutputBlock).filter((b): b is ReportOutputBlock => b !== null).slice(0, MAX_BLOCKS)
            : [];
          return { file: asText(r.file, MAX_GUIDE_CELL), blocks };
        })
        .filter(v => v.file !== '' && v.blocks.length > 0)
        .slice(0, MAX_PLANS)
    : base.outputPlans;
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
    overview,
    sheetGuide,
    sheetGuideNote: o.sheetGuideNote === undefined
      ? base.sheetGuideNote : asText(o.sheetGuideNote, MAX_NOTE_LEN),
    sheetOrigins,
    reproduce,
    howMade: o.howMade === undefined ? base.howMade : asLines(o.howMade, MAX_HOWMADE),
    howMadeFigure: o.howMadeFigure === undefined
      ? base.howMadeFigure : normalizeHowMadeFigure(o.howMadeFigure),
    howMadeSource: o.howMadeSource === undefined
      ? base.howMadeSource : asText(o.howMadeSource, MAX_NOTE_LEN),
    assumptions: o.assumptions === undefined ? base.assumptions : asLines(o.assumptions, MAX_ASSUMPTIONS),
    outputPlans,
    fileNotes: Array.isArray(o.fileNotes)
      ? o.fileNotes
          .map(v => {
            const r = asRecord(v);
            return { file: asText(r.file, MAX_GUIDE_CELL), note: asText(r.note, MAX_LINE) };
          })
          .filter(v => v.file !== '' && v.note !== '')
          .slice(0, MAX_GUIDE_FILES)
      : base.fileNotes,
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
    `はじめに（全体像）: ${spec.overview.length > 0 ? spec.overview.map(o => o.label).join(' / ') : '（なし）'}`,
    `タブの役割とデータ元: ${spec.sheetGuide.length > 0 ? spec.sheetGuide.map(g => `${g.file}（${g.rows.length}行）`).join(' / ') : '（なし）'}`,
    `シートの入手元: ${spec.sheetOrigins.length > 0 ? spec.sheetOrigins.map(o => `${o.file}（${o.items.length}件）`).join(' / ') : '（なし）'}`,
    `再現するもの: ${spec.reproduce.length > 0 ? spec.reproduce.map(r => r.label).join(' / ') : '（なし・はじめにの全体像を使う）'}`,
    `作られ方: ${spec.howMade.length > 0 ? `${spec.howMade.length} 行` : '（なし）'}`,
    `作られ方の図: ${spec.howMadeFigure
      ? `${spec.howMadeFigure.groups.map(g => g.label || `${g.columns.length}列`).join(' → ')}`
      : '（なし・箇条書きだけ）'}`,
    `再現するうえでの前提: ${spec.assumptions.length > 0 ? `${spec.assumptions.length} 行` : '（なし・案件の前提を使う）'}`,
    `帳票の読み方: ${spec.outputPlans.length > 0
      ? spec.outputPlans.map(p => `${p.file}（${p.blocks.map(b => b.kind).join('→')}）`).join(' / ')
      : '（なし・自動生成分のみ）'}`,
  ];
}

// 資料の自動読み取り（doc-draft）の品質を、決めた基準で機械判定する。
//
// 「毎回この品質が出るか」を人の目視だけに頼らないための回帰チェック。
// 抽出の指示・モデル・正規化を変えたら、代表案件（協和など）でこれを流して
// PASS が維持されているかを見る。
//
// 使い方:
//   npx tsx scripts/check-draft-quality.ts <baseUrl> <projectId>
//   例: npx tsx scripts/check-draft-quality.ts http://localhost:8787 30
//
// 基準（協和 8/21 の参考版から決めたもの）:
//   R1 再現するアウトプットが1件以上ある
//   R2 outputPlans がある（対象は最終アウトプットのファイル名）
//   R3 steps ブロックがあり、カードが2枚以上（手順書がある案件）
//   R4 比率配賦カードの行は ①集計(base) → ②演算(direct) → ③配賦(ratio) の型
//   R5 丸数字がカード内で連番（①②③…）
//   R6 「作られ方（イメージ）」の図がある（groups に base と result を含む）
//   R7 本文・sample に7桁以上の実数らしい数値が無い（大前提: 実データの数値を出さない）

interface StepLine { tag: string; tone: string; text: string }
interface Card { title: string; text: string; steps: StepLine[]; note: string }
interface Block { kind: string; title?: string; cards?: Card[]; items?: string[]; question?: string }

const [baseUrl, projectId] = process.argv.slice(2);
if (!baseUrl || !projectId) {
  console.error('usage: npx tsx scripts/check-draft-quality.ts <baseUrl> <projectId>');
  process.exit(2);
}

const res = await fetch(`${baseUrl}/api/projects/${projectId}/doc-draft`);
const draft = await res.json() as {
  status: string;
  requirements?: { spec: {
    reproduce: unknown[];
    outputPlans: { file: string; blocks: Block[] }[];
    howMadeFigure: { groups: { tone: string }[] } | null;
  } } | null;
};

const results: { rule: string; ok: boolean; detail: string }[] = [];
const check = (rule: string, ok: boolean, detail = '') => results.push({ rule, ok, detail });

if (draft.status !== 'done' || !draft.requirements) {
  console.error(`draft が done ではありません: status=${draft.status}`);
  process.exit(2);
}
const spec = draft.requirements.spec;

check('R1 再現するアウトプット', spec.reproduce.length >= 1, `${spec.reproduce.length} 件`);
check('R2 outputPlans', spec.outputPlans.length >= 1, `${spec.outputPlans.length} 件`);

const stepsBlocks = spec.outputPlans.flatMap(p => p.blocks.filter(b => b.kind === 'steps'));
const cards = stepsBlocks.flatMap(b => b.cards ?? []);
check('R3 steps ブロック', stepsBlocks.length >= 1 && cards.length >= 2,
  `blocks=${stepsBlocks.length} cards=${cards.length}`);

// R4/R5: 行を持つカード（比率配賦）の型
const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨'];
let r4ok = true, r5ok = true;
const r4detail: string[] = [];
for (const c of cards) {
  if (c.steps.length === 0) continue; // 直接付与カードは行なしが正
  c.steps.forEach((s, i) => {
    if (!s.tag.startsWith(CIRCLED[i] ?? '?')) { r5ok = false; r4detail.push(`${c.title}: tag=${s.tag}（${i + 1}行目）`); }
  });
  const tones = c.steps.map(s => s.tone).join(',');
  // 3行型のカードは base,direct,ratio。行数が違うカードも tone の順序性（base が先頭・ratio が末尾）は守る
  if (c.steps.length === 3 && tones !== 'base,direct,ratio') { r4ok = false; r4detail.push(`${c.title}: tones=${tones}`); }
}
check('R4 札の色の型（集計→演算→配賦）', r4ok, r4detail.join(' / ') || '全カード適合');
check('R5 丸数字の連番', r5ok, r4detail.join(' / ') || '全カード適合');

const fig = spec.howMadeFigure;
const figTones = new Set((fig?.groups ?? []).map(g => g.tone));
check('R6 作られ方の図', fig !== null && figTones.has('base') && figTones.has('result'),
  fig ? `groups=${fig.groups.length}（tones: ${[...figTones].join(',')}）` : '図なし');

const allText = JSON.stringify(spec);
const bigNumbers = allText.match(/\d{1,3}(,\d{3}){2,}|\d{7,}/g) ?? [];
check('R7 実データ数値の混入なし', bigNumbers.length === 0, bigNumbers.slice(0, 3).join(' / ') || 'なし');

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.rule}${r.detail ? `  — ${r.detail}` : ''}`);
  if (!r.ok) failed++;
}
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} 件 FAIL`);
process.exit(failed === 0 ? 0 : 1);

// 協和案件のレポート HTML は原本 xlsx が手元に無く再生成できないため、
// 生成器で直した見た目だけを既存の HTML へ当てる使い捨てのパッチ。
//   npx tsx scripts/_patch-kyowa-css.ts <対象.html>
//
// 直す内容は relationsReport.ts と同じ:
//   ・.mini-step .tag を塊ごとの固定幅（--tagw）にし、右の説明の開始位置をそろえる
//   ・<div class="mini-steps"> ごとに、いちばん長い札に合わせた --tagw を入れる
//   ・表（.ot）に列の区切り線と、まとめ列の地色を入れる
// 何度当てても同じ結果になる（すでに直っている箇所は触らない）。
import { readFileSync, writeFileSync } from 'node:fs';

const OLD_SUBH = '.sub-h{font-family:var(--disp);font-weight:700;font-size:18px;color:var(--ink);margin:30px 0 6px}';
const NEW_SUBH = '/* 小見出しの前は広めに空ける。前の話（凡例や表）と次の小見出しが近いと、\n'
  + '   どこで話が変わったのかが見た目で分からない */\n'
  + '.sub-h{font-family:var(--disp);font-weight:700;font-size:18px;color:var(--ink);margin:44px 0 6px}';

const OLD_TABLE = '.ot tr:last-child td{border-bottom:none}';
const NEW_TABLE = OLD_TABLE + '\n'
  + '/* 列の区切り。長い文が入る表では、横線だけだと隣の列と地続きに見えて、\n'
  + '   どこまでが「行」でどこからが「作り方」なのかを目で分けられない。\n'
  + '   まとめ列（rowspan）があると行ごとにセル数が変わるので、左ではなく右に引く */\n'
  + '.ot td{border-right:1px solid var(--line)}\n'
  + '.ot th{border-right:1px solid rgba(255,255,255,.22)}\n'
  + '.ot tr>td:last-child,.ot tr>th:last-child{border-right:none}\n'
  + '/* まとめ列は、どこからどこまでが1つの塊かが分かるよう地色を敷く */\n'
  + '.ot td[rowspan]{background:#F7F9FC}';

const OLD_CSS = '.mini-step .tag{flex:none;font-size:11.5px;font-weight:700;border-radius:6px;padding:3px 10px;white-space:nowrap}';
const NEW_CSS = '/* 札は塊ごとに幅をそろえる（--tagw）。右の説明が同じ位置から始まらないと縦に読めない */\n'
  + '.mini-step .tag{flex:0 0 var(--tagw,auto);text-align:center;font-size:11.5px;font-weight:700;\n'
  + '  border-radius:6px;padding:3px 10px;white-space:nowrap}';

/** 表示幅（px）。全角=1・半角=0.6 の概算（relationsReport.ts の textW と同じ） */
function textW(s: string, fontPx: number): number {
  let acc = 0;
  for (const ch of s) acc += /[\x00-\xff｡-ﾟ]/.test(ch) ? fontPx * 0.6 : fontPx;
  return acc;
}

const file = process.argv[2];
if (!file) { console.error('対象の HTML を指定してください'); process.exit(1); }
let html = readFileSync(file, 'utf8');

if (!html.includes(OLD_CSS) && !html.includes('.mini-step .tag{flex:0 0 var(--tagw')) {
  console.error('想定した .mini-step .tag の指定が見つかりませんでした（中身が変わっている可能性）');
  process.exit(1);
}
const cssHit = html.includes(OLD_CSS);
if (cssHit) html = html.split(OLD_CSS).join(NEW_CSS);

// 表の列の区切り（すでに入っていれば触らない）
const tableHit = !html.includes('.ot tr>td:last-child') && html.includes(OLD_TABLE);
if (tableHit) html = html.replace(OLD_TABLE, NEW_TABLE);

// 小見出しの前の余白
const subhHit = html.includes(OLD_SUBH);
if (subhHit) html = html.replace(OLD_SUBH, NEW_SUBH);

// 「受領ファイルのシート N シート」のタイル（解析の規模で、読み手が使う数字ではない）
const tileHit = /<div class="tile"><div class="tl">受領ファイルのシート<\/div>[\s\S]*?<\/div><\/div>/.test(html);
if (tileHit) {
  html = html.replace(/\s*<div class="tile"><div class="tl">受領ファイルのシート<\/div>[\s\S]*?<\/div><\/div>/, '');
  html = html.replace('.tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}',
    '/* タイルの数は案件によって変わる（最終アウトプットの出し方で1〜2枚）。\n'
    + '   数を決め打ちにすると、2枚のときに右が大きく空く */\n'
    + '.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:18px}');
}

// 02 の「ここが出発点になりますので…」（節の位置と道案内カードで分かる）
const startHit = html.includes('ここが出発点になりますので');
if (startHit) {
  html = html.replace(/<span class="s">ここが出発点になりますので[^<]*<\/span>(<wbr>)?/, '');
}

// 04 の導入文（見出しと各カードで足りているので置かない）
const ledeHit = /<p class="sec-lede" id="qlede">[\s\S]*?<\/p>/.test(html);
if (ledeHit) html = html.replace(/\s*<p class="sec-lede" id="qlede">[\s\S]*?<\/p>/, '');

// 塊ごとに、その中の札でいちばん長いものへ幅を合わせる
let groups = 0;
html = html.replace(/<div class="mini-steps"(?: style="[^"]*")?>([\s\S]*?)<\/div>\s*(?:<\/figcaption>|<p class="tbl-note"|<\/div>)/g,
  (whole: string, inner: string) => {
    const tags = [...inner.matchAll(/<span class="tag[^"]*"[^>]*>([^<]+)<\/span>/g)].map(m => m[1]);
    if (tags.length === 0) return whole;
    groups++;
    const w = Math.ceil(Math.max(...tags.map(t => textW(t, 11.5)))) + 22;
    return whole.replace(/<div class="mini-steps"(?: style="[^"]*")?>/, `<div class="mini-steps" style="--tagw:${w}px">`);
  });

writeFileSync(file, html, 'utf8');
console.log(`札のCSS: ${cssHit ? '差し替えました' : '（すでに新しい指定でした）'}`
  + ` ／ 表のCSS: ${tableHit ? '入れました' : '（すでに入っていました）'}`
  + ` ／ 小見出しの余白: ${subhHit ? '広げました' : '（すでに広げてありました）'}`
  + ` ／ 04 の導入文: ${ledeHit ? '外しました' : '（すでにありませんでした）'}`
  + ` ／ シート数のタイル: ${tileHit ? '外しました' : '（すでにありませんでした）'}`
  + ` ／ 02 の一文: ${startHit ? '外しました' : '（すでにありませんでした）'}`
  + ` ／ 幅を入れた塊: ${groups} 件`);
for (const m of html.matchAll(/<div class="mini-steps" style="--tagw:(\d+)px">/g)) console.log(`  --tagw: ${m[1]}px`);

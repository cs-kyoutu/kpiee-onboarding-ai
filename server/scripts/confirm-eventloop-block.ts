// 1순위 원인(단일 이벤트 루프 블로킹) 실증 스크립트。
// 実 HTTP エンドポイントが使う analyzeArtifacts をそのまま回し、その間の
// イベントループ遅延（=/api/projects・静的バンドル配信が待たされる時間）を計測する。
// 使い方: npx tsx scripts/confirm-eventloop-block.ts <xlsx/csv パス...>
import { readFileSync } from 'node:fs';
import { analyzeArtifacts } from '../src/preprocess/relations.js';
import path from 'node:path';

const files = process.argv.slice(2);
if (files.length === 0) { console.error('usage: tsx scripts/confirm-eventloop-block.ts <path...>'); process.exit(1); }

// --- イベントループ遅延モニタ（50ms 間隔のハートビート） ---
// これは「サーバーが /api/projects リクエストを受理・処理する / 静的バンドルを送る」余力の代理指標。
// 予定より遅れて発火した分 = その瞬間にリクエストが立ち往生する時間。
const INTERVAL = 50;
let expected = Date.now() + INTERVAL;
let maxLag = 0;
let totalStall = 0;      // 100ms を超える遅れの累計（実質的なフリーズ時間）
let stallCount = 0;
const timer = setInterval(() => {
  const now = Date.now();
  const lag = now - expected;
  expected = now + INTERVAL;
  if (lag > maxLag) maxLag = lag;
  if (lag > 100) { totalStall += lag; stallCount++; }
}, INTERVAL);

// ベースライン: 計算前の 500ms は静穏なはず
await new Promise(r => setTimeout(r, 500));
const baselineMax = maxLag;
console.log(`baseline max lag (計算前・静穏時): ${baselineMax}ms`);
maxLag = 0; totalStall = 0; stallCount = 0;

// --- 実エンドポイントと同じ経路: ファイル単位で遅延ロードしつつ解析 ---
const arts = files.map(f => ({
  filename: path.basename(f).replace(/^\d+-/, ''),
  load: async () => readFileSync(f),
}));

console.log(`\n解析対象 ${arts.length} ファイル。analyzeArtifacts 実行中...`);
const t0 = Date.now();
const graph = await analyzeArtifacts(arts);
const elapsed = Date.now() - t0;
clearInterval(timer);

console.log(`\n=== 結果 ===`);
console.log(`analyzeArtifacts 所要（同期CPU占有）: ${(elapsed / 1000).toFixed(2)}s`);
console.log(`  → regions=${graph.regions.length}, edges=${graph.edges.length}, warnings=${graph.warnings?.length ?? 0}`);
console.log(`計算中の最大イベントループ遅延      : ${(maxLag / 1000).toFixed(2)}s`);
console.log(`>100ms のフリーズ累計 / 回数         : ${(totalStall / 1000).toFixed(2)}s / ${stallCount}回`);
console.log(`\n判定: この間に来た /api/projects と静的バンドル配信は最長 ${(maxLag / 1000).toFixed(2)}s 待たされる。`);

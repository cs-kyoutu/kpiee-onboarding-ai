# クレンジングのスニペット（Snowflake）

顧客のExcel/CSV由来データは、見た目が数値・日付でも中身は文字列であることが多い。
以下は現場で実際に必要になったものだけを載せる。

## 1. 日付

> **⚠ 書式を必ず明示する。`TRY_TO_DATE(x)` の1引数版を使わない。**
> SQLジョブのセッションは `DATE_INPUT_FORMAT` が `AUTO` ではないらしく、
> **`2026/05/01` という素直な文字列でも1引数版は NULL を返す**（2026-09-04 実測。
> 値は半角10文字・全角混入なし・`TRY_TO_DATE(x, 'YYYY/MM/DD')` なら通る）。
> `TRY_` はエラーを出さず NULL にするので、**そのデータが丸ごと消えても気づかない。**
> 変換できなかった行を数えるクエリを必ず併走させること。

```sql
-- DATE 型として取込まれている場合：そのまま使う
IMPORT_30015_DATE_1 AS date
```

```sql
-- 文字列で "2026/04/01 12:34:56" のように時刻が付く場合：日付部分だけ取る
TO_DATE(SPLIT_PART(IMPORT_30002_STRING_8, ' ', 1), 'YYYY/MM/DD') AS date
```

```sql
-- 書式が混在している／不正値が混ざる恐れがある場合
TRY_TO_DATE(SPLIT_PART(TRIM(IMPORT_30002_STRING_8), ' ', 1), 'YYYY/MM/DD') AS date
```

```sql
-- "2026年4月1日" 形式
TRY_TO_DATE(
  REGEXP_REPLACE(IMPORT_30002_STRING_8, '年|月', '/')
  , 'YYYY/MM/DD"日"'
) AS date
-- 素直に置換で作るなら：
TRY_TO_DATE(REPLACE(REPLACE(REPLACE(IMPORT_30002_STRING_8,'年','/'),'月','/'),'日',''), 'YYYY/MM/DD')
```

```sql
-- "202604" / "2026-04" のような月次データ。月初日に寄せる
TRY_TO_DATE(LEFT(REPLACE(IMPORT_30002_STRING_8,'-',''), 6) || '01', 'YYYYMMDD') AS date
```

```sql
-- Excel のシリアル値が文字列で混ざる場合（"2026/06/01" と "46174" が同じ列に同居する）
-- 実例: 協和⑥拠点別経費の 月 列。片方の書式しか見ずに書くと、もう片方が全部 NULL になる
CASE
  WHEN REGEXP_LIKE(TRIM(IMPORT_30009_STRING_1), '^[0-9]{5}$')
    THEN DATEADD('DAY', TRY_TO_NUMBER(TRIM(IMPORT_30009_STRING_1)) - 2, '1900-01-01'::DATE)
  ELSE TRY_TO_DATE(TRIM(IMPORT_30009_STRING_1), 'YYYY/MM/DD')
END AS date
```

**同じ列の中で書式が1つとは限らない。** 日付列は必ず「生値 × 変換結果 × 件数」を
`GROUP BY` して目視する（`reconciliation.md` §7）。1書式だけを見て決め打ちしない。

日付が変換できなかった行は `WHERE date IS NULL` で件数を確認する。0件でなければ書式が混在している。

## 2. 金額・数値

> **⚠ `TRY_TO_NUMBER` を既定にしない。scale が 0 で、小数が黙って切り捨てられる。**
> 金額は `TRY_TO_DECIMAL(x, 18, 2)`、率・構成比は `TRY_TO_DECIMAL(x, 12, 6)`。
> 按分比率を `TRY_TO_NUMBER` で通すと **全部 0 に潰れて配賦額が丸ごと消える**。
> エラーは出ない。

```sql
-- 基本形（金額）：数字・小数点・マイナス以外を削って数値化
-- 文字クラス内の "-" は末尾に置く（エスケープ不要・意図が明確）
TRY_TO_DECIMAL(REGEXP_REPLACE(TO_VARCHAR(IMPORT_30015_BIGINT_13), '[^0-9.-]', ''), 18, 2) AS cost
```

```sql
-- 率・構成比・按分比率
TRY_TO_DECIMAL(REGEXP_REPLACE(TO_VARCHAR(IMPORT_30012_STRING_6), '[^0-9.-]', ''), 12, 6) AS ratio
```

`TO_VARCHAR` を通すのは、推定型が数値でも文字列でもどちらでも動くようにするため。

`TRY_TO_DOUBLE` でもよい（協和の土台SQLはこちらを使っている）。**使い分けない方が事故が減る**ので、
案件の中では金額＝`TRY_TO_DECIMAL(...,18,2)` に統一し、案件メモに書いておく。

```sql
-- 掛け目を掛けて整数化する（例：手数料率30%上乗せ、四捨五入して円単位）
CAST(ROUND(
  TRY_TO_DECIMAL(REGEXP_REPLACE(TO_VARCHAR(IMPORT_30002_STRING_13), '[^0-9.-]', ''), 18, 2) * 1.3
) AS INT) AS cost   -- 1.3 = アフィリエイト手数料込み（根拠を必ず書く）
```

端数は業務ルール次第。`ROUND`（四捨五入）／`FLOOR`（切り捨て）／`CEIL`（切り上げ）を
ユーザーに確認して選ぶ。何も指定がないまま `ROUND` を選んだ場合はそう明記する。

```sql
-- 括弧マイナス "(1,234)"・和文マイナス "△1,234" "▲1,234" が負数を表すExcel書式
-- 会計系のExcelは3種類とも混在しうる。片方だけ見て決めない
CASE
  WHEN TRIM(IMPORT_30015_STRING_23) LIKE '(%)'
    OR TRIM(IMPORT_30015_STRING_23) LIKE '△%'
    OR TRIM(IMPORT_30015_STRING_23) LIKE '▲%' THEN
    -1 * TRY_TO_DECIMAL(REGEXP_REPLACE(IMPORT_30015_STRING_23, '[^0-9.]', ''), 18, 2)
  ELSE TRY_TO_DECIMAL(REGEXP_REPLACE(IMPORT_30015_STRING_23, '[^0-9.-]', ''), 18, 2)
END AS amount
```

```sql
-- 全角数字が混ざる場合：TRANSLATE で半角へ寄せてから数値化
TRY_TO_DECIMAL(REGEXP_REPLACE(
  TRANSLATE(TO_VARCHAR(IMPORT_30015_BIGINT_13), '０１２３４５６７８９．，－', '0123456789.,-')
, '[^0-9.-]', ''), 18, 2) AS cost
```

```sql
-- パーセント表記 "12.3%" → 0.123
TRY_TO_DECIMAL(REGEXP_REPLACE(IMPORT_30015_DOUBLE_15, '[^0-9.-]', ''), 12, 6) / 100 AS acos
```

率（CTR・ACOS・ROAS）は原則そのまま持たず、分子と分母を出しておいてレポート側で割る。
集計時に率を平均すると誤った数字になる。

## 3. 文字列・分類キー

```sql
-- 前後の半角/全角スペースを落とす
TRIM(IMPORT_30015_STRING_4, ' 　') AS campaign
```

```sql
-- 空白（NULL・空文字・スペースのみ）を「不明」に寄せる
COALESCE(NULLIF(TRIM(IMPORT_30015_STRING_4, ' 　'), ''), '不明') AS product_group
```

`COALESCE` 単体では `''` を拾えない。`NULLIF(TRIM(...), '')` を必ず挟む。

```sql
-- キャンペーン名から商品グループへ読み替える（完全一致）
CASE TRIM(IMPORT_30015_STRING_4, ' 　')
  WHEN '雲のやすらぎ_マニュアル'                 THEN '雲のやすらぎ'
  WHEN 'アスミール_マニュアル'                   THEN 'アスミール'
  WHEN '三つ折りマットレス_オート'               THEN '三つ折りマットレス'
  WHEN '雲のやすらぎ三つ折りマットレスマニュアル' THEN '雲のやすらぎ三つ折りマットレス'
  WHEN 'マットレス2_オート'                      THEN 'マットレス2'
  WHEN '3R_オート'                               THEN '3R'
  ELSE '不明'
END AS product_group
```

完全一致は、キャンペーン名が1文字でも変わると静かに「不明」へ落ちる。
新しい命名が増える運用なら部分一致にする：

```sql
CASE
  WHEN campaign ILIKE '%雲のやすらぎ%三つ折り%' THEN '雲のやすらぎ三つ折りマットレス'
  WHEN campaign ILIKE '%雲のやすらぎ%'          THEN '雲のやすらぎ'
  WHEN campaign ILIKE '%アスミール%'            THEN 'アスミール'
  ELSE '不明'
END AS product_group
```

部分一致は**順序が意味を持つ**。範囲の狭い条件を先に置く（上の例で
`%雲のやすらぎ%` を先に書くと三つ折りが吸われる）。

### 不明の監視

CASE を書いたら、必ず不明の中身を確認する。

```sql
SELECT TRIM(IMPORT_30015_STRING_4, ' 　') AS campaign, COUNT(*) AS rows, SUM(cost) AS cost
FROM ...   -- 上のCASEを適用したCTEに対して product_group = '不明' で絞る
GROUP BY 1
ORDER BY 3 DESC;
```

金額の大きい「不明」が残っているならマッピング漏れ。ユーザーに一覧を見せて判断を仰ぐ。

## 4. マスタ突合

```sql
-- 突合先が別アセット（マスタ表）にある場合
LEFT JOIN IMPORT_30030 m
  ON TRIM(r.product_code) = TRIM(m.IMPORT_30030_STRING_2)
```

- 突合キーは両側 `TRIM` する。取込データの末尾スペースは目に見えない事故要因。
- `LEFT JOIN` にして、突合できなかった行を消さない。突合不能は `'不明'` に寄せて件数を数える。
- マスタが1コード複数行だと `JOIN` で行が増える。`SELECT code, COUNT(*) ... HAVING COUNT(*) > 1`
  で先に重複を確認する。

### 4-1. コードの桁をそろえる

前ゼロ（`0012` と `12`）が片側で落ちているのは頻出。ただし**数字だけの行に限って揃える**。
科目コードのように英数字混在（`ZDA` `695`）が同居する列を無条件に `LPAD` すると別物になる。

```sql
CASE
  WHEN REGEXP_LIKE(TRIM(IMPORT_30006_STRING_1), '^[0-9]+$')
    THEN LPAD(TRIM(IMPORT_30006_STRING_1), 3, '0')
  ELSE TRIM(IMPORT_30006_STRING_1)
END AS branch_cd
```

**桁数は実データを見て決める。** 揃えた側・揃えなかった側の両方で `DISTINCT` を出し、
突合前に件数を比べる。

### 4-2. 階層のレベルがズレている（未マッチ金額が大きいときの第一容疑）

コードの表記は合っているのに未マッチが大量に出るなら、**両側が同じ階層レベルを指していない**
可能性を先に疑う。実例（協和）: ⑥拠点別経費は「計」レベル（`140` `150` `160`）しか持たないが、
得意先マスタは下位（`141`〜`144`）を持つ。そのままだと **4.53億が未配賦**で消えた。

```sql
-- 下位コードを親（計）へロールアップして突合する
-- 141 → 140、152 → 150。親コードが実在する場合だけ寄せる
LEFT(branch_cd, 2) || '0' AS branch_cd_parent
```

**寄せ方の妥当性は必ず実データで確認する**（`071` → `070` のような誤結合が起きないか）。
規則を決めたら案件メモに書く。次回の自分が同じ検証をやり直さないため。

### 4-3. キーの出所が複数あるとき

同じ「拠点コード」がマスタ側と実績側の両方にある、という状況は普通に起きる。
**どちらを使うか勝手に決めない。突合表を出してから決める。**

```sql
-- MATCH / DIFF / NO_MASTER の3分類で件数を出す
SELECT
  CASE
    WHEN m.branch_cd IS NULL      THEN 'NO_MASTER'
    WHEN m.branch_cd = p.branch_cd THEN 'MATCH'
    ELSE 'DIFF'
  END AS status,
  COUNT(*) AS n
FROM pro_measure p LEFT JOIN customer_master m USING (customer_cd)
GROUP BY 1
```

協和の実測は MATCH 2,267 / DIFF 372 / NO_MASTER 3 で、**DIFF の 358件はマスタ側が `000`（未設定）**、
真の不一致は14件だけだった。ここまで割ってから
「マスタ優先・`000` のときだけ実績側で補完」というルールを決めている。
件数を見ずに「マスタが正」と決めると、`000` の分がまるごと落ちる。

## 5. 重複排除

同じ日付・同じキーで複数行が来る仕様なら、合算か最新採用かを確認する。

```sql
-- 合算（既定。広告費・売上など加算可能な指標）
SELECT date, product_group, sub_channel, SUM(cost) AS cost
FROM ... GROUP BY 1,2,3
```

```sql
-- 最新行のみ採用（同一キーで再送されるスナップショット系データ）
QUALIFY ROW_NUMBER() OVER (PARTITION BY date, product_code ORDER BY updated_at DESC) = 1
```

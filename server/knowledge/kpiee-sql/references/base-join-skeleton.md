# 土台＋列足し型SQLの骨格

顧客の帳票が「1行＝1エンティティ（得意先・商品・拠点）で、列がどんどん右に伸びていく」形なら
これ。Excel 側は `VLOOKUP` の連なりになっている。

## 0. まずどの類型かを決める

3類型あり、**選択を間違えると作り直しになる。** 最終アウトプットの1行が何かで決まる。

| 類型 | 最終アウトプットの1行 | 骨格 | 参照 |
|---|---|---|---|
| **土台＋列足し** | 1エンティティ（得意先1件） | 土台に `LEFT JOIN` で列を足す | この文書 |
| 区分別統合 | 1区分×1日付（販路×日） | 区分ごとのCTEを `UNION ALL` | `channel-aggregation.md` |
| 配賦 | 配賦先1件（金額を移し替える） | CTEを縦に積む | `allocation-sql-skeleton.md` |

見分け方は Excel の数式。**`VLOOKUP` が並んでいれば土台＋列足し。**
シートが区分ごとに分かれていて縦に結合されていれば区分別統合。

1つの案件に複数の類型が同居することはある（協和は STEP1 が土台＋列足し、
STEP2〜4 が配賦）。**混ぜて1本のCTEに書かない。工程ごとに分ける。**

## 1. 母集合は土台ソース**1本**から作る

この類型で最大の事故がこれ。

```sql
-- NG: 全ソースの和集合を母集合にする
customers AS (
    SELECT cust FROM base_measure
    UNION SELECT cust FROM spd_measure      -- ← ③にしか無い行が母集合に入る
    UNION SELECT cust FROM amex_measure
)
```

```sql
-- OK: 土台1本。他ソースは列を足すだけで、行を増やす権利を持たない
customers AS (
    SELECT DISTINCT cd FROM base   -- ①68期実績（原本の土台）
)
```

和集合にすると、**付随ソースにしか無い行（合計行・テスト先・廃止先）が母集合に昇格する。**
協和では ③SPD収支管理表の合計行8件がこれで入り込み、経費 889,061,547 が丸ごと二重計上された
（`reconciliation.md` §6-1）。

**どれが土台かは付録の数式原文で決まる。** `VLOOKUP($D6, ...)` の `$D6` が居るシートが土台。
自分で「多そうな方」を選ばない。付録から読み取れないなら、土台の判定自体を未確定として出す。

> 例外: 数式が明示的に和集合を取っているとき（協和 STEP4 は「①・AMEX・人件費・プロ経費の
> 4ソース和集合」が正）。**そのときも和集合であることを案件メモに書く。**
> 既定は土台1本、和集合は根拠がある場合だけ。

## 2. 付随ソースは「1キー1行」に潰してから足す

`VLOOKUP` は最初の1件しか返さない。`JOIN` は全件返して行を増やす。
**この差がそのまま金額の水増しになる。**

```sql
spd AS (
    SELECT
        TRIM(IMPORT_30012_STRING_2) AS cd,
        SUM(TRY_TO_DECIMAL(REGEXP_REPLACE(TO_VARCHAR(IMPORT_30012_STRING_7), '[^0-9.-]',''),18,2)) AS mgmt_fee,
        SUM(TRY_TO_DECIMAL(REGEXP_REPLACE(TO_VARCHAR(IMPORT_30012_STRING_11),'[^0-9.-]',''),18,2)) AS cost_total
    FROM IMPORT_30012
    GROUP BY 1                       -- ← 足す前に必ずキー単位へ潰す
)
```

潰し方は2択で、**勝手に決めない**。

| 潰し方 | いつ | 書き方 |
|---|---|---|
| 合算 | 明細が複数行ある（金額は加算可能） | `SUM(...) GROUP BY key` |
| 代表1行 | 属性を引くだけ（拠点名・部門コード） | `QUALIFY ROW_NUMBER() OVER (PARTITION BY key ORDER BY ...) = 1` |

`QUALIFY` で代表を選ぶときは、**`ORDER BY` が業務的に意味を持つか**を確認する。
「最小コードを採る」を黙って採用したなら、その旨を回答に書いてユーザーの合意を取る
（協和の検証2がこれ。1キーに複数の部門コードが付いていないかを事前に数えた）。

## 3. 骨格

```sql
WITH base AS (
    -- ① 土台。クレンジングだけを済ませ、行は落とさない
),
base_by_key AS (
    -- ② 土台を出力グレイン（得意先1件）へ潰す
    --    土台自身が縦持ち（区分×得意先）なら、ここで区分を列へ戻す
),
attr_master AS (
    -- ③ 属性マスタ。1キー1行に潰す（§2）
),
m1 AS ( /* 付随ソース1。1キー1行 */ ),
m2 AS ( /* 付随ソース2。1キー1行 */ )
SELECT
    b.cd,
    b.nm,
    b.sales,
    b.gross,
    COALESCE(m1.mgmt_fee,  0) AS mgmt_fee,     -- ← 未突合は 0。NULL のまま足すと全部 NULL
    COALESCE(m2.fee,       0) AS amex_fee,
    COALESCE(a.branch_cd, '不明') AS branch_cd
FROM base_by_key b
LEFT JOIN attr_master a ON b.cd = a.cd          -- ← 全て LEFT。土台の行数は最後まで変わらない
LEFT JOIN m1           ON b.cd = m1.cd
LEFT JOIN m2           ON b.cd = m2.cd
```

守ること:

- **`JOIN` は全て `LEFT`。** `INNER` にした瞬間、突合できない土台の行が消える。
  消えたことはエラーにならない
- **金額の `COALESCE(..., 0)` を落とさない。** 加算式の途中に1つ NULL があると結果が丸ごと NULL。
  協和①は備品列の **69%が空欄**で、これを入れ忘れると合計が全部 NULL になる
- **`SELECT COUNT(*)` を JOIN の前後で比べる。** 増えていたら §2 の潰しが漏れている
- 未突合の件数と金額を出す（`reconciliation.md` §3）

## 4. 縦持ちの土台を横へ戻す

取込側が横持ちを縦持ちに変換していることがある（`physical-columns.md` §4）。
出力が「得意先1行」なら、区分を列へ戻す。

```sql
SELECT
    cd,
    MAX(nm)                                          AS nm,
    SUM(CASE WHEN kubun = '備品' THEN sales ELSE 0 END) AS sales_bihin,
    SUM(CASE WHEN kubun = '備品' THEN gross ELSE 0 END) AS gross_bihin,
    SUM(sales)                                       AS sales_total
FROM flt
GROUP BY cd
```

`CASE` の値は**実データの全列挙**から取る（`reconciliation.md` §6）。
空の区分が混ざっていないか、`Total` 行が無いかをここで確認する。

## 5. 率は列を使わず再計算する

`粗利率` のような率の列は `11.3%` の文字列だったり、丸め済みだったりする。
**原本も再計算している**ことが多い。

```sql
DIV0(gross_total, sales_total) AS gross_rate   -- 列 _STRING_7 は使わない
```

## 6. 出力グレインは最終アウトプットに合わせる

「月別か期累計か」を勝手に決めない。協和は**期単位（得意先1件＝1行）**が正で、
各ソースの `月` 列は時間軸ではなくファイルのスタンプだった（`reconciliation.md` §7）。

月を落とすと決めたら、**各ソースの月が1種類しかないことを検算に残す。**
将来複数月のファイルが入った瞬間、静かに二重計上になる。

## 7. 別名は中間CTEが ASCII、最終SELECTが日本語

中間CTEは ASCII の snake_case。**最終SELECTは帳票の見出し（日本語）**にする —
その別名が kpiee のカラムラベルになり、レポート指標の選択肢と顧客が開く
「数値の明細表示」の見出しにそのまま出る（`SKILL.md` §2）。

日本語別名は VDI 経由のコピーでダブルクォートが壊れ `unexpected '集計'` の構文エラーになる
（協和で実測）。ただし**壊れると必ず構文エラーになる**ので、最終SELECTを1か所にまとめ、
壊れたらそのブロックだけ貼り直す。中間CTEを ASCII にするのは、数が多くて
壊れた箇所を特定しにくいから。

同じ理由で、**日本語のリテラル比較も避けられるなら避ける。**
協和の土台は `kubun = '備品'` が壊れたため `LENGTH(kubun) IN (2, 3)` で判定している
（備品=2文字 / 備品外=3文字）。**これは応急処置なので、そう分かるコメントを必ず残す。**

# 販路別集計の組み立て（CTE ＋ UNION ALL）

## 0. この類型でいいかを先に確かめる

これは**区分別統合型**（最終アウトプットの1行 = 区分×日付）の骨格。
最終アウトプットの1行が「得意先1件」のように**エンティティ単位**なら別の類型で、
`UNION ALL` ではなく土台に列を足す（`base-join-skeleton.md`）。
金額を配賦先へ移し替えるなら `allocation-sql-skeleton.md`。

**Excel の数式で見分ける。`VLOOKUP` が横に並んでいれば土台＋列足し型。**
ここを取り違えると全部作り直しになる。

## 1. 骨格

区分（販路・部門・チャネル）ごとにアセットが分かれていて、レイアウトも列名も違う。
これを「区分ごとに1つのCTE」で受け、全CTEの列構成をそろえてから UNION ALL する。

```sql
WITH
-- ④Amazon
amazon AS (
  SELECT
    IMPORT_30015_DATE_1 AS date,
    TRY_TO_DECIMAL(REGEXP_REPLACE(TO_VARCHAR(IMPORT_30015_BIGINT_13), '[^0-9.-]', ''), 18, 2) AS cost,
    CASE TRIM(IMPORT_30015_STRING_4, ' 　')
      WHEN '雲のやすらぎ_マニュアル' THEN '雲のやすらぎ'
      -- …実データの全列挙結果をここに反映する
      ELSE '不明'
    END AS product_group,
    'Amazon' AS channel,
    'Amazon' AS sub_channel
  FROM IMPORT_30015
),                          -- ← CTE の区切りカンマ。ここを落とすと後続CTEが消える

-- ③Yahoo!
yahoo AS (
  SELECT
    ...
  FROM IMPORT_300xx
),

-- ②楽天（サブ販路が複数アセットに分かれる例）
rakuten_rpp AS (
  SELECT ... FROM IMPORT_30020   -- RPP広告
),
rakuten_ca AS (
  SELECT ... FROM IMPORT_30019   -- クーポンアドバンス広告
),

-- ①自社（1アセット内でサブ販路が分岐する例）
own AS (
  SELECT ... FROM IMPORT_300xx
),
a8 AS (
  SELECT ... FROM IMPORT_30002   -- A8アフィリエイト
),

unioned AS (
  SELECT * FROM amazon
  UNION ALL SELECT * FROM yahoo
  UNION ALL SELECT * FROM rakuten_rpp
  UNION ALL SELECT * FROM rakuten_ca
  UNION ALL SELECT * FROM own
  UNION ALL SELECT * FROM a8
)

SELECT
  date                                            AS ymd,
  channel,
  sub_channel,
  COALESCE(NULLIF(TRIM(product_group, ' 　'), ''), '不明') AS product_group,
  SUM(cost)                                       AS cost
FROM unioned
GROUP BY 1, 2, 3, 4
ORDER BY 1, 2, 3, 4
```

**別名は中間CTEが ASCII、最終SELECTが日本語（帳票の見出し）。** 最終SELECTの別名が
kpiee のカラムラベルになり、顧客が開く「数値の明細表示」の見出しに出る（`SKILL.md` §2）。
日本語別名は VDI 経由のコピーでダブルクォートが壊れ `unexpected '集計'` になる実例があるが、
**壊れると必ず構文エラーになる**ので、最終SELECTを1か所にまとめ、そのブロックだけ貼り直す。

`UNION ALL` する区分別CTEは**中間CTE扱い**で ASCII に揃える。
日本語にするのは全体を束ねた最終SELECTだけ（列名は位置で結合されるので、
中間で日本語にすると破損時の特定が難しくなる）。

### 骨格のルール

- 全CTEが**同じ列名・同じ順序・同じ型**を返す。`UNION ALL` は列名ではなく位置で結合するので、
  順序がずれると別の指標が混ざる（エラーにならないので気づけない）。
- 該当しない列は `CAST(NULL AS NUMBER) AS xxx` のように明示的に埋める。
- `UNION`（重複排除）ではなく `UNION ALL` を使う。重複排除は最後の `GROUP BY` で意図的に行う。
- 集計は最終SELECTで1回だけ。CTEの中で `SUM` してから外でまた `SUM` すると、
  内訳の追跡ができなくなる。
- 販路名・サブ販路名はリテラルで持たせる。これが顧客帳票の行見出しになる。

## 2. 進める順序

ややこしい販路を後回しにして、単純な販路から1本ずつ完成・検算する。

1. 1アセット＝1販路で加工も薄いもの（例：Amazon、Yahoo!）
2. 複数アセットが1販路にまとまるもの（例：楽天 RPP／CA／TDA）
3. 1アセット内で条件によりサブ販路が分岐するもの（例：自社＝sizebook／自社その他／A8／アフィその他）
4. マスタ突合が必要なもの

各段階で「その販路だけの月次合計」を出して顧客帳票と突き合わせる。
全部つないでから検算すると、どの販路が原因かの切り分けができない。

## 3. サブ販路の分岐

1つのアセットの中で条件によってサブ販路が変わる場合、分岐条件は必ずユーザーに確認する。
推測で `LIKE '%アフィリ%'` のような条件を作ると、静かに別の販路へ紛れ込む。

```sql
own AS (
  SELECT
    ...,
    '自社' AS channel,
    CASE
      WHEN 媒体名 = 'sizebook'          THEN 'sizebook'
      WHEN 媒体名 ILIKE '%A8%'          THEN 'A8アフィリ'
      WHEN 媒体区分 = 'アフィリエイト'   THEN 'アフィその他'
      ELSE '自社その他'
    END AS sub_channel
  FROM IMPORT_300xx
)
```

`ELSE` が「その他」になる構造では、想定外の値も黙って「その他」に入る。
分岐後にサブ販路別の件数・金額を出し、「その他」が想定より大きくないか確認する。

## 4. マスタ突合が未確定のとき

分類（商品グループ）の突合ルールが決まっていない販路は、突合キーを列として残したまま
分類を `'不明'` にして先に進める。列を落とすと、後で突合ロジックが決まったときに作り直しになる。

```sql
a8 AS (
  SELECT
    TRY_TO_DATE(SPLIT_PART(IMPORT_30002_STRING_8, ' ', 1), 'YYYY/MM/DD') AS date,
    CAST(ROUND(
      TRY_TO_DECIMAL(REGEXP_REPLACE(TO_VARCHAR(IMPORT_30002_STRING_13), '[^0-9.-]', ''), 18, 2) * 1.3
    ) AS INT) AS cost,                 -- 1.3 = 手数料込み（根拠：要確認／ユーザー指定）
    IMPORT_30002_STRING_10 AS product_code,  -- 商品マスタ突合用に保持
    '不明' AS product_group,                 -- 商品マスタ突合が未確定のため暫定
    '自社' AS channel,
    'A8アフィリ' AS sub_channel
  FROM IMPORT_30002
)
```

`COALESCE(NULL, '不明')` のように NULL リテラルを包むのは意味がない。`'不明'` と直接書き、
なぜ暫定なのかをコメントに残す。

## 5. 検算クエリ

完成後、顧客の元帳票と突き合わせるための断面を出す。

```sql
-- 販路×月の合計
SELECT TO_CHAR(date, 'YYYY-MM') AS ym, channel, SUM(cost) AS cost, COUNT(*) AS rows
FROM unioned GROUP BY 1, 2 ORDER BY 1, 2;
```

```sql
-- 「不明」の残り具合（大きければマッピング漏れ）
SELECT channel, sub_channel, SUM(cost) AS cost, COUNT(*) AS rows
FROM unioned WHERE product_group = '不明' GROUP BY 1, 2 ORDER BY 3 DESC;
```

```sql
-- 変換失敗（NULL に化けた行）の検出
SELECT channel, COUNT(*) FROM unioned WHERE date IS NULL OR cost IS NULL GROUP BY 1;
```

数字が合わないときの切り分け順：行数 → 対象期間 → 重複 → 除外条件 → 掛け目。

## 6. 実例に出てくるIDの扱い

この文書のアセットID（30002=A8、30015=Amazon、30019=楽天CA、30020=楽天RPP など）は
特定案件の実測値。別案件では必ず取り直す。IDを書き写して流用しない。

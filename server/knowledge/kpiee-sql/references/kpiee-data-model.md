# アセットと物理カラムの特定

## 1. 命名規則

| 対象 | 形式 | 例 |
|---|---|---|
| テーブル | `IMPORT_<アセットID>` | `IMPORT_30015` |
| カラム | `IMPORT_<アセットID>_<型>_<列順>` | `IMPORT_30015_BIGINT_13` |

型部分に現れるのは `STRING` / `BIGINT` / `DOUBLE` / `DATE` など取込時の推定型。
kpiee のレポート内部SQLも同じ物理名を参照している（`kpiee-designs` の
`docs/feature/reports/IMP_KP000965/basic_design/report_import_query.sql` が実例）。

### 落とし穴

- **型は当てにならない。** 金額が `BIGINT` でも中身は `"1,234"`、率が `BIGINT` でも実体は小数。
  型名ではなく、カラム名（業務名）と実データを見て判断する。
- **数値化は `TRY_TO_DECIMAL`。** 金額は `(x, 18, 2)`、率は `(x, 12, 6)`。
  `TRY_TO_NUMBER` は scale=0 で小数を切り捨てる（`cleansing-recipes.md` §2）。
- **列順は固定ではない。** 顧客が取込ファイルの列を差し替えると `_13` の中身が変わる。
  作ったSQLは「どのアセットIDのどの連番が、どの業務名だったか」をコメントで残す。
- **アセットIDは案件（ワークスペース）ごとに違う。** 別案件へ流用するときはIDを必ず取り直す。
  過去案件のIDをそのまま書き写すのが一番多い事故。

## 2. MCP（app.kpiee.com コネクタ）での確認手順

**物理カラム名の取得は Redash（`physical-columns.md`）が先。** ここは値の検証の話。
顧客ワークスペースは共用アカウントからは見えないので、以下が使えるのは
自社ワークスペース（ws4「データX」）での検証時か、権限のあるアカウントのときだけ。

1. `get_basic_information` — 用語と制約の確認（初回のみ）
2. `list_workspaces` — 対象 `workspace_id` を特定
3. `list_table_data_files`（`keyword` で絞る／予算データは `template_type=budget`）
   または `list_record_data_files`（履歴データ）
4. `get_table_data_file_detail` / `get_record_data_file_detail` —
   `table_name` とカラム定義（物理名・型・ラベル）を取得
5. `execute_sql` — SELECT のみ発行して中身を見る
   （`data_file_ids` に参照するデータファイルIDを渡す。実行45秒・10,000行・60回/分の制限あり）

### 最初に流す確認クエリ

```sql
-- 値の実体（カンマ・通貨記号・全角・前後空白・時刻付き日付の有無を見る）
SELECT IMPORT_30015_DATE_1, IMPORT_30015_STRING_4, IMPORT_30015_BIGINT_13
FROM IMPORT_30015
LIMIT 20;
```

```sql
-- 分類キーの全列挙。CASE はこの結果を全部覆う
SELECT IMPORT_30015_STRING_4 AS campaign, COUNT(*) AS rows
FROM IMPORT_30015
GROUP BY 1
ORDER BY 2 DESC;
```

```sql
-- 期間と行数（顧客帳票との突き合わせの土台）
SELECT MIN(IMPORT_30015_DATE_1), MAX(IMPORT_30015_DATE_1), COUNT(*)
FROM IMPORT_30015;
```

```sql
-- 数値化できない行を洗い出す（TRY_ 系で NULL に化ける行の把握）
SELECT IMPORT_30015_BIGINT_13 AS raw_cost, COUNT(*)
FROM IMPORT_30015
WHERE IMPORT_30015_BIGINT_13 IS NOT NULL
  AND TRY_TO_DECIMAL(REGEXP_REPLACE(TO_VARCHAR(IMPORT_30015_BIGINT_13), '[^0-9.-]', ''), 18, 2) IS NULL
GROUP BY 1;
```

MCPが使えない場合は、上記を「実行して結果を貼ってほしいクエリ」としてユーザーに渡す。
推測でマッピングを埋めない。

## 3. 出力側の命名

- **中間CTEの別名は ASCII の snake_case**（`date` / `cost` / `product_group` / `sub_channel`）。
- **最終SELECTの別名は日本語（帳票の見出し）。** その別名が kpiee のカラムラベル（論理名）に
  なり、レポート指標の選択肢と、顧客が開く「数値の明細表示」の列見出しにそのまま出る
  （`SKILL.md` §2、`calc-spec.md` §6）。ASCII のままだと `sga_after_alloc` が顧客に見える。
- **VDI 経由のコピーでダブルクォート付き識別子のマルチバイトが壊れ
  `unexpected '集計'` の構文エラーになる**（協和で実測）。ただし壊れると必ず構文エラーになるので、
  最終SELECTを1か所にまとめて壊れたらそのブロックだけ貼り直す。
  中間CTEを ASCII にするのは、数が多くて破損箇所を特定しにくいから。
- 日本語のリテラル比較（`kubun = '備品'`）も壊れうる。`'不明'` 処理も含め
  マルチバイトはどうせSQLに残るので、別名だけ ASCII にしても回避にならない。
- 物理名（`DC_SQL_JOB_xxxx_STRING_C1`）が必要なのは、SQLジョブが**別のジョブ出力を
  FROM で参照する**ときだけ（`physical-columns.md` §6）。レポート定義は論理名で選ぶ。

## 4. データ種別の使い分け（kpiee 側の用語）

| 種別 | 中身 | 主な用途 |
|---|---|---|
| 階層データ（マスタ） | 組織・科目などのツリー。コードで数値と紐づく | 分類軸。レポート側で階層集計される |
| 履歴データ | 時系列に蓄積される数値 | 実績値の原本 |
| 表形式データ | 表そのまま。予算データもここ | 取込生データ、SQLジョブの出力先 |

月次ロールアップやマスタ階層の集計はレポート側の責務。SQLジョブでは
日次粒度＋分類コードを素直に出しておき、SQL内で先に丸めない（丸めると内訳が追えなくなる）。

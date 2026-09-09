# 提出前チェックと頻出エラー

## 1. SQLジョブの契約（違反すると実行前に弾かれる）

根拠：`atlas-core/rails/app/services/sql_jobs/query_scanner.rb`

### 構文レベル

| 制約 | 内容 |
|---|---|
| 単一文のみ | セミコロン区切りの複数文は `multiple_statements_not_allowed` |
| 先頭は SELECT / WITH | それ以外は `invalid_statement_start` |
| DDL/DML禁止 | `INSERT` `UPDATE` `DELETE` `MERGE` `CREATE` `DROP` `ALTER` `TRUNCATE` `USE` |
| stage禁止 | `@stage` `@~/path` `@%table` など `@` を含む参照 |
| 修飾付き関数禁止 | `schema.func()` `db.schema.func()`（関数名に関わらず不可） |
| 参照先の限定 | `FROM` / `JOIN` は登録済みアセット（同一スキーマ）のみ |

### 禁止関数

コンテキスト・メタデータ・権限系。**括弧なしの形（`SELECT CURRENT_USER`）も禁止**。

```
get_ddl, generate_column_description, result_scan, last_query_id, last_transaction,
current_session, current_statement, current_transaction, current_account, current_account_name,
current_organization_name, current_organization_user, current_user, current_role, current_role_type,
current_available_roles, current_secondary_roles, current_warehouse, current_database,
current_schema, current_schemas, current_version, current_client, current_ip_address, current_region,
all_user_names, sys_context, set_sys_context, getvariable, policy_context,
get_condition_query_uuid, invoker_role, invoker_share,
is_role_activated, is_role_in_session, is_granted_to_invoker_role,
is_application_role_activated, is_application_role_in_session, is_database_role_in_session,
is_instance_role_in_session, is_group_activated, is_group_imported, is_user_imported,
is_organization_user, is_organization_user_group, is_organization_user_group_in_session,
explain_privileges, explain_grantable_privileges
```

加えて `system$` で始まる関数はすべて禁止。

`CURRENT_DATE` / `CURRENT_TIMESTAMP` はこのリストに入っていないので使える。
ただし実行日基準の集計は再実行で結果が変わるため、期間は原則リテラルかパラメータで渡す。

## 2. 提出前チェックリスト

**構造**

- [ ] `WITH` の各CTEの閉じ括弧の後にカンマがあるか（最後のCTEのみカンマなし）
- [ ] 全CTEの列数・列順・列名が一致しているか（`UNION ALL` は位置で結合する）
- [ ] CTE名の重複がないか。CTE名とアセット名が衝突していないか
- [ ] 最終SELECTの `GROUP BY` に、集計関数以外の全列が入っているか
- [ ] **中間CTEの別名が ASCII か。最終SELECTの別名が帳票の見出し（日本語）か**
      （最終SELECTの別名がカラムラベルになり顧客の明細に出る。`SKILL.md` §2）
- [ ] 最終SELECTが1か所にまとまっているか（VDI で壊れたときブロック単位で貼り直せる形か）
- [ ] **キーの母集合を土台1本から作っているか**（和集合にしていないか。根拠があるなら書いたか）
- [ ] **引き算・残余の駆動表が「総額側」か**（実績側を左に置いていないか）
- [ ] 付随ソースを1キー1行に潰してから `JOIN` しているか
- [ ] `JOIN` が全て `LEFT` か。加算式の各項に `COALESCE(..., 0)` があるか

**変換**

- [ ] **金額を `TRY_TO_DECIMAL(x, 18, 2)` で数値化したか**
      （`TRY_TO_NUMBER` は scale=0。小数が黙って切り捨てられる）
- [ ] **率・構成比・按分比率を `TRY_TO_DECIMAL(x, 12, 6)` にしたか**（0 に潰れていないか）
- [ ] 日付化する列すべてに **書式を明示した** `TRY_TO_DATE(x, 'YYYY/MM/DD')` を通したか
      （1引数版は素直な文字列でも NULL を返す）
- [ ] 同じ日付列に複数書式（`YYYY/MM/DD` / `YYYYMM` / Excelシリアル値）が混ざっていないか
- [ ] 掛け目・端数処理をユーザー指定どおりに書いたか。指定がない場合その旨をコメントしたか

**分類**

- [ ] 空白の分類キーが `'不明'` に寄るか（`COALESCE` 単体ではなく `NULLIF(TRIM(...), '')` を挟んだか）
- [ ] `CASE` のマッピングが実データの全列挙結果を覆っているか
- [ ] `ELSE '不明'` / `ELSE 'その他'` に落ちる件数・金額を確認したか
- [ ] 部分一致 `CASE` の条件順が、狭い条件 → 広い条件になっているか

**契約**

- [ ] 文が1本だけか（末尾のセミコロンは付けない）
- [ ] 禁止キーワード・禁止関数・`@`・修飾付き関数呼び出しがないか
- [ ] `FROM` / `JOIN` の参照先が登録済みアセットとCTEだけか

**根拠の突き合わせ**（配賦・按分があるとき必須）

原本 Excel は見られない前提なので、根拠はレポート付録の数式原文まで。

- [ ] 配賦元の総額の**出所シート**を付録の数式で確認したか（無ければ「不明」と書いたか）
- [ ] 既配賦として引く項目の**数**が数式の項数と一致するか
- [ ] 分母の**母集合条件**（`">0"` など）を数式から拾ったか
- [ ] 付録に数式が無い列を「根拠なし」として分離し、件数を出したか
- [ ] 数式が存在しない列（手入力・手作業転記）を「未確定」として分離したか
- [ ] 正解値をもらえていない項目に「未検証」と明記したか

**検算**

- [ ] **本体を流す前に事前検証（変換の成否・前提・一意性・未マッチ・残余マイナス）を出したか**
- [ ] 結合する全ソースの**月分布を1本のクエリ**で並べたか（噛み合わないと無言で0件になる）
- [ ] 販路×月の合計を出したか。顧客帳票と一致したか
- [ ] `date IS NULL` / `cost IS NULL` の件数を確認したか
- [ ] `JOIN` で行数が増えていないか（突合前後の件数比較）
- [ ] 合計が 0 の項目を「データ無し」と判断していないか（符号で割ったか）

## 3. 頻出エラーと原因

| メッセージ | 実際の原因 |
|---|---|
| `オブジェクト 'CA' は存在しません`（invalid identifier / does not exist） | 直前のCTEの閉じ括弧の後のカンマ落ち。カンマがないと後続の `ca AS (...)` がCTEとして認識されない。差分だけ貼り替えたときに最も起きやすい |
| 同上 | CTE名のタイポ、または参照側と定義側の綴り違い |
| `SQL compilation error: ... not a valid group by expression` | 最終SELECTの非集計列が `GROUP BY` から漏れている |
| `Numeric value 'xxx' is not recognized` | `TRY_` を付けずに `CAST`/`TO_NUMBER` した。1行の異常値で全体が落ちる |
| `Can't parse 'xxxx/x/x' as date` | 書式指定と実データの不一致（ゼロ埋めなし、和暦、時刻付き） |
| 結果が0行 | 期間フィルタの型不一致（文字列日付に対して日付比較）、`JOIN` が `INNER` で全件落ちた |
| 金額が想定の数倍 | `JOIN` で行が増殖（マスタ側のキー重複）、または同じアセットを2つのCTEで二重計上 |
| 特定販路だけ数値が合わない | 掛け目・税の扱いがその販路だけ違う。除外条件（テスト注文・キャンセル）の未適用 |
| 列の中身が別の指標になっている | `UNION ALL` する各CTEの列順不一致。エラーは出ない |
| `multiple statements are not allowed` | 検算用クエリを一緒に貼った、または末尾のセミコロン以降に何か残っている |
| `... is not allowed`（関数系） | `CURRENT_USER` 等の禁止関数。§1のリストを確認 |
| `指定したカラムが存在しません` | 物理カラム名の**接頭辞を省いた**（`STRING_1` ではなく `IMPORT_30008_STRING_1`）。または**ジョブ出力を元クエリの日本語別名で参照した**（`AS "月"` と書いてあっても参照名は `DC_SQL_JOB_0028_DATE_C1`） |
| `テーブルが存在しません` | ジョブ出力のテーブル名（`DC_EXPORTED_300xx`）の推定違い。SQLジョブ画面の `入力一覧` からアセット名をクリック挿入する。または入力にそのアセットを選んでいない |
| `unexpected '集計'` 等、日本語の断片が出る構文エラー | 日本語別名のダブルクォートが VDI 経由のコピーで壊れた（協和で実測）。**最終SELECTのブロックだけ貼り直す。** 中間CTEで出たならその別名を ASCII に直す。最終SELECTの別名は顧客の明細見出しになるので ASCII に逃げない（`SKILL.md` §2） |
| 按分額・構成比が全て 0 | `TRY_TO_NUMBER`（scale=0）で比率を数値化して 0 に潰れた。`TRY_TO_DECIMAL(x, 12, 6)` にする |
| 特定の実績だけ全件消える | 日付変換が NULL 化して結合キーが NULL になった。または結合するソース同士で月が噛み合っていない（`reconciliation.md` §7） |
| 金額が丸ごと NULL | 加算式の項に空欄由来の NULL が混ざった。`COALESCE(..., 0)` の付け忘れ |

## 4. エラー報告を受けたときの動き

ユーザーが「エラーになった」と言ってきたら、原因を推測で1つに決めない。

1. **実行したSQL全文**をもらう。差分やスクリーンショットの一部では原因が特定できない
   （カンマ落ち・貼り替えミスは、まさに見えていない部分で起きている）
2. エラーメッセージの原文をもらう
3. 上の表で当たりを付け、該当箇所を含む**CTE単位の完成形**を返す
4. 直したうえで、同じ事故が起きた構造（差分貼り替え）そのものを避ける形で渡す

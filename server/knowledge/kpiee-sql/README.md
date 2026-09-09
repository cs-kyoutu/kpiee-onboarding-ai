# kpiee 構築SQL のナレッジ（同梱コピー）

SQL構築チャット（`src/sqlChat.ts`)が参照するナレッジ。

- **原本は `kpiee-research/skills/kpiee-sql-builder/`**（このリポジトリの外）。
  ここにあるのはデプロイへ載せるためのコピーで、手で編集しない。
- 原本を更新したら、次のコマンドで丸ごと写し直してコミットする:

```powershell
Copy-Item ..\..\..\skills\kpiee-sql-builder\SKILL.md server\knowledge\kpiee-sql\SKILL.md -Force
Copy-Item ..\..\..\skills\kpiee-sql-builder\references\*.md server\knowledge\kpiee-sql\references\ -Force
```

- `SKILL.md` と `references/workflow.md` はシステムプロンプトへ常時入る。
  残りの references はチャットの `read_reference` 道具でオンデマンドに読まれる
  （全部を常時入れるとプロンプトが太りすぎるため。Q&A エージェントと同じ戦略）。

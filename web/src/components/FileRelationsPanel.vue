<script setup lang="ts">
// ブック（ファイル）関係の登録。シート単位の自動解析より上位の入力段階。
//
// なぜこの段階が要るか:
//   Excel の数式はファイルを跨げないため、ファイル間の関係は「値の一致による手コピー推定」しか
//   自動検出できず、正しい推定もノイズも同じ確度で並ぶ。逆に担当者が知っているつながり
//   （外部リンク・ピボット・人手の転記）は自動検出できないと図から消えてしまう。
//   ここで人の業務知識を入れると、シート関係の確度補正とレポートの説明文に反映される。
//
// 自動検出は「初期案」として出すだけで、確定するのは人。ファイルが多い案件のために一括確定も置く。
import { computed, onMounted, ref } from 'vue'
import {
  getFileRelations, addFileRelation, acceptAllFileRelations, updateFileRelation, deleteFileRelation,
  type FileRelationsData, type FileRelType, type FileRelVerdict,
} from '../api'

const props = defineProps<{ projectId: number }>()
// 関係を変えるとシート関係の確度・レポートが変わるので、親から他パネルへ再読込を伝えてもらう
const emit = defineEmits<{ changed: [] }>()

const data = ref<FileRelationsData | null>(null)
const loading = ref(true)
const error = ref('')
const busy = ref(false)

// 手動追加フォーム
const newFrom = ref<number | null>(null)
const newTo = ref<number | null>(null)
const newType = ref<FileRelType>('aggregate')
const newNote = ref('')

const REL_LABELS: Record<FileRelType, string> = {
  aggregate: '集計',
  reference: '参照・マスタ引き当て',
  transcribe: '転記',
  manual_copy: '手作業コピー',
  unknown: '種別未設定',
}
const REL_TYPES = Object.keys(REL_LABELS) as FileRelType[]

const VERDICT_INFO: Record<FileRelVerdict, { label: string; cls: string; desc: string }> = {
  matched: { label: '一致', cls: 'ok', desc: 'ご登録どおりのつながりを自動解析でも確認できました。' },
  declared_not_detected: {
    label: '自動検出できず', cls: 'ng',
    desc: '登録された関係の根拠（数式・値の一致）が見つかりませんでした。外部リンク・ピボット・手作業の可能性があります。',
  },
  detected_not_declared: {
    label: '登録なし', cls: 'warn',
    desc: '自動検出したが登録がない関係です。把握されていない経路か、偶然の値一致かを確認してください。',
  },
  direction_conflict: {
    label: '向きが逆', cls: 'ng',
    desc: '登録の向きと検出した値の流れが逆です。どちらが元データかを顧客に確認してください。',
  },
}

const files = computed(() => data.value?.files ?? [])
const fileNameOf = (label: string) => files.value.find(f => f.label === label)?.filename ?? label

/** どのブック関係にも登場しないファイル（確認漏れの温床なので必ず見せる） */
const unlinked = computed(() => {
  const d = data.value
  if (!d) return []
  const used = new Set<string>()
  for (const r of d.declared) { used.add(r.fromFile); used.add(r.toFile) }
  for (const p of d.proposed) { used.add(p.fromFile); used.add(p.toFile) }
  return d.files.filter(f => !used.has(f.label))
})

async function load() {
  error.value = ''
  try {
    data.value = await getFileRelations(props.projectId)
  } catch (e) {
    error.value = String(e)
  } finally {
    loading.value = false
  }
}

/** 変更後は一覧を取り直し、シート関係・レポート側にも反映されるよう親へ通知する */
async function mutate(fn: () => Promise<unknown>) {
  error.value = ''
  busy.value = true
  try {
    await fn()
    await load()
    emit('changed')
  } catch (e) {
    error.value = String(e)
  } finally {
    busy.value = false
  }
}

function confirmProposal(p: FileRelationsData['proposed'][number], relType: FileRelType) {
  return mutate(() => addFileRelation(props.projectId, {
    fromArtifactId: p.fromArtifactId, toArtifactId: p.toArtifactId,
    relType, note: p.reason, origin: 'auto',
  }))
}

function acceptAll() {
  return mutate(() => acceptAllFileRelations(props.projectId))
}

function addManual() {
  if (newFrom.value === null || newTo.value === null) return
  return mutate(async () => {
    await addFileRelation(props.projectId, {
      fromArtifactId: newFrom.value!, toArtifactId: newTo.value!,
      relType: newType.value, note: newNote.value.trim(),
    })
    newNote.value = ''
  })
}

/** 初期案の種別セレクトの選択状態（確定前にその場で直せるようにする） */
const proposalType = ref<Record<string, FileRelType>>({})
const proposalKey = (p: { fromFile: string; toFile: string }) => `${p.fromFile}>${p.toFile}`
const typeOfProposal = (p: FileRelationsData['proposed'][number]) =>
  proposalType.value[proposalKey(p)] ?? p.relType

onMounted(load)
</script>

<template>
  <div class="panel">
    <h2>ブック関係 — ファイルどうしのつながりを確定する</h2>
    <p class="muted">
      Excel の数式は<strong>ファイルを跨げない</strong>ため、ファイル間のつながりは自動では「値の一致からの推定」しか出せません。
      ここで<strong>「このファイルはあのファイルへ集約している」</strong>という業務知識を登録すると、
      シート関係の確度に反映され、顧客共有レポートにもそのまま説明として載ります。
    </p>

    <p v-if="loading" class="muted" style="padding: 12px 0">読み込み中…</p>
    <p v-if="error" class="error-box">{{ error }}</p>

    <template v-if="data">
      <div v-if="files.length === 0" class="muted" style="padding: 12px 0">
        関係を登録できるファイル（.xlsx / .csv）がまだありません。「資料アップロード」から追加してください。
      </div>

      <template v-else>
        <!-- ① 自動検出の初期案 -->
        <section class="frsec">
          <div class="frhead">
            <h3>自動検出された関係（初期案）</h3>
            <button
              v-if="data.proposed.length > 1" :disabled="busy"
              @click="acceptAll"
            >すべて確定（{{ data.proposed.length }}件）</button>
          </div>
          <p class="muted">
            シート関係の解析から見つかったファイル間のつながりです。<strong>種別と説明を直してから確定</strong>してください。
            誤検出（偶然の値一致）なら確定せず放置して構いません。
          </p>
          <div v-if="data.proposed.length === 0" class="muted frempty">
            未登録の自動検出はありません。
          </div>
          <div v-for="p in data.proposed" :key="proposalKey(p)" class="frcard">
            <div class="frflow">
              <b>{{ fileNameOf(p.fromFile) }}</b>
              <span class="frarrow">──▶</span>
              <b>{{ fileNameOf(p.toFile) }}</b>
              <span class="badge info">自動検出</span>
            </div>
            <div class="frreason muted">{{ p.reason }}</div>
            <div class="frform">
              <select :value="typeOfProposal(p)" @change="proposalType[proposalKey(p)] = ($event.target as HTMLSelectElement).value as FileRelType">
                <option v-for="t in REL_TYPES" :key="t" :value="t">{{ REL_LABELS[t] }}</option>
              </select>
              <button class="primary" :disabled="busy" @click="confirmProposal(p, typeOfProposal(p))">確定</button>
            </div>
          </div>
        </section>

        <!-- ② 登録済み -->
        <section class="frsec">
          <h3>登録済みのブック関係（{{ data.declared.length }}件）</h3>
          <p class="muted">説明文は顧客共有レポートの各ロジックブロックに「担当者の説明」として掲載されます。</p>
          <table v-if="data.declared.length > 0">
            <thead>
              <tr>
                <th style="width: 30%">関係</th>
                <th style="width: 170px">種別</th>
                <th>説明（レポートに掲載）</th>
                <th style="width: 70px">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in data.declared" :key="r.id">
                <td>
                  {{ fileNameOf(r.fromFile) }} <span class="frarrow">→</span> {{ fileNameOf(r.toFile) }}
                  <span v-if="r.origin === 'auto'" class="badge info">自動由来</span>
                </td>
                <td>
                  <select
                    :value="r.relType"
                    @change="mutate(() => updateFileRelation(r.id, { relType: ($event.target as HTMLSelectElement).value as FileRelType }))"
                  >
                    <option v-for="t in REL_TYPES" :key="t" :value="t">{{ REL_LABELS[t] }}</option>
                  </select>
                </td>
                <td>
                  <input
                    type="text" :value="r.note" placeholder="例: 日次の売上を月単位に集約しています"
                    @change="mutate(() => updateFileRelation(r.id, { note: ($event.target as HTMLInputElement).value }))"
                  />
                </td>
                <td><button class="danger" :disabled="busy" @click="mutate(() => deleteFileRelation(r.id))">削除</button></td>
              </tr>
            </tbody>
          </table>
          <div v-else class="muted frempty">まだ登録がありません。上の初期案を確定するか、下から手動で追加してください。</div>

          <div class="frform frmanual">
            <select v-model.number="newFrom">
              <option :value="null">元ファイル…</option>
              <option v-for="f in files" :key="f.id" :value="f.id">{{ f.filename }}</option>
            </select>
            <span class="frarrow">→</span>
            <select v-model.number="newTo">
              <option :value="null">先ファイル…</option>
              <option v-for="f in files" :key="f.id" :value="f.id">{{ f.filename }}</option>
            </select>
            <select v-model="newType">
              <option v-for="t in REL_TYPES" :key="t" :value="t">{{ REL_LABELS[t] }}</option>
            </select>
            <input v-model="newNote" type="text" placeholder="説明（任意。レポートに掲載されます）" style="min-width: 240px; flex: 1" />
            <button
              class="primary"
              :disabled="busy || newFrom === null || newTo === null || newFrom === newTo"
              @click="addManual"
            >＋ 追加</button>
          </div>
        </section>

        <!-- ③ 未接続ファイル -->
        <section v-if="unlinked.length > 0" class="frsec">
          <h3>どのファイルともつながっていないファイル（{{ unlinked.length }}件）</h3>
          <p class="muted">
            自動検出でもつながりが出ず、登録もされていないファイルです。
            <strong>本当に単独で使われているのか、それとも見落としているつながりがあるのか</strong>を確認してください。
          </p>
          <div class="frchips">
            <span v-for="f in unlinked" :key="f.id" class="frchip">{{ f.filename }}</span>
          </div>
        </section>

        <!-- ④ 突き合わせ -->
        <section v-if="data.audit.length > 0" class="frsec">
          <h3>登録内容と自動解析の突き合わせ</h3>
          <p class="muted">食い違いは顧客共有レポートの「ご確認いただきたい点」にも自動で載ります。</p>
          <table>
            <thead>
              <tr><th style="width: 34%">関係</th><th style="width: 130px">判定</th><th style="width: 90px">検出数</th><th>意味</th></tr>
            </thead>
            <tbody>
              <tr v-for="(a, i) in data.audit" :key="i">
                <td>{{ fileNameOf(a.fromFile) }} <span class="frarrow">→</span> {{ fileNameOf(a.toFile) }}</td>
                <td><span class="badge" :class="VERDICT_INFO[a.verdict].cls">{{ VERDICT_INFO[a.verdict].label }}</span></td>
                <td>{{ a.detectedTotal > 0 ? a.detectedTotal.toLocaleString() : '—' }}</td>
                <td class="muted">{{ VERDICT_INFO[a.verdict].desc }}</td>
              </tr>
            </tbody>
          </table>
        </section>
      </template>
    </template>
  </div>
</template>

<style scoped>
.frsec { margin-top: 22px; }
.frsec > h3 { font-size: 15px; margin: 0 0 4px; }
.frhead { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.frempty { padding: 10px 0; }
.frcard {
  border: 1px solid var(--border);
  border-left: 4px solid var(--primary);
  border-radius: var(--r);
  padding: 11px 14px;
  margin-top: 10px;
  background: var(--panel);
}
.frflow { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; font-size: 13.5px; }
.frflow b { word-break: break-all; }
.frarrow { color: var(--muted-2); font-family: monospace; }
.frreason { margin-top: 3px; }
.frform { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 9px; }
.frmanual {
  margin-top: 14px;
  padding: 12px 14px;
  border: 1px dashed var(--border-strong);
  border-radius: var(--r);
}
.frchips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
.frchip {
  border: 1px solid var(--warn);
  background: var(--warn-bg);
  color: var(--warn);
  border-radius: 20px;
  padding: 3px 12px;
  font-size: 12.5px;
}
</style>

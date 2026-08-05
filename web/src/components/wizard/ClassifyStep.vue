<script setup lang="ts">
// 新UI ステップ2: シートの分類（インプット / マスタ / 中間 / 最終アウトプット）を確認する。
//
// ここが後段すべての前提になる。「どれが最終アウトプットか」「どれがマスタか」は業務知識で、
// 構造からは決められない（マスタと raw はどちらも「参照される出発点」で見分けが付かない）。
// なので自動判定を初期値として出し、人が直す形にする。
//
// 「確定」は全ファイルの役割を明示的に保存し、roles_confirmed の印を立てる（人が見た証跡）。
// 確定後は編集をロックする。後段（関係図・レポート）がこの分類を前提に作られるため、
// 気づかず書き換わるのを防ぐ。直したいときは「確定を解除」で明示的に開けてもらう。
import { computed, ref, watch } from 'vue'
import {
  patch, setProjectFlag, clearProjectFlag,
  type Artifact, type SheetClassification,
} from '../../api'

const props = defineProps<{ projectId: number; artifacts: Artifact[]; confirmed: boolean }>()
const emit = defineEmits<{ changed: [] }>()

// 確定済みは既定でロック。解除すると編集できる（解除したこと自体も画面に出す）
const unlocked = ref(false)
const locked = computed(() => props.confirmed && !unlocked.value)

// 凡例は「短い語 ＋ hover で補足」に留める。説明文を並べると読む前に諦められるので、
// 画面に常時出す文字は最小限にし、詳しい言い方は title（ツールチップ）へ逃がす。
const ROLES = [
  { value: 'input_data', label: 'インプット', hint: '加工前の元データ。基幹システムの出力や CSV' },
  { value: 'master_data', label: 'マスタ', hint: '部門・商品などの対応表。集計の軸になる' },
  { value: 'working_sheet', label: '中間', hint: '集計・整形の途中。数式が入る' },
  { value: 'final_output', label: '最終アウトプット', hint: '顧客が見る帳票。kpiee で再現する対象' },
  { value: 'unknown', label: '未分類', hint: '判断がつかないもの。残すと確認待ちになる' },
] as const

type Row = { sheet: string; role: string; reason: string; rowCount: number | null; formulaCount: number | null }
type Book = { artifactId: number; filename: string; rows: Row[] }

const books = ref<Book[]>([])
const saving = ref(false)
const saved = ref(false)
const error = ref('')
// 保存の進捗（何ファイル目か）。1件ずつ PATCH するので途中で止まっても分かるようにする
const savedCount = ref(0)

/** 解析できたファイルだけが対象（解析失敗・非対応形式は分類しても意味がない） */
const targets = computed(() => props.artifacts.filter(a => a.parse_status === 'done'))

const unknownCount = computed(() =>
  books.value.reduce((n, b) => n + b.rows.filter(r => r.role === 'unknown').length, 0))
const finalCount = computed(() =>
  books.value.reduce((n, b) => n + b.rows.filter(r => r.role === 'final_output').length, 0))

/**
 * 表は artifacts.sheet_roles（一覧取得で既に手元にある）から組む。
 * 以前はファイルごとに /artifacts/:id/preview を叩いていたが、あれは原本を再パースする
 * （無保存モードでは Drive 再取得まで走る）ため、ファイル数ぶんの重い待ちになっていた。
 * 行数・数式数は取込時に sheet_roles へ入れてある（古いデータには無いので「—」表示）。
 */
function buildBooks() {
  error.value = ''
  books.value = targets.value.map(a => {
    let roles: Record<string, SheetClassification> = {}
    try {
      roles = a.sheet_roles ? JSON.parse(a.sheet_roles) as Record<string, SheetClassification> : {}
    } catch {
      roles = {} // 壊れた保存値は空扱い（役割を選び直してもらう）
    }
    return {
      artifactId: a.id,
      filename: a.original_filename,
      rows: Object.entries(roles).map(([sheet, c]) => ({
        sheet,
        role: c.role ?? 'unknown',
        reason: c.reason ?? '自動判定なし',
        rowCount: c.rows ?? null,
        formulaCount: c.formulas ?? null,
      })),
    }
  })
}

/** 1ファイルの全シートを同じ役割にする（部門別ブックのように役割が揃っている場合の近道） */
function applyAll(book: Book, role: string) {
  for (const r of book.rows) r.role = role
  saved.value = false
}

async function confirmAll() {
  saving.value = true
  error.value = ''
  savedCount.value = 0
  try {
    for (const book of books.value) {
      if (book.rows.length === 0) continue
      await patch(`/artifacts/${book.artifactId}/roles`, {
        sheet_roles: Object.fromEntries(book.rows.map(r => [r.sheet, r.role])),
      })
      savedCount.value++
    }
    // 人が確認した印。自動分類の結果が入っているだけでは完了にしないため、ここで初めて立つ
    await setProjectFlag(props.projectId, 'roles_confirmed')
    saved.value = true
    unlocked.value = false // 確定したらまたロックする
    emit('changed')
  } catch (e) {
    error.value = String(e)
  } finally {
    saving.value = false
  }
}

/** 確定を解除して編集できるようにする（印を外し、後段が古い前提で進まないようにする） */
async function unlock() {
  error.value = ''
  try {
    await clearProjectFlag(props.projectId, 'roles_confirmed')
    unlocked.value = true
    saved.value = false
    emit('changed')
  } catch (e) {
    error.value = String(e)
  }
}

// 取り込みの増減・役割の保存で artifacts が変わったら組み直す（immediate で初回も作る）
watch(() => targets.value.map(a => a.id + ':' + (a.sheet_roles ?? '').length).join(','), buildBooks, { immediate: true })
</script>

<template>
  <div class="wz-body">
    <p class="wz-lede">
      シートの役割を確認します。自動判定が初期値です。<b>最終アウトプット</b>と<b>マスタ</b>だけは
      構造から判断できないため、ここでの指定が以降の前提になります。
    </p>

    <div class="wz-legend">
      <span v-for="r in ROLES" :key="r.value" class="lg" :class="`role-${r.value}`" :title="r.hint">
        <i></i>{{ r.label }}
      </span>
    </div>

    <p v-if="error" class="error-box">{{ error }}</p>
    <p v-if="targets.length === 0" class="muted">解析済みのファイルがありません。前のステップで取り込んでください。</p>

    <!-- 確定/編集中の状態。今どちらなのかが一目で分かるようにする -->
    <div v-if="props.confirmed || unlocked" class="wz-lockbar" :class="locked ? 'is-locked' : 'is-open'">
      <span class="ico">{{ locked ? '🔒' : '✏️' }}</span>
      <span class="tx">
        <b>{{ locked ? '確定済み（編集ロック中）' : '編集中（未確定）' }}</b>
        <em>{{ locked
          ? 'この分類を前提に関係図とレポートを作っています。直すにはロックを解除してください。'
          : '直したら「この分類で確定する」を押してください。押すまで後段は前の分類のままです。' }}</em>
      </span>
      <button v-if="locked" @click="unlock">確定を解除して編集する</button>
    </div>

    <div v-for="book in books" :key="book.artifactId" class="wz-card">
      <div class="wz-book-head">
        <h3 class="wz-h">{{ book.filename }}</h3>
        <span class="muted">{{ book.rows.length }} シート</span>
        <span v-if="!locked" class="wz-bulk">
          一括:
          <button v-for="r in ROLES.slice(0, 4)" :key="r.value" class="link" @click="applyAll(book, r.value)">
            {{ r.label }}
          </button>
        </span>
      </div>
      <p v-if="book.rows.length === 0" class="muted">シート情報がありません。取り込み直してください。</p>
      <table v-else class="wz-table">
        <thead>
          <tr><th>シート</th><th>行数</th><th>数式セル</th><th>役割</th><th>自動判定の理由</th></tr>
        </thead>
        <tbody>
          <tr v-for="r in book.rows" :key="r.sheet" :class="{ warn: r.role === 'unknown' }">
            <td class="nm">{{ r.sheet }}</td>
            <td class="num">{{ r.rowCount === null ? "—" : r.rowCount.toLocaleString() }}</td>
            <td class="num">{{ r.formulaCount === null ? "—" : r.formulaCount.toLocaleString() }}</td>
            <td>
              <select v-model="r.role" :disabled="locked" @change="saved = false">
                <option v-for="o in ROLES" :key="o.value" :value="o.value">{{ o.label }}</option>
              </select>
            </td>
            <td class="muted">{{ r.reason }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="targets.length > 0" class="wz-actions">
      <span v-if="unknownCount > 0" class="badge warn">未分類 {{ unknownCount }} シート</span>
      <span v-if="finalCount === 0" class="badge warn">最終アウトプットが未指定</span>
      <span v-else class="badge ok">最終アウトプット {{ finalCount }} シート</span>
      <button v-if="!locked" class="primary" :disabled="saving" @click="confirmAll">
        {{ saving ? `保存中… ${savedCount} / ${books.length}` : 'この分類で確定する' }}
      </button>
      <button v-else @click="unlock">確定を解除して編集する</button>
      <span v-if="saved" class="badge ok">確定しました</span>
    </div>
  </div>
</template>

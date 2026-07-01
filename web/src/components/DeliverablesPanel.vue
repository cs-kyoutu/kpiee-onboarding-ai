<script setup lang="ts">
// SC-05 成果物ビューア。タブ構成: マッピング表 / SQL（検証結果バッジ付き）/ マスタCSV / レポート設定表 / API用JSON。
import { computed, onMounted, ref } from 'vue'
import { get, type Deliverable } from '../api'

const props = defineProps<{ projectId: number }>()

const items = ref<Deliverable[]>([])
const version = ref(0)
const latestVersion = ref(0)
const activeKind = ref('mapping')

const TABS = [
  { kind: 'decode_report', label: '解読リポート' },
  { kind: 'mapping', label: 'マッピング表' },
  { kind: 'sql', label: 'SQL' },
  { kind: 'master_csv', label: 'マスタCSV' },
  { kind: 'report_config_table', label: 'レポート設定表' },
  { kind: 'report_config_json', label: 'API用JSON' },
]

const active = computed(() => items.value.find(d => d.kind === activeKind.value))

async function load(v?: number) {
  const res = await get<{ version: number; latestVersion: number; items: Deliverable[] }>(
    `/projects/${props.projectId}/deliverables${v ? `?version=${v}` : ''}`,
  )
  items.value = res.items
  version.value = res.version
  latestVersion.value = res.latestVersion
}

onMounted(() => load())
</script>

<template>
  <div v-if="latestVersion === 0" class="muted panel">
    成果物がまだありません。検収完了後に「▶ 成果物生成」を実行してください。
  </div>
  <div v-else>
    <div class="toolbar">
      <label>バージョン:
        <select :value="version" style="width: 80px" @change="load(Number(($event.target as HTMLSelectElement).value))">
          <option v-for="v in latestVersion" :key="v" :value="v">v{{ v }}</option>
        </select>
      </label>
      <span class="muted">（再生成のたびにバージョンが増えます）</span>
    </div>

    <div class="tabs">
      <button
        v-for="t in TABS" :key="t.kind"
        :class="{ active: activeKind === t.kind }"
        @click="activeKind = t.kind"
      >
        {{ t.label }}
        <template v-if="t.kind === 'sql'">
          <span
            v-if="items.find(d => d.kind === 'sql')"
            class="badge"
            :class="items.find(d => d.kind === 'sql')?.validation_status === 'passed' ? 'ok' : 'ng'"
          >{{ items.find(d => d.kind === 'sql')?.validation_status === 'passed' ? '検証OK' : '検証NG' }}</span>
        </template>
      </button>
    </div>

    <div v-if="active" class="panel">
      <p v-if="active.validation_errors" class="error-box">
        静的検証エラー:
        {{ JSON.parse(active.validation_errors).join(' / ') }}
      </p>
      <pre class="code" style="white-space: pre-wrap">{{ active.content }}</pre>
    </div>
  </div>
</template>

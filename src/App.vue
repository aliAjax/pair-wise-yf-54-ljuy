<script setup lang="ts">
import { computed, ref } from 'vue';
import { useOnline } from '@vueuse/core';
import { toTypedSchema } from '@vee-validate/zod';
import { useForm } from 'vee-validate';
import { z } from 'zod';
import { api } from './services/api';
import { ENV_FIELDS, FIELD_LABELS, FIELD_UNITS, type EnvField } from './services/merge';
import { useExhibitionStore, type Exhibit } from './stores/exhibition';

const store = useExhibitionStore();
const online = useOnline();
const tab = ref<'checkin' | 'environment' | 'offline' | 'discrepancy'>('checkin');
const dialog = ref(false);
const batchDialog = ref(false);
const selected = ref<Exhibit | null>(null);
const expandedHistory = ref<Set<string>>(new Set());
const schema = toTypedSchema(z.object({ code: z.string().min(2), name: z.string().min(2), lender: z.string().min(2), hall: z.string().min(2) }));
const { defineField, errors, handleSubmit, resetForm } = useForm({ validationSchema: schema });
const [code] = defineField('code');
const [name] = defineField('name');
const [lender] = defineField('lender');
const [hall] = defineField('hall');
const apiLabel = computed(() => String(api.defaults.baseURL));

const submit = handleSubmit((values) => { store.addExhibit(values); dialog.value = false; resetForm(); });
function stageLabel(stage: Exhibit['stage']) { return { arrival: '到场点交', install: '布展核验', return: '闭展归还' }[stage]; }
function statusLabel(status: Exhibit['status']) { return { pending: '待核验', passed: '已通过', issue: '异常', review: '待复核' }[status]; }
function statusColor(status: Exhibit['status']) { return { pending: 'grey', passed: 'green', issue: 'red', review: 'orange' }[status]; }
function shortTime(iso: string) { return iso ? iso.replace('T', ' ').slice(0, 16) : '—'; }

// 读数冲突定位：展品 + 字段 + 采集时间点
const conflictKeys = computed(() => {
  const keys = new Set<string>();
  for (const conflict of store.conflicts.filter((item) => item.kind === 'reading')) {
    keys.add(`${conflict.exhibitId}|${conflict.field}|${conflict.collectedAt}`);
  }
  return keys;
});
function historyOf(exhibitId: string) {
  return (store.environmentHistory[exhibitId] ?? []).slice().sort((a, b) => a.collectedAt.localeCompare(b.collectedAt));
}
function isConflictReading(exhibitId: string, field: EnvField, collectedAt: string) {
  return conflictKeys.value.has(`${exhibitId}|${field}|${collectedAt}`);
}
function toggleHistory(exhibitId: string) {
  const next = new Set(expandedHistory.value);
  next.has(exhibitId) ? next.delete(exhibitId) : next.add(exhibitId);
  expandedHistory.value = next;
}
function exhibitName(id: string) { return store.exhibits.find((item) => item.id === id)?.name ?? id; }

// ---- 模拟断网期间在某台终端上暂存一条数据 ----
const batchTerminal = ref('T-01');
const batchExhibitId = ref('ex-1');
const batchField = ref<EnvField>('temperature');
const batchValue = ref(22);
const batchCollectedAt = ref('2026-10-02T10:15');
const batchDiscTitle = ref('');
const batchDiscSeverity = ref<'minor' | 'major'>('minor');
function recordOfflineBatch() {
  const exhibitId = batchExhibitId.value;
  const terminalId = batchTerminal.value.trim();
  const collectedAt = batchCollectedAt.value;
  if (!terminalId || !exhibitId || !collectedAt) return;
  store.offlineBatches.push({
    id: `batch-${Date.now()}`,
    terminalId,
    exhibitId,
    submittedAt: new Date().toISOString(),
    status: 'pending',
    readings: [{ field: batchField.value, value: Number(batchValue.value), collectedAt, terminalId }],
    discrepancies: batchDiscTitle.value.trim()
      ? [{ id: `d-${Date.now()}`, title: batchDiscTitle.value.trim(), severity: batchDiscSeverity.value, collectedAt, terminalId }]
      : []
  });
  store.persist();
  batchDiscTitle.value = '';
  batchDialog.value = false;
}
</script>

<template>
  <v-app>
    <v-app-bar color="deep-purple-darken-3" flat>
      <v-app-bar-title>{{ $t('title') }}</v-app-bar-title>
      <v-chip class="mr-3" :color="online ? 'green' : 'orange'" theme="dark">{{ online ? '在线' : '离线暂存' }}</v-chip>
      <v-btn prepend-icon="mdi-plus" class="mr-2" @click="dialog = true">登记展品</v-btn>
      <v-chip color="amber-lighten-4" prepend-icon="mdi-sync-alert">待合并批次 {{ store.pendingBatches }}</v-chip>
    </v-app-bar>
    <v-main class="bg-grey-lighten-4">
      <v-container fluid class="pa-6">
        <v-alert v-if="!online || store.queued" color="orange-lighten-4" icon="mdi-cloud-off-outline" class="mb-5">
          网络不可用时核验不会丢失：当前有 {{ store.queued }} 条变更在本地队列。接口地址 {{ apiLabel }}
          <template #append><v-btn v-if="online" variant="text" @click="store.syncQueue">确认同步</v-btn></template>
        </v-alert>

        <v-row class="mb-5">
          <v-col cols="12" md="3"><v-card><v-card-text><div class="metric-label">待到场点交</div><div class="metric">{{ store.stageCounts.arrival }}</div></v-card-text></v-card></v-col>
          <v-col cols="12" md="3"><v-card><v-card-text><div class="metric-label">布展中</div><div class="metric">{{ store.stageCounts.install }}</div></v-card-text></v-card></v-col>
          <v-col cols="12" md="3"><v-card><v-card-text><div class="metric-label">未解决差异</div><div class="metric warn">{{ store.unresolved }}</div></v-card-text></v-card></v-col>
          <v-col cols="12" md="3"><v-card><v-card-text><div class="metric-label">待合并/保留批次</div><div class="metric">{{ store.pendingBatches }} / {{ store.keptBatches.length }}</div></v-card-text></v-card></v-col>
        </v-row>

        <v-card>
          <v-tabs v-model="tab" color="deep-purple">
            <v-tab value="checkin">{{ $t('checkIn') }}</v-tab><v-tab value="environment">{{ $t('environment') }}</v-tab><v-tab value="offline">断网合并</v-tab><v-tab value="discrepancy">{{ $t('discrepancies') }}</v-tab>
          </v-tabs>
          <v-window v-model="tab">
            <v-window-item value="checkin">
              <v-virtual-scroll :items="store.exhibits" height="520" item-height="112">
                <template #default="{ item }">
                  <v-list-item :key="item.id" class="exhibit-row" @click="selected = item">
                    <template #prepend><v-avatar color="deep-purple-lighten-4">{{ item.code.slice(1) }}</v-avatar></template>
                    <v-list-item-title>{{ item.name }} · {{ item.code }}</v-list-item-title>
                    <v-list-item-subtitle>{{ item.lender }} · {{ item.hall }} · {{ stageLabel(item.stage) }}<span v-if="item.reviewReason" class="review-hint"> · {{ item.reviewReason.slice(0, 26) }}…</span></v-list-item-subtitle>
                    <template #append>
                      <v-chip size="small" :color="statusColor(item.status)">{{ statusLabel(item.status) }}</v-chip>
                    </template>
                  </v-list-item>
                </template>
              </v-virtual-scroll>
            </v-window-item>
            <v-window-item value="environment">
              <v-alert type="info" variant="tonal" density="compact" class="ma-3">
                环境读数按采集时间逐字段合并；同一时间点多终端读数矛盾时两条都留（红色），当前值取最后一致读数。合并后已通过展品自动退回待复核。
              </v-alert>
              <v-table>
                <thead><tr><th>展品</th><th>温度</th><th>湿度</th><th>照度</th><th>判定</th><th></th></tr></thead>
                <tbody>
                  <template v-for="item in store.exhibits" :key="item.id">
                    <tr>
                      <td>{{ item.code }} {{ item.status === 'review' ? '（待复核）' : '' }}</td>
                      <td>{{ item.environment.temperature }}℃</td><td>{{ item.environment.humidity }}%</td><td>{{ item.environment.light }} lux</td>
                      <td>
                        <v-btn size="small" color="green" variant="text" @click="store.setCondition(item.id, 'passed')">通过</v-btn>
                        <v-btn size="small" color="red" variant="text" @click="store.setCondition(item.id, 'issue')">异常</v-btn>
                      </td>
                      <td><v-btn size="small" variant="text" :append-icon="expandedHistory.has(item.id) ? 'mdi-chevron-up' : 'mdi-chevron-down'" @click="toggleHistory(item.id)">读数历史</v-btn></td>
                    </tr>
                    <tr v-if="expandedHistory.has(item.id)">
                      <td colspan="6" class="history-row">
                        <v-alert v-if="item.reviewReason" type="warning" variant="tonal" density="compact" class="mb-2">{{ item.reviewReason }}</v-alert>
                        <div v-if="!historyOf(item.id).length" class="text-grey text-caption px-2">该展品暂无离线合并进来的读数，以上为合并前基线值。</div>
                        <v-chip v-for="field in ENV_FIELDS" :key="field" size="small" variant="outlined" class="mr-3 mb-1">{{ FIELD_LABELS[field] }}</v-chip>
                        <div v-for="reading in historyOf(item.id)" :key="`${reading.field}-${reading.collectedAt}-${reading.terminalId}`"
                          class="history-line" :class="{ conflict: isConflictReading(item.id, reading.field, reading.collectedAt) }">
                          <v-icon size="small" class="mr-1">{{ isConflictReading(item.id, reading.field, reading.collectedAt) ? 'mdi-alert-octagon' : 'mdi-radiobox-marked' }}</v-icon>
                          {{ shortTime(reading.collectedAt) }} · 终端 {{ reading.terminalId }} · {{ FIELD_LABELS[reading.field] }} {{ reading.value }}{{ FIELD_UNITS[reading.field] }}
                          <span v-if="isConflictReading(item.id, reading.field, reading.collectedAt)" class="conflict-tag">冲突双留，未覆盖</span>
                        </div>
                      </td>
                    </tr>
                  </template>
                </tbody>
              </v-table>
            </v-window-item>
            <v-window-item value="offline">
              <v-card-text>
                <v-row align="center">
                  <v-col cols="12" md="7">
                    <h3 class="mb-1">断网暂存批次（多终端网络恢复时同时提交）</h3>
                    <div class="text-grey text-body-2">待合并 {{ store.pendingBatches }} 批 · 冲突保留 {{ store.keptBatches.length }} 批 · 历史冲突记录 {{ store.conflicts.length }} 条</div>
                  </v-col>
                  <v-col cols="12" md="5" class="text-right">
                    <v-btn color="deep-purple" prepend-icon="mdi-sync" class="mr-2" :disabled="!store.pendingBatches" @click="store.mergeOfflineBatches()">一键提交并合并</v-btn>
                    <v-btn variant="tonal" prepend-icon="mdi-plus" class="mr-2" @click="batchDialog = true">模拟终端暂存</v-btn>
                    <v-btn variant="text" prepend-icon="mdi-refresh" @click="store.resetDemoBatches()">重置演示</v-btn>
                  </v-col>
                </v-row>

                <v-alert v-if="store.lastMergeReport" type="success" variant="tonal" class="mb-3">
                  最近合并（{{ shortTime(store.lastMergeReport.at) }}）：成功合入 {{ store.lastMergeReport.mergedBatchIds.length }} 批，保留 {{ store.lastMergeReport.keptBatches.length }} 批，
                  {{ store.lastMergeReport.reviewed.length }} 件展品退回待复核，登记冲突 {{ store.lastMergeReport.conflicts.length }} 条。
                  <div v-for="reviewed in store.lastMergeReport.reviewed" :key="reviewed.exhibitId" class="text-body-2 mt-1">
                    · {{ exhibitName(reviewed.exhibitId) }}：{{ reviewed.reason }}
                  </div>
                </v-alert>

                <v-alert v-for="conflict in store.conflicts" :key="conflict.id" :color="conflict.kind === 'invalid-batch' || conflict.kind === 'unknown-exhibit' ? 'error' : 'warning'"
                  variant="tonal" density="comfortable" class="mb-2" :icon="conflict.kind === 'reading' ? 'mdi-thermometer-alert' : conflict.kind === 'discrepancy' ? 'mdi-alert-box' : 'mdi-database-remove'">
                  <div>{{ conflict.detail }}</div>
                  <div class="text-caption text-grey-darken-1 mt-1">
                    类型：{{ { reading: '读数冲突', discrepancy: '差异项矛盾', 'unknown-exhibit': '展品不存在', 'invalid-batch': '批次校验失败' }[conflict.kind] }}
                    ；涉及终端：{{ conflict.terminalIds.join('、') }}；时间点：{{ shortTime(conflict.collectedAt) }}；批次：{{ conflict.batchIds.join('、') }}
                  </div>
                </v-alert>

                <v-table>
                  <thead><tr><th>批次</th><th>终端</th><th>展品</th><th>提交时间</th><th>读数/差异</th><th>状态与保留原因</th><th></th></tr></thead>
                  <tbody>
                    <tr v-for="batch in store.offlineBatches" :key="batch.id" :class="{ 'row-kept': batch.status === 'kept' }">
                      <td class="text-caption">{{ batch.id }}</td>
                      <td><v-chip size="small" color="deep-purple-lighten-4">{{ batch.terminalId }}</v-chip></td>
                      <td>{{ batch.exhibitId }}<span class="text-grey text-caption"> · {{ exhibitName(batch.exhibitId) }}</span></td>
                      <td>{{ shortTime(batch.submittedAt) }}</td>
                      <td class="text-caption">{{ batch.readings.length }} 条读数 / {{ batch.discrepancies.length }} 项差异</td>
                      <td>
                        <v-chip size="small" :color="batch.status === 'merged' ? 'green' : batch.status === 'kept' ? 'red' : 'orange'">
                          {{ { pending: '待提交', merged: '已合入', kept: '保留未合' }[batch.status] }}
                        </v-chip>
                        <div v-if="batch.keepReason" class="text-caption text-red-darken-2 mt-1">{{ batch.keepReason }}</div>
                      </td>
                      <td><v-btn v-if="batch.status === 'kept'" size="x-small" variant="text" @click="store.discardKeptBatch(batch.id)">线下处理完，移出队列</v-btn></td>
                    </tr>
                  </tbody>
                </v-table>
                <div class="text-grey text-caption px-4 pb-4">说明：读数矛盾/校验失败/未知展品的批次整批保留，可线下核对后再次合并；成功合入的批次仅作台账留存。读数历史与差异项不会随批次移出而删除。</div>
              </v-card-text>
            </v-window-item>
            <v-window-item value="discrepancy">
              <v-list>
                <v-list-item v-for="item in store.discrepancies" :key="item.id" :class="{ 'row-kept': item.conflict }">
                  <template #prepend><v-icon :color="item.conflict ? 'red' : item.severity === 'major' ? 'orange' : 'grey'">{{ item.conflict ? 'mdi-alert-octagon' : 'mdi-file-document-alert' }}</v-icon></template>
                  <v-list-item-title>
                    {{ item.title }}
                    <v-chip v-if="item.conflict" size="x-small" color="red" class="ml-2">定级矛盾·双留</v-chip>
                  </v-list-item-title>
                  <v-list-item-subtitle>
                    展品 {{ item.exhibitId }} · {{ item.severity === 'major' ? '重大差异' : '轻微差异' }}
                    <span v-if="item.sources?.length"> · 上报终端：<span v-for="(source, index) in item.sources" :key="source.terminalId + source.collectedAt">{{ index ? '、' : '' }}{{ source.terminalId }}（{{ shortTime(source.collectedAt) }}）</span></span>
                  </v-list-item-subtitle>
                  <template #append><v-btn :disabled="item.resolved" color="green" @click="store.resolveDiscrepancy(item.id)">{{ item.resolved ? '已解决' : '确认解决' }}</v-btn></template>
                </v-list-item>
              </v-list>
            </v-window-item>
          </v-window>
        </v-card>

        <v-dialog v-model="dialog" max-width="560">
          <v-card title="登记新展品">
            <v-card-text><v-form @submit.prevent="submit"><v-text-field v-model="code" label="展品编号" :error-messages="errors.code" /><v-text-field v-model="name" label="展品名称" :error-messages="errors.name" /><v-text-field v-model="lender" label="借展方" :error-messages="errors.lender" /><v-text-field v-model="hall" label="展厅/柜位" :error-messages="errors.hall" /><v-btn type="submit" color="deep-purple" block>写入点交队列</v-btn></v-form></v-card-text>
          </v-card>
        </v-dialog>

        <v-dialog v-model="batchDialog" max-width="520">
          <v-card title="模拟断网期间终端暂存">
            <v-card-text>
              <v-row dense>
                <v-col cols="6"><v-text-field v-model="batchTerminal" label="终端编号" density="compact" /></v-col>
                <v-col cols="6">
                  <v-select v-model="batchExhibitId" label="展品" density="compact"
                    :items="store.exhibits.map((item) => ({ title: `${item.code} ${item.name}`, value: item.id }))" />
                </v-col>
                <v-col cols="4"><v-select v-model="batchField" label="读数字段" density="compact" :items="ENV_FIELDS.map((field) => ({ title: FIELD_LABELS[field], value: field }))" /></v-col>
                <v-col cols="4"><v-text-field v-model.number="batchValue" label="读数值" type="number" density="compact" /></v-col>
                <v-col cols="4"><v-text-field v-model="batchCollectedAt" label="采集时间" type="datetime-local" density="compact" /></v-col>
                <v-col cols="8"><v-text-field v-model="batchDiscTitle" label="差异项标题（可不填）" density="compact" /></v-col>
                <v-col cols="4"><v-select v-model="batchDiscSeverity" label="差异定级" density="compact" :items="[{ title: '轻微', value: 'minor' }, { title: '重大', value: 'major' }]" /></v-col>
              </v-row>
              <v-btn color="deep-purple" block @click="recordOfflineBatch">存入离线批次</v-btn>
            </v-card-text>
          </v-card>
        </v-dialog>

        <v-dialog :model-value="Boolean(selected)" max-width="680" @update:model-value="selected = null">
          <v-card v-if="selected" :title="`${selected.code} · ${selected.name}`">
            <v-card-text>
              <v-alert v-if="selected.status === 'review'" type="warning" variant="tonal" class="mb-3" icon="mdi-clipboard-alert">
                {{ selected.reviewReason }}
              </v-alert>
              <v-alert v-if="selected.signed.length" type="info" variant="text" density="compact" icon="mdi-shield-check" class="mb-2">
                已签字（{{ selected.signed.join('、') }}）在合并后继续有效，复核只针对判定结论，无需重新签字。
              </v-alert>
              <v-timeline side="end" density="compact">
                <v-timeline-item dot-color="green"><b>保管员点收</b><p>核对包装、封条和附件清单。</p><v-btn size="small" :disabled="selected.signed.includes('保管员')" @click="store.sign(selected.id, '保管员')">{{ selected.signed.includes('保管员') ? '已签字' : '保管员签字' }}</v-btn></v-timeline-item>
                <v-timeline-item dot-color="orange"><b>借展方确认</b><p>确认差异项及后续责任。</p><v-btn size="small" :disabled="selected.signed.includes('借展方')" @click="store.sign(selected.id, '借展方')">{{ selected.signed.includes('借展方') ? '已签字' : '借展方签字' }}</v-btn></v-timeline-item>
                <v-timeline-item dot-color="purple"><b>推进阶段</b><p>存在未解决差异、缺少借展方签字或处于待复核时不能推进。</p><v-btn size="small" color="deep-purple" :disabled="selected.status === 'review'" @click="store.advance(selected.id)">推进到下一阶段</v-btn></v-timeline-item>
              </v-timeline>
            </v-card-text>
          </v-card>
        </v-dialog>
      </v-container>
    </v-main>
  </v-app>
</template>

<style>
.metric-label { color: #6b7280; font-size: 13px; }
.metric { font-size: 31px; font-weight: 750; color: #4c1d95; }
.metric.warn { color: #b91c1c; }
.exhibit-row { border-bottom: 1px solid #eee; cursor: pointer; }
.review-hint { color: #b26a00; }
.history-row { background: #faf7ff; padding: 8px 16px !important; }
.history-line { font-size: 13px; padding: 2px 0; color: #374151; display: flex; align-items: center; }
.history-line.conflict { color: #b91c1c; font-weight: 600; }
.conflict-tag { margin-left: 8px; font-size: 11px; background: #fde2e1; border-radius: 4px; padding: 0 6px; }
.row-kept { background: #fff7f7; }
</style>

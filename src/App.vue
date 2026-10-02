<script setup lang="ts">
import { computed, ref } from 'vue';
import { useOnline } from '@vueuse/core';
import { toTypedSchema } from '@vee-validate/zod';
import { useForm } from 'vee-validate';
import { z } from 'zod';
import { api } from './services/api';
import { useExhibitionStore, type Exhibit } from './stores/exhibition';

const store = useExhibitionStore();
const online = useOnline();
const tab = ref<'checkin' | 'environment' | 'discrepancy' | 'batch'>('checkin');
const dialog = ref(false);
const selected = ref<Exhibit | null>(null);
const schema = toTypedSchema(z.object({ code: z.string().min(2), name: z.string().min(2), lender: z.string().min(2), hall: z.string().min(2) }));
const { defineField, errors, handleSubmit, resetForm } = useForm({ validationSchema: schema });
const [code] = defineField('code');
const [name] = defineField('name');
const [lender] = defineField('lender');
const [hall] = defineField('hall');
const apiLabel = computed(() => String(api.defaults.baseURL));

const submit = handleSubmit((values) => { store.addExhibit(values); dialog.value = false; resetForm(); });
function stageLabel(stage: Exhibit['stage']) { return { arrival: '到场点交', install: '布展核验', return: '闭展归还' }[stage]; }
function statusLabel(status: Exhibit['status']) { return { pending: '待复核', passed: '已通过', issue: '异常' }[status]; }
function batchStatusLabel(status: string) { return { stored: '待合并', merged: '已合并', conflict: '冲突保留' }[status]; }
function fmtTime(ts: number) {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
</script>

<template>
  <v-app>
    <v-app-bar color="deep-purple-darken-3" flat>
      <v-app-bar-title>{{ $t('title') }}</v-app-bar-title>
      <v-chip class="mr-3" :color="online ? 'green' : 'orange'" theme="dark">{{ online ? '在线' : '离线暂存' }}</v-chip>
      <v-chip class="mr-3" color="deep-purple-lighten-3" theme="dark">终端 {{ store.terminalId }}</v-chip>
      <v-btn prepend-icon="mdi-plus" @click="dialog = true">登记展品</v-btn>
    </v-app-bar>
    <v-main class="bg-grey-lighten-4">
      <v-container fluid class="pa-6">
        <v-alert v-if="!online || store.storedBatchCount" color="orange-lighten-4" icon="mdi-cloud-off-outline" class="mb-5">
          网络不可用时核验不会丢失：终端 {{ store.terminalId }} 本地暂存 {{ store.storedBatchCount }} 个离线批次，网络恢复后与其他终端同时提交、按采集时间逐字段合并。接口地址 {{ apiLabel }}
          <template #append>
            <v-btn variant="text" @click="store.simulateOfflineTerminals()">模拟多终端同时提交</v-btn>
            <v-btn v-if="online" variant="text" @click="store.syncBatches()">合并同步</v-btn>
          </template>
        </v-alert>
        <v-alert v-if="store.conflictBatches.length" color="red-lighten-4" icon="mdi-alert-circle-outline" class="mb-5">
          <b>{{ store.conflictBatches.length }} 个离线批次读数矛盾或合并失败，批次保留未丢弃，需人工复核：</b>
          <div v-for="batch in store.conflictBatches" :key="batch.id" class="mt-1">· {{ batch.terminalId }}（暂存于 {{ fmtTime(batch.storedAt) }}）：{{ batch.conflictNote }}</div>
        </v-alert>

        <v-row class="mb-5">
          <v-col cols="12" md="3"><v-card><v-card-text><div class="metric-label">待到场点交</div><div class="metric">{{ store.stageCounts.arrival }}</div></v-card-text></v-card></v-col>
          <v-col cols="12" md="3"><v-card><v-card-text><div class="metric-label">布展中</div><div class="metric">{{ store.stageCounts.install }}</div></v-card-text></v-card></v-col>
          <v-col cols="12" md="3"><v-card><v-card-text><div class="metric-label">未解决差异</div><div class="metric warn">{{ store.unresolved }}</div></v-card-text></v-card></v-col>
          <v-col cols="12" md="3"><v-card><v-card-text><div class="metric-label">离线待合并批次</div><div class="metric">{{ store.storedBatchCount }}</div></v-card-text></v-card></v-col>
        </v-row>

        <v-card>
          <v-tabs v-model="tab" color="deep-purple">
            <v-tab value="checkin">{{ $t('checkIn') }}</v-tab><v-tab value="environment">{{ $t('environment') }}</v-tab><v-tab value="discrepancy">{{ $t('discrepancies') }}</v-tab><v-tab value="batch">离线批次<v-badge v-if="store.storedBatchCount" :content="store.storedBatchCount" color="orange" inline class="ml-1" /></v-tab>
          </v-tabs>
          <v-window v-model="tab">
            <v-window-item value="checkin">
              <v-virtual-scroll :items="store.exhibits" height="520" item-height="112">
                <template #default="{ item }">
                  <v-list-item :key="item.id" class="exhibit-row" @click="selected = item">
                    <template #prepend><v-avatar color="deep-purple-lighten-4">{{ item.code.slice(1) }}</v-avatar></template>
                    <v-list-item-title>{{ item.name }} · {{ item.code }}</v-list-item-title>
                    <v-list-item-subtitle>{{ item.lender }} · {{ item.hall }} · {{ stageLabel(item.stage) }}<span v-if="item.reviewReason" class="text-orange"> · {{ item.reviewReason }}</span></v-list-item-subtitle>
                    <template #append>
                      <v-chip size="small" :color="item.status === 'issue' ? 'red' : item.status === 'passed' ? 'green' : 'orange'">{{ statusLabel(item.status) }}</v-chip>
                    </template>
                  </v-list-item>
                </template>
              </v-virtual-scroll>
            </v-window-item>
            <v-window-item value="environment">
              <v-table>
                <thead><tr><th>展品</th><th>温度</th><th>湿度</th><th>照度</th><th>条件</th></tr></thead>
                <tbody><tr v-for="item in store.exhibits" :key="item.id"><td>{{ item.code }}</td><td>{{ item.environment.temperature }}℃</td><td>{{ item.environment.humidity }}%</td><td>{{ item.environment.light }} lux</td><td><v-btn size="small" color="green" variant="text" @click="store.setCondition(item.id, 'passed')">通过</v-btn><v-btn size="small" color="red" variant="text" @click="store.setCondition(item.id, 'issue')">异常</v-btn><v-chip v-if="item.status === 'pending' && item.reviewReason" size="small" color="orange" class="ml-1">待复核</v-chip><div v-if="item.reviewReason" class="text-orange text-caption mt-1">{{ item.reviewReason }}</div></td></tr></tbody>
              </v-table>
            </v-window-item>
            <v-window-item value="discrepancy">
              <v-list><v-list-item v-for="item in store.discrepancies" :key="item.id"><v-list-item-title>{{ item.title }}</v-list-item-title><v-list-item-subtitle>展品 {{ item.exhibitId }}<span v-if="item.terminalId"> · {{ item.terminalId }} 上报</span> · {{ item.severity === 'major' ? '重大差异' : '轻微差异' }}</v-list-item-subtitle><template #append><v-btn :disabled="item.resolved" color="green" @click="store.resolveDiscrepancy(item.id)">{{ item.resolved ? '已解决' : '确认解决' }}</v-btn></template></v-list-item></v-list>
            </v-window-item>
            <v-window-item value="batch">
              <v-alert color="blue-lighten-5" icon="mdi-information-outline" class="mb-3">每台终端断网期间把核验读数暂存为一个离线批次；网络恢复后各批次同时提交，按采集时间逐字段合并。同时间窗内读数互相矛盾时两条都留下，整批保留并标出终端与时间点，不丢弃任何一方。</v-alert>
              <v-list>
                <v-list-item v-for="batch in store.batches" :key="batch.id">
                  <template #prepend><v-icon :color="batch.status === 'merged' ? 'green' : batch.status === 'conflict' ? 'red' : 'orange'">mdi-tablet-cellphone</v-icon></template>
                  <v-list-item-title>{{ batch.terminalId }} · {{ batch.records.length }} 条展品记录 · {{ batch.records.reduce((n, r) => n + r.readings.length, 0) }} 条读数</v-list-item-title>
                  <v-list-item-subtitle>暂存于 {{ fmtTime(batch.storedAt) }} · 状态：{{ batchStatusLabel(batch.status) }}<div v-if="batch.conflictNote" class="text-red mt-1">{{ batch.conflictNote }}</div></v-list-item-subtitle>
                  <template #append><v-chip :color="batch.status === 'merged' ? 'green' : batch.status === 'conflict' ? 'red' : 'orange'" size="small">{{ batchStatusLabel(batch.status) }}</v-chip></template>
                </v-list-item>
                <v-list-item v-if="!store.batches.length"><v-list-item-subtitle>暂无离线批次。点击上方「模拟多终端同时提交」构造断网暂存场景。</v-list-item-subtitle></v-list-item>
              </v-list>
            </v-window-item>
          </v-window>
        </v-card>

        <v-dialog v-model="dialog" max-width="560">
          <v-card title="登记新展品">
            <v-card-text><v-form @submit.prevent="submit"><v-text-field v-model="code" label="展品编号" :error-messages="errors.code" /><v-text-field v-model="name" label="展品名称" :error-messages="errors.name" /><v-text-field v-model="lender" label="借展方" :error-messages="errors.lender" /><v-text-field v-model="hall" label="展厅/柜位" :error-messages="errors.hall" /><v-btn type="submit" color="deep-purple" block>写入点交队列</v-btn></v-form></v-card-text>
          </v-card>
        </v-dialog>

        <v-dialog :model-value="Boolean(selected)" max-width="680" @update:model-value="selected = null">
          <v-card v-if="selected" :title="`${selected.code} · ${selected.name}`">
            <v-card-text>
              <v-timeline side="end" density="compact">
                <v-timeline-item dot-color="green"><b>保管员点收</b><p>核对包装、封条和附件清单。</p><v-btn size="small" :disabled="selected.signed.includes('保管员')" @click="store.sign(selected.id, '保管员')">{{ selected.signed.includes('保管员') ? '已签字' : '保管员签字' }}</v-btn></v-timeline-item>
                <v-timeline-item dot-color="orange"><b>借展方确认</b><p>确认差异项及后续责任。</p><v-btn size="small" :disabled="selected.signed.includes('借展方')" @click="store.sign(selected.id, '借展方')">{{ selected.signed.includes('借展方') ? '已签字' : '借展方签字' }}</v-btn></v-timeline-item>
                <v-timeline-item dot-color="purple"><b>推进阶段</b><p>存在未解决差异或缺少借展方签字时不能推进。</p><v-btn size="small" color="deep-purple" @click="store.advance(selected.id)">推进到下一阶段</v-btn></v-timeline-item>
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
</style>

import { defineStore } from 'pinia';

export type Stage = 'arrival' | 'install' | 'return';
export type CheckStatus = 'pending' | 'passed' | 'issue';
export type EnvField = 'temperature' | 'humidity' | 'light';

/** 一条终端采集读数：保留采集终端与采集时间，合并按采集时间逐字段进行 */
export interface EnvReading {
  terminalId: string;
  field: EnvField;
  value: number;
  collectedAt: number;
}

export interface Exhibit {
  id: string;
  code: string;
  name: string;
  lender: string;
  hall: string;
  stage: Stage;
  status: CheckStatus;
  signed: string[];
  environment: { temperature: number; humidity: number; light: number };
  /** 全部已合并读数（含互相矛盾时双方的读数，两条都留下） */
  readings: EnvReading[];
  /** 退回待复核时写明的原因 */
  reviewReason?: string;
}

export interface Discrepancy {
  id: string;
  exhibitId: string;
  title: string;
  severity: 'minor' | 'major';
  resolved: boolean;
  terminalId?: string;
  collectedAt?: number;
}

export interface BatchDiscrepancy { title: string; severity: 'minor' | 'major'; }
export interface BatchRecord {
  exhibitId: string;
  readings: { field: EnvField; value: number; collectedAt: number }[];
  discrepancies?: BatchDiscrepancy[];
}

export interface ConflictInfo {
  exhibitId: string;
  field: EnvField;
  terminalId: string;
  collectedAt: number;
  value: number;
  against: { terminalId: string; collectedAt: number; value: number };
  reason: string;
}

/** 断网暂存的离线批次：合并失败或读数矛盾时整批保留，标出终端与时间点 */
export interface OfflineBatch {
  id: string;
  terminalId: string;
  storedAt: number;
  status: 'stored' | 'merged' | 'conflict';
  records: BatchRecord[];
  conflicts: ConflictInfo[];
  conflictNote?: string;
}

interface State {
  terminalId: string;
  exhibits: Exhibit[];
  discrepancies: Discrepancy[];
  batches: OfflineBatch[];
  queued: number;
}

/** 同一时间窗内读数差超过容差视为互相矛盾（单位：℃ / % / lux） */
const TOLERANCE: Record<EnvField, number> = { temperature: 1.0, humidity: 5, light: 50 };
const CONCURRENT_WINDOW = 10 * 60 * 1000;
const FIELD_LABEL: Record<EnvField, string> = { temperature: '温度', humidity: '湿度', light: '照度' };
const STORAGE_KEY = 'yf54-exhibition-state';

function latestReading(exhibit: Exhibit, field: EnvField): EnvReading | undefined {
  return exhibit.readings
    .filter((reading) => reading.field === field)
    .sort((a, b) => a.collectedAt - b.collectedAt)
    .at(-1);
}

/** 读数矛盾：同时间窗内差值超出容差；时间相隔远则视为环境正常变化，不算矛盾 */
function isContradiction(
  a: { value: number; collectedAt: number },
  b: { value: number; collectedAt: number },
  field: EnvField
): boolean {
  return Math.abs(a.value - b.value) > TOLERANCE[field] && Math.abs(a.collectedAt - b.collectedAt) <= CONCURRENT_WINDOW;
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function baselineReadings(environment: Exhibit['environment']): EnvReading[] {
  return (['temperature', 'humidity', 'light'] as EnvField[]).map((field) => ({
    terminalId: 'BASE 基线',
    field,
    value: environment[field],
    collectedAt: 0
  }));
}

const seed: State = {
  terminalId: 'TERM-本机',
  exhibits: Array.from({ length: 24 }, (_, index) => {
    const environment = { temperature: 20 + index % 3, humidity: 48 + index % 8, light: 120 + index * 3 };
    return {
      id: `ex-${index + 1}`,
      code: `M${String(index + 1).padStart(3, '0')}`,
      name: ['青铜镜', '釉里红瓷瓶', '石雕佛首', '手抄经卷', '鎏金香炉'][index % 5] + ` ${index + 1}`,
      lender: index % 2 ? '西北博物馆' : '私人借展方',
      hall: index % 3 === 0 ? 'A2 温湿展柜' : 'B1 开放展区',
      stage: index < 8 ? 'arrival' : index < 18 ? 'install' : 'return',
      status: index === 4 ? 'issue' : index < 10 ? 'passed' : 'pending',
      signed: index < 5 ? ['保管员', '借展方'] : index < 10 ? ['保管员'] : [],
      environment,
      readings: baselineReadings(environment)
    };
  }),
  discrepancies: [
    { id: 'd1', exhibitId: 'ex-5', title: '封条编号与交接单不一致', severity: 'major', resolved: false },
    { id: 'd2', exhibitId: 'ex-7', title: '木箱边角轻微磕碰', severity: 'minor', resolved: false }
  ],
  batches: [],
  queued: 0
};

function load(): State {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return seed;
      const parsed = JSON.parse(saved) as Partial<State>;
    return {
      ...seed,
      ...parsed,
      exhibits: (parsed.exhibits ?? seed.exhibits).map((exhibit) => ({
        ...exhibit,
        readings: exhibit.readings?.length ? exhibit.readings : baselineReadings(exhibit.environment)
      })),
      batches: parsed.batches ?? []
    };
  } catch {
    return seed;
  }
}

export const useExhibitionStore = defineStore('exhibition', {
  state: (): State => load(),
  getters: {
    unresolved: (state) => state.discrepancies.filter((item) => !item.resolved).length,
    stageCounts: (state) => ({ arrival: state.exhibits.filter((item) => item.stage === 'arrival').length, install: state.exhibits.filter((item) => item.stage === 'install').length, return: state.exhibits.filter((item) => item.stage === 'return').length }),
    storedBatchCount: (state) => state.batches.filter((batch) => batch.status === 'stored').length,
    conflictBatches: (state) => state.batches.filter((batch) => batch.status === 'conflict')
  },
  actions: {
    persist() { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.$state)); },
    refreshQueue() { this.queued = this.batches.filter((batch) => batch.status === 'stored').length; },
    markQueued() { this.refreshQueue(); this.persist(); },
    setCondition(id: string, status: CheckStatus) {
      const exhibit = this.exhibits.find((item) => item.id === id);
      if (exhibit) { exhibit.status = status; exhibit.reviewReason = undefined; this.markQueued(); }
    },
    sign(id: string, role: string) { const exhibit = this.exhibits.find((item) => item.id === id); if (!exhibit || exhibit.signed.includes(role)) return; exhibit.signed.push(role); this.markQueued(); },
    advance(id: string) {
      const exhibit = this.exhibits.find((item) => item.id === id);
      if (!exhibit || !exhibit.signed.includes('借展方') || this.discrepancies.some((item) => item.exhibitId === id && !item.resolved)) return;
      exhibit.stage = exhibit.stage === 'arrival' ? 'install' : exhibit.stage === 'install' ? 'return' : 'return';
      this.markQueued();
    },
    resolveDiscrepancy(id: string) { const item = this.discrepancies.find((entry) => entry.id === id); if (item) { item.resolved = true; this.markQueued(); } },
    addExhibit(payload: Pick<Exhibit, 'code' | 'name' | 'lender' | 'hall'>) {
      const environment = { temperature: 20, humidity: 50, light: 150 };
      this.exhibits.unshift({ id: `ex-${Date.now()}`, ...payload, stage: 'arrival', status: 'pending', signed: [], environment, readings: baselineReadings(environment) });
      this.markQueued();
    },

    /** 终端断网期间把核验记录暂存为离线批次，网络恢复后随其他终端一起提交 */
    stageBatch(terminalId: string, records: BatchRecord[]): OfflineBatch {
      const batch: OfflineBatch = {
        id: `batch-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        terminalId,
        storedAt: Date.now(),
        status: 'stored',
        records,
        conflicts: []
      };
      this.batches.push(batch);
      this.markQueued();
      return batch;
    },

    /** 模拟多台核验终端断网后各自暂存、网络恢复时同时提交 */
    simulateOfflineTerminals() {
      const t = Date.now();
      this.stageBatch('TERM-01 核验终端', [
        { exhibitId: 'ex-1', readings: [
          { field: 'temperature', value: 21, collectedAt: t - 30 * 60000 },
          { field: 'humidity', value: 50, collectedAt: t - 30 * 60000 }
        ] }
      ]);
      this.stageBatch('TERM-02 核验终端', [
        { exhibitId: 'ex-1', readings: [
          { field: 'temperature', value: 26, collectedAt: t - 25 * 60000 }
        ] },
        { exhibitId: 'ex-2', readings: [
          { field: 'humidity', value: 60, collectedAt: t - 20 * 60000 }
        ] }
      ]);
      this.stageBatch('TERM-03 核验终端', [
        { exhibitId: 'ex-999', readings: [
          { field: 'temperature', value: 22, collectedAt: t - 15 * 60000 }
        ] },
        { exhibitId: 'ex-4', readings: [
          { field: 'light', value: 300, collectedAt: t - 10 * 60000 }
        ], discrepancies: [
          { title: '展柜照明异常偏暗', severity: 'minor' }
        ] },
        { exhibitId: 'ex-1', readings: [
          { field: 'humidity', value: 49, collectedAt: t - 45 * 60000 }
        ], discrepancies: [
          { title: '温湿度波动超出记录范围', severity: 'major' }
        ] }
      ]);
    },

    /** 合并所有已暂存的离线批次；矛盾或失败的批次保留不动，标出终端与时间点 */
    syncBatches() {
      for (const batch of this.batches.filter((item) => item.status === 'stored')) this.mergeBatch(batch);
      this.refreshQueue();
      this.persist();
    },

    mergeBatch(batch: OfflineBatch) {
      const conflicts: ConflictInfo[] = [];
      const errors: string[] = [];
      for (const record of batch.records) {
        const exhibit = this.exhibits.find((item) => item.id === record.exhibitId);
        if (!exhibit) {
          // 合并失败：该条记录无法写入，连同整批保留，标出终端与时间点
          errors.push(`终端 ${batch.terminalId} 于 ${fmtTime(batch.storedAt)} 上报的展品 ${record.exhibitId} 在系统中不存在，该条记录合并失败并保留，待人工处理`);
          continue;
        }
        for (const item of record.readings) {
          const incoming: EnvReading = { terminalId: batch.terminalId, field: item.field, value: item.value, collectedAt: item.collectedAt };
          const prev = latestReading(exhibit, item.field);
          exhibit.readings.push(incoming); // 两条读数都留下，后到的不盖掉先到的
          if (prev && isContradiction(prev, incoming, item.field)) {
            const reason = `终端 ${batch.terminalId} 于 ${fmtTime(item.collectedAt)} 采集的${FIELD_LABEL[item.field]}读数 ${item.value} 与终端 ${prev.terminalId} 于 ${fmtTime(prev.collectedAt)} 的读数 ${prev.value} 互相矛盾（差值 ${Math.abs(item.value - prev.value)}），两条读数均保留，待人工复核`;
            conflicts.push({ exhibitId: exhibit.id, field: item.field, terminalId: batch.terminalId, collectedAt: item.collectedAt, value: item.value, against: { terminalId: prev.terminalId, collectedAt: prev.collectedAt, value: prev.value }, reason });
            if (exhibit.status === 'passed') {
              exhibit.status = 'pending';
              exhibit.reviewReason = `环境读数矛盾：${reason}；原通过判定失效，退回待复核（已签字无需重签）`;
            }
          } else {
            // 读数一致：按采集时间逐字段合并，采集时间晚的覆盖早的
            if (!prev || incoming.collectedAt >= prev.collectedAt) {
              const old = exhibit.environment[item.field];
              exhibit.environment[item.field] = incoming.value;
              if (exhibit.status === 'passed' && old !== incoming.value) {
                exhibit.status = 'pending';
                exhibit.reviewReason = `环境${FIELD_LABEL[item.field]}读数已按采集时间合并更新（${old} → ${incoming.value}，来源 ${batch.terminalId} ${fmtTime(incoming.collectedAt)}），原通过判定失效，退回待复核（已签字无需重签）`;
              }
            }
          }
        }
        for (const discrepancy of record.discrepancies ?? []) {
          this.discrepancies.push({
            id: `d-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            exhibitId: exhibit.id,
            title: discrepancy.title,
            severity: discrepancy.severity,
            resolved: false,
            terminalId: batch.terminalId,
            collectedAt: batch.storedAt
          });
        }
      }

      batch.conflicts = conflicts;
      const notes = [...errors, ...conflicts.map((item) => item.reason)];
      if (notes.length) {
        batch.status = 'conflict';
        batch.conflictNote = notes.join('；');
      } else {
        batch.status = 'merged';
      }
      this.persist();
    }
  }
});

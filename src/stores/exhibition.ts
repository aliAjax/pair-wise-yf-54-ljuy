import { defineStore } from 'pinia';
import {
  demoOfflineBatches,
  runMerge,
  type EnvironmentReading,
  type MergeReport,
  type OfflineBatch,
  type MergeConflict,
  type StoredDiscrepancy
} from '../services/merge';

export type Stage = 'arrival' | 'install' | 'return';
// review = 离线读数合并后判定失效，退回待复核
export type CheckStatus = 'pending' | 'passed' | 'issue' | 'review';
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
  reviewReason?: string;
}
export type Discrepancy = StoredDiscrepancy;
interface State {
  exhibits: Exhibit[];
  discrepancies: Discrepancy[];
  queued: number;
  offlineBatches: OfflineBatch[];
  environmentHistory: Record<string, EnvironmentReading[]>;
  conflicts: MergeConflict[];
  lastMergeReport: MergeReport | null;
}

const seed: State = {
  exhibits: Array.from({ length: 24 }, (_, index) => ({
    id: `ex-${index + 1}`,
    code: `M${String(index + 1).padStart(3, '0')}`,
    name: ['青铜镜', '釉里红瓷瓶', '石雕佛首', '手抄经卷', '鎏金香炉'][index % 5] + ` ${index + 1}`,
    lender: index % 2 ? '西北博物馆' : '私人借展方',
    hall: index % 3 === 0 ? 'A2 温湿展柜' : 'B1 开放展区',
    stage: index < 8 ? 'arrival' : index < 18 ? 'install' : 'return',
    status: index === 4 ? 'issue' : index < 10 ? 'passed' : 'pending',
    signed: index < 5 ? ['保管员', '借展方'] : index < 10 ? ['保管员'] : [],
    environment: { temperature: 20 + index % 3, humidity: 48 + index % 8, light: 120 + index * 3 }
  })),
  discrepancies: [
    { id: 'd1', exhibitId: 'ex-5', title: '封条编号与交接单不一致', severity: 'major', resolved: false },
    { id: 'd2', exhibitId: 'ex-7', title: '木箱边角轻微磕碰', severity: 'minor', resolved: false }
  ],
  queued: 0,
  offlineBatches: demoOfflineBatches(),
  environmentHistory: {},
  conflicts: [],
  lastMergeReport: null
};

function load(): State {
  const saved = localStorage.getItem('yf54-exhibition-state');
  if (!saved) return seed;
  const parsed = JSON.parse(saved) as Partial<State>;
  // 老版本持久化数据补齐断网合并相关字段
  return {
    exhibits: parsed.exhibits ?? seed.exhibits,
    discrepancies: parsed.discrepancies ?? seed.discrepancies,
    queued: parsed.queued ?? 0,
    offlineBatches: parsed.offlineBatches ?? demoOfflineBatches(),
    environmentHistory: parsed.environmentHistory ?? {},
    conflicts: parsed.conflicts ?? [],
    lastMergeReport: parsed.lastMergeReport ?? null
  };
}

export const useExhibitionStore = defineStore('exhibition', {
  state: () => load(),
  getters: {
    unresolved: (state) => state.discrepancies.filter((item) => !item.resolved).length,
    stageCounts: (state) => ({ arrival: state.exhibits.filter((item) => item.stage === 'arrival').length, install: state.exhibits.filter((item) => item.stage === 'install').length, return: state.exhibits.filter((item) => item.stage === 'return').length }),
    pendingBatches: (state) => state.offlineBatches.filter((batch) => batch.status === 'pending').length,
    keptBatches: (state) => state.offlineBatches.filter((batch) => batch.status === 'kept')
  },
  actions: {
    persist() { localStorage.setItem('yf54-exhibition-state', JSON.stringify(this.$state)); },
    markQueued() { this.queued += 1; this.persist(); },
    setCondition(id: string, status: CheckStatus) {
      const exhibit = this.exhibits.find((item) => item.id === id);
      if (exhibit) {
        exhibit.status = status;
        if (status === 'passed' || status === 'issue') exhibit.reviewReason = undefined;
        this.markQueued();
      }
    },
    sign(id: string, role: string) { const exhibit = this.exhibits.find((item) => item.id === id); if (!exhibit || exhibit.signed.includes(role)) return; exhibit.signed.push(role); this.markQueued(); },
    advance(id: string) {
      const exhibit = this.exhibits.find((item) => item.id === id);
      if (!exhibit || !exhibit.signed.includes('借展方') || this.discrepancies.some((item) => item.exhibitId === id && !item.resolved)) return;
      // 合并导致判定失效、退回待复核的展品，复核结论给出前不能继续推进；签字仍然有效
      if (exhibit.status === 'review') return;
      exhibit.stage = exhibit.stage === 'arrival' ? 'install' : exhibit.stage === 'install' ? 'return' : 'return';
      this.markQueued();
    },
    resolveDiscrepancy(id: string) { const item = this.discrepancies.find((entry) => entry.id === id); if (item) { item.resolved = true; this.markQueued(); } },
    addExhibit(payload: Pick<Exhibit, 'code' | 'name' | 'lender' | 'hall'>) {
      this.exhibits.unshift({ id: `ex-${Date.now()}`, ...payload, stage: 'arrival', status: 'pending', signed: [], environment: { temperature: 20, humidity: 50, light: 150 } });
      this.markQueued();
    },
    // 网络恢复：各终端同时提交的暂存批次一次性合并
    mergeOfflineBatches() {
      const report = runMerge(
        {
          exhibits: this.exhibits,
          discrepancies: this.discrepancies,
          environmentHistory: this.environmentHistory,
          conflicts: this.conflicts
        },
        this.offlineBatches
      );
      this.lastMergeReport = report;
      this.queued = 0;
      this.persist();
      return report;
    },
    // 保留批次经线下人工处理后，可手动移出队列；对应的读数/差异历史保留
    discardKeptBatch(id: string) {
      this.offlineBatches = this.offlineBatches.filter((batch) => batch.id !== id);
      this.persist();
    },
    // 重置回演示批次（含跨终端一致、读数冲突、定级矛盾、未知展品、坏数据五种情形）
    resetDemoBatches() {
      this.offlineBatches = demoOfflineBatches();
      this.lastMergeReport = null;
      this.persist();
    },
    syncQueue() { this.queued = 0; this.persist(); }
  }
});

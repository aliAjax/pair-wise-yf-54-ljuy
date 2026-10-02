// 断网多终端暂存批次恢复时的合并逻辑（纯函数，不依赖 Vue/Pinia）。
// 规则：
// 1. 同一展品的环境读数按字段、按采集时间逐字段合并，历史全部保留；
// 2. 同字段同一采集时间点读数不一致即为冲突，所有终端的读数都留下，
//    后到批次不得直接覆盖先到读数，当前值停留在最后一个一致读数；
// 3. 合并后环境读数实际更新且原判定为“通过”的展品退回待复核并写明原因，
//    已有签字原样保留（合并逻辑不触碰签字）；
// 4. 校验失败、指向未知展品或读数/差异项互相矛盾时，相关离线批次整批保留，
//    冲突记录标明终端与采集时间点。

export type EnvField = 'temperature' | 'humidity' | 'light';
export const ENV_FIELDS: EnvField[] = ['temperature', 'humidity', 'light'] as const;

export const FIELD_LABELS: Record<EnvField, string> = {
  temperature: '温度',
  humidity: '湿度',
  light: '照度'
};

export const FIELD_UNITS: Record<EnvField, string> = {
  temperature: '℃',
  humidity: '%',
  light: 'lux'
};

export interface EnvironmentReading {
  field: EnvField;
  value: number;
  collectedAt: string; // ISO 时间，按采集设备本地时钟记录
  terminalId: string;
}

export interface OfflineDiscrepancy {
  id: string;
  title: string;
  severity: 'minor' | 'major';
  collectedAt: string;
  terminalId: string;
}

export type BatchStatus = 'pending' | 'merged' | 'kept';

export interface OfflineBatch {
  id: string;
  terminalId: string;
  exhibitId: string;
  submittedAt: string;
  readings: EnvironmentReading[];
  discrepancies: OfflineDiscrepancy[];
  status: BatchStatus;
  keepReason?: string;
}

export interface StoredDiscrepancy {
  id: string;
  exhibitId: string;
  title: string;
  severity: 'minor' | 'major';
  resolved: boolean;
  terminalId?: string;
  collectedAt?: string;
  conflict?: boolean;
  // 同一差异被多台终端上报时，记录每个上报来源
  sources?: { terminalId: string; collectedAt: string }[];
}

export type ConflictKind = 'reading' | 'discrepancy' | 'unknown-exhibit' | 'invalid-batch';

export interface MergeConflict {
  id: string;
  kind: ConflictKind;
  exhibitId?: string;
  field?: EnvField;
  collectedAt: string;
  terminalIds: string[];
  batchIds: string[];
  detail: string;
  values?: { terminalId: string; value: number }[];
}

export interface ChangedField {
  field: EnvField;
  from: number;
  to: number;
  collectedAt: string;
  terminalId: string;
}

export interface ReviewedExhibit {
  exhibitId: string;
  changedFields: ChangedField[];
  reason: string;
}

export interface KeptBatchInfo {
  batchId: string;
  terminalId: string;
  reason: string;
}

export interface MergeReport {
  at: string;
  mergedBatchIds: string[];
  keptBatches: KeptBatchInfo[];
  conflicts: MergeConflict[];
  reviewed: ReviewedExhibit[];
}

export interface MergeableExhibit {
  id: string;
  status: string;
  environment: Record<EnvField, number>;
  reviewReason?: string;
}

export interface MergeState {
  exhibits: MergeableExhibit[];
  discrepancies: StoredDiscrepancy[];
  environmentHistory: Record<string, EnvironmentReading[]>;
  conflicts: MergeConflict[];
}

type AnnReading = EnvironmentReading & { batchId: string };
type AnnDiscrepancy = OfflineDiscrepancy & { batchId: string };

function t(time: string): number {
  return Date.parse(time) || 0;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function conflictId(parts: (string | undefined)[]): string {
  return 'cf-' + parts.filter(Boolean).join('::');
}

function validateBatch(batch: OfflineBatch): string | null {
  if (!batch.terminalId?.trim()) return '缺少终端编号';
  if (!batch.exhibitId?.trim()) return '缺少展品编号';
  for (const reading of batch.readings) {
    if (!ENV_FIELDS.includes(reading.field)) return `存在未知环境字段（批次读数 ${JSON.stringify(reading.field)}）`;
    if (typeof reading.value !== 'number' || !Number.isFinite(reading.value)) return `温度/湿度/照度读数不是有效数值（${reading.field}）`;
    if (!reading.collectedAt || Number.isNaN(Date.parse(reading.collectedAt))) return `存在缺少采集时间的读数（${reading.field}）`;
    if (!reading.terminalId?.trim()) return `存在缺少终端标记的读数（${reading.field}）`;
  }
  for (const discrepancy of batch.discrepancies) {
    if (!discrepancy.title?.trim()) return '存在缺少标题的差异项';
    if (discrepancy.severity !== 'minor' && discrepancy.severity !== 'major') return `差异项「${discrepancy.title}」定级非法`;
    if (!discrepancy.collectedAt || Number.isNaN(Date.parse(discrepancy.collectedAt))) return `差异项「${discrepancy.title}」缺少采集时间`;
  }
  return null;
}

/**
 * 合并所有尚未成功合入的离线批次（pending / 上次保留的 kept 可再次尝试）。
 * 就地更新 state 与 batches，并返回本次合并报告。
 */
export function runMerge(state: MergeState, batches: OfflineBatch[]): MergeReport {
  const report: MergeReport = {
    at: new Date().toISOString(),
    mergedBatchIds: [],
    keptBatches: [],
    conflicts: [],
    reviewed: []
  };

  const eligible = batches.filter((batch) => batch.status !== 'merged');
  if (!eligible.length) return report;

  // 批次 -> 保留原因（一个批次可能牵涉多处冲突）
  const reasons = new Map<string, string[]>();
  const keepBatch = (batch: OfflineBatch, reason: string) => {
    const list = reasons.get(batch.id) ?? [];
    list.push(`【终端 ${batch.terminalId}】${reason}`);
    reasons.set(batch.id, list);
  };

  const addConflict = (conflict: Omit<MergeConflict, 'id'> & { id?: string }, id: string) => {
    // 重试合并时同一冲突不重复记录
    if (state.conflicts.some((item) => item.id === id) || report.conflicts.some((item) => item.id === id)) return;
    state.conflicts.push({ ...conflict, id });
    report.conflicts.push(state.conflicts[state.conflicts.length - 1]);
  };

  // 1. 校验：合并不了的批次整批保留
  const valid: OfflineBatch[] = [];
  for (const batch of eligible) {
    batch.keepReason = undefined;
    const problem = validateBatch(batch);
    if (problem) {
      const reason = `批次数据校验失败：${problem}，整批保留待人工核查（提交于 ${batch.submittedAt}）`;
      keepBatch(batch, reason);
      addConflict(
        {
          kind: 'invalid-batch',
          collectedAt: batch.submittedAt,
          terminalIds: [batch.terminalId],
          batchIds: [batch.id],
          detail: reason
        },
        conflictId(['invalid', batch.id])
      );
      continue;
    }
    valid.push(batch);
  }

  // 2. 按展品分组；指向未知展品的批次整批保留
  const knownIds = new Set(state.exhibits.map((item) => item.id));
  const byExhibit = new Map<string, OfflineBatch[]>();
  for (const batch of valid) {
    if (!knownIds.has(batch.exhibitId)) {
      const reason = `批次指向不存在的展品 ${batch.exhibitId}，无法定位合并目标，整批保留（提交于 ${batch.submittedAt}）`;
      keepBatch(batch, reason);
      addConflict(
        {
          kind: 'unknown-exhibit',
          exhibitId: batch.exhibitId,
          collectedAt: batch.submittedAt,
          terminalIds: [batch.terminalId],
          batchIds: [batch.id],
          detail: reason
        },
        conflictId(['unknown', batch.exhibitId, batch.id])
      );
      continue;
    }
    const list = byExhibit.get(batch.exhibitId) ?? [];
    list.push(batch);
    byExhibit.set(batch.exhibitId, list);
  }

  for (const [exhibitId, exhibitBatches] of byExhibit) {
    const exhibit = state.exhibits.find((item) => item.id === exhibitId)!;

    // ---- 环境读数：逐字段、按采集时间合并 ----
    const incomingReadings: AnnReading[] = exhibitBatches.flatMap((batch) =>
      batch.readings.map((reading) => ({ ...reading, batchId: batch.id }))
    );

    if (incomingReadings.length) {
      // 内部历史条目带 batchId，用于冲突时回溯应保留的批次
      const history: (EnvironmentReading & { batchId?: string })[] = state.environmentHistory[exhibitId] ?? [];
      // 同一终端重报完全相同的读数（重试合并）去重；矛盾读数不去重
      const seen = new Set(history.map((r) => `${r.terminalId}|${r.collectedAt}|${r.field}|${r.value}`));
      for (const reading of incomingReadings) {
        const key = `${reading.terminalId}|${reading.collectedAt}|${reading.field}|${reading.value}`;
        if (seen.has(key)) continue;
        seen.add(key);
        history.push({ field: reading.field, value: reading.value, collectedAt: reading.collectedAt, terminalId: reading.terminalId, batchId: reading.batchId });
      }
      history.sort((a, b) => t(a.collectedAt) - t(b.collectedAt) || a.terminalId.localeCompare(b.terminalId));
      state.environmentHistory[exhibitId] = history as EnvironmentReading[];

      const changedFields: ChangedField[] = [];

      for (const field of ENV_FIELDS) {
        const perField = history.filter((r) => r.field === field);
        // 采集时间点 -> 该时间点出现过的不同读数
        const atTime = new Map<string, (EnvironmentReading & { batchId?: string })[]>();
        for (const reading of perField) {
          const list = atTime.get(reading.collectedAt) ?? [];
          list.push(reading);
          atTime.set(reading.collectedAt, list);
        }

        const conflictTimes = new Set<string>();
        for (const [collectedAt, group] of atTime) {
          const distinct = new Map<number, (EnvironmentReading & { batchId?: string })[]>();
          for (const reading of group) {
            const list = distinct.get(reading.value) ?? [];
            list.push(reading);
            distinct.set(reading.value, list);
          }
          if (distinct.size <= 1) continue;

          // 同字段、同采集时间点、读数不一致：所有读数都留下，登记冲突
          conflictTimes.add(collectedAt);
          const terminals = unique(group.map((r) => r.terminalId));
          const batchIds = unique(group.map((r) => r.batchId).filter((id): id is string => Boolean(id)));
          const values = [...distinct.entries()].map(([value, rs]) => ({
            value,
            terminalId: unique(rs.map((r) => r.terminalId)).join('/')
          }));
          const valueText = values.map((v) => `终端 ${v.terminalId} 报 ${v.value}${FIELD_UNITS[field]}`).join('，');
          const detail = `${FIELD_LABELS[field]}读数互相矛盾：采集时间 ${collectedAt}，${valueText}；各终端读数均保留，后到读数未覆盖先到读数，当前值暂取最后一致读数。`;
          const id = conflictId(['reading', exhibitId, field, collectedAt]);
          addConflict(
            { kind: 'reading', exhibitId, field, collectedAt, terminalIds: terminals, batchIds, detail, values: values.map((v) => ({ terminalId: v.terminalId, value: v.value })) },
            id
          );
          for (const batchId of batchIds) {
            const batch = exhibitBatches.find((b) => b.id === batchId);
            const mine = incomingReadings.find((r) => r.batchId === batchId && r.field === field && r.collectedAt === collectedAt);
            if (batch) keepBatch(batch, `${FIELD_LABELS[field]}读数在 ${collectedAt} 与终端 ${terminals.filter((x) => x !== batch.terminalId).join('/') || terminals.join('/')} 矛盾（本终端报 ${mine?.value}${FIELD_UNITS[field]}），读数双留待判`);
          }
        }

        // 当前值：取时间最晚且该时间点无矛盾的读数；最新读数处于冲突时不动当前值
        let candidate: EnvironmentReading | undefined;
        for (const timeKey of [...atTime.keys()].sort((a, b) => t(b) - t(a))) {
          if (conflictTimes.has(timeKey)) continue;
          candidate = atTime.get(timeKey)![0];
          break;
        }
        const before = exhibit.environment[field];
        if (candidate && candidate.value !== before) {
          exhibit.environment[field] = candidate.value;
          changedFields.push({ field, from: before, to: candidate.value, collectedAt: candidate.collectedAt, terminalId: candidate.terminalId });
        }
      }

      // 3. 读数实际更新且原判定为通过 -> 退回待复核；其它状态仅更新读数
      const conflictCount = state.conflicts.filter((c) => c.kind === 'reading' && c.exhibitId === exhibitId).length;
      if (changedFields.length && exhibit.status === 'passed') {
        exhibit.status = 'review';
        const changeText = changedFields
          .map((c) => `${FIELD_LABELS[c.field]} ${c.from}→${c.to}${FIELD_UNITS[c.field]}（终端 ${c.terminalId}，采集 ${c.collectedAt}）`)
          .join('、');
        exhibit.reviewReason =
          `离线批次合并后环境读数更新：${changeText}；原“通过”判定失效，退回待复核。` +
          (conflictCount ? ` 另有 ${conflictCount} 处读数矛盾已全部保留并挂起。` : '') +
          ' 原有签字保留，无需重签。';
        report.reviewed.push({ exhibitId, changedFields, reason: exhibit.reviewReason });
      } else if (changedFields.length && exhibit.status === 'review' && conflictCount) {
        exhibit.reviewReason = `${exhibit.reviewReason ?? '待复核。'}（最近一次合并仍有 ${conflictCount} 处读数矛盾挂起）`;
      }
    }

    // ---- 差异项：按标题归并，同标题不同定级视为矛盾，两条都留下 ----
    const incomingDiscrepancies: AnnDiscrepancy[] = exhibitBatches.flatMap((batch) =>
      batch.discrepancies.map((d) => ({ ...d, batchId: batch.id }))
    );

    for (const incoming of incomingDiscrepancies) {
      const existing = state.discrepancies.filter((d) => d.exhibitId === exhibitId && d.title === incoming.title);

      if (!existing.length) {
        state.discrepancies.push({
          id: incoming.id,
          exhibitId,
          title: incoming.title,
          severity: incoming.severity,
          resolved: false,
          terminalId: incoming.terminalId,
          collectedAt: incoming.collectedAt,
          conflict: false,
          sources: [{ terminalId: incoming.terminalId, collectedAt: incoming.collectedAt }]
        });
        continue;
      }

      const sameSeverity = existing.find((d) => d.severity === incoming.severity);
      const exactSource = existing.some((d) =>
        d.sources?.some((s) => s.terminalId === incoming.terminalId && s.collectedAt === incoming.collectedAt)
      );

      if (sameSeverity) {
        // 同标题同定级：多终端重复上报，合并来源而不是重复建档
        if (!exactSource) {
          sameSeverity.sources = sameSeverity.sources ?? [];
          if (!sameSeverity.sources.some((s) => s.terminalId === incoming.terminalId)) {
            sameSeverity.sources.push({ terminalId: incoming.terminalId, collectedAt: incoming.collectedAt });
          }
        }
        continue;
      }

      // 同标题但定级不一致：矛盾，两条都保留并标记
      if (exactSource) continue; // 重试合并幂等
      const opposite = existing[0];
      const stored: StoredDiscrepancy = {
        id: incoming.id,
        exhibitId,
        title: incoming.title,
        severity: incoming.severity,
        resolved: false,
        terminalId: incoming.terminalId,
        collectedAt: incoming.collectedAt,
        conflict: true,
        sources: [{ terminalId: incoming.terminalId, collectedAt: incoming.collectedAt }]
      };
      state.discrepancies.push(stored);
      opposite.conflict = true;
      const sevLabel = (severity: 'minor' | 'major') => (severity === 'major' ? '重大差异' : '轻微差异');
      const terminals = unique([opposite.terminalId ?? '未知终端', incoming.terminalId]);
      const batchIds = unique([incoming.batchId]);
      const detail =
        `差异项「${incoming.title}」定级矛盾：终端 ${opposite.terminalId ?? '未知终端'} 于 ${opposite.terminalId ? opposite.collectedAt : '此前'} 记为${sevLabel(opposite.severity)}，` +
        `终端 ${incoming.terminalId} 于 ${incoming.collectedAt} 记为${sevLabel(incoming.severity)}；两条记录均保留待人工判定。`;
      addConflict(
        { kind: 'discrepancy', exhibitId, collectedAt: incoming.collectedAt, terminalIds: terminals, batchIds, detail },
        conflictId(['discrepancy', exhibitId, incoming.title])
      );
      const batch = exhibitBatches.find((b) => b.id === incoming.batchId);
      if (batch) keepBatch(batch, `差异项「${incoming.title}」定级与终端 ${opposite.terminalId ?? '未知终端'}矛盾，两条记录双留`);
    }
  }

  // 4. 批次处置：无任何保留原因即合并成功。
  //    幂等重试时冲突登记会跳过，这里统一兜底：批次仍关联任一未消解冲突（含上轮登记的）就继续保留。
  for (const conflict of state.conflicts) {
    for (const batchId of conflict.batchIds) {
      const batch = eligible.find((b) => b.id === batchId);
      if (batch && !reasons.has(batch.id)) {
        keepBatch(batch, `仍关联未消解冲突（${conflict.kind === 'reading' ? '读数矛盾' : conflict.kind === 'discrepancy' ? '差异项矛盾' : conflict.kind === 'unknown-exhibit' ? '展品不存在' : '批次校验失败'}，时间点 ${conflict.collectedAt}，终端 ${conflict.terminalIds.join('/')}）`);
      }
    }
  }
  for (const batch of eligible) {
    const reasonList = reasons.get(batch.id);
    if (reasonList?.length) {
      batch.status = 'kept';
      batch.keepReason = reasonList.join('；');
      report.keptBatches.push({ batchId: batch.id, terminalId: batch.terminalId, reason: batch.keepReason });
    } else {
      batch.status = 'merged';
      batch.keepReason = undefined;
      report.mergedBatchIds.push(batch.id);
    }
  }

  return report;
}

// ---- 演示用断网批次：模拟三终端在网络恢复瞬间同时提交 ----
export function demoOfflineBatches(): OfflineBatch[] {
  return [
    {
      id: 'batch-T01-a',
      terminalId: 'T-01',
      exhibitId: 'ex-1',
      submittedAt: '2026-10-02T10:08:00',
      status: 'pending',
      readings: [
        { field: 'temperature', value: 21.0, collectedAt: '2026-10-02T10:02:00', terminalId: 'T-01' },
        { field: 'humidity', value: 52, collectedAt: '2026-10-02T10:03:00', terminalId: 'T-01' }
      ],
      discrepancies: [
        { id: 'd-b1', title: '展柜密封条松动', severity: 'minor', collectedAt: '2026-10-02T10:04:00', terminalId: 'T-01' }
      ]
    },
    {
      id: 'batch-T02-a',
      terminalId: 'T-02',
      exhibitId: 'ex-1',
      submittedAt: '2026-10-02T10:08:10',
      status: 'pending',
      readings: [
        { field: 'temperature', value: 22.5, collectedAt: '2026-10-02T10:05:00', terminalId: 'T-02' },
        { field: 'light', value: 148, collectedAt: '2026-10-02T10:05:30', terminalId: 'T-02' }
      ],
      discrepancies: [
        // 与 T-01 同标题同定级：应去重合并来源，不建档两次
        { id: 'd-b2', title: '展柜密封条松动', severity: 'minor', collectedAt: '2026-10-02T10:06:00', terminalId: 'T-02' }
      ]
    },
    {
      id: 'batch-T03-a',
      terminalId: 'T-03',
      exhibitId: 'ex-1',
      submittedAt: '2026-10-02T10:08:20',
      status: 'pending',
      readings: [
        // 与 T-02 同一采集时间点、温度读数不一致：双留冲突
        { field: 'temperature', value: 23.1, collectedAt: '2026-10-02T10:05:00', terminalId: 'T-03' },
        { field: 'humidity', value: 55, collectedAt: '2026-10-02T10:07:00', terminalId: 'T-03' }
      ],
      discrepancies: []
    },
    {
      id: 'batch-T02-b',
      terminalId: 'T-02',
      exhibitId: 'ex-2',
      submittedAt: '2026-10-02T10:08:10',
      status: 'pending',
      readings: [{ field: 'temperature', value: 21.5, collectedAt: '2026-10-02T10:10:00', terminalId: 'T-02' }],
      discrepancies: []
    },
    {
      id: 'batch-T01-b',
      terminalId: 'T-01',
      exhibitId: 'ex-7',
      submittedAt: '2026-10-02T10:08:00',
      status: 'pending',
      readings: [],
      discrepancies: [
        // 与既有差异 d2 同标题但定级不同（既有为轻微）：定级矛盾，双留
        { id: 'd-b3', title: '木箱边角轻微磕碰', severity: 'major', collectedAt: '2026-10-02T09:58:00', terminalId: 'T-01' }
      ]
    },
    {
      id: 'batch-T03-b',
      terminalId: 'T-03',
      exhibitId: 'ex-999',
      submittedAt: '2026-10-02T10:08:20',
      status: 'pending',
      readings: [{ field: 'temperature', value: 19.8, collectedAt: '2026-10-02T10:00:00', terminalId: 'T-03' }],
      discrepancies: []
    },
    {
      id: 'batch-T02-c',
      terminalId: 'T-02',
      exhibitId: 'ex-3',
      submittedAt: '2026-10-02T10:08:10',
      status: 'pending',
      // 缺采集时间：校验失败，整批保留
      readings: [{ field: 'humidity', value: 60, collectedAt: '', terminalId: 'T-02' }],
      discrepancies: []
    }
  ];
}

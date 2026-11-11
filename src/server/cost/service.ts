/**
 * 成本服务：把 CostEngine 接到聚合查询上（汇总 / 周期卡 / 时间序列 / 分组 / 成本汇总 / 订阅回本）。
 * 所有金额都在这里算好，前端只做格式化。
 */
import { filterBase, selectRecords, summarize } from '../core/aggregate.ts';
import type { AggregateContext, AggregateQuery, Selection } from '../core/aggregate.ts';
import { modelGroupOf } from '../core/models.ts';
import { billingCycle, enumerateBuckets, localParts, periodBounds } from '../core/time.ts';
import type { UsageRecord } from '../../shared/types.ts';
import { L } from '../i18n.ts';
import { byTypeUsd, bySubTypeUsd, CostEngine, mergeAcc, newAcc, roundUsd } from './engine.ts';
import type { CostAcc, CostBlock, CostType } from './engine.ts';

export const costNoteEstimate = (): string => L('成本均为估算：等价 API 成本 = 本机记录的 token 按各模型官方 API 单价折算，以官方账单为准。', 'All costs are estimates: API-equivalent cost = tokens recorded on this machine at the official API prices of each model; the official bill is authoritative.');

export function pctChange(cur: number | null, prev: number | null): number | null {
  if (cur === null || prev === null || prev <= 0) return null;
  return (cur - prev) / prev;
}

/** 汇总：一次选择的成本。 */
export function selectionCost(engine: CostEngine, sel: Selection): CostBlock {
  return engine.total(sel.records).block;
}

export interface PeriodCosts {
  today: CostBlock;
  yesterday: CostBlock;
  thisWeek: CostBlock;
  prevWeek: CostBlock;
  thisMonth: CostBlock;
  prevMonth: CostBlock;
  /** 等价 API 成本环比（小数；上期为 0 / 无法计算 → null） */
  deltas: { today: number | null; week: number | null; month: number | null };
}

export function periodCosts(engine: CostEngine, ctx: AggregateContext, q: AggregateQuery): PeriodCosts {
  const base = filterBase(ctx, q);
  const b = periodBounds(q.now, q.tz, q.weekStart, q.billingDay ?? null);
  const blk = (range: [number, number]): CostBlock => engine.total(base.filter((r) => r.ts >= range[0] && r.ts < range[1])).block;
  const today = blk(b.today);
  const yesterday = blk(b.yesterday);
  const thisWeek = blk(b.thisWeek);
  const prevWeek = blk(b.prevWeek);
  const thisMonth = blk(b.thisMonth);
  const prevMonth = blk(b.prevMonth);
  return {
    today,
    yesterday,
    thisWeek,
    prevWeek,
    thisMonth,
    prevMonth,
    deltas: { today: pctChange(today.apiUsd, yesterday.apiUsd), week: pctChange(thisWeek.apiUsd, prevWeek.apiUsd), month: pctChange(thisMonth.apiUsd, prevMonth.apiUsd) },
  };
}

// ---------------------------------------------------------------------------
// 时间序列
// ---------------------------------------------------------------------------

export interface CostSeries {
  cost: CostBlock;
  /** 与 points 对齐的等价 API 成本（USD；无记录的桶为 0） */
  api: number[];
  /** 订阅摊销（USD）；未设置订阅方案为 null */
  sub: number[] | null;
}

export interface TimelineCost {
  points: CostBlock[];
  series: Map<string, CostSeries>;
}

function upperBound(starts: number[], ts: number): number {
  let lo = 0;
  let hi = starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (starts[mid]! <= ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const TYPE_LABEL: CostType[] = ['input', 'cacheWrite', 'cacheRead', 'output'];

/** 时间序列的成本：points 与 aggregate().timeline 一一对应；series 的键与 aggregate().series 一致（none → total）。 */
export function timelineCost(engine: CostEngine, ctx: AggregateContext, q: AggregateQuery, sel: Selection): TimelineCost {
  const buckets = sel.fromTs !== null && sel.toTs !== null ? enumerateBuckets(sel.fromTs, sel.toTs, q.granularity, q.tz, q.weekStart) : [];
  const starts = buckets.map((b) => b.start);
  const n = buckets.length;
  const pointAcc: CostAcc[] = buckets.map(() => newAcc());
  const merge = q.mergeModelFamilies ?? false;
  const seriesAcc = new Map<string, CostAcc[]>();
  const getSeries = (key: string): CostAcc[] => {
    let s = seriesAcc.get(key);
    if (!s) {
      s = Array.from({ length: n }, () => newAcc());
      seriesAcc.set(key, s);
    }
    return s;
  };
  for (const r of sel.records) {
    const idx = upperBound(starts, r.ts) - 1;
    if (idx < 0 || idx >= n) continue;
    engine.add(pointAcc[idx]!, r);
    if (q.split === 'model') engine.add(getSeries(modelGroupOf(r.model, merge, q.modelNormalize).key)[idx]!, r);
    else if (q.split === 'project') engine.add(getSeries(ctx.projects.idOfKey(r.projectKey))[idx]!, r);
  }
  const series = new Map<string, CostSeries>();
  const mk = (accs: CostAcc[], pick: (a: CostAcc) => { api: number; sub: number }, typeIdx?: number): CostSeries => {
    const tot = newAcc();
    for (const a of accs) mergeAcc(tot, a);
    const block = engine.block(tot);
    // token 类型系列：该系列自己的金额（而不是整个选择的合计）
    if (typeIdx !== undefined) {
      block.apiUsd = block.apiUsd === null ? null : roundUsd(tot.comps[typeIdx]!);
      block.subUsd = block.subUsd === null ? null : r6(tot.subComps[typeIdx]!);
    }
    return {
      cost: block,
      api: accs.map((a) => pick(a).api),
      sub: engine.subscriptionConfigured ? accs.map((a) => pick(a).sub) : null,
    };
  };
  const r6 = (x: number): number => Math.round(x * 1e6) / 1e6;
  switch (q.split) {
    case 'none':
      series.set('total', mk(pointAcc, (a) => ({ api: roundUsd(a.nano), sub: r6(a.sub) })));
      break;
    case 'tokenType':
      TYPE_LABEL.forEach((t, i) => series.set(t, mk(pointAcc, (a) => ({ api: roundUsd(a.comps[i]!), sub: r6(a.subComps[i]!) }), i)));
      break;
    default:
      for (const [key, accs] of seriesAcc) series.set(key, mk(accs, (a) => ({ api: roundUsd(a.nano), sub: r6(a.sub) })));
  }
  return { points: pointAcc.map((a) => engine.block(a)), series };
}

// ---------------------------------------------------------------------------
// /api/cost/summary
// ---------------------------------------------------------------------------

export interface CostSummaryGroup {
  id: string;
  label: string;
  /** basis 口径的 token 数 */
  tokens: number;
  cost: CostBlock;
}

export function costSummary(opts: {
  engine: CostEngine;
  ctx: AggregateContext;
  q: AggregateQuery;
  plan: string | null;
  monthlyFeeUsd: number | null;
}): unknown {
  const { engine, ctx, q } = opts;
  const sel = selectRecords(ctx, q);
  const sum = summarize(sel.records, q.basis, q.tz);
  const { acc, block } = engine.total(sel.records);

  // 日期跨度（本地日序号）
  let fromDn: number | null = null;
  let toDn: number | null = null;
  if (sel.fromTs !== null && sel.toTs !== null) {
    fromDn = localParts(sel.fromTs, q.tz).dayNumber;
    toDn = localParts(sel.toTs - 1, q.tz).dayNumber;
  }
  const isAll = q.range.kind === 'all';
  if (isAll) {
    // all：从全部记录的最早一天（或选择的最早一天）到今天；没有任何记录则无跨度
    toDn = engine.todayDn;
    fromDn = sel.fromTs !== null ? localParts(sel.fromTs, q.tz).dayNumber : null;
  }
  const hasSpan = fromDn !== null && toDn !== null && fromDn <= Math.min(toDn, engine.todayDn);
  const lastDn = hasSpan ? Math.min(toDn!, engine.todayDn) : null;

  // 每日
  const perDay = engine.group(sel.records, (r) => localParts(r.ts, q.tz).dayNumber);
  const daily: Array<{ date: string; apiUsd: number | null; feeUsd: number | null }> = [];
  if (hasSpan) {
    for (let d = fromDn!; d <= lastDn!; d++) {
      const a = perDay.get(d);
      const p = localParts(d * 86_400_000 + 43_200_000, 'UTC'); // 日序号 → 日期（UTC 正午，避免边界）
      daily.push({ date: p.date, apiUsd: block.apiUsd === null ? null : a ? roundUsd(a.nano) : 0, feeUsd: engine.subscriptionConfigured ? Math.round(engine.dailyFee(d) * 1e6) / 1e6 : null });
    }
  }

  // 订阅摊销
  const configured = engine.subscriptionConfigured;
  const idle = configured && hasSpan ? engine.idleUsd(fromDn!, lastDn!) : configured ? 0 : null;
  const feeTotal = configured && hasSpan ? engine.feeSum(fromDn!, lastDn!) : configured ? 0 : null;
  const tokensM = sum.value / 1e6;
  const subTotal = block.subUsd;
  const denom = subTotal !== null && idle !== null ? subTotal + idle : null;

  const fastApplied = acc.fastApplied > 0;
  const notes: string[] = [costNoteEstimate()];
  if (acc.fastUnconfigured > 0) notes.push(L(`不含 fast 模式溢价（未配置）：${acc.fastUnconfigured} 条 fast 记录按标准价计算。`, `Fast-mode premium not included (not configured): ${acc.fastUnconfigured} fast ${acc.fastUnconfigured === 1 ? 'record is' : 'records are'} priced at the standard rate.`));
  if (fastApplied) notes.push(L(`已按价格表的 fast 倍率计入 ${acc.fastApplied} 条 fast 记录的溢价。`, `The fast-mode premium from the price table was applied to ${acc.fastApplied} fast ${acc.fastApplied === 1 ? 'record' : 'records'}.`));
  if (acc.assumed5m > 0) notes.push(L(`有 ${acc.assumed5m} 个缓存写入 token 缺少 5 分钟 / 1 小时细分，按 5 分钟价计算。`, `${acc.assumed5m} cache-write tokens have no 5-minute / 1-hour breakdown and are priced at the 5-minute rate.`));
  if (block.unpricedModels.length > 0) notes.push(L(`部分模型未计价：${block.unpricedModels.join('、')}（共 ${block.unpricedTokens} token 未计入成本，不会按 0 处理）。`, `Some models are unpriced: ${block.unpricedModels.join(', ')} (${block.unpricedTokens} tokens are not included in the cost; they are not treated as 0).`));
  if (acc.localRecords > 0) notes.push(L('本地模型不计费，不进入成本占比。', 'Local models are not billed and are excluded from cost shares.'));
  if (configured) notes.push(L('订阅摊销是按天、按当天各条目等价 API 成本占比分摊月费的估算，不是套餐额度消耗，也不是实际扣费。', 'Plan-prorated cost is an estimate that splits the monthly fee by day, in proportion to the API-equivalent cost of each entry that day; it is not quota usage or an actual charge.'));

  // 分组表：项目 / 模型（供成本模块的表格）
  const projGroups = engine.group(sel.records, (r) => ctx.projects.idOfKey(r.projectKey));
  const projTokens = new Map<string, number>();
  for (const r of sel.records) {
    const id = ctx.projects.idOfKey(r.projectKey);
    const v = q.basis === 'fresh' ? r.input + r.cacheWrite + r.output : r.input + r.cacheWrite + r.cacheRead + r.output;
    projTokens.set(id, (projTokens.get(id) ?? 0) + v);
  }
  const byProject: CostSummaryGroup[] = [...projGroups.entries()]
    .map(([id, a]) => ({ id, label: ctx.projects.byId.get(id)?.displayName ?? id, tokens: projTokens.get(id) ?? 0, cost: engine.block(a) }))
    .sort((a, b) => (b.cost.apiUsd ?? -1) - (a.cost.apiUsd ?? -1) || b.tokens - a.tokens || (a.id < b.id ? -1 : 1));

  const modelGroups = engine.group(sel.records, (r) => modelGroupOf(r.model, q.mergeModelFamilies ?? false, q.modelNormalize).key);
  const modelTokens = new Map<string, number>();
  const modelLabel = new Map<string, { label: string; local: boolean }>();
  for (const r of sel.records) {
    const g = modelGroupOf(r.model, q.mergeModelFamilies ?? false, q.modelNormalize);
    modelLabel.set(g.key, { label: g.display, local: g.isLocal });
    const v = q.basis === 'fresh' ? r.input + r.cacheWrite + r.output : r.input + r.cacheWrite + r.cacheRead + r.output;
    modelTokens.set(g.key, (modelTokens.get(g.key) ?? 0) + v);
  }
  const byModel = [...modelGroups.entries()]
    .map(([id, a]) => ({ id, label: modelLabel.get(id)?.label ?? id, local: modelLabel.get(id)?.local ?? false, tokens: modelTokens.get(id) ?? 0, cost: engine.block(a) }))
    .sort((a, b) => (b.cost.apiUsd ?? -1) - (a.cost.apiUsd ?? -1) || b.tokens - a.tokens || (a.id < b.id ? -1 : 1));

  const subPerM = subTotal !== null && tokensM > 0 ? subTotal / tokensM : null;
  const apiPerM = block.apiUsd !== null && tokensM > 0 ? block.apiUsd / tokensM : null;
  return {
    currency: 'USD',
    api: {
      totalUsd: block.apiUsd,
      byType: block.apiUsd === null ? null : byTypeUsd(acc),
      unpricedTokens: block.unpricedTokens,
      unpricedModels: block.unpricedModels,
      fastPremiumApplied: fastApplied,
      fastUnconfiguredRecords: acc.fastUnconfigured,
      assumedCacheWrite5mTokens: acc.assumed5m,
      localRecords: acc.localRecords,
    },
    subscription: {
      configured,
      plan: opts.plan,
      monthlyFeeUsd: configured ? opts.monthlyFeeUsd : null,
      totalUsd: subTotal,
      byType: configured ? bySubTypeUsd(acc) : null,
      idleUsd: idle,
      feeSumUsd: feeTotal,
      perMillionTokensUsd: subPerM === null ? null : Math.round(subPerM * 1e6) / 1e6,
      apiPerMillionTokensUsd: apiPerM === null ? null : Math.round(apiPerM * 1e6) / 1e6,
      multiple: block.apiUsd !== null && denom !== null && denom > 0 ? Math.round((block.apiUsd / denom) * 1e4) / 1e4 : null,
    },
    tokens: sum.value,
    daily,
    byProject,
    byModel,
    notes,
  };
}

// ---------------------------------------------------------------------------
// /api/subscription/payback
// ---------------------------------------------------------------------------

export function payback(opts: { engine: CostEngine; ctx: AggregateContext; tz: string; nowTs: number; weekStart: 'monday' | 'sunday'; monthlyFeeUsd: number | null; billingDay?: number | null }): unknown {
  const { engine, ctx, tz, nowTs } = opts;
  const billingDay = opts.billingDay ?? null;
  const lp = localParts(nowTs, tz);
  // 周期：设了续费日 = 当前订阅周期；否则 = 自然月。startDn / endDn = 起点日 / 下个周期起点日（本地日序号）
  let startDn = lp.dayNumber - lp.d + 1;
  let endDn = startDn + daysInMonthOf(lp.y, lp.m);
  if (billingDay !== null) {
    const c = billingCycle(lp.dayNumber, billingDay);
    startDn = c.startDn;
    endDn = c.endDn;
  }
  const dateOf = (dn: number): string => localParts(dn * 86_400_000 + 43_200_000, 'UTC').date;
  const month = billingDay === null ? `${String(lp.y).padStart(4, '0')}-${String(lp.m).padStart(2, '0')}` : dateOf(startDn);
  const elapsedDays = lp.dayNumber - startDn + 1;
  const dim = endDn - startDn;
  const b = periodBounds(nowTs, tz, opts.weekStart, billingDay).thisMonth;
  // "本月至今"：到当前时刻为止（夹具 / 时钟被固定时，数据里可能有晚于"现在"的记录，不应计入）
  const recs = ctx.records.filter((r) => r.ts >= b[0] && r.ts < b[1] && r.ts <= nowTs && r.model !== '<synthetic>');
  const { block } = engine.total(recs);
  const configured = engine.subscriptionConfigured;
  const fee = configured ? opts.monthlyFeeUsd! : null;
  const apiMtd = block.apiUsd;
  const r4 = (x: number): number => Math.round(x * 1e4) / 1e4;
  const projectedApi = apiMtd === null ? null : Math.round(((apiMtd / elapsedDays) * dim) * 1e6) / 1e6;
  return {
    configured,
    month,
    /** 续费日（1–31）；null = 按自然月。设置后 elapsedDays / daysInMonth 指订阅周期的已过天数 / 总天数 */
    billingDay,
    cycleStart: dateOf(startDn),
    cycleEnd: dateOf(endDn - 1),
    elapsedDays,
    daysInMonth: dim,
    apiUsdMtd: apiMtd,
    monthlyFeeUsd: fee,
    proratedFeeUsd: fee === null ? null : Math.round(((fee * elapsedDays) / dim) * 1e6) / 1e6,
    multipleMtd: fee !== null && apiMtd !== null ? r4(apiMtd / fee) : null,
    savingsUsd: fee !== null && apiMtd !== null ? Math.round(Math.max(0, apiMtd - fee) * 1e6) / 1e6 : null,
    paidBack: fee !== null && apiMtd !== null ? apiMtd >= fee : false,
    projected: { apiUsd: projectedApi, multiple: fee !== null && projectedApi !== null ? r4(projectedApi / fee) : null },
    partial: block.unpricedModels.length > 0,
    unpricedModels: block.unpricedModels,
  };
}

function daysInMonthOf(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// ---------------------------------------------------------------------------
// 分组辅助（供 /api/projects、会话、分析、导出复用）
// ---------------------------------------------------------------------------

export function groupCosts<K>(engine: CostEngine, records: readonly UsageRecord[], keyOf: (r: UsageRecord) => K): Map<K, CostBlock> {
  const out = new Map<K, CostBlock>();
  for (const [k, a] of engine.group(records, keyOf)) out.set(k, engine.block(a));
  return out;
}

/** 空成本块（无记录 / 无匹配时）。 */
export function emptyCost(engine: CostEngine): CostBlock {
  return engine.block(newAcc());
}

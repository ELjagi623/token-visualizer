/**
 * 把 `cost` 字段挂到已有聚合响应上（/api/summary、/api/timeseries、/api/projects ……）。
 * 做成"包一层"的纯函数，保证所有聚合端点共用同一套成本计算（不新增并行路径，避免口径分叉）。
 */
import type { AggregateContext, AggregateQuery } from '../core/aggregate.ts';
import { selectRecords } from '../core/aggregate.ts';
import type { UsageRecord } from '../../shared/types.ts';
import { CostEngine, mergeAcc, newAcc } from './engine.ts';
import type { CostAcc, CostBlock } from './engine.ts';
import { periodCosts, selectionCost, timelineCost } from './service.ts';

interface WithSummary {
  summary: object;
  periods?: object;
}

/** /api/summary：顶层 `cost`、`summary.cost`、`periods.<期>.cost`、`periods.costDeltas`。 */
export function attachSummaryCost<T extends WithSummary>(engine: CostEngine, ctx: AggregateContext, q: AggregateQuery, payload: T): T & { cost: CostBlock } {
  const cost = selectionCost(engine, selectRecords(ctx, q));
  const out = { ...payload, summary: { ...payload.summary, cost }, cost } as T & { cost: CostBlock };
  if (payload.periods) {
    const pc = periodCosts(engine, ctx, q);
    const p = payload.periods as Record<string, unknown>;
    const withCost = (k: keyof typeof pc & string): unknown => ({ ...(p[k] as object), cost: pc[k as 'today'] });
    (out as { periods: unknown }).periods = {
      ...p,
      today: withCost('today'),
      yesterday: withCost('yesterday'),
      thisWeek: withCost('thisWeek'),
      prevWeek: withCost('prevWeek'),
      thisMonth: withCost('thisMonth'),
      prevMonth: withCost('prevMonth'),
      costDeltas: pc.deltas,
    };
  }
  return out;
}

interface TsPayload {
  summary: object;
  points: object[];
  series: Array<{ key: string } & object>;
}

/** /api/timeseries：每个点 `points[i].cost`；每个系列 `series[j].cost` 与 `series[j].costValues`（{ api, sub }，与 points 对齐）。 */
export function attachTimeseriesCost<T extends TsPayload>(engine: CostEngine, ctx: AggregateContext, q: AggregateQuery, payload: T): T & { cost: CostBlock } {
  const sel = selectRecords(ctx, q);
  const tc = timelineCost(engine, ctx, q, sel);
  const cost = selectionCost(engine, sel);
  return {
    ...payload,
    summary: { ...payload.summary, cost },
    cost,
    points: payload.points.map((p, i) => ({ ...p, cost: tc.points[i] })),
    series: payload.series.map((s) => {
      const c = tc.series.get(s.key);
      return c ? { ...s, cost: c.cost, costValues: { api: c.api, sub: c.sub } } : s;
    }),
  };
}

/** 成本汇总的小工具：把若干 key 的累加器合并成一个成本块。 */
export function mergedBlock(engine: CostEngine, groups: ReadonlyMap<string, CostAcc>, keys: readonly string[]): CostBlock {
  const acc = newAcc();
  for (const k of keys) {
    const a = groups.get(k);
    if (a) mergeAcc(acc, a);
  }
  return engine.block(acc);
}

/** 按项目文件夹 key 分组的成本累加器（供 /api/projects 使用）。 */
export function costByFolder(engine: CostEngine, records: readonly UsageRecord[]): Map<string, CostAcc> {
  return engine.group(records, (r) => r.projectKey);
}

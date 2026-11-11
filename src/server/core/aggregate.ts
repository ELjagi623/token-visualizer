/**
 * 聚合引擎：在去重后的 UsageRecord 之上按"查询参数"产出汇总、时间序列与各维度分组。
 *
 * 口径见 `src/shared/metrics.ts`。关键不变量（有单测）：
 *   - summary.total = 时间序列各点 total 之和（hour/day/week/month 四种粒度一致）；
 *   - 按 tokenType / model / project 拆分后，各系列之和 = 总量（basis 口径下）；
 *   - Total - Fresh = cacheRead 之和（精确相等）。
 *
 * 性能：对 9 千～数十万条记录做一次线性扫描即可（毫秒级）。预聚合"小时×项目×模型×sidechain"立方
 * 是阶段 2 的可选项，这里没有做；阶段 4 的 (dataVersion, 查询) LRU 缓存会覆盖重复请求。
 */
import type { Basis, UsageNumbers } from '../../shared/metrics.ts';
import { addUsage, cacheHitRate, freshOf, outputInputRatio, totalOf, valueOf, zeroUsage } from '../../shared/metrics.ts';
import type { UsageRecord } from '../../shared/types.ts';
import { modelGroupOf } from './models.ts';
import type { ModelFamily, NormalizeOptions } from './models.ts';
import type { ProjectIndex } from './projects.ts';
import { assertValidTimeZone, bucketOf, enumerateBuckets, localParts, periodBounds, QueryError, resolveRange } from './time.ts';
import type { Granularity, RangeSpec, WeekStart } from './time.ts';

export type SplitMode = 'none' | 'tokenType' | 'model' | 'project';

export interface AggregateQuery {
  /** `all` 或项目 id 列表（普通项目 = projectKey；`scratch` = Scratch 组；见 projects.ts）。 */
  projects: 'all' | string[];
  range: RangeSpec;
  granularity: Granularity;
  tz: string;
  weekStart: WeekStart;
  /** 订阅续费日（1–31）；设置后"本月 / 上月"指订阅周期，缺省 / null = 自然月。来自设置，不是 URL 参数。 */
  billingDay?: number | null;
  basis: Basis;
  /**
   * 模型过滤：mergeModelFamilies=false 时是原始模型名；=true 时是家族键（opus/sonnet/haiku/local/other）。
   * 缺省 / 空数组 = 不过滤。
   */
  models?: string[];
  mergeModelFamilies?: boolean;
  split: SplitMode;
  includeSidechain: boolean;
  /** "当前时间"（epoch ms）：由调用方注入，聚合层不读系统时钟。 */
  now: number;
  /** 本地模型显示名规则（是否去量化后缀），默认 true。 */
  modelNormalize?: NormalizeOptions;
}

export interface AggregateContext {
  records: readonly UsageRecord[];
  projects: ProjectIndex;
}

// ---------------------------------------------------------------------------
// 结果类型
// ---------------------------------------------------------------------------

export interface Summary extends UsageNumbers {
  total: number;
  fresh: number;
  /** 按 basis 选择的值（Total 或 Fresh）。 */
  value: number;
  requests: number;
  sessions: number;
  activeDays: number;
  cacheHitRate: number | null;
  outputInputRatio: number | null;
  avgPerRequest: number | null;
  avgPerSession: number | null;
}

export interface TimelinePoint extends UsageNumbers {
  key: string;
  /** 桶起点（UTC 毫秒）。 */
  start: number;
  total: number;
  fresh: number;
  value: number;
  requests: number;
}

export interface Series {
  key: string;
  label: string;
  /** 与 `timeline` 对齐的值（basis 口径）。 */
  values: number[];
  total: number;
  isLocal?: boolean;
  family?: ModelFamily;
}

export interface AggregateResult {
  range: { fromTs: number | null; toTs: number | null };
  summary: Summary;
  timeline: TimelinePoint[];
  /** split = none 时为单条 `total`；其它见 AggregateQuery.split。 */
  series: Series[];
}

// ---------------------------------------------------------------------------
// 过滤
// ---------------------------------------------------------------------------

export interface Selection {
  records: UsageRecord[];
  fromTs: number | null;
  toTs: number | null;
}

function checkQuery(q: AggregateQuery): void {
  assertValidTimeZone(q.tz);
  if (q.weekStart !== 'monday' && q.weekStart !== 'sunday') throw new QueryError('INVALID_WEEKSTART', `未知的周起始日：${String(q.weekStart)}`);
  if (q.basis !== 'total' && q.basis !== 'fresh') throw new QueryError('INVALID_BASIS', `未知的口径：${String(q.basis)}`);
  if (!['none', 'tokenType', 'model', 'project'].includes(q.split)) throw new QueryError('INVALID_SPLIT', `未知的拆分方式：${String(q.split)}`);
  if (!['hour', 'day', 'week', 'month'].includes(q.granularity)) throw new QueryError('INVALID_GRANULARITY', `未知的时间粒度：${String(q.granularity)}`);
}

/** 项目 / 模型 / 子代理 过滤（不含时间）。 */
export function filterBase(ctx: AggregateContext, q: Pick<AggregateQuery, 'projects' | 'models' | 'mergeModelFamilies' | 'includeSidechain' | 'modelNormalize'>): UsageRecord[] {
  let keys: Set<string> | null = null;
  if (q.projects !== 'all') {
    keys = new Set<string>();
    for (const id of q.projects) {
      const ks = ctx.projects.keysFor(id);
      if (!ks) throw new QueryError('UNKNOWN_PROJECT', `未知的项目：${id}`);
      for (const k of ks) keys.add(k);
    }
  }
  const modelSet = q.models && q.models.length > 0 ? new Set(q.models) : null;
  const merge = q.mergeModelFamilies ?? false;
  const out: UsageRecord[] = [];
  for (const r of ctx.records) {
    if (keys && !keys.has(r.projectKey)) continue;
    if (!q.includeSidechain && r.isSidechain) continue;
    if (r.model === '<synthetic>') continue; // 防御：解析层本就排除
    if (modelSet && !modelSet.has(modelGroupOf(r.model, merge, q.modelNormalize).key)) continue;
    out.push(r);
  }
  return out;
}

/** 完整选择：过滤 + 时间范围（all 时取数据跨度）。 */
export function selectRecords(ctx: AggregateContext, q: AggregateQuery): Selection {
  checkQuery(q);
  const base = filterBase(ctx, q);
  const rr = resolveRange(q.range, q.now, q.tz, q.billingDay ?? null);
  if (rr.fromTs === null || rr.toTs === null) {
    let min = Infinity;
    let max = -Infinity;
    for (const r of base) {
      if (r.ts < min) min = r.ts;
      if (r.ts > max) max = r.ts;
    }
    if (base.length === 0) return { records: [], fromTs: null, toTs: null };
    return { records: base, fromTs: min, toTs: max + 1 };
  }
  const { fromTs, toTs } = rr;
  return { records: base.filter((r) => r.ts >= fromTs && r.ts < toTs), fromTs, toTs };
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

export function summarize(records: readonly UsageRecord[], basis: Basis, tz: string): Summary {
  const u = zeroUsage();
  const sessions = new Set<string>();
  const days = new Set<string>();
  for (const r of records) {
    addUsage(u, r);
    sessions.add(r.sessionId);
    days.add(localParts(r.ts, tz).date);
  }
  return makeSummary(u, records.length, sessions.size, days.size, basis);
}

function makeSummary(u: UsageNumbers, requests: number, sessions: number, activeDays: number, basis: Basis): Summary {
  const value = valueOf(u, basis);
  return {
    ...u,
    total: totalOf(u),
    fresh: freshOf(u),
    value,
    requests,
    sessions,
    activeDays,
    cacheHitRate: cacheHitRate(u),
    outputInputRatio: outputInputRatio(u),
    avgPerRequest: requests > 0 ? value / requests : null,
    avgPerSession: sessions > 0 ? value / sessions : null,
  };
}

// ---------------------------------------------------------------------------
// 时间序列
// ---------------------------------------------------------------------------

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

const TOKEN_TYPES: Array<{ key: 'input' | 'cacheWrite' | 'cacheRead' | 'output'; label: string }> = [
  { key: 'input', label: 'Input' },
  { key: 'cacheWrite', label: 'Cache write' },
  { key: 'cacheRead', label: 'Cache read' },
  { key: 'output', label: 'Output' },
];

export function aggregate(ctx: AggregateContext, q: AggregateQuery): AggregateResult {
  const sel = selectRecords(ctx, q);
  const summary = summarize(sel.records, q.basis, q.tz);

  const buckets = sel.fromTs !== null && sel.toTs !== null ? enumerateBuckets(sel.fromTs, sel.toTs, q.granularity, q.tz, q.weekStart) : [];
  const starts = buckets.map((b) => b.start);
  const n = buckets.length;
  const usage: UsageNumbers[] = buckets.map(() => zeroUsage());
  const reqs: number[] = new Array<number>(n).fill(0);

  // 拆分系列的累加器：key → { label, values[] }
  const seriesAcc = new Map<string, { label: string; values: number[]; isLocal?: boolean; family?: ModelFamily }>();
  const merge = q.mergeModelFamilies ?? false;
  const getSeries = (key: string, label: string, extra?: { isLocal?: boolean; family?: ModelFamily }) => {
    let s = seriesAcc.get(key);
    if (!s) {
      s = { label, values: new Array<number>(n).fill(0), ...extra };
      seriesAcc.set(key, s);
    }
    return s;
  };
  if (q.split === 'none') getSeries('total', 'Total');
  if (q.split === 'tokenType') for (const t of TOKEN_TYPES) if (!(q.basis === 'fresh' && t.key === 'cacheRead')) getSeries(t.key, t.label);

  for (const r of sel.records) {
    const idx = upperBound(starts, r.ts) - 1;
    if (idx < 0 || idx >= n) continue; // 不应发生：桶覆盖了 [from, to)
    addUsage(usage[idx]!, r);
    reqs[idx]!++;
    switch (q.split) {
      case 'none':
        seriesAcc.get('total')!.values[idx]! += valueOf(r, q.basis);
        break;
      case 'tokenType':
        for (const t of TOKEN_TYPES) {
          if (q.basis === 'fresh' && t.key === 'cacheRead') continue;
          seriesAcc.get(t.key)!.values[idx]! += r[t.key];
        }
        break;
      case 'model': {
        const g = modelGroupOf(r.model, merge, q.modelNormalize);
        getSeries(g.key, g.display, { isLocal: g.isLocal, family: g.family }).values[idx]! += valueOf(r, q.basis);
        break;
      }
      case 'project': {
        const id = ctx.projects.idOfKey(r.projectKey);
        const info = ctx.projects.byId.get(id);
        getSeries(id, info?.displayName ?? id).values[idx]! += valueOf(r, q.basis);
        break;
      }
    }
  }

  const timeline: TimelinePoint[] = buckets.map((b, i) => {
    const u = usage[i]!;
    return { ...u, key: b.key, start: b.start, total: totalOf(u), fresh: freshOf(u), value: valueOf(u, q.basis), requests: reqs[i]! };
  });

  const series: Series[] = [...seriesAcc.entries()].map(([key, s]) => ({
    key,
    label: s.label,
    values: s.values,
    total: s.values.reduce((a, b) => a + b, 0),
    ...(s.isLocal !== undefined ? { isLocal: s.isLocal } : {}),
    ...(s.family !== undefined ? { family: s.family } : {}),
  }));
  if (q.split === 'model' || q.split === 'project') series.sort((a, b) => b.total - a.total || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  return { range: { fromTs: sel.fromTs, toTs: sel.toTs }, summary, timeline, series };
}

// ---------------------------------------------------------------------------
// 今日 / 昨日 / 本周 / 本月 及环比
// ---------------------------------------------------------------------------

export interface PeriodStat {
  from: number;
  to: number;
  summary: Summary;
}

export interface PeriodDelta {
  /** (本期 − 上期) / 上期；上期为 0 → null（界面显示"—"）。 */
  pct: number | null;
  diff: number;
}

export interface PeriodCards {
  today: PeriodStat;
  yesterday: PeriodStat;
  thisWeek: PeriodStat;
  prevWeek: PeriodStat;
  thisMonth: PeriodStat;
  prevMonth: PeriodStat;
  /** 环比：今日 vs 昨日（整日）、本周 vs 上周（整周）、本月 vs 上月（整月）；比较的是 basis 口径的 value。 */
  deltas: { today: PeriodDelta; week: PeriodDelta; month: PeriodDelta };
}

function delta(cur: number, prev: number): PeriodDelta {
  return { pct: prev > 0 ? (cur - prev) / prev : null, diff: cur - prev };
}

/** 各"期"的汇总。忽略 q.range / granularity / split，只用项目 / 模型 / 子代理过滤、tz、weekStart、basis、now。 */
export function periodCards(ctx: AggregateContext, q: AggregateQuery): PeriodCards {
  checkQuery(q);
  const base = filterBase(ctx, q);
  const b = periodBounds(q.now, q.tz, q.weekStart, q.billingDay ?? null);
  const stat =(range: [number, number]): PeriodStat => ({
    from: range[0],
    to: range[1],
    summary: summarize(
      base.filter((r) => r.ts >= range[0] && r.ts < range[1]),
      q.basis,
      q.tz,
    ),
  });
  const today = stat(b.today);
  const yesterday = stat(b.yesterday);
  const thisWeek = stat(b.thisWeek);
  const prevWeek = stat(b.prevWeek);
  const thisMonth = stat(b.thisMonth);
  const prevMonth = stat(b.prevMonth);
  return {
    today,
    yesterday,
    thisWeek,
    prevWeek,
    thisMonth,
    prevMonth,
    deltas: {
      today: delta(today.summary.value, yesterday.summary.value),
      week: delta(thisWeek.summary.value, prevWeek.summary.value),
      month: delta(thisMonth.summary.value, prevMonth.summary.value),
    },
  };
}

// ---------------------------------------------------------------------------
// 分组聚合（供阶段 4 / 7 / 8 使用）
// ---------------------------------------------------------------------------

export interface GroupRow extends UsageNumbers {
  total: number;
  fresh: number;
  value: number;
  requests: number;
  /** value / Σ value；全部为 0 时为 0。各行 share 之和 = 1（浮点容差内）。 */
  share: number;
}

function toRow(u: UsageNumbers, requests: number, basis: Basis): Omit<GroupRow, 'share'> {
  return { ...u, total: totalOf(u), fresh: freshOf(u), value: valueOf(u, basis), requests };
}

function withShares<T extends Omit<GroupRow, 'share'>>(rows: T[]): Array<T & { share: number }> {
  const sum = rows.reduce((a, r) => a + r.value, 0);
  return rows.map((r) => ({ ...r, share: sum > 0 ? r.value / sum : 0 }));
}

export interface ModelRow extends GroupRow {
  key: string;
  display: string;
  family: ModelFamily;
  isLocal: boolean;
  /** 该组包含的原始模型名。 */
  rawIds: string[];
}

export function groupByModel(ctx: AggregateContext, q: AggregateQuery): ModelRow[] {
  const sel = selectRecords(ctx, q);
  const merge = q.mergeModelFamilies ?? false;
  const acc = new Map<string, { g: ReturnType<typeof modelGroupOf>; u: UsageNumbers; n: number; raw: Set<string> }>();
  for (const r of sel.records) {
    const g = modelGroupOf(r.model, merge, q.modelNormalize);
    let a = acc.get(g.key);
    if (!a) {
      a = { g, u: zeroUsage(), n: 0, raw: new Set() };
      acc.set(g.key, a);
    }
    addUsage(a.u, r);
    a.n++;
    a.raw.add(r.model);
  }
  const rows = [...acc.entries()].map(([key, a]) => ({
    key,
    display: a.g.display,
    family: a.g.family,
    isLocal: a.g.isLocal,
    rawIds: [...a.raw].sort(),
    ...toRow(a.u, a.n, q.basis),
  }));
  rows.sort((a, b) => b.value - a.value || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return withShares(rows);
}

export interface ProjectRow extends GroupRow {
  id: string;
  displayName: string;
}

export function groupByProject(ctx: AggregateContext, q: AggregateQuery): ProjectRow[] {
  const sel = selectRecords(ctx, q);
  const acc = new Map<string, { u: UsageNumbers; n: number }>();
  for (const r of sel.records) {
    const id = ctx.projects.idOfKey(r.projectKey);
    let a = acc.get(id);
    if (!a) {
      a = { u: zeroUsage(), n: 0 };
      acc.set(id, a);
    }
    addUsage(a.u, r);
    a.n++;
  }
  const rows = [...acc.entries()].map(([id, a]) => ({ id, displayName: ctx.projects.byId.get(id)?.displayName ?? id, ...toRow(a.u, a.n, q.basis) }));
  rows.sort((a, b) => b.value - a.value || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return withShares(rows);
}

export interface SessionRow extends GroupRow {
  sessionId: string;
  projectKey: string;
  projectId: string;
  firstTs: number;
  lastTs: number;
  sidechainRequests: number;
  /** token 最多的模型分组键（按 mergeModelFamilies 口径）。 */
  mainModel: string;
}

export function groupBySession(ctx: AggregateContext, q: AggregateQuery): SessionRow[] {
  const sel = selectRecords(ctx, q);
  const merge = q.mergeModelFamilies ?? false;
  interface Acc {
    u: UsageNumbers;
    n: number;
    side: number;
    first: number;
    last: number;
    projectKey: string;
    models: Map<string, number>;
  }
  const acc = new Map<string, Acc>();
  for (const r of sel.records) {
    let a = acc.get(r.sessionId);
    if (!a) {
      a = { u: zeroUsage(), n: 0, side: 0, first: r.ts, last: r.ts, projectKey: r.projectKey, models: new Map() };
      acc.set(r.sessionId, a);
    }
    addUsage(a.u, r);
    a.n++;
    if (r.isSidechain) a.side++;
    if (r.ts < a.first) {
      a.first = r.ts;
      a.projectKey = r.projectKey;
    }
    if (r.ts > a.last) a.last = r.ts;
    const mk = modelGroupOf(r.model, merge, q.modelNormalize).key;
    a.models.set(mk, (a.models.get(mk) ?? 0) + valueOf(r, q.basis));
  }
  const rows = [...acc.entries()].map(([sessionId, a]) => {
    let main = '';
    let best = -1;
    for (const [k, v] of [...a.models.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
      if (v > best) {
        best = v;
        main = k;
      }
    }
    return {
      sessionId,
      projectKey: a.projectKey,
      projectId: ctx.projects.idOfKey(a.projectKey),
      firstTs: a.first,
      lastTs: a.last,
      sidechainRequests: a.side,
      mainModel: main,
      ...toRow(a.u, a.n, q.basis),
    };
  });
  rows.sort((a, b) => b.value - a.value || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0));
  return withShares(rows);
}

export interface ToolRow {
  name: string;
  count: number;
}

/** 工具调用次数（仅 name；按 tool_use block id 去重后的记录级计数，归属所有权文件）。 */
export function groupByTool(ctx: AggregateContext, q: AggregateQuery): ToolRow[] {
  const sel = selectRecords(ctx, q);
  const m = new Map<string, number>();
  for (const r of sel.records) for (const [name, c] of Object.entries(r.tools)) m.set(name, (m.get(name) ?? 0) + c);
  return [...m.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1));
}

/** 小时 × 星期 网格：`grid[weekday][hour]`，weekday 0 = 周日 … 6 = 周六，按 basis 取值。 */
export function hourWeekGrid(ctx: AggregateContext, q: AggregateQuery): number[][] {
  const sel = selectRecords(ctx, q);
  const grid = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  for (const r of sel.records) {
    const p = localParts(r.ts, q.tz);
    grid[p.weekday]![p.h]! += valueOf(r, q.basis);
  }
  return grid;
}

export interface SidechainSplit {
  main: Omit<GroupRow, 'share'> & { share: number };
  sidechain: Omit<GroupRow, 'share'> & { share: number };
}

/** 主线 / 子代理拆分（忽略 q.includeSidechain，两边都算）。 */
export function sidechainSplit(ctx: AggregateContext, q: AggregateQuery): SidechainSplit {
  const sel = selectRecords(ctx, { ...q, includeSidechain: true });
  const m = zeroUsage();
  const s = zeroUsage();
  let mn = 0;
  let sn = 0;
  for (const r of sel.records) {
    if (r.isSidechain) {
      addUsage(s, r);
      sn++;
    } else {
      addUsage(m, r);
      mn++;
    }
  }
  const [main, sidechain] = withShares([toRow(m, mn, q.basis), toRow(s, sn, q.basis)]);
  return { main: main!, sidechain: sidechain! };
}

/** 供测试 / 其它模块复用：某时刻在 tz / 粒度下的桶键。 */
export function bucketKeyOf(ts: number, q: Pick<AggregateQuery, 'granularity' | 'tz' | 'weekStart'>): string {
  return bucketOf(ts, q.granularity, q.tz, q.weekStart).key;
}

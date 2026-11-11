/**
 * 批次 B 的只读视图端点：热力图 / 当日明细 / 分析页（A1–A9、A19、A20）/ 会话列表与详情，
 * 以及 summary / timeseries 的 AI 运行时长（activeMs）。
 *
 * 全部复用 core/aggregate.ts 的口径函数；与总览共用同一套全局筛选参数
 * （project / range / from / to / basis / models / mergeFamilies / tz / weekStart / includeSidechain）。
 * 不返回任何对话正文：会话标题只有 custom-title.json 或首条真人消息的前 ≤ 40 字（仅本机显示）。
 */
import type http from 'node:http';
import { totalOf, valueOf, zeroUsage, addUsage, freshOf } from '../../shared/metrics.ts';
import type { UsageNumbers } from '../../shared/metrics.ts';
import type { UsageRecord } from '../../shared/types.ts';
import { activitySet, computeActivity } from '../core/activity.ts';
import type { FileActivity } from '../core/activity.ts';
import { aggregate, groupByModel, groupByProject, groupBySession, groupByTool, hourWeekGrid, selectRecords, sidechainSplit } from '../core/aggregate.ts';
import type { AggregateContext, AggregateQuery, AggregateResult } from '../core/aggregate.ts';
import { modelGroupOf } from '../core/models.ts';
import { bucketOf, localParts, nextBucketStart, startOfWeek } from '../core/time.ts';
import type { Settings } from '../settings.ts';
import type { CostEngine } from '../cost/engine.ts';
import type { Store } from '../store/store.ts';
import { newAcc as newCostAcc } from '../cost/engine.ts';
import { ApiError, badRequest } from './errors.ts';
import { oneOfParam, parseAggregateQuery, singleParam } from './params.ts';

const DAY = 86_400_000;
const HOUR = 3_600_000;

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => void | Promise<void>;

export interface ViewRouteDeps {
  route: (path: string, method: string, h: Handler, autoHead?: boolean) => void;
  sendJson: (res: http.ServerResponse, status: number, body: string) => void;
  /** 按 (dataVersion, 设置版本, 查询串) 缓存的 JSON 序列化 */
  cached: (url: URL, compute: () => unknown) => string;
  getCtx: () => AggregateContext;
  settings: () => Settings;
  store: Store;
  now: () => number;
  /** 成本引擎（批次 C）：给分析 / 会话条目附带 cost */
  engineFor: (ctx: AggregateContext, tz: string, now: number) => CostEngine;
}

// ---------------------------------------------------------------------------
// AI 运行时长（summary / timeseries 使用）
// ---------------------------------------------------------------------------

/** 汇总 / 序列里附带的运行时长字段。窗口：范围 all 时取"数据跨度所在的整本地日"，否则就是查询范围。 */
export function activityFor(files: readonly FileActivity[], ctx: AggregateContext, q: AggregateQuery, r: AggregateResult): { activeMs: number; activeMsSum: number; perBucket: number[] } {
  if (r.timeline.length === 0 || r.range.fromTs === null || r.range.toTs === null) return { activeMs: 0, activeMsSum: 0, perBucket: [] };
  let keys: Set<string> | null = null;
  if (q.projects !== 'all') {
    keys = new Set<string>();
    for (const id of q.projects) for (const k of ctx.projects.keysFor(id) ?? []) keys.add(k);
  } else {
    // 隐藏的项目不计入"全部项目"：运行时长也要排除它们的会话文件
    const hidden = (ctx as { hiddenKeys?: ReadonlySet<string> }).hiddenKeys;
    if (hidden && hidden.size > 0) {
      keys = new Set<string>();
      for (const p of ctx.projects.list) for (const k of p.memberKeys) keys.add(k);
    }
  }
  const set = activitySet(files, { keys, includeSidechain: q.includeSidechain });
  let from = r.range.fromTs;
  let to = r.range.toTs;
  if (q.range.kind === 'all') {
    from = bucketOf(from, 'day', q.tz, q.weekStart).start;
    to = nextBucketStart(bucketOf(to - 1, 'day', q.tz, q.weekStart).start, 'day', q.tz);
  }
  return computeActivity(set, from, to, r.timeline.map((p) => p.start));
}

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

function intParam(sp: URLSearchParams, key: string, dflt: number, min: number, max: number): number {
  const v = singleParam(sp, key);
  if (v === undefined || v === '') return dflt;
  if (!/^-?\d+$/.test(v)) throw badRequest(`INVALID_${key.toUpperCase()}`, `参数 ${key} 必须是整数`);
  const n = Number(v);
  if (n < min || n > max) throw badRequest(`INVALID_${key.toUpperCase()}`, `参数 ${key} 超出范围（${min}–${max}）`);
  return n;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface TitleInfo {
  title: string | null;
  titleSource: 'custom' | 'auto' | 'none';
}

function usageOf(u: UsageNumbers): UsageNumbers {
  return { input: u.input, cacheWrite: u.cacheWrite, cacheWrite5m: u.cacheWrite5m, cacheWrite1h: u.cacheWrite1h, cacheRead: u.cacheRead, output: u.output, thinking: u.thinking };
}

function mcpGroup(name: string): { label: string; mcp: boolean } {
  const m = /^mcp__(.+?)__/.exec(name);
  if (m) return { label: `mcp__${m[1]}`, mcp: true };
  return { label: name, mcp: false };
}

// ---------------------------------------------------------------------------
// 注册
// ---------------------------------------------------------------------------

export function registerViewRoutes(d: ViewRouteDeps): void {
  const parse = (url: URL, extra: readonly string[] = []): AggregateQuery => parseAggregateQuery(url.searchParams, { settings: d.settings(), now: d.now() }, extra);
  const get = (path: string, compute: (url: URL) => unknown): void => d.route(path, 'GET', (_req, res, url) => d.sendJson(res, 200, d.cached(url, () => compute(url))));

  const titleInfo = (id: string): TitleInfo => {
    const v = d.store.getView();
    const c = v.titles.get(id);
    if (c) return { title: c, titleSource: 'custom' };
    const a = v.autoTitles.get(id);
    if (a) return { title: a, titleSource: 'auto' };
    return { title: null, titleSource: 'none' };
  };
  const projectName = (ctx: AggregateContext, id: string): string => ctx.projects.byId.get(id)?.displayName ?? id;

  // ---------------------------- 热力图（日历）----------------------------
  get('/api/heatmap', (url) => {
    const q = parse(url, ['weeks']);
    const weeks = intParam(url.searchParams, 'weeks', 26, 1, 60);
    const ctx = d.getCtx();
    const now = d.now();
    const weekStart = startOfWeek(now, q.tz, q.weekStart);
    const fromKey = bucketOf(weekStart - (weeks - 1) * 7 * DAY + 12 * HOUR, 'day', q.tz, q.weekStart).key;
    const toKey = localParts(now, q.tz).date;
    const r = aggregate(ctx, { ...q, range: { kind: 'custom', from: fromKey, to: toKey }, granularity: 'day', split: 'none' });
    const days = r.timeline.map((p) => ({ date: p.key, value: p.value, total: p.total, fresh: p.fresh, requests: p.requests }));
    let max = 0;
    for (const x of days) if (x.value > max) max = x.value;
    // 日历格从"一周的第一天"开始：第一格的星期偏移（0 = 与 weekStart 对齐）
    return { from: fromKey, to: toKey, weeks, weekStart: q.weekStart, tz: q.tz, basis: q.basis, max, total: days.reduce((a, x) => a + x.value, 0), days };
  });

  // ---------------------------- 当日明细 ----------------------------
  get('/api/day-detail', (url) => {
    const q = parse(url, ['date']);
    const date = singleParam(url.searchParams, 'date');
    if (!date || !DATE_RE.test(date)) throw badRequest('INVALID_DATE', '参数 date 必须是 YYYY-MM-DD');
    const ctx = d.getCtx();
    const dq: AggregateQuery = { ...q, range: { kind: 'custom', from: date, to: date }, granularity: 'hour', split: 'none' };
    const r = aggregate(ctx, dq);
    const rows = groupBySession(ctx, dq);
    return {
      date,
      tz: q.tz,
      basis: q.basis,
      summary: r.summary,
      hours: r.timeline.map((p) => ({ key: p.key, start: p.start, value: p.value, total: p.total, fresh: p.fresh, requests: p.requests, ...usageOf(p) })),
      sessions: rows.slice(0, 200).map((s) => ({
        id: s.sessionId,
        ...titleInfo(s.sessionId),
        projectId: s.projectId,
        projectName: projectName(ctx, s.projectId),
        firstTs: s.firstTs,
        lastTs: s.lastTs,
        requests: s.requests,
        value: s.value,
        total: s.total,
      })),
      sessionCount: rows.length,
    };
  });

  // ---------------------------- 分析页 ----------------------------
  get('/api/analysis/models', (url) => {
    const q = parse(url);
    const ctx = d.getCtx();
    const engine = d.engineFor(ctx, q.tz, d.now());
    const costs = engine.group(selectRecords(ctx, q).records, (r) => modelGroupOf(r.model, q.mergeModelFamilies ?? false, q.modelNormalize).key);
    const rows = groupByModel(ctx, q).map((m) => ({ ...m, cost: engine.block(costs.get(m.key) ?? newCostAcc()) }));
    const total = rows.reduce((a, r) => a + r.value, 0);
    return { basis: q.basis, mergeFamilies: q.mergeModelFamilies ?? false, total, mostUsed: rows[0]?.key ?? null, models: rows };
  });

  get('/api/analysis/composition', (url) => {
    const q = parse(url);
    const sel = selectRecords(d.getCtx(), q);
    const u = zeroUsage();
    for (const r of sel.records) addUsage(u, r);
    return { basis: q.basis, ...usageOf(u), total: totalOf(u), fresh: freshOf(u), value: valueOf(u, q.basis), requests: sel.records.length };
  });

  get('/api/analysis/projects', (url) => {
    const q = parse(url);
    const ctx = d.getCtx();
    const engine = d.engineFor(ctx, q.tz, d.now());
    const costs = engine.group(selectRecords(ctx, q).records, (r) => ctx.projects.idOfKey(r.projectKey));
    const rows = groupByProject(ctx, q).map((p) => ({ ...p, cost: engine.block(costs.get(p.id) ?? newCostAcc()) }));
    return { basis: q.basis, total: rows.reduce((a, r) => a + r.value, 0), projects: rows };
  });

  get('/api/analysis/sessions-top', (url) => {
    const q = parse(url, ['limit']);
    const limit = intParam(url.searchParams, 'limit', 10, 1, 100);
    const ctx = d.getCtx();
    const rows = groupBySession(ctx, q);
    const mg = q.mergeModelFamilies ?? false;
    const engine = d.engineFor(ctx, q.tz, d.now());
    const costs = engine.group(selectRecords(ctx, q).records, (r) => r.sessionId);
    return {
      basis: q.basis,
      total: rows.length,
      sessions: rows.slice(0, limit).map((s) => ({
        id: s.sessionId,
        ...titleInfo(s.sessionId),
        projectId: s.projectId,
        projectName: projectName(ctx, s.projectId),
        firstTs: s.firstTs,
        lastTs: s.lastTs,
        durationMs: s.lastTs - s.firstTs,
        requests: s.requests,
        value: s.value,
        total: s.total,
        share: s.share,
        cost: engine.block(costs.get(s.sessionId) ?? newCostAcc()),
        mainModel: s.mainModel ? { key: s.mainModel, display: modelGroupOf(s.mainModel, mg, q.modelNormalize).display } : null,
      })),
    };
  });

  get('/api/analysis/cache-efficiency', (url) => {
    const q = parse(url);
    const r = aggregate(d.getCtx(), { ...q, split: 'none' });
    const s = r.summary;
    const points = r.timeline.map((p) => {
      const denom = p.input + p.cacheWrite + p.cacheRead;
      return { key: p.key, start: p.start, hitRate: denom > 0 ? p.cacheRead / denom : null, cacheRead: p.cacheRead, cacheWrite: p.cacheWrite, input: p.input, requests: p.requests };
    });
    return {
      granularity: q.granularity,
      hitRate: s.cacheHitRate,
      cacheRead: s.cacheRead,
      cacheWrite: s.cacheWrite,
      /** 缓存读 ÷ 缓存写（"1 : N" 里的 N）；缓存写为 0 → null */
      readPerWrite: s.cacheWrite > 0 ? s.cacheRead / s.cacheWrite : null,
      points,
    };
  });

  get('/api/analysis/activity-grid', (url) => {
    const q = parse(url);
    const grid = hourWeekGrid(d.getCtx(), q); // grid[weekday 0=周日][hour]
    let max = 0;
    let total = 0;
    for (const row of grid) for (const v of row) {
      if (v > max) max = v;
      total += v;
    }
    return { basis: q.basis, tz: q.tz, weekdays: 'sun-first', grid, max, total };
  });

  get('/api/analysis/tools', (url) => {
    const q = parse(url);
    const rows = groupByTool(d.getCtx(), q);
    const merged = new Map<string, { name: string; count: number; mcp: boolean }>();
    for (const r of rows) {
      const g = mcpGroup(r.name);
      const m = merged.get(g.label) ?? { name: g.label, count: 0, mcp: g.mcp };
      m.count += r.count;
      merged.set(g.label, m);
    }
    const list = [...merged.values()].sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1));
    return { total: list.reduce((a, r) => a + r.count, 0), rawTotal: rows.reduce((a, r) => a + r.count, 0), tools: list };
  });

  get('/api/analysis/sidechain', (url) => {
    const q = parse(url);
    return { basis: q.basis, ...sidechainSplit(d.getCtx(), q) };
  });

  get('/api/analysis/local-vs-cloud', (url) => {
    const q = parse(url);
    const rows = groupByModel(d.getCtx(), q);
    const local = zeroUsage();
    const cloud = zeroUsage();
    let ln = 0;
    let cn = 0;
    for (const r of rows) {
      if (r.isLocal) {
        addUsage(local, r);
        ln += r.requests;
      } else {
        addUsage(cloud, r);
        cn += r.requests;
      }
    }
    const lv = valueOf(local, q.basis);
    const cv = valueOf(cloud, q.basis);
    const sum = lv + cv;
    return { basis: q.basis, local: { value: lv, requests: ln, share: sum > 0 ? lv / sum : 0 }, cloud: { value: cv, requests: cn, share: sum > 0 ? cv / sum : 0 } };
  });

  // A20 数据质量：全局，不随筛选变化
  get('/api/analysis/quality', () => {
    const v = d.store.getView();
    const st = d.store.getStatus();
    const s = v.stats;
    return {
      filesParsed: s.filesParsed,
      assistantRows: s.assistantRows,
      uniqueMessages: s.uniqueMessages,
      duplicatesDropped: s.duplicatesDropped,
      crossFileDuplicates: s.crossFileDuplicates,
      syntheticExcluded: s.syntheticExcluded,
      corruptLines: s.corruptLines,
      emptyFiles: s.emptyFiles,
      missingId: s.missingId,
      missingTimestamp: s.missingTimestamp,
      missingUsage: s.missingUsage,
      missingCacheBreakdown: s.missingCacheBreakdown,
      missingThinking: s.missingThinking,
      /** 缺字段记录数：缺 usage 整体 + 缺缓存细分 */
      missingFieldRecords: s.missingUsage + s.missingCacheBreakdown,
      linesRead: s.linesRead,
      lastScanMs: st.startedAt !== null && st.lastScanAt !== null ? Math.max(0, st.lastScanAt - st.startedAt) : null,
      lastScanAt: st.lastScanAt,
      lastRecordTs: v.lastRecordTs,
      dataVersion: v.dataVersion,
    };
  });

  // ---------------------------- 会话 ----------------------------
  const SORTS = ['tokens', 'requests', 'start', 'duration'] as const;
  get('/api/sessions', (url) => {
    const q = parse(url, ['q', 'sort', 'dir', 'page', 'pageSize']);
    const sort = oneOfParam(singleParam(url.searchParams, 'sort'), 'sort', SORTS, 'tokens');
    const dir = oneOfParam(singleParam(url.searchParams, 'dir'), 'dir', ['asc', 'desc'] as const, 'desc');
    const page = intParam(url.searchParams, 'page', 1, 1, 1_000_000);
    const pageSize = intParam(url.searchParams, 'pageSize', 50, 1, 500);
    const needle = (singleParam(url.searchParams, 'q') ?? '').trim().toLowerCase();
    const ctx = d.getCtx();
    const mg = q.mergeModelFamilies ?? false;
    const engine = d.engineFor(ctx, q.tz, d.now());
    const costs = engine.group(selectRecords(ctx, q).records, (r) => r.sessionId);
    let rows = groupBySession(ctx, q).map((s) => ({
      id: s.sessionId,
      ...titleInfo(s.sessionId),
      projectId: s.projectId,
      projectKey: s.projectKey,
      projectName: projectName(ctx, s.projectId),
      firstTs: s.firstTs,
      lastTs: s.lastTs,
      durationMs: s.lastTs - s.firstTs,
      requests: s.requests,
      sidechainRequests: s.sidechainRequests,
      ...usageOf(s),
      total: s.total,
      fresh: s.fresh,
      value: s.value,
      cost: engine.block(costs.get(s.sessionId) ?? newCostAcc()),
      mainModel: s.mainModel ? { key: s.mainModel, display: modelGroupOf(s.mainModel, mg, q.modelNormalize).display, isLocal: modelGroupOf(s.mainModel, mg, q.modelNormalize).isLocal } : null,
    }));
    if (needle) rows = rows.filter((r) => [r.title ?? '', r.projectName, r.id].some((x) => x.toLowerCase().includes(needle)));
    const key = (r: (typeof rows)[number]): number => (sort === 'tokens' ? r.value : sort === 'requests' ? r.requests : sort === 'start' ? r.firstTs : r.durationMs);
    const sign = dir === 'asc' ? 1 : -1;
    rows.sort((a, b) => sign * (key(a) - key(b)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const sumValue = rows.reduce((a, r) => a + r.value, 0);
    const from = (page - 1) * pageSize;
    return { basis: q.basis, tz: q.tz, sort, dir, page, pageSize, total: rows.length, sumValue, rows: rows.slice(from, from + pageSize) };
  });

  d.route('/api/sessions/:id', 'GET', (_req, res, url) => d.sendJson(res, 200, d.cached(url, () => sessionDetail(url))));

  function sessionDetail(url: URL): unknown {
    const id = decodeURIComponent(url.pathname.slice('/api/sessions/'.length));
    if (id.length === 0 || id.length > 200) throw badRequest('INVALID_SESSION', '会话 id 不合法');
    // 详情不受时间范围 / 项目 / 模型筛选影响（总是整个会话）；仅 basis / tz / includeSidechain 有意义
    const q = parse(url);
    const ctx = d.getCtx();
    const recs: UsageRecord[] = [];
    for (const r of ctx.records) if (r.sessionId === id && (q.includeSidechain || !r.isSidechain)) recs.push(r);
    if (recs.length === 0) throw new ApiError(404, 'SESSION_NOT_FOUND', '没有找到该会话');
    recs.sort((a, b) => a.ts - b.ts || (a.messageId < b.messageId ? -1 : 1));
    const u = zeroUsage();
    const models = new Map<string, { display: string; isLocal: boolean; u: UsageNumbers; n: number }>();
    const tools = new Map<string, number>();
    const requests: Array<Record<string, unknown>> = [];
    const context: number[] = [];
    const compactions: number[] = [];
    let prevCtx = 0;
    let side = 0;
    const mg = q.mergeModelFamilies ?? false;
    recs.forEach((r, i) => {
      addUsage(u, r);
      const g = modelGroupOf(r.model, mg, q.modelNormalize);
      const m = models.get(g.key) ?? { display: g.display, isLocal: g.isLocal, u: zeroUsage(), n: 0 };
      addUsage(m.u, r);
      m.n++;
      models.set(g.key, m);
      for (const [name, c] of Object.entries(r.tools)) tools.set(name, (tools.get(name) ?? 0) + c);
      const ctxSize = r.input + r.cacheWrite + r.cacheRead;
      if (r.isSidechain) side++;
      else {
        // 主线上下文骤降（< 上一次的一半且上一次 ≥ 2 万）视为压缩
        if (prevCtx >= 20_000 && ctxSize < prevCtx * 0.5) compactions.push(i);
        prevCtx = ctxSize;
      }
      context.push(ctxSize);
      requests.push({ ts: r.ts, ...usageOf(r), total: totalOf(r), fresh: freshOf(r), value: valueOf(r, q.basis), model: r.model, modelDisplay: g.display, isSidechain: r.isSidechain, context: ctxSize });
    });
    const first = recs[0]!;
    const last = recs[recs.length - 1]!;
    const cost = d.engineFor(ctx, q.tz, d.now()).total(recs).block;
    const pid = ctx.projects.idOfKey(first.projectKey);
    return {
      id,
      ...titleInfo(id),
      basis: q.basis,
      tz: q.tz,
      projectId: pid,
      projectName: projectName(ctx, pid),
      firstTs: first.ts,
      lastTs: last.ts,
      durationMs: last.ts - first.ts,
      requestCount: recs.length,
      cost,
      sidechainRequests: side,
      composition: { ...usageOf(u), total: totalOf(u), fresh: freshOf(u), value: valueOf(u, q.basis) },
      models: [...models.entries()]
        .map(([key, m]) => ({ key, display: m.display, isLocal: m.isLocal, requests: m.n, value: valueOf(m.u, q.basis), total: totalOf(m.u) }))
        .sort((a, b) => b.value - a.value || (a.key < b.key ? -1 : 1)),
      tools: [...tools.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1)),
      requests,
      compactions,
    };
  }
}

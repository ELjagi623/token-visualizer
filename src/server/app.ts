/**
 * HTTP 应用：把 Store 通过本地 HTTP 暴露出来。
 *
 * - 只绑定 127.0.0.1；校验 Host / Origin；从不发 CORS 头；
 * - 统一错误格式 `{ error: { code, message } }`，所有查询参数走同一套解析 / 校验（api/params.ts）；
 * - 聚合类响应按 (dataVersion, 设置版本, 时间桶, 路径 + 规范化查询串) 做 LRU 缓存；
 * - API 不返回任何对话正文：只有用量、元数据、项目名 / 路径、模型名；
 * - 静态托管 web/dist（未构建时给中文提示页）。
 */
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Basis } from '../shared/metrics.ts';
import { aggregate, periodCards } from './core/aggregate.ts';
import type { AggregateContext, AggregateQuery } from './core/aggregate.ts';
import { defaultDataRoot } from './core/paths.ts';
import { buildProjectIndex } from './core/projects.ts';
import type { ProjectInfo, ProjectIndex } from './core/projects.ts';
import { createAppDataWriter, createSafeFs } from './core/safeFs.ts';
import { localParts, QueryError } from './core/time.ts';
import { systemTzFallbackWarning, systemTimeZone, systemTimeZoneInfo } from './systemTz.ts';
import { ApiError, badRequest } from './api/errors.ts';
import { activityFor, registerViewRoutes } from './api/viewRoutes.ts';
import { LruCache } from './api/lru.ts';
import { oneOfParam, parseAggregateQuery, rejectUnknown, singleParam } from './api/params.ts';
import { checkRequestOrigin, readJsonBody, requireJson } from './api/security.ts';
import { SseHub } from './api/sse.ts';
import { serveStatic } from './api/static.ts';
import { assertDataRootCompatible, SettingsError, SettingsStore, validateDataRoot } from './settings.ts';
import type { Settings } from './settings.ts';
// 批次 C：价格 / 订阅 / 成本 / 项目覆盖 / 导出
import { registerCostRoutes } from './api/routes-cost.ts';
import { registerSettingsRoutes } from './api/routes-settings.ts';
import { attachSummaryCost, attachTimeseriesCost, costByFolder, mergedBlock } from './cost/attach.ts';
import { CostEngine, DayNanoCache } from './cost/engine.ts';
import type { CostBlock } from './cost/engine.ts';
import { PriceError, PriceStore } from './cost/prices.ts';
import { OverrideError, OverridesStore } from './overrides.ts';
import { buildAppContext } from './projectContext.ts';
import type { AppContext } from './projectContext.ts';
import { Store } from './store/store.ts';
import type { StoreOptions } from './store/store.ts';
import { Watcher } from './store/watcher.ts';
import type { WatcherOptions } from './store/watcher.ts';
import { L } from './i18n.ts';

export const DEFAULT_PORT = 47821;

export interface AppOptions {
  /** 默认数据根（设置里没指定 dataRoot 时使用）；缺省 TV_DATA_ROOT 或 ~/.claude/projects */
  dataRoot?: string;
  appDataDir: string;
  /** 起始端口（被占用则向后顺延）；0 = 让系统分配 */
  port?: number;
  /** 最多向后探测多少个端口，默认 100 */
  probePorts?: number;
  /** 前端构建目录，默认 <项目>/web/dist */
  webDir?: string;
  /** 时钟；用于 TV_NOW 固定当前时间 */
  now?: () => number;
  watcher?: WatcherOptions;
  store?: Partial<StoreOptions>;
  /** SSE 心跳间隔（毫秒），默认 15000；测试可调小 */
  sseHeartbeatMs?: number;
}

export interface App {
  readonly port: number;
  readonly url: string;
  readonly store: Store;
  readonly settings: SettingsStore;
  readonly watcher: Watcher;
  readonly server: http.Server;
  readonly cache: LruCache;
  readonly sse: SseHub;
  close(): Promise<void>;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_WEB_DIR = path.resolve(HERE, '..', '..', 'web', 'dist');

const BASE_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

const JSON_HEADERS = { ...BASE_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };

// ---------------------------------------------------------------------------
// 端口
// ---------------------------------------------------------------------------

/** 该端口上是否已有进程在 127.0.0.1 监听（Windows 允许"更具体地址"的重复绑定，所以绑定前先探测）。 */
function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    const done = (v: boolean): void => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(300, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

function listenOn(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onErr = (e: Error): void => {
      server.off('listening', onOk);
      reject(e);
    };
    const onOk = (): void => {
      server.off('error', onErr);
      resolve();
    };
    server.once('error', onErr);
    server.once('listening', onOk);
    server.listen({ port, host: '127.0.0.1', exclusive: true });
  });
}

// ---------------------------------------------------------------------------
// 创建应用
// ---------------------------------------------------------------------------

interface ProjectItem {
  id: string;
  displayName: string;
  path: string | null;
  cwds: string[];
  pathUnknown: boolean;
  isScratchGroup: boolean;
  isScratch: boolean;
  requests: number;
  total: number;
  fresh: number;
  value: number;
  sparkline: number[];
  todayRequests: number;
  todayValue: number;
  activeToday: boolean;
  lastActiveTs: number | null;
  firstTs: number | null;
  /** 置顶 / 被重命名（项目管理）；defaultName = 自动识别的原始名称 */
  pinned: boolean;
  renamed: boolean;
  defaultName: string | null;
  /** 全部时间的成本（两种口径一次返回） */
  cost: CostBlock;
  children?: ProjectItem[];
}

interface FolderAcc {
  requests: number;
  total: number;
  fresh: number;
  spark: number[];
  todayRequests: number;
  todayTotal: number;
  todayFresh: number;
  firstTs: number | null;
  lastTs: number | null;
}

const SPARK_DAYS = 30;

function newAcc(): FolderAcc {
  return { requests: 0, total: 0, fresh: 0, spark: new Array<number>(SPARK_DAYS).fill(0), todayRequests: 0, todayTotal: 0, todayFresh: 0, firstTs: null, lastTs: null };
}

export async function createApp(opts: AppOptions): Promise<App> {
  const clock = opts.now ?? Date.now;
  const fixedClock = opts.now !== undefined;
  const fs = createSafeFs();
  const fallbackRoot = opts.dataRoot ?? defaultDataRoot();
  let storeRef: Store | undefined;
  const writer = createAppDataWriter({ appDataDir: opts.appDataDir, protectedRoots: () => [storeRef?.dataRoot ?? fallbackRoot, fallbackRoot] });
  const settings = new SettingsStore(writer);
  await settings.load();
  await settings.repairDataRoot(opts.appDataDir);
  const prices = new PriceStore(writer);
  await prices.load();
  const overrides = new OverridesStore(writer);
  await overrides.load();

  const effectiveRoot = (s: Settings): string => s.dataRoot ?? fallbackRoot;
  const store = new Store({ ...opts.store, dataRoot: effectiveRoot(settings.get()), appDataDir: opts.appDataDir });
  storeRef = store;
  await store.init(); // 读缓存（秒开）；扫描在监听之后后台进行

  const cache = new LruCache();
  const sse = new SseHub(opts.sseHeartbeatMs);
  const webDir = opts.webDir ?? DEFAULT_WEB_DIR;

  const s0 = settings.get();
  const watcher = new Watcher(store, { intervalMs: s0.autoRefresh.intervalSec * 1000, ...opts.watcher });

  let listenPort = 0;

  // ------------------------------ 上下文 / 缓存 ------------------------------

  // 聚合上下文 = store 视图 + 项目覆盖规则（重命名 / 置顶 / 隐藏：隐藏项目的记录在这里整体剔除，保证分组之和 = 合计）
  let ctxCache: { version: number; groupScratch: boolean; ovVersion: number; ctx: AppContext } | null = null;
  function getCtx(): AppContext {
    const view = store.getView();
    const gs = settings.get().groupScratch;
    if (ctxCache && ctxCache.version === view.dataVersion && ctxCache.groupScratch === gs && ctxCache.ovVersion === overrides.version) return ctxCache.ctx;
    const ctx = buildAppContext(view, gs, overrides.get());
    ctxCache = { version: view.dataVersion, groupScratch: gs, ovVersion: overrides.version, ctx };
    return ctx;
  }

  // 成本引擎（同一份记录 + 价格表 + 时区的"每日总成本"只算一次）
  const dayNano = new DayNanoCache();
  function engineFor(ctx: AggregateContext, tz: string, now: number): CostEngine {
    const book = prices.getBook();
    return new CostEngine({ book, monthlyFeeUsd: settings.get().subscription.monthlyFeeUsd, billingDay: settings.get().subscription.billingDay, tz, nowTs: now, dayNano: dayNano.get(ctx.records, book, tz) });
  }

  function cacheKey(url: URL): string {
    const sp = [...url.searchParams.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
    const bucket = fixedClock ? 'f' : Math.floor(clock() / 60_000);
    return `${store.getView().dataVersion}|${settings.version}|${prices.version}|${overrides.version}|${store.dataRoot}|${bucket}|${url.pathname}?${sp.map(([k, v]) => `${k}=${v}`).join('&')}`;
  }

  function cached(url: URL, compute: () => unknown): string {
    const key = cacheKey(url);
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const body = JSON.stringify(compute());
    cache.set(key, body);
    return body;
  }

  // ------------------------------ 状态 ------------------------------

  let todayMemo: { key: string; value: unknown } | null = null;
  function todayPart(): unknown {
    const s = settings.get();
    const tz = settings.effectiveTimezone();
    const now = clock();
    const key = `${store.getView().dataVersion}|${settings.version}|${Math.floor(now / 60_000)}`;
    if (todayMemo && todayMemo.key === key) return todayMemo.value;
    let value: unknown;
    try {
      const cards = periodCards(getCtx(), baseQuery(s, tz, now));
      const t = cards.today.summary;
      value = { value: t.value, total: t.total, fresh: t.fresh, requests: t.requests, basis: s.defaultBasis, tz };
    } catch {
      value = null;
    }
    todayMemo = { key, value };
    return value;
  }

  function baseQuery(s: Settings, tz: string, now: number): AggregateQuery {
    return { projects: 'all', range: { kind: 'all' }, granularity: 'day', tz, weekStart: s.weekStart, billingDay: s.subscription.billingDay, basis: s.defaultBasis, split: 'none', includeSidechain: true, now };
  }

  function buildStatus(): Record<string, unknown> {
    const st = store.getStatus();
    const now = clock();
    const age = st.lastRecordTs === null ? null : Math.max(0, now - st.lastRecordTs);
    const activity = age === null ? 'idle' : age <= 60_000 ? 'generating' : age <= 600_000 ? 'active' : 'idle';
    const usageState = st.state === 'scanning' ? 'scanning' : st.state === 'error' ? 'error' : activity;
    return {
      ...st,
      warnings: [...settings.warnings, ...st.warnings],
      usageState,
      activity,
      recordAgeMs: age,
      serverNow: now,
      dataRoot: store.dataRoot,
      today: todayPart(),
    };
  }

  // 订阅 store：状态 / 数据变化 → SSE
  const unsubscribe = store.onChange(() => {
    if (sse.size > 0) sse.broadcastStatus(buildStatus() as { dataVersion: number });
  });

  // ------------------------------ 项目列表 ------------------------------

  function projectsPayload(sp: URLSearchParams): unknown {
    rejectUnknown(sp, ['sort', 'q', 'basis', 'tz']);
    const s = settings.get();
    const sort = oneOfParam(singleParam(sp, 'sort'), 'sort', ['total', 'recent', 'name', 'today'] as const, 'total');
    const basis: Basis = oneOfParam(singleParam(sp, 'basis'), 'basis', ['total', 'fresh'] as const, s.defaultBasis);
    const tzRaw = singleParam(sp, 'tz');
    const tz = tzRaw && tzRaw.length > 0 ? tzRaw : settings.effectiveTimezone();
    try {
      localParts(0, tz);
    } catch (e) {
      throw badRequest('INVALID_TZ', e instanceof QueryError ? e.message : L('无效的时区', 'Invalid time zone'));
    }
    const q = (singleParam(sp, 'q') ?? '').trim().toLowerCase();
    const now = clock();
    const ctx = getCtx();
    const index: ProjectIndex = ctx.projects;
    const todayDn = localParts(now, tz).dayNumber;

    const folders = new Map<string, FolderAcc>();
    const all = newAcc();
    const feed = (a: FolderAcc, r: (typeof ctx.records)[number], t: number, f: number, dn: number): void => {
      a.requests++;
      a.total += t;
      a.fresh += f;
      const back = todayDn - dn;
      if (back >= 0 && back < SPARK_DAYS) {
        a.spark[SPARK_DAYS - 1 - back] = (a.spark[SPARK_DAYS - 1 - back] ?? 0) + (basis === 'fresh' ? f : t);
        if (back === 0) {
          a.todayRequests++;
          a.todayTotal += t;
          a.todayFresh += f;
        }
      }
      if (a.firstTs === null || r.ts < a.firstTs) a.firstTs = r.ts;
      if (a.lastTs === null || r.ts > a.lastTs) a.lastTs = r.ts;
    };
    for (const r of ctx.records) {
      const f = r.input + r.cacheWrite + r.output;
      const t = f + r.cacheRead;
      const dn = localParts(r.ts, tz).dayNumber;
      let a = folders.get(r.projectKey);
      if (!a) {
        a = newAcc();
        folders.set(r.projectKey, a);
      }
      feed(a, r, t, f, dn);
      feed(all, r, t, f, dn);
    }

    const merge = (keys: string[]): FolderAcc => {
      const m = newAcc();
      for (const k of keys) {
        const a = folders.get(k);
        if (!a) continue;
        m.requests += a.requests;
        m.total += a.total;
        m.fresh += a.fresh;
        m.todayRequests += a.todayRequests;
        m.todayTotal += a.todayTotal;
        m.todayFresh += a.todayFresh;
        for (let i = 0; i < SPARK_DAYS; i++) m.spark[i] = (m.spark[i] ?? 0) + (a.spark[i] ?? 0);
        if (a.firstTs !== null && (m.firstTs === null || a.firstTs < m.firstTs)) m.firstTs = a.firstTs;
        if (a.lastTs !== null && (m.lastTs === null || a.lastTs > m.lastTs)) m.lastTs = a.lastTs;
      }
      return m;
    };
    const engine = engineFor(ctx, tz, now);
    const costGroups = costByFolder(engine, ctx.records);
    const toItem = (p: ProjectInfo, acc: FolderAcc): ProjectItem => ({
      pinned: p.pinned,
      renamed: p.renamed,
      defaultName: ctx.defaultNames.get(p.id) ?? null,
      cost: mergedBlock(engine, costGroups, p.memberKeys),
      id: p.id,
      displayName: p.displayName,
      path: p.path,
      cwds: p.cwds,
      pathUnknown: p.pathUnknown,
      isScratchGroup: p.isScratchGroup,
      isScratch: p.isScratch,
      requests: acc.requests,
      total: acc.total,
      fresh: acc.fresh,
      value: basis === 'fresh' ? acc.fresh : acc.total,
      sparkline: acc.spark.slice(0, SPARK_DAYS),
      todayRequests: acc.todayRequests,
      todayValue: basis === 'fresh' ? acc.todayFresh : acc.todayTotal,
      activeToday: acc.todayRequests > 0,
      lastActiveTs: acc.lastTs,
      firstTs: acc.firstTs,
    });
    const matches = (it: ProjectItem): boolean => q === '' || [it.displayName, it.path ?? '', it.id, ...it.cwds].some((x) => x.toLowerCase().includes(q));
    const cmp = (a: ProjectItem, b: ProjectItem): number => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1; // 置顶永远在前
      switch (sort) {
        case 'recent':
          return (b.lastActiveTs ?? -1) - (a.lastActiveTs ?? -1) || a.id.localeCompare(b.id);
        case 'name':
          return a.displayName.localeCompare(b.displayName, 'zh', { sensitivity: 'base' }) || a.id.localeCompare(b.id);
        case 'today':
          return b.todayValue - a.todayValue || b.value - a.value || a.id.localeCompare(b.id);
        default:
          return b.value - a.value || a.displayName.localeCompare(b.displayName, 'zh') || a.id.localeCompare(b.id);
      }
    };
    const items: ProjectItem[] = [];
    for (const p of index.list) {
      const item = toItem(p, merge(p.memberKeys));
      if (p.children) {
        const kids = p.children.map((c) => toItem(c, merge(c.memberKeys)));
        const groupMatch = matches(item);
        const shown = groupMatch ? kids : kids.filter(matches);
        if (!groupMatch && shown.length === 0) continue;
        item.children = shown.sort(cmp);
      } else if (!matches(item)) continue;
      items.push(item);
    }
    items.sort(cmp);
    const allItem = {
      requests: all.requests,
      total: all.total,
      fresh: all.fresh,
      value: basis === 'fresh' ? all.fresh : all.total,
      sparkline: all.spark.slice(0, SPARK_DAYS),
      todayRequests: all.todayRequests,
      todayValue: basis === 'fresh' ? all.todayFresh : all.todayTotal,
      activeToday: all.todayRequests > 0,
      lastActiveTs: all.lastTs,
      cost: engine.total(ctx.records).block,
    };
    return { basis, tz, sort, q, all: allItem, projects: items, projectCount: index.list.length, folderCount: store.getView().folderKeys.length, hidden: ctx.hidden, hiddenCount: ctx.hidden.length };
  }

  // ------------------------------ 聚合端点 ------------------------------

  function echoQuery(q: AggregateQuery): Record<string, unknown> {
    return {
      project: q.projects,
      range: q.range,
      granularity: q.granularity,
      tz: q.tz,
      weekStart: q.weekStart,
      basis: q.basis,
      split: q.split,
      models: q.models ?? null,
      mergeFamilies: q.mergeModelFamilies ?? false,
      includeSidechain: q.includeSidechain,
      now: q.now,
    };
  }

  function summaryPayload(sp: URLSearchParams): unknown {
    const q = parseAggregateQuery(sp, { settings: settings.get(), now: clock() });
    const ctx = getCtx();
    const r = aggregate(ctx, { ...q, granularity: 'day', split: 'none' });
    const act = activityFor(store.getView().activity, ctx, q, r);
    return attachSummaryCost(engineFor(ctx, q.tz, q.now), ctx, q, { query: echoQuery(q), range: r.range, summary: { ...r.summary, activeMs: act.activeMs, activeMsSum: act.activeMsSum }, periods: periodCards(ctx, q) });
  }

  function timeseriesPayload(sp: URLSearchParams): unknown {
    const q = parseAggregateQuery(sp, { settings: settings.get(), now: clock() });
    const ctx = getCtx();
    const r = aggregate(ctx, q);
    const act = activityFor(store.getView().activity, ctx, q, r);
    return attachTimeseriesCost(engineFor(ctx, q.tz, q.now), ctx, q, { query: echoQuery(q), range: r.range, summary: { ...r.summary, activeMs: act.activeMs, activeMsSum: act.activeMsSum }, points: r.timeline.map((p, i) => ({ ...p, activeMs: act.perBucket[i] ?? 0 })), series: r.series });
  }

  // ------------------------------ 设置 ------------------------------

  function settingsPayload(): unknown {
    const s = settings.get();
    return {
      settings: s,
      effective: { dataRoot: effectiveRoot(s), timezone: settings.effectiveTimezone() },
      systemTimezone: systemTimeZone(),
      version: settings.version,
      warnings: systemTimeZoneInfo().source === 'fallback' ? [...settings.warnings, systemTzFallbackWarning()] : settings.warnings,
    };
  }

  async function updateSettings(body: unknown): Promise<unknown> {
    const before = settings.get();
    const beforeRoot = effectiveRoot(before);
    const updated = await settings.update(body, async (next) => {
      if (next.dataRoot !== null && next.dataRoot !== before.dataRoot) {
        await validateDataRoot(fs, next.dataRoot);
        assertDataRootCompatible(next.dataRoot, opts.appDataDir);
      }
    });
    // 副作用
    const afterRoot = effectiveRoot(updated);
    if (afterRoot !== beforeRoot) void store.switchDataRoot(afterRoot).catch(() => undefined);
    if (updated.autoRefresh.enabled !== before.autoRefresh.enabled || updated.autoRefresh.intervalSec !== before.autoRefresh.intervalSec) {
      if (updated.autoRefresh.enabled) {
        watcher.setIntervalMs(updated.autoRefresh.intervalSec * 1000);
        watcher.start();
      } else watcher.stop();
    }
    cache.clear();
    if (sse.size > 0) sse.broadcast('settings', { version: settings.version });
    return settingsPayload();
  }

  // ------------------------------ 请求分发 ------------------------------

  function sendJson(res: http.ServerResponse, status: number, body: string, extra?: Record<string, string>): void {
    const buf = Buffer.from(body, 'utf8');
    res.writeHead(status, { ...JSON_HEADERS, ...extra, 'Content-Length': String(buf.length) });
    res.end(res.req?.method === 'HEAD' ? undefined : buf);
  }

  function sendError(res: http.ServerResponse, e: unknown): void {
    let status = 500;
    let code = 'INTERNAL';
    let message = '服务器内部错误';
    let headers: Record<string, string> | undefined;
    if (e instanceof ApiError) {
      status = e.status;
      code = e.code;
      message = e.message;
      headers = e.headers;
    } else if (e instanceof QueryError) {
      status = 400;
      code = e.code;
      message = e.message;
    } else if (e instanceof SettingsError) {
      status = 400;
      code = 'INVALID_SETTING';
      message = e.message;
    } else if (e instanceof PriceError) {
      status = 400;
      code = 'INVALID_PRICE';
      message = e.message;
    } else if (e instanceof OverrideError) {
      status = 400;
      code = 'INVALID_OVERRIDE';
      message = e.message;
    } else {
      // 只记录错误类别与消息，不记录请求内容
      console.error(`[error] ${(e as Error)?.name ?? 'Error'}: ${(e as Error)?.message ?? String(e)}`);
      if ((e as { name?: string })?.name === 'SafeFsViolation') {
        code = 'WRITE_REFUSED';
        message = '写入被拒绝（目标不在应用数据目录内）';
      }
    }
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const field = (e instanceof SettingsError || e instanceof PriceError || e instanceof OverrideError) && e.field ? { field: e.field } : {};
    sendJson(res, status, JSON.stringify({ error: { code, message, ...field } }), headers);
  }

  type Handler = (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => void | Promise<void>;
  const routes = new Map<string, Partial<Record<string, Handler>>>();
  const route = (p: string, method: string, h: Handler, autoHead = true): void => {
    const m = routes.get(p) ?? {};
    m[method] = h;
    if (method === 'GET' && autoHead) m.HEAD = h;
    routes.set(p, m);
  };

  route('/api/status', 'GET', (_req, res, url) => {
    rejectUnknown(url.searchParams, []);
    sendJson(res, 200, JSON.stringify(buildStatus()));
  });
  route('/api/events', 'GET', (req, res, url) => {
    rejectUnknown(url.searchParams, []);
    if (sse.full) throw new ApiError(503, 'TOO_MANY_STREAMS', '事件流连接过多');
    const status = buildStatus();
    sse.add(req, res, BASE_HEADERS, [
      ['status', status],
      ['dataVersion', { dataVersion: (status as { dataVersion: number }).dataVersion }],
    ]);
  }, false); // 长连接：不登记 HEAD（HEAD 返回 405，不占 SSE 名额）
  route('/api/projects', 'GET', (_req, res, url) => sendJson(res, 200, cached(url, () => projectsPayload(url.searchParams))));
  route('/api/summary', 'GET', (_req, res, url) => sendJson(res, 200, cached(url, () => summaryPayload(url.searchParams))));
  route('/api/timeseries', 'GET', (_req, res, url) => sendJson(res, 200, cached(url, () => timeseriesPayload(url.searchParams))));
  route('/api/settings', 'GET', (_req, res) => sendJson(res, 200, JSON.stringify(settingsPayload())));
  route('/api/settings', 'PUT', async (req, res) => {
    requireJson(req);
    const body = await readJsonBody(req);
    sendJson(res, 200, JSON.stringify(await updateSettings(body)));
  });
  route('/api/refresh', 'POST', async (_req, res) => {
    await store.refreshNow();
    sendJson(res, 200, JSON.stringify(buildStatus()));
  });
  route('/api/rebuild', 'POST', (_req, res) => {
    void store.rebuild();
    sendJson(res, 202, JSON.stringify({ accepted: true, status: buildStatus() }));
  });

  // 批次 B：热力图 / 当日明细 / 分析页 / 会话（见 api/viewRoutes.ts）
  registerViewRoutes({ route, sendJson, cached, getCtx, settings: () => settings.get(), store, now: clock, engineFor });

  // 批次 C：价格表 / 订阅 / 成本汇总 / 回本 / 导出，设置检测 / 项目覆盖（见 api/routes-cost.ts、routes-settings.ts）
  const changed = (): void => {
    settings.touch();
    cache.clear();
    if (sse.size > 0) sse.broadcast('settings', { version: settings.version });
  };
  registerCostRoutes({ route, sendJson, baseHeaders: BASE_HEADERS, cached, getCtx, settings, prices, clock, engineFor, changed });
  registerSettingsRoutes({ route, sendJson, fs, appDataDir: opts.appDataDir, overrides, getCtx, changed });

  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        checkRequestOrigin(req, listenPort);
        const raw = req.url ?? '';
        if (!raw.startsWith('/') || raw.startsWith('//')) throw new ApiError(400, 'BAD_URL', '请求路径不合法');
        let url: URL;
        try {
          url = new URL(raw, 'http://127.0.0.1');
        } catch {
          throw new ApiError(400, 'BAD_URL', '请求路径不合法');
        }
        if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
          const entry = routes.get(url.pathname) ?? (url.pathname.startsWith('/api/sessions/') && url.pathname.length > '/api/sessions/'.length ? routes.get('/api/sessions/:id') : undefined);
          if (!entry) throw new ApiError(404, 'NOT_FOUND', `未知的 API：${url.pathname}`);
          const h = entry[req.method ?? ''];
          if (!h) throw new ApiError(405, 'METHOD_NOT_ALLOWED', '不支持的请求方法', { Allow: Object.keys(entry).join(', ') });
          await h(req, res, url);
          return;
        }
        await serveStatic(req, res, url.pathname, webDir, BASE_HEADERS);
      } catch (e) {
        sendError(res, e);
      }
    })();
  });
  server.on('clientError', (_err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    else socket.destroy();
  });
  server.requestTimeout = 60_000;
  server.headersTimeout = 20_000;

  // ------------------------------ 监听 ------------------------------

  const start = opts.port ?? DEFAULT_PORT;
  const limit = start === 0 ? 1 : (opts.probePorts ?? 100);
  let bound = false;
  for (let i = 0; i < limit && !bound; i++) {
    const p = start === 0 ? 0 : start + i;
    if (p !== 0 && (await portInUse(p))) continue;
    try {
      await listenOn(server, p);
      bound = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE' && (e as NodeJS.ErrnoException).code !== 'EACCES') throw e;
    }
  }
  if (!bound) {
    unsubscribe();
    store.close();
    throw new Error(`在 ${start}–${start + limit - 1} 范围内没有找到可用端口。可用环境变量 TV_PORT 指定其它端口。`);
  }
  listenPort = (server.address() as net.AddressInfo).port;

  // 后台：增量扫描 + 轮询
  void store.refreshNow();
  if (s0.autoRefresh.enabled) watcher.start();

  let closing: Promise<void> | null = null;
  const app: App = {
    port: listenPort,
    url: `http://127.0.0.1:${listenPort}/`,
    store,
    settings,
    watcher,
    server,
    cache,
    sse,
    close(): Promise<void> {
      closing ??= (async () => {
        watcher.stop();
        unsubscribe();
        sse.closeAll();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
        await store.idle();
        store.close();
      })();
      return closing;
    },
  };
  return app;
}

/**
 * 路由：价格表 / 订阅方案 / 成本汇总 / 订阅回本 / 导出。
 * 在 app.ts 里用 `registerCostRoutes(deps)` 一行注册；业务计算都在 src/server/cost/ 与 src/server/export.ts。
 */
import type http from 'node:http';
import type { AggregateContext } from '../core/aggregate.ts';
import { builtinDefaults, effectiveRules } from '../cost/prices.ts';
import type { PriceStore } from '../cost/prices.ts';
import { builtinPlans } from '../cost/plans.ts';
import type { CostEngine } from '../cost/engine.ts';
import { costSummary, payback } from '../cost/service.ts';
import { buildExport } from '../export.ts';
import type { ExportFormat, ExportKind } from '../export.ts';
import type { SettingsStore } from '../settings.ts';
import { badRequest } from './errors.ts';
import { oneOfParam, parseAggregateQuery, rejectUnknown, singleParam } from './params.ts';
import { QUERY_PARAMS } from './params.ts';
import { readJsonBody, requireJson } from './security.ts';

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => void | Promise<void>;

export interface CostRouteDeps {
  route: (path: string, method: string, h: Handler, autoHead?: boolean) => void;
  sendJson: (res: http.ServerResponse, status: number, body: string, extra?: Record<string, string>) => void;
  baseHeaders: Record<string, string>;
  cached: (url: URL, compute: () => unknown) => string;
  getCtx: () => AggregateContext;
  settings: SettingsStore;
  prices: PriceStore;
  clock: () => number;
  engineFor: (ctx: AggregateContext, tz: string, now: number) => CostEngine;
  /** 价格 / 覆盖规则变化后：清响应缓存 + 通知前端重取 */
  changed: () => void;
}

export function pricesPayload(prices: PriceStore): unknown {
  const b = builtinDefaults();
  const user = prices.get();
  return {
    rules: user,
    effective: effectiveRules(user, b.rules),
    builtin: b.rules,
    defaultsVersion: b.defaultsVersion,
    builtinCount: b.rules.length,
    version: prices.version,
    warnings: prices.warnings,
  };
}

export function registerCostRoutes(d: CostRouteDeps): void {
  const { route, sendJson } = d;

  route('/api/prices', 'GET', (_req, res, url) => {
    rejectUnknown(url.searchParams, []);
    sendJson(res, 200, JSON.stringify(pricesPayload(d.prices)));
  });
  route('/api/prices', 'PUT', async (req, res) => {
    requireJson(req);
    const body = await readJsonBody(req, 512 * 1024);
    await d.prices.replace(body);
    d.changed();
    sendJson(res, 200, JSON.stringify(pricesPayload(d.prices)));
  });
  route('/api/prices/reset', 'POST', async (_req, res) => {
    await d.prices.reset();
    d.changed();
    sendJson(res, 200, JSON.stringify(pricesPayload(d.prices)));
  });

  route('/api/subscription/plans', 'GET', (_req, res, url) => {
    rejectUnknown(url.searchParams, []);
    sendJson(res, 200, JSON.stringify(builtinPlans()));
  });

  route('/api/subscription/payback', 'GET', (_req, res, url) => {
    rejectUnknown(url.searchParams, []);
    sendJson(
      res,
      200,
      d.cached(url, () => {
        const s = d.settings.get();
        const now = d.clock();
        const tz = d.settings.effectiveTimezone();
        const ctx = d.getCtx();
        return payback({ engine: d.engineFor(ctx, tz, now), ctx, tz, nowTs: now, weekStart: s.weekStart, monthlyFeeUsd: s.subscription.monthlyFeeUsd, billingDay: s.subscription.billingDay });
      }),
    );
  });

  route('/api/cost/summary', 'GET', (_req, res, url) => {
    sendJson(
      res,
      200,
      d.cached(url, () => {
        const s = d.settings.get();
        const now = d.clock();
        const q = parseAggregateQuery(url.searchParams, { settings: s, now });
        const ctx = d.getCtx();
        return costSummary({ engine: d.engineFor(ctx, q.tz, now), ctx, q, plan: s.subscription.plan, monthlyFeeUsd: s.subscription.monthlyFeeUsd });
      }),
    );
  });

  route('/api/export', 'GET', (_req, res, url) => {
    rejectUnknown(url.searchParams, [...QUERY_PARAMS, 'kind', 'format']);
    const kind = oneOfParam<ExportKind>(singleParam(url.searchParams, 'kind'), 'kind', ['daily', 'model', 'session'] as const, 'daily');
    const format = oneOfParam<ExportFormat>(singleParam(url.searchParams, 'format'), 'format', ['csv', 'json'] as const, 'csv');
    const sp = new URLSearchParams(url.searchParams);
    sp.delete('kind');
    sp.delete('format');
    const s = d.settings.get();
    const now = d.clock();
    const q = parseAggregateQuery(sp, { settings: s, now });
    const ctx = d.getCtx();
    const out = buildExport({ engine: d.engineFor(ctx, q.tz, now), ctx, q, kind, format });
    const buf = Buffer.from(out.body, 'utf8');
    if (buf.length > 200 * 1024 * 1024) throw badRequest('EXPORT_TOO_LARGE', '导出内容过大，请缩小时间范围');
    res.writeHead(200, {
      ...d.baseHeaders,
      'Content-Type': out.contentType,
      'Content-Disposition': `attachment; filename="${out.filename}"`,
      'Cache-Control': 'no-store',
      'Content-Length': String(buf.length),
    });
    res.end(res.req?.method === 'HEAD' ? undefined : buf);
  });
}

/**
 * 导出：CSV / JSON，日 / 模型 / 会话三种粒度。
 * 遵从当前筛选（项目 / 范围 / 模型 / 子代理）、统计口径与时区；包含 cost_api_usd / cost_sub_usd（无法计算为空）。
 * 不含对话正文，也不含由首条用户消息派生的会话标题（会话只导出 id、项目名、起止时间、模型名与用量）。
 * CSV：UTF-8 带 BOM；第一行是以 # 开头的"估算"说明（读取时请忽略 # 行），第二行是列名。
 */
import { L } from './i18n.ts';
import { aggregate, groupByModel, groupBySession, selectRecords } from './core/aggregate.ts';
import type { AggregateContext, AggregateQuery } from './core/aggregate.ts';
import { modelGroupOf } from './core/models.ts';
import { localParts } from './core/time.ts';
import type { CostBlock, CostEngine } from './cost/engine.ts';
import { timelineCost } from './cost/service.ts';

export type ExportKind = 'daily' | 'model' | 'session';
export type ExportFormat = 'csv' | 'json';

export const exportNote = (): string =>
  L(
    '成本为估算值：cost_api_usd = 本机记录的 token 按各模型官方 API 单价折算的等价 API 成本；cost_sub_usd = 订阅月费按天、按当天各条目等价 API 成本占比分摊（非额度消耗，未设置订阅方案时为空）。空值表示无法计算（例如模型未配置价格）。',
    'Costs are estimates: cost_api_usd = tokens recorded on this machine at the official API prices of each model (API-equivalent cost); cost_sub_usd = the monthly plan fee split by day in proportion to the API-equivalent cost of each entry (not quota usage; empty when no plan is set). An empty value means it cannot be computed (for example the model has no price configured).',
  );

export interface ExportResult {
  filename: string;
  contentType: string;
  body: string;
}

type Cell = string | number | boolean | null;
type Row = Record<string, Cell>;

const TOKEN_COLS = ['requests', 'input_tokens', 'cache_write_tokens', 'cache_read_tokens', 'output_tokens', 'thinking_tokens', 'total_tokens', 'fresh_tokens', 'value_tokens'] as const;

function tokenCells(u: { requests: number; input: number; cacheWrite: number; cacheRead: number; output: number; thinking: number; total: number; fresh: number; value: number }): Row {
  return {
    requests: u.requests,
    input_tokens: u.input,
    cache_write_tokens: u.cacheWrite,
    cache_read_tokens: u.cacheRead,
    output_tokens: u.output,
    thinking_tokens: u.thinking,
    total_tokens: u.total,
    fresh_tokens: u.fresh,
    value_tokens: u.value,
  };
}

function costCells(c: CostBlock | undefined): Row {
  return { cost_api_usd: c?.apiUsd ?? null, cost_sub_usd: c?.subUsd ?? null };
}

/** CSV 公式注入防护：文本以 = + - @ 制表符 回车 开头时前置单引号。 */
function safeText(s: string): string {
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

function csvCell(v: Cell, text: boolean): string {
  if (v === null) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  const s = text ? safeText(v) : v;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(columns: readonly string[], textCols: ReadonlySet<string>, rows: Row[]): string {
  const lines = [`# ${exportNote()}`, columns.join(',')];
  for (const r of rows) lines.push(columns.map((c) => csvCell(r[c] ?? null, textCols.has(c))).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}

function describeRange(q: AggregateQuery): string {
  const k = q.range.kind;
  return k === 'custom' ? `${q.range.from}_${q.range.to}` : k;
}

export function buildExport(opts: { engine: CostEngine; ctx: AggregateContext; q: AggregateQuery; kind: ExportKind; format: ExportFormat; projectName?: (id: string) => string }): ExportResult {
  const { engine, ctx, q, kind, format } = opts;
  const qd: AggregateQuery = { ...q, split: 'none' };
  let columns: string[];
  let textCols: Set<string>;
  let rows: Row[] = [];

  if (kind === 'daily') {
    const dq = { ...qd, granularity: 'day' as const };
    const r = aggregate(ctx, dq);
    const sel = selectRecords(ctx, dq);
    const tc = timelineCost(engine, ctx, dq, sel);
    columns = ['date', ...TOKEN_COLS, 'cost_api_usd', 'cost_sub_usd'];
    textCols = new Set();
    r.timeline.forEach((p, i) => {
      if (p.requests === 0) return;
      rows.push({ date: localParts(p.start, q.tz).date, ...tokenCells({ ...p }), ...costCells(tc.points[i]) });
    });
  } else if (kind === 'model') {
    const sel = selectRecords(ctx, qd);
    const merge = q.mergeModelFamilies ?? false;
    const groups = engine.group(sel.records, (r) => modelGroupOf(r.model, merge, q.modelNormalize).key);
    columns = ['model', 'display_name', 'family', 'is_local', ...TOKEN_COLS, 'cost_api_usd', 'cost_sub_usd', 'unpriced'];
    textCols = new Set(['model', 'display_name', 'family']);
    for (const m of groupByModel(ctx, qd)) {
      const acc = groups.get(m.key);
      const blk = acc ? engine.block(acc) : undefined;
      rows.push({
        model: m.key,
        display_name: m.display,
        family: m.family,
        is_local: m.isLocal,
        ...tokenCells(m),
        ...costCells(blk),
        unpriced: !m.isLocal && (blk?.unpricedTokens ?? 0) > 0,
      });
    }
  } else {
    const sel = selectRecords(ctx, qd);
    const groups = engine.group(sel.records, (r) => r.sessionId);
    columns = ['session_id', 'project', 'start', 'end', 'sidechain_requests', 'main_model', ...TOKEN_COLS, 'cost_api_usd', 'cost_sub_usd'];
    textCols = new Set(['session_id', 'project', 'main_model']);
    for (const s of groupBySession(ctx, qd)) {
      const acc = groups.get(s.sessionId);
      rows.push({
        session_id: s.sessionId,
        project: opts.projectName ? opts.projectName(s.projectId) : (ctx.projects.byId.get(s.projectId)?.displayName ?? s.projectId),
        start: new Date(s.firstTs).toISOString(),
        end: new Date(s.lastTs).toISOString(),
        sidechain_requests: s.sidechainRequests,
        main_model: s.mainModel,
        ...tokenCells(s),
        ...costCells(acc ? engine.block(acc) : undefined),
      });
    }
    rows = rows.sort((a, b) => String(a.start) < String(b.start) ? -1 : String(a.start) > String(b.start) ? 1 : String(a.session_id) < String(b.session_id) ? -1 : 1);
  }

  const stamp = localParts(q.now, q.tz).date.replace(/-/g, '');
  const base = `token-usage-${kind}-${describeRange(q)}-${stamp}`;
  if (format === 'csv') return { filename: `${base}.csv`, contentType: 'text/csv; charset=utf-8', body: toCsv(columns, textCols, rows) };
  const body = JSON.stringify(
    {
      meta: { kind, currency: 'USD', basis: q.basis, tz: q.tz, range: q.range, projects: q.projects, note: exportNote(), columns, rowCount: rows.length },
      rows,
    },
    null,
    2,
  );
  return { filename: `${base}.json`, contentType: 'application/json; charset=utf-8', body: `${body}\n` };
}

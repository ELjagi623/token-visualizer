/**
 * 查询参数的统一解析 / 校验。所有数据类端点共用，非法输入一律抛 ApiError(400)，绝不 500。
 *
 *   project        all（默认）| 项目 id（可逗号分隔多个）
 *   range          today | 7d | 30d | thisMonth | 90d | all | custom
 *   from / to      本地日期 YYYY-MM-DD（含两端；给了 from/to 且未给 range 时隐含 custom）
 *   granularity    hour | day | week | month
 *   basis          total | fresh（默认取设置里的 defaultBasis）
 *   split          none | tokenType | model | project
 *   models         逗号分隔（mergeFamilies=true 时是家族键 opus/sonnet/haiku/local/other）
 *   mergeFamilies  true | false
 *   tz             IANA 时区（默认取设置）
 *   weekStart      monday | sunday（默认取设置）
 *   includeSidechain true | false（默认 true）
 */
import type { AggregateQuery, SplitMode } from '../core/aggregate.ts';
import type { RangeSpec } from '../core/time.ts';
import { assertValidTimeZone, QueryError } from '../core/time.ts';
import type { Settings } from '../settings.ts';
import { systemTimeZone } from '../systemTz.ts';
import { badRequest } from './errors.ts';

export const QUERY_PARAMS = ['project', 'range', 'from', 'to', 'granularity', 'basis', 'split', 'models', 'mergeFamilies', 'tz', 'weekStart', 'includeSidechain'] as const;

const MAX_PARAM_LEN = 2000;
const MAX_LIST = 200;

/** 取单值参数；同名重复出现 → 400。 */
function single(sp: URLSearchParams, key: string): string | undefined {
  const all = sp.getAll(key);
  if (all.length === 0) return undefined;
  if (all.length > 1) throw badRequest('DUPLICATE_PARAM', `参数 ${key} 重复出现`);
  const v = all[0]!;
  if (v.length > MAX_PARAM_LEN) throw badRequest('INVALID_PARAM', `参数 ${key} 过长`);
  return v;
}

function oneOf<T extends string>(v: string | undefined, key: string, allowed: readonly T[], dflt: T): T {
  if (v === undefined || v === '') return dflt;
  if (!(allowed as readonly string[]).includes(v)) throw badRequest(`INVALID_${key.toUpperCase()}`, `参数 ${key} 的值 "${v}" 不合法，可选：${allowed.join(' / ')}`);
  return v as T;
}

export function parseBool(v: string | undefined, key: string, dflt: boolean): boolean {
  if (v === undefined || v === '') return dflt;
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  throw badRequest('INVALID_PARAM', `参数 ${key} 必须是 true 或 false`);
}

export function parseList(sp: URLSearchParams, key: string): string[] | undefined {
  const all = sp.getAll(key);
  if (all.length === 0) return undefined;
  const items = all.flatMap((s) => s.split(',')).map((s) => s.trim()).filter((s) => s.length > 0);
  if (items.length > MAX_LIST) throw badRequest('INVALID_PARAM', `参数 ${key} 的项目过多`);
  for (const i of items) if (i.length > MAX_PARAM_LEN) throw badRequest('INVALID_PARAM', `参数 ${key} 中有过长的项`);
  return items;
}

/** 拒绝白名单之外的参数名（拼写错误尽早暴露）。 */
export function rejectUnknown(sp: URLSearchParams, allowed: readonly string[]): void {
  for (const k of new Set(sp.keys())) {
    if (!allowed.includes(k)) throw badRequest('UNKNOWN_PARAM', `未知的查询参数：${k}`);
  }
}

export interface ParseContext {
  settings: Settings;
  /** 当前时间（毫秒；可被 TV_NOW 固定） */
  now: number;
}

/** 解析聚合查询参数。 */
export function parseAggregateQuery(sp: URLSearchParams, ctx: ParseContext, extraAllowed: readonly string[] = []): AggregateQuery {
  rejectUnknown(sp, [...QUERY_PARAMS, ...extraAllowed]);
  const projectsRaw = parseList(sp, 'project');
  const projects: 'all' | string[] = !projectsRaw || projectsRaw.length === 0 || (projectsRaw.length === 1 && projectsRaw[0] === 'all') ? 'all' : projectsRaw;
  if (Array.isArray(projects) && projects.includes('all')) throw badRequest('INVALID_PROJECT', '参数 project 不能同时包含 all 与具体项目');

  const from = single(sp, 'from');
  const to = single(sp, 'to');
  const rangeRaw = single(sp, 'range');
  const kind = oneOf(rangeRaw, 'range', ['today', '7d', '30d', 'thisMonth', '90d', 'all', 'custom'] as const, from !== undefined || to !== undefined ? 'custom' : 'all');
  if ((from !== undefined || to !== undefined) && kind !== 'custom') throw badRequest('INVALID_RANGE', '只有 range=custom 时才能使用 from / to');
  if (kind === 'custom' && (from === undefined || to === undefined)) throw badRequest('INVALID_RANGE', 'range=custom 需要同时提供 from 与 to（YYYY-MM-DD）');
  const range: RangeSpec = kind === 'custom' ? { kind, from, to } : { kind };

  const tzRaw = single(sp, 'tz');
  const tz = tzRaw && tzRaw.length > 0 ? tzRaw : ctx.settings.timezone === 'system' ? systemTimeZone() : ctx.settings.timezone;
  try {
    assertValidTimeZone(tz);
  } catch (e) {
    throw badRequest('INVALID_TZ', e instanceof QueryError ? e.message : '无效的时区');
  }

  const models = parseList(sp, 'models');
  return {
    projects,
    range,
    granularity: oneOf(single(sp, 'granularity'), 'granularity', ['hour', 'day', 'week', 'month'] as const, 'day'),
    tz,
    weekStart: oneOf(single(sp, 'weekStart'), 'weekStart', ['monday', 'sunday'] as const, ctx.settings.weekStart),
    billingDay: ctx.settings.subscription?.billingDay ?? null,
    basis: oneOf(single(sp, 'basis'), 'basis', ['total', 'fresh'] as const, ctx.settings.defaultBasis),
    split: oneOf<SplitMode>(single(sp, 'split'), 'split', ['none', 'tokenType', 'model', 'project'] as const, 'none'),
    includeSidechain: parseBool(single(sp, 'includeSidechain'), 'includeSidechain', true),
    models: models && models.length > 0 ? models : undefined,
    mergeModelFamilies: parseBool(single(sp, 'mergeFamilies'), 'mergeFamilies', false),
    now: ctx.now,
  };
}

export { single as singleParam, oneOf as oneOfParam };

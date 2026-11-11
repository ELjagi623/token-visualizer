/**
 * 路由的纯逻辑部分（无 DOM / React 依赖，可在 Node 下单测）：类型、解析、构造链接。
 * 极简 hash 路由：#/overview?project=<id>&range=30d&models=a,b&family=1&basis=fresh、#/analysis、#/sessions[/<id>]、#/settings。
 *
 * - 选中的项目与"全局筛选"（时间范围 / 模型 / 家族合并 / 口径）都放在查询串里：刷新 / 分享可还原，浏览器后退能还原视图；
 * - 页面切换保留项目与全局筛选；页面私有参数（如会话页的 q / sort / page）放在 `params`，换页时清空。
 */

/** cost = 成本模块（总览的子视图 #/cost，导航里归在"总览"下） */
export type Page = 'overview' | 'analysis' | 'sessions' | 'settings' | 'cost';
export const PAGES: readonly Page[] = ['overview', 'analysis', 'sessions', 'settings', 'cost'];

export type RangeKind = 'today' | '7d' | '30d' | 'thisMonth' | 'all';
/** 下拉菜单顺序（由上至下）：全部 → 本月 → 近 30 天 → 近 7 天 → 今天。URL 里旧的 range=90d 会回落到默认范围。 */
export const RANGES: readonly RangeKind[] = ['all', 'thisMonth', '30d', '7d', 'today'];
export const DEFAULT_RANGE: RangeKind = '30d';

/** 全局筛选（总览 / 分析 / 会话共用） */
export interface Filters {
  range: RangeKind;
  /** 模型多选：family=false 时是原始模型名；family=true 时是家族键（opus / sonnet / haiku / local / other） */
  models: string[];
  /** 按模型家族合并 */
  family: boolean;
  /** 口径；null = 跟随设置里的默认口径 */
  basis: 'total' | 'fresh' | null;
}

export const DEFAULT_FILTERS: Filters = { range: DEFAULT_RANGE, models: [], family: false, basis: null };

export interface Route {
  page: Page;
  /** 项目 id：all | scratch | <folderKey> */
  project: string;
  /** 路径里 page 之后的部分（如 #/sessions/<id> 的 <id>） */
  rest: string[];
  filters: Filters;
  /** 页面私有查询参数（会话页的 q / sort / dir / page 等） */
  params: Record<string, string>;
}

const RESERVED = new Set(['project', 'range', 'models', 'family', 'basis']);

export function parseHash(hash: string): Route {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const qi = raw.indexOf('?');
  const pathPart = qi >= 0 ? raw.slice(0, qi) : raw;
  const query = new URLSearchParams(qi >= 0 ? raw.slice(qi + 1) : '');
  const segs = pathPart.split('/').filter((s) => s.length > 0);
  const first = segs[0];
  const page: Page = (PAGES as readonly string[]).includes(first ?? '') ? (first as Page) : 'overview';
  const project = query.get('project');
  const range = query.get('range');
  const basis = query.get('basis');
  const models = (query.get('models') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const params: Record<string, string> = {};
  for (const [k, v] of query.entries()) if (!RESERVED.has(k)) params[k] = v;
  return {
    page,
    project: project && project.length > 0 ? project : 'all',
    rest: segs.slice(1).map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    }),
    filters: {
      range: (RANGES as readonly string[]).includes(range ?? '') ? (range as RangeKind) : DEFAULT_RANGE,
      models,
      family: query.get('family') === '1',
      basis: basis === 'total' || basis === 'fresh' ? basis : null,
    },
    params,
  };
}

export interface BuildExtra {
  filters?: Filters;
  params?: Record<string, string | undefined>;
}

export function buildHash(page: Page, project: string, rest: string[] = [], extra: BuildExtra = {}): string {
  const path = [page, ...rest.map(encodeURIComponent)].join('/');
  const q = new URLSearchParams();
  if (project !== 'all') q.set('project', project);
  const f = extra.filters;
  if (f) {
    if (f.range !== DEFAULT_RANGE) q.set('range', f.range);
    if (f.models.length > 0) q.set('models', f.models.join(','));
    if (f.family) q.set('family', '1');
    if (f.basis) q.set('basis', f.basis);
  }
  for (const [k, v] of Object.entries(extra.params ?? {})) if (v !== undefined && v !== '' && !RESERVED.has(k)) q.set(k, v);
  const qs = q.toString();
  return qs ? `#/${path}?${qs}` : `#/${path}`;
}

/** 以当前路由为基础构造链接（保留项目与全局筛选）；换页时清空页面私有参数。 */
export function hashFor(route: Route, to: { page?: Page; project?: string; rest?: string[]; filters?: Partial<Filters>; params?: Record<string, string | undefined> }): string {
  const page = to.page ?? route.page;
  const samePage = page === route.page;
  return buildHash(page, to.project ?? route.project, to.rest ?? (samePage ? route.rest : []), {
    filters: { ...route.filters, ...(to.filters ?? {}) },
    params: to.params ?? (samePage ? route.params : {}),
  });
}

import type { Basis } from '../api/types.ts';
import type { Route } from '../state/routeCore.ts';

export interface QueryOverrides {
  /** 覆盖时间范围：range 名称或自定义起止（本地日期） */
  range?: string;
  from?: string;
  to?: string;
  granularity?: string;
  split?: string;
  includeSidechain?: boolean;
  /** true = 忽略全局筛选里的模型多选 / 家族合并（只保留项目与口径） */
  ignoreModels?: boolean;
  extra?: Record<string, string | number | undefined>;
}

/**
 * 把当前路由里的全局筛选（项目 / 时间范围 / 模型 / 家族合并）与口径拼成查询串（不含 `?`）。
 * 所有总览 / 分析 / 会话请求都走这里，所以筛选联动天然一致。
 */
export function filterQuery(route: Pick<Route, 'project' | 'filters'>, basis: Basis, o: QueryOverrides = {}): string {
  const p = new URLSearchParams();
  p.set('project', route.project);
  if (o.from && o.to) {
    p.set('range', 'custom');
    p.set('from', o.from);
    p.set('to', o.to);
  } else p.set('range', o.range ?? route.filters.range);
  p.set('basis', basis);
  if (!o.ignoreModels) {
    if (route.filters.models.length > 0) p.set('models', route.filters.models.join(','));
    if (route.filters.family) p.set('mergeFamilies', 'true');
  }
  if (o.granularity) p.set('granularity', o.granularity);
  if (o.split) p.set('split', o.split);
  if (o.includeSidechain === false) p.set('includeSidechain', 'false');
  for (const [k, v] of Object.entries(o.extra ?? {})) if (v !== undefined && v !== '') p.set(k, String(v));
  return p.toString();
}

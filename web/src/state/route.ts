/**
 * hash 路由的浏览器部分：订阅 hashchange、读取 / 写入 location.hash。纯逻辑见 routeCore.ts。
 */
import { useMemo, useSyncExternalStore } from 'react';
import { parseHash } from './routeCore.ts';
import type { Filters, Page, Route } from './routeCore.ts';
import { buildHash } from './routeCore.ts';

export * from './routeCore.ts';
export type { Filters, Page, Route };

function subscribe(cb: () => void): () => void {
  window.addEventListener('hashchange', cb);
  return () => window.removeEventListener('hashchange', cb);
}

const getHash = (): string => window.location.hash;

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, getHash, () => '');
  return useMemo(() => parseHash(hash), [hash]);
}

export function currentRoute(): Route {
  return parseHash(window.location.hash);
}

export interface NavTarget {
  page?: Page;
  project?: string;
  rest?: string[];
  filters?: Partial<Filters>;
  /** 合并到页面私有参数；值为 undefined / '' 表示删除该参数 */
  params?: Record<string, string | undefined>;
  /** 完全替换页面私有参数 */
  setParams?: Record<string, string | undefined>;
}

export function navigate(to: NavTarget, opts: { replace?: boolean } = {}): void {
  const cur = currentRoute();
  const page = to.page ?? cur.page;
  const samePage = page === cur.page;
  const params = to.setParams ?? { ...(samePage ? cur.params : {}), ...(to.params ?? {}) };
  const hash = buildHash(page, to.project ?? cur.project, to.rest ?? (samePage ? cur.rest : []), { filters: { ...cur.filters, ...(to.filters ?? {}) }, params });
  if (hash === window.location.hash || (hash === '#/overview' && window.location.hash === '')) return;
  if (opts.replace) window.location.replace(hash);
  else window.location.hash = hash;
}

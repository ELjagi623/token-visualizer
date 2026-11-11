/**
 * useApi：GET 请求 + 缓存 + keepPreviousData。
 *
 *  - 命中缓存（同一路径、同一"数据令牌"）→ 同步返回，不重复请求；
 *  - 路径变化（如切换项目）时，新数据到达前继续返回上一份数据（placeholder = true），页面不闪白；
 *  - 数据令牌 = dataVersion + 设置版本：服务端数据或设置变化后自动重取（旧数据仍先展示）；
 *  - 同一路径若有更早的缓存（令牌过期），先同步展示旧数据再后台刷新（stale-while-revalidate）。
 */
import { useEffect, useReducer, useRef } from 'react';
import { useStore } from '../state/store.ts';
import { ApiError, apiGet } from './client.ts';

interface CacheEntry {
  data: unknown;
  token: string;
}

const cache = new Map<string, CacheEntry>();
/** 同一路径 + 令牌的并发请求合并（侧栏与页头会各自 useApi 同一个 URL） */
const inflight = new Map<string, Promise<unknown>>();
const MAX_ENTRIES = 300;

function tokenNow(): string {
  const st = useStore.getState();
  return `${st.status?.dataVersion ?? -1}:${st.settingsVersion}`;
}

export interface ApiResult<T> {
  /** 最近一份可用数据（可能属于上一个 key，见 placeholder） */
  data: T | null;
  /** data 对应的请求路径 */
  loadedKey: string | null;
  /** 正在请求最新数据 */
  loading: boolean;
  /** data 不是当前 key 的数据（来自上一个 key，keepPreviousData） */
  placeholder: boolean;
  error: ApiError | null;
  reload: () => void;
}

export function useApi<T>(path: string | null): ApiResult<T> {
  const token = useStore((s) => `${s.status?.dataVersion ?? -1}:${s.settingsVersion}`);
  const [, force] = useReducer((x: number) => x + 1, 0);
  const shown = useRef<{ key: string; data: unknown } | null>(null);
  const errRef = useRef<{ key: string; error: ApiError } | null>(null);
  const reloadTick = useRef(0);

  const hit = path !== null ? cache.get(path) : undefined;
  if (path !== null && hit) shown.current = { key: path, data: hit.data };
  const fresh = path !== null && hit !== undefined && hit.token === token;

  useEffect(() => {
    if (path === null) return;
    const cur = cache.get(path);
    if (cur && cur.token === token) return;
    let cancelled = false;
    if (errRef.current?.key === path) errRef.current = null;
    const k = path + '|' + token;
    let p = inflight.get(k);
    if (!p) {
      p = apiGet<T>(path);
      inflight.set(k, p);
      const done = (): void => {
        inflight.delete(k);
      };
      p.then(done, done);
    }
    (p as Promise<T>)
      .then((data) => {
        if (token === tokenNow()) {
          if (cache.size >= MAX_ENTRIES) cache.clear();
          cache.set(path, { data, token });
        }
        if (cancelled) return;
        errRef.current = null;
        force();
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        errRef.current = { key: path, error: e instanceof ApiError ? e : new ApiError('NETWORK', String((e as Error)?.message ?? e)) };
        force();
      });
    return () => {
      cancelled = true;
    };
  }, [path, token, reloadTick.current]);

  const err = errRef.current && errRef.current.key === path ? errRef.current.error : null;
  return {
    data: (shown.current?.data as T | undefined) ?? null,
    loadedKey: shown.current?.key ?? null,
    loading: path !== null && !fresh && err === null,
    placeholder: path !== null && shown.current !== null && shown.current.key !== path,
    error: err,
    reload: () => {
      if (path !== null) cache.delete(path);
      errRef.current = null;
      reloadTick.current++;
      force();
    },
  };
}

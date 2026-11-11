/**
 * 请求封装：统一错误格式 `{ error: { code, message } }`；网络失败抛 code = NETWORK 的 ApiError。
 * 所有请求都是同源相对路径（/api/...），不会访问任何外部地址。
 */
import type { SettingsData, SettingsPayload, StatusPayload } from './types.ts';

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 0) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      signal,
      cache: 'no-store',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    if ((e as { name?: string }).name === 'AbortError') throw e;
    throw new ApiError('NETWORK', (e as Error).message || 'network error');
  }
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    // 非 JSON 响应（例如被代理改写）
  }
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(err?.code ?? 'HTTP_ERROR', err?.message ?? `HTTP ${res.status}`, res.status);
  }
  return json as T;
}

export function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  return request<T>('GET', path, undefined, signal);
}

export const api = {
  status: (signal?: AbortSignal) => apiGet<StatusPayload>('/api/status', signal),
  settings: (signal?: AbortSignal) => apiGet<SettingsPayload>('/api/settings', signal),
  putSettings: (patch: Partial<SettingsData>) => request<SettingsPayload>('PUT', '/api/settings', patch),
  refresh: () => request<StatusPayload>('POST', '/api/refresh'),
};

/**
 * 批次 C 用的请求封装（写操作）：与 client.ts 同一套统一错误格式 `{ error: { code, message, field? } }`。
 * 全部同源相对路径，不访问任何外部地址。
 */
import { ApiError } from './client.ts';

export async function apiSend<T>(method: 'PUT' | 'POST', path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      cache: 'no-store',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw new ApiError('NETWORK', (e as Error).message || 'network error');
  }
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    // 非 JSON 响应
  }
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(err?.code ?? 'HTTP_ERROR', err?.message ?? `HTTP ${res.status}`, res.status);
  }
  return json as T;
}

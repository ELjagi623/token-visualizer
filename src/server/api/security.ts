/**
 * 请求来源校验（防 DNS rebinding / CSRF）。
 *
 * 服务只绑定 127.0.0.1。仍要校验：
 *   - Host 必须是 127.0.0.1:<port> 或 localhost:<port>（DNS rebinding 时浏览器会带攻击者域名的 Host）；
 *   - 若带 Origin（浏览器跨站 / 同站 fetch 都会带），必须是 http://127.0.0.1:<port> 或 http://localhost:<port>；
 *     "null" / 其它来源一律拒绝（所有方法，不只是写操作）；
 *   - 写操作（PUT / POST）还要求 Content-Type: application/json（迫使跨站请求先过预检，而我们从不应答预检）；
 *   - 从不发 CORS 头。
 * 没有 Origin 的请求（curl、测试、同源导航的 GET）放行。
 */
import type { IncomingMessage } from 'node:http';
import { ApiError } from './errors.ts';

export function allowedHosts(port: number): string[] {
  return [`127.0.0.1:${port}`, `localhost:${port}`];
}

export function checkRequestOrigin(req: IncomingMessage, port: number): void {
  const host = req.headers.host;
  if (typeof host !== 'string' || !allowedHosts(port).includes(host.toLowerCase())) {
    throw new ApiError(403, 'FORBIDDEN_HOST', '不允许的 Host 头：本服务只接受 127.0.0.1 / localhost 的访问');
  }
  const origin = req.headers.origin;
  if (origin !== undefined) {
    const ok = typeof origin === 'string' && allowedHosts(port).some((h) => origin.toLowerCase() === `http://${h}`);
    if (!ok) throw new ApiError(403, 'FORBIDDEN_ORIGIN', '不允许的请求来源（Origin）');
  }
  const site = req.headers['sec-fetch-site'];
  if (site === 'cross-site') throw new ApiError(403, 'FORBIDDEN_ORIGIN', '不允许跨站请求');
}

export function requireJson(req: IncomingMessage): void {
  const ct = req.headers['content-type'];
  if (typeof ct !== 'string' || !/^application\/json\s*(;|$)/i.test(ct)) {
    throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', '请求的 Content-Type 必须是 application/json');
  }
}

/** 读取并解析 JSON 请求体（上限 64 KB）。 */
export async function readJsonBody(req: IncomingMessage, limit = 64 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    const b = c as Buffer;
    size += b.length;
    if (size > limit) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', '请求体过大');
    chunks.push(b);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim().length === 0) throw new ApiError(400, 'INVALID_JSON', '请求体不能为空');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError(400, 'INVALID_JSON', '请求体不是合法的 JSON');
  }
}

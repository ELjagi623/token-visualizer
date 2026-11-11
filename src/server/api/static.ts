/**
 * 静态托管 web/dist。
 *
 * - 路径穿越防护：URL 解码后拒绝 NUL / 反斜杠 / `.` `..` 段 / 以点开头的段；解析后的真实路径（realpath，
 *   跟随符号链接 / junction）必须仍在 webDir 的真实路径之内，且必须是普通文件；
 * - SPA 回退：没有扩展名的未知路径（页面导航）返回 index.html；带扩展名的缺失资源返回 404；
 * - web/dist 不存在（尚未构建）时，导航请求返回明确的中文提示页；
 * - Cache-Control：index.html no-cache；/assets/ 下带哈希的资源 immutable 一年；其它 1 小时；支持 ETag / 304 与 HEAD。
 */
import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { isInside } from '../core/safeFs.ts';
import { ApiError } from './errors.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

export const PLACEHOLDER_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Token Visualizer</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f6f6f3;color:#111613;font-family:system-ui,"Microsoft YaHei",sans-serif}
  main{max-width:560px;padding:32px 36px;margin:20px;background:#fff;border-radius:24px;box-shadow:0 14px 36px rgba(17,22,19,.06);border:1px solid rgba(17,22,19,.07)}
  h1{font-size:22px;margin:0 0 12px}
  p{line-height:1.7;color:#555c56;margin:8px 0}
  code{background:#edeeea;border-radius:8px;padding:2px 8px;font-size:14px;color:#111613}
</style>
</head>
<body>
<main>
  <h1>The web UI has not been built yet · 前端界面尚未构建</h1>
  <p>The server is running, but the build output <code>web/dist</code> was not found. 服务已经在运行，但没有找到前端构建产物 <code>web/dist</code>。</p>
  <p>Run <code>npm run build</code> in the project folder, then refresh this page. 请在项目目录执行 <code>npm run build</code>，然后刷新本页。</p>
  <p>The API is available directly · API 可以直接访问：<a href="/api/status">/api/status</a></p>
</main>
</body>
</html>
`;

function hasExtension(segment: string): boolean {
  return path.extname(segment).length > 0;
}

function sendBuffer(req: IncomingMessage, res: ServerResponse, status: number, body: Buffer | string, headers: Record<string, string>): void {
  const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  res.writeHead(status, { ...headers, 'Content-Length': String(buf.length) });
  if (req.method === 'HEAD') res.end();
  else res.end(buf);
}

async function realpathOrNull(p: string): Promise<string | null> {
  try {
    return await fs.promises.realpath(p);
  } catch {
    return null;
  }
}

/** 把 URL 路径解析成 webDir 内的段列表；非法返回 null，解码失败抛 400。 */
export function safeSegments(urlPath: string): string[] | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    throw new ApiError(400, 'BAD_PATH', '路径编码不合法');
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const segs = decoded.split('/').filter((s) => s.length > 0);
  for (const s of segs) if (s === '.' || s === '..' || s.startsWith('.') || s.includes(':')) return null;
  return segs;
}

interface Found {
  file: string;
  stat: fs.Stats;
}

async function locate(webDirReal: string, segs: string[]): Promise<Found | null> {
  const candidate = path.join(webDirReal, ...segs);
  if (!isInside(candidate, webDirReal)) return null;
  const real = await realpathOrNull(candidate);
  if (!real || !isInside(real, webDirReal)) return null;
  try {
    const st = await fs.promises.stat(real);
    if (!st.isFile()) return null;
    return { file: real, stat: st };
  } catch {
    return null;
  }
}

function cacheControlFor(segs: string[]): string {
  if (segs.length === 0 || segs[segs.length - 1] === 'index.html') return 'no-cache';
  if (segs[0] === 'assets') return 'public, max-age=31536000, immutable';
  return 'public, max-age=3600';
}

export async function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string, webDir: string, baseHeaders: Record<string, string>): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new ApiError(405, 'METHOD_NOT_ALLOWED', '只支持 GET / HEAD', { Allow: 'GET, HEAD' });
  const segs = safeSegments(pathname);
  if (segs === null) throw new ApiError(404, 'NOT_FOUND', '未找到');

  const webReal = await realpathOrNull(webDir);
  const serveFile = async (found: Found, useSegs: string[]): Promise<void> => {
    const ext = path.extname(found.file).toLowerCase();
    const etag = `W/"${found.stat.size.toString(16)}-${Math.floor(found.stat.mtimeMs).toString(16)}"`;
    const headers: Record<string, string> = {
      ...baseHeaders,
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': cacheControlFor(useSegs),
      ETag: etag,
    };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    const body = await fs.promises.readFile(found.file);
    sendBuffer(req, res, 200, body, headers);
  };

  const wantsIndex = segs.length === 0;
  if (webReal) {
    const found = await locate(webReal, wantsIndex ? ['index.html'] : segs);
    if (found) return serveFile(found, wantsIndex ? ['index.html'] : segs);
  }
  // 未找到：页面导航（无扩展名）→ SPA 回退到 index.html；否则 404
  const last = segs[segs.length - 1] ?? '';
  if (wantsIndex || !hasExtension(last)) {
    if (webReal) {
      const index = await locate(webReal, ['index.html']);
      if (index) return serveFile(index, ['index.html']);
    }
    sendBuffer(req, res, 200, PLACEHOLDER_HTML, { ...baseHeaders, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    return;
  }
  throw new ApiError(404, 'NOT_FOUND', '未找到');
}

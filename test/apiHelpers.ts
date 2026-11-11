import http from 'node:http';
import path from 'node:path';
import { createApp } from '../src/server/app.ts';
import type { App, AppOptions } from '../src/server/app.ts';
import { FIXTURE_ROOT, makeTmpDir, rmDir } from './helpers.ts';

export interface TestApp {
  app: App;
  base: string;
  port: number;
  appData: string;
  close: () => Promise<void>;
}

export interface StartOptions extends Partial<AppOptions> {
  /** 启动后立刻 PUT 的设置（默认固定上海时区，保证用例与主机时区无关） */
  settings?: Record<string, unknown>;
  waitIdle?: boolean;
  keepAppData?: boolean;
}

export async function startApp(opts: StartOptions = {}): Promise<TestApp> {
  const appData = opts.appDataDir ?? path.join(makeTmpDir('tv-api-'), 'appdata');
  const app = await createApp({
    dataRoot: FIXTURE_ROOT,
    port: 0,
    now: () => Date.parse('2026-10-20T12:00:00.000Z'),
    ...opts,
    appDataDir: appData,
  });
  const base = `http://127.0.0.1:${app.port}`;
  if (opts.waitIdle !== false) await app.store.idle();
  const t: TestApp = {
    app,
    base,
    port: app.port,
    appData,
    close: async () => {
      await app.close();
      if (!opts.keepAppData) rmDir(path.dirname(appData));
    },
  };
  const s = opts.settings ?? { timezone: 'Asia/Shanghai' };
  if (Object.keys(s).length > 0) {
    const r = await fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(s) });
    if (r.status !== 200) throw new Error(`初始设置失败：${await r.text()}`);
  }
  return t;
}

export async function getJson(base: string, p: string): Promise<{ status: number; body: any; headers: Headers }> {
  const r = await fetch(`${base}${p}`);
  const text = await r.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: r.status, body, headers: r.headers };
}

export async function putJson(base: string, p: string, data: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  const r = await fetch(`${base}${p}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data) });
  const text = await r.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: r.status, body };
}

/** 发送原始请求（可自定义 Host / 原始路径，不被 fetch 规范化）。 */
export function rawRequest(port: number, opts: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: opts.method ?? 'GET', path: opts.path, headers: opts.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

export interface SseEvent {
  id?: string;
  event: string;
  data: any;
}

/** 打开 SSE 连接并收集事件。 */
export function openSse(port: number, p = '/api/events'): { events: SseEvent[]; raw: string[]; close: () => void; waitFor: (pred: (e: SseEvent) => boolean, ms?: number) => Promise<SseEvent | null>; closed: Promise<void> } {
  const events: SseEvent[] = [];
  const raw: string[] = [];
  let buf = '';
  let resolveClosed: () => void = () => {};
  const closed = new Promise<void>((r) => (resolveClosed = r));
  const req = http.get({ host: '127.0.0.1', port, path: p, headers: { Accept: 'text/event-stream' } }, (res) => {
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      raw.push(chunk);
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev: Partial<SseEvent> & { event?: string } = {};
        let data = '';
        for (const line of block.split('\n')) {
          if (line.startsWith('id: ')) ev.id = line.slice(4);
          else if (line.startsWith('event: ')) ev.event = line.slice(7);
          else if (line.startsWith('data: ')) data += line.slice(6);
        }
        if (ev.event) events.push({ id: ev.id, event: ev.event, data: data ? JSON.parse(data) : null });
      }
    });
    res.on('close', () => resolveClosed());
  });
  req.on('error', () => resolveClosed());
  return {
    events,
    raw,
    close: () => req.destroy(),
    closed,
    async waitFor(pred, ms = 3000) {
      const t0 = Date.now();
      for (;;) {
        const found = events.find(pred);
        if (found) return found;
        if (Date.now() - t0 > ms) return null;
        await new Promise((r) => setTimeout(r, 15));
      }
    },
  };
}

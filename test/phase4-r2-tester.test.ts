/**
 * 阶段 4 第 2 轮复测（测试工程师编写）：独立验证缺陷 1–3 的修复与建议项 4。
 */
import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app.ts';
import type { App, AppOptions } from '../src/server/app.ts';
import { FIXTURE_ROOT, makeTmpDir, rmDir, snapshotDir } from './helpers.ts';

const PROJECT = path.resolve(path.dirname(FIXTURE_ROOT), '..', '..');
const NOW = Date.parse('2026-10-20T12:00:00Z');
const bases: string[] = [];
const apps: App[] = [];
const procs = new Set<ChildProcess>();
afterAll(async () => {
  for (const p of procs) {
    try {
      if (p.pid !== undefined && p.exitCode === null) execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      /* ignore */
    }
  }
  for (const a of apps) await a.close().catch(() => undefined);
  for (const b of bases) rmDir(b);
});

interface World {
  base: string;
  root: string;
  app: string;
}
function newWorld(copyFixture = true): World {
  const base = makeTmpDir('tv-p4r2-');
  bases.push(base);
  const root = path.join(base, 'projects');
  fs.mkdirSync(root, { recursive: true });
  if (copyFixture) fs.cpSync(FIXTURE_ROOT, root, { recursive: true });
  return { base, root, app: path.join(base, 'appdata') };
}
async function start(w: World, extra: Partial<AppOptions> = {}): Promise<App> {
  const a = await createApp({ dataRoot: w.root, appDataDir: w.app, port: 0, now: () => NOW, sseHeartbeatMs: 300, ...extra });
  apps.push(a);
  await a.store.idle();
  return a;
}
interface Resp {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}
function raw(port: number, o: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method: o.method ?? 'GET', path: o.path, headers: o.headers, setHost: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    r.setTimeout(8000, () => r.destroy(new Error('timeout')));
    if (o.body !== undefined) r.write(o.body);
    r.end();
  });
}
const hostOf = (a: App): string => `127.0.0.1:${a.port}`;
const get = (a: App, p: string): Promise<Resp> => raw(a.port, { path: p, headers: { Host: hostOf(a) } });
const put = (a: App, body: unknown): Promise<Resp> => raw(a.port, { method: 'PUT', path: '/api/settings', headers: { Host: hostOf(a), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const json = (r: Resp): any => JSON.parse(r.body);

// ---------------------------------------------------------------------------
describe('缺陷 1 复测：dataRoot 与应用数据目录的关系', () => {
  it('PUT dataRoot 为 应用数据目录自身 / 其变体 / 父目录 / 更上层 / 盘符根 / 指向这些目录的 junction → 400 INVALID_SETTING，不泄漏路径，已有设置不变（含同请求其它字段），之后仍可改', async () => {
    const w = newWorld();
    const a = await start(w);
    fs.mkdirSync(w.app, { recursive: true });
    expect((await put(a, { theme: 'dark', weekStart: 'sunday' })).status).toBe(200);
    const stable = json(await get(a, '/api/settings')).settings;
    const variants: string[] = [
      w.app,
      w.app + path.sep,
      path.join(w.app, '.'),
      path.join(w.app, 'sub', '..'),
      w.app.toUpperCase(),
      w.app.replaceAll('\\', '/'),
      path.dirname(w.app), // 父目录（= w.base，同时是数据根的父目录）
      path.dirname(path.dirname(w.app)),
      path.parse(w.app).root, // 盘符根
    ];
    const jn = path.join(makeTmpDir('tv-p4r2-jn-'), 'link');
    bases.push(path.dirname(jn));
    try {
      fs.symlinkSync(path.dirname(w.app), jn, 'junction');
      variants.push(jn);
    } catch {
      /* 无法创建 junction 时跳过该变体 */
    }
    for (const v of variants) {
      const r = await put(a, { dataRoot: v, theme: 'light' });
      expect(r.status, `dataRoot=${v}`).toBe(400);
      const j = json(r);
      expect(j.error.code).toBe('INVALID_SETTING');
      expect(j.error.field).toBe('dataRoot');
      expect(j.error.message).toMatch(/应用数据目录/);
      // 不泄漏任何绝对路径
      expect(r.body, `dataRoot=${v} 泄漏`).not.toMatch(/[A-Za-z]:[\\/]/);
      expect(r.body).not.toContain(path.basename(w.base));
      expect(json(await get(a, '/api/settings')).settings, `dataRoot=${v} 设置被改动`).toEqual(stable);
    }
    // 之后仍可改：主题、dataRoot=null、以及与应用数据目录无关的有效目录
    expect((await put(a, { theme: 'system' })).status).toBe(200);
    const other = path.join(w.base, 'other-root');
    fs.mkdirSync(other);
    expect((await put(a, { dataRoot: other })).status).toBe(200);
    await a.store.idle();
    expect((await put(a, { dataRoot: null })).status).toBe(200);
    expect((await put(a, { dataRoot: w.root })).status).toBe(200); // 数据根的兄弟目录（应用数据目录不在其内）可设
    expect(a.store.getStatus().warnings.join('\n')).not.toMatch(/缓存/);
  });

  it('dataRoot 设为应用数据目录的子目录（如 appdata/cache）：不会锁死设置（设置仍可写）', async () => {
    const w = newWorld();
    const a = await start(w);
    fs.mkdirSync(path.join(w.app, 'cache'), { recursive: true });
    const r = await put(a, { dataRoot: path.join(w.app, 'cache') });
    // 接受或拒绝都可以，但绝不能让后续设置写入失败
    expect([200, 400]).toContain(r.status);
    await a.store.idle();
    expect((await put(a, { theme: 'dark' })).status).toBe(200);
    expect((await put(a, { dataRoot: null })).status).toBe(200);
  });

  it('启动时设置文件里已有坏值（dataRoot = 应用数据目录的父目录）：自动回退默认并在 /api/status.warnings 警告，其余设置保留，之后可正常修改，文件被修正，再次启动无警告', async () => {
    const w = newWorld();
    fs.mkdirSync(w.app, { recursive: true });
    const settingsFile = path.join(w.app, 'settings.json');
    fs.writeFileSync(settingsFile, JSON.stringify({ schema: 1, settings: { dataRoot: w.base, theme: 'dark', language: 'en', weekStart: 'sunday', budget: { daily: 7, monthly: null } } }));
    const rootBefore = JSON.stringify(snapshotDir(w.root));
    let a = await start(w);
    const st = json(await get(a, '/api/status'));
    expect(st.dataRoot).toBe(w.root); // 回到默认数据根（createApp 的 dataRoot）
    expect(st.state).toBe('idle');
    expect(st.warnings.join('\n')).toMatch(/数据根/);
    expect(st.warnings.join('\n')).not.toMatch(/[A-Za-z]:[\\/]/);
    const s = json(await get(a, '/api/settings'));
    expect(s.settings).toMatchObject({ dataRoot: null, theme: 'dark', language: 'en', weekStart: 'sunday', budget: { daily: 7, monthly: null } });
    expect(s.warnings.join('\n')).toMatch(/数据根/);
    expect(json(await get(a, '/api/summary')).summary.requests).toBe(59); // 数据没丢
    expect((await put(a, { theme: 'light' })).status).toBe(200);
    expect((await put(a, { dataRoot: null })).status).toBe(200);
    expect(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).settings.dataRoot).toBeNull(); // 文件已被修正
    expect(JSON.stringify(snapshotDir(w.root))).toBe(rootBefore);
    await a.close();
    a = await start(w);
    expect(json(await get(a, '/api/status')).warnings.filter((x: string) => /数据根/.test(x))).toEqual([]);
    // 变体：dataRoot 恰好等于应用数据目录自身
    await a.close();
    fs.writeFileSync(settingsFile, JSON.stringify({ schema: 1, settings: { dataRoot: w.app, timezone: 'Asia/Shanghai' } }));
    a = await start(w);
    const st2 = json(await get(a, '/api/status'));
    expect(st2.dataRoot).toBe(w.root);
    expect(st2.warnings.join('\n')).toMatch(/数据根/);
    expect(json(await get(a, '/api/settings')).settings.timezone).toBe('Asia/Shanghai');
    expect((await put(a, { theme: 'dark' })).status).toBe(200);
  });

  it('启动时设置文件里保存的 dataRoot 指向已不存在的目录：服务正常启动，state=error 带中文原因，PUT dataRoot=null 可恢复', async () => {
    const w = newWorld();
    fs.mkdirSync(w.app, { recursive: true });
    fs.writeFileSync(path.join(w.app, 'settings.json'), JSON.stringify({ schema: 1, settings: { dataRoot: path.join(w.base, 'gone') } }));
    const a = await start(w);
    const st = json(await get(a, '/api/status'));
    expect(st.state).toBe('error');
    expect(st.lastError).toMatch(/数据根目录不存在/);
    expect((await get(a, '/api/summary')).status).toBe(200);
    expect((await put(a, { dataRoot: null })).status).toBe(200);
    await a.store.idle();
    expect(json(await get(a, '/api/status')).state).toBe('idle');
    expect(json(await get(a, '/api/summary')).summary.requests).toBe(59);
  });
});

// ---------------------------------------------------------------------------
interface SseEvent {
  event: string;
  data: any;
  at: number;
}
function openSse(a: App): { events: SseEvent[]; close: () => void; ready: Promise<void> } {
  const events: SseEvent[] = [];
  let buf = '';
  const t0 = Date.now();
  let req!: http.ClientRequest;
  const ready = new Promise<void>((resolve) => {
    req = http.request({ host: '127.0.0.1', port: a.port, path: '/api/events', headers: { Host: hostOf(a) } }, (res) => {
      res.on('data', (c: Buffer) => {
        buf += c.toString('utf8');
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (ev && data) events.push({ event: ev, data: JSON.parse(data), at: Date.now() - t0 });
        }
      });
      resolve();
    });
    req.end();
  });
  return { events, close: () => req.destroy(), ready };
}
const versionsOf = (c: { events: SseEvent[] }): number[] => c.events.filter((e) => e.event === 'dataVersion').map((e) => e.data.dataVersion as number);
const line = (id: string, ts: string): string => JSON.stringify({ type: 'assistant', timestamp: ts, message: { id, model: 'claude-x', usage: { input_tokens: 1, output_tokens: 1 } } }) + '\n';

describe('缺陷 2 复测：SSE 每客户端各自记录已知版本', () => {
  it('连接后（经过多次轮询/扫描）数据没变就不再多发 dataVersion；每个客户端的版本号序列严格递增且无重复', async () => {
    const w = newWorld();
    const a = await start(w, { watcher: { intervalMs: 2000 } });
    const c = openSse(a);
    await c.ready;
    for (let i = 0; i < 3; i++) await a.store.refreshNow();
    await new Promise((r) => setTimeout(r, 2600)); // 跨过至少一次定时轮询
    expect(versionsOf(c)).toEqual([a.store.getView().dataVersion]); // 只有初始快照那一条
    expect(c.events.filter((e) => e.event === 'status').length).toBeGreaterThan(2); // 状态事件仍在流动
    c.close();
  });

  it('多客户端：A 在 v1 连接，数据变化到 v2，B 在 v2 连接，再变化到 v3，C 在 v3 连接，再到 v4 —— 每个客户端恰好各收到自己连接后的每个新版本一次，没有被其它客户端的连接吞掉', async () => {
    const w = newWorld();
    const a = await start(w);
    const file = path.join(w.root, 'D--Work-beta', 'bbbbbbbb-0000-4000-8000-000000000001.jsonl');
    const bump = async (id: string): Promise<number> => {
      fs.appendFileSync(file, line(id, '2026-10-19T10:00:00Z'));
      await a.store.refreshNow();
      return a.store.getView().dataVersion;
    };
    const A = openSse(a);
    await A.ready;
    await new Promise((r) => setTimeout(r, 150));
    const v1 = a.store.getView().dataVersion;
    const v2 = await bump('m2');
    await new Promise((r) => setTimeout(r, 150));
    const B = openSse(a);
    await B.ready;
    await new Promise((r) => setTimeout(r, 150));
    const v3 = await bump('m3');
    await new Promise((r) => setTimeout(r, 150));
    const C = openSse(a);
    await C.ready;
    await new Promise((r) => setTimeout(r, 150));
    const v4 = await bump('m4');
    await new Promise((r) => setTimeout(r, 300));
    expect([v2 > v1, v3 > v2, v4 > v3]).toEqual([true, true, true]);
    expect(versionsOf(A)).toEqual([v1, v2, v3, v4]);
    expect(versionsOf(B)).toEqual([v2, v3, v4]);
    expect(versionsOf(C)).toEqual([v3, v4]);
    // status 事件里的 dataVersion 与之一致（最后一条）
    for (const c of [A, B, C]) expect(c.events.filter((e) => e.event === 'status').pop()!.data.dataVersion).toBe(v4);
    [A, B, C].forEach((c) => c.close());
  });

  it('同一客户端断开重连：重连后的初始快照是当前版本，之后不重复；并发连接 20 个客户端，数据变化后每个恰好收到 1 次新版本', async () => {
    const w = newWorld();
    const a = await start(w);
    const first = openSse(a);
    await first.ready;
    first.close();
    await new Promise((r) => setTimeout(r, 200));
    const clients = Array.from({ length: 20 }, () => openSse(a));
    await Promise.all(clients.map((c) => c.ready));
    await new Promise((r) => setTimeout(r, 200));
    const v0 = a.store.getView().dataVersion;
    fs.appendFileSync(path.join(w.root, 'D--Work-beta', 'bbbbbbbb-0000-4000-8000-000000000001.jsonl'), line('many1', '2026-10-19T10:00:00Z'));
    await a.store.refreshNow();
    await new Promise((r) => setTimeout(r, 300));
    const v1 = a.store.getView().dataVersion;
    expect(v1).toBeGreaterThan(v0);
    for (const c of clients) expect(versionsOf(c)).toEqual([v0, v1]);
    clients.forEach((c) => c.close());
  });
});

// ---------------------------------------------------------------------------
function rawSocket(port: number, text: string, ms = 1500): Promise<{ out: string; ms: number }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const s = net.connect({ port, host: '127.0.0.1' });
    let out = '';
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      s.destroy();
      resolve({ out, ms: Date.now() - t0 });
    };
    s.on('data', (d) => {
      out += d.toString('utf8');
      if (out.includes('\r\n\r\n')) setTimeout(finish, 50);
    });
    s.on('close', finish);
    s.on('error', finish);
    setTimeout(finish, ms);
    s.write(text);
  });
}

describe('缺陷 3 复测：HEAD /api/events', () => {
  it('立即 405（统一错误格式、Allow: GET），不占 SSE 名额；其它 HEAD 行为不变；OPTIONS/POST 同为 405', async () => {
    const w = newWorld();
    const a = await start(w);
    const r = await rawSocket(a.port, `HEAD /api/events HTTP/1.1\r\nHost: ${hostOf(a)}\r\n\r\n`);
    expect(r.out).toMatch(/^HTTP\/1\.1 405/);
    expect(r.out.toLowerCase()).toMatch(/allow: get\r\n/);
    expect(r.ms).toBeLessThan(500);
    expect(a.sse.size).toBe(0);
    // 重复 20 次也不累积名额
    for (let i = 0; i < 20; i++) await rawSocket(a.port, `HEAD /api/events HTTP/1.1\r\nHost: ${hostOf(a)}\r\nConnection: close\r\n\r\n`);
    expect(a.sse.size).toBe(0);
    for (const m of ['OPTIONS', 'POST', 'PUT', 'DELETE']) {
      const x = await raw(a.port, { method: m, path: '/api/events', headers: { Host: hostOf(a), ...(m === 'PUT' ? { 'Content-Type': 'application/json' } : {}) }, body: m === 'PUT' ? '{}' : undefined });
      expect(x.status, m).toBe(405);
      expect(Object.keys(JSON.parse(x.body))).toEqual(['error']);
    }
    for (const p of ['/api/status', '/api/summary', '/api/projects', '/api/timeseries', '/api/settings']) {
      const h = await raw(a.port, { method: 'HEAD', path: p, headers: { Host: hostOf(a) } });
      const g = await get(a, p);
      expect([h.status, h.body, h.headers['content-length']], p).toEqual([200, '', g.headers['content-length']]);
    }
    // 之后 GET 仍可建立 SSE，名额计数正确；HEAD 与错误 Origin/Host 的组合仍 403
    const c = openSse(a);
    await c.ready;
    expect(a.sse.size).toBe(1);
    const evil = await raw(a.port, { method: 'HEAD', path: '/api/events', headers: { Host: hostOf(a), Origin: 'http://evil.example' } });
    expect(evil.status).toBe(403);
    c.close();
  });

  it('100 个 SSE 满额时，HEAD /api/events 仍是 405（不是 503，也不挂起）', async () => {
    const w = newWorld();
    const a = await start(w);
    const many = Array.from({ length: 100 }, () => openSse(a));
    await Promise.all(many.map((m) => m.ready));
    expect(a.sse.size).toBe(100);
    const r = await rawSocket(a.port, `HEAD /api/events HTTP/1.1\r\nHost: ${hostOf(a)}\r\n\r\n`);
    expect(r.out).toMatch(/^HTTP\/1\.1 405/);
    many.forEach((m) => m.close());
  });
});

// ---------------------------------------------------------------------------
describe('建议项 4 复测：数据根不存在时 npm start 的控制台提示', () => {
  it('打印一次"提示：数据根目录不存在…"，轮询重试不刷屏；目录出现后打印"已恢复"；不会在恢复前重复打印', async () => {
    const w = newWorld(false);
    fs.mkdirSync(w.app, { recursive: true });
    fs.writeFileSync(path.join(w.app, 'settings.json'), JSON.stringify({ schema: 1, settings: { autoRefresh: { enabled: true, intervalSec: 2 } } }));
    const missing = path.join(w.base, 'nope');
    const child = spawn(process.execPath, [path.join(PROJECT, 'src', 'server', 'index.ts'), '--no-open'], { env: { ...process.env, TV_DATA_ROOT: missing, TV_APPDATA_DIR: w.app, TV_PORT: '0' } });
    procs.add(child);
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (out += d.toString('utf8')));
    const waitFor = async (re: RegExp, ms: number): Promise<void> => {
      const t0 = Date.now();
      while (!re.test(out) && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 50));
      expect(out, `等待 ${re} 超时\n${out}`).toMatch(re);
    };
    await waitFor(/已启动：http:\/\/127\.0\.0\.1:\d+\//, 15_000);
    await waitFor(/提示：数据根目录不存在/, 10_000);
    await new Promise((r) => setTimeout(r, 5500)); // 至少再经过 2 次轮询重试
    expect(out.match(/提示：数据根目录不存在/g)!.length).toBe(1);
    expect(out).toContain(missing);
    // 恢复
    fs.mkdirSync(path.join(missing, 'P'), { recursive: true });
    fs.writeFileSync(path.join(missing, 'P', 's.jsonl'), line('rec1', '2026-10-10T00:00:00Z'));
    await waitFor(/数据根目录已恢复/, 10_000);
    await new Promise((r) => setTimeout(r, 2500));
    expect(out.match(/数据根目录已恢复/g)!.length).toBe(1);
    expect(out.match(/提示：数据根目录不存在/g)!.length).toBe(1);
    // 启动日志格式：地址与"关闭此窗口"
    expect(out).toMatch(/已启动：http:\/\/127\.0\.0\.1:\d+\/\r?\n\s*关闭此窗口（或按 Ctrl\+C）即退出。/);
  }, 60_000);
});

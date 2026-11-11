/**
 * 阶段 4 独立测试（测试工程师编写）：HTTP API / 安全 / 静态托管 / 设置 / SSE。
 * 期望值来自 naiveView + Intl（apiCrossCheck.ts），不使用开发者的聚合/测试辅助。
 */
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app.ts';
import type { App, AppOptions } from '../src/server/app.ts';
import { crossCheck } from './apiCrossCheck.ts';
import { FIXTURE_ROOT, makeTmpDir, rmDir, snapshotDir } from './helpers.ts';
import { naiveRecords, naiveView } from './naiveView.ts';

const NOW = Date.parse('2026-10-20T12:00:00Z');
const bases: string[] = [];
const apps: App[] = [];
afterAll(async () => {
  for (const a of apps) await a.close().catch(() => undefined);
  for (const b of bases) rmDir(b);
});

interface World {
  base: string;
  root: string;
  app: string;
}
function newWorld(copyFixture = true): World {
  const base = makeTmpDir('tv-p4t-');
  bases.push(base);
  const root = path.join(base, 'projects');
  fs.mkdirSync(root, { recursive: true });
  if (copyFixture) fs.cpSync(FIXTURE_ROOT, root, { recursive: true });
  return { base, root, app: path.join(base, '应用 数据') };
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
function raw(port: number, o: { method?: string; path: string; headers?: Record<string, string>; body?: string | Buffer }): Promise<Resp> {
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
/** 发送原始 TCP 文本（用于缺失 Host、畸形请求行等）。 */
function rawSocket(port: number, text: string): Promise<string> {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    let out = '';
    s.on('data', (d) => (out += d.toString('utf8')));
    s.on('close', () => resolve(out));
    s.on('error', () => resolve(out));
    s.setTimeout(4000, () => s.destroy());
    s.write(text);
  });
}
/** 用原始 TCP 发 GET（允许路径里有空格/反斜杠等 http.request 会拒绝的字符）。 */
async function getRaw(a: App, p: string): Promise<Resp> {
  const CRLF = '\r\n';
  const out = await rawSocket(a.port, `GET ${p} HTTP/1.1${CRLF}Host: 127.0.0.1:${a.port}${CRLF}Connection: close${CRLF}${CRLF}`);
  const m = /^HTTP\/1\.[01] (\d{3})/.exec(out);
  const i = out.indexOf(CRLF + CRLF);
  return { status: m ? Number(m[1]) : 0, headers: {}, body: i >= 0 ? out.slice(i + 4) : out };
}
const hostOf = (a: App): string => `127.0.0.1:${a.port}`;
const get = (a: App, p: string, headers: Record<string, string> = {}): Promise<Resp> => raw(a.port, { path: p, headers: { Host: hostOf(a), ...headers } });
const json = (r: Resp): any => JSON.parse(r.body);
function put(a: App, body: unknown, headers: Record<string, string> = {}): Promise<Resp> {
  return raw(a.port, { method: 'PUT', path: '/api/settings', headers: { Host: hostOf(a), 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
}

const LEAK_PATTERNS: RegExp[] = [/[A-Za-z]:\\/, /[A-Za-z]:\//, /\bat .*\(.*:\d+:\d+\)/, /node_modules/, /\.ts:\d+/, /\bsrc[\\/]server/, /Error:/];
function assertErrorShape(r: Resp, status: number, ctx: string): void {
  expect(r.status, `${ctx} 状态`).toBe(status);
  expect(r.headers['content-type'], ctx).toMatch(/application\/json/);
  const j = JSON.parse(r.body);
  expect(Object.keys(j), ctx).toEqual(['error']);
  expect(typeof j.error.code, ctx).toBe('string');
  expect(typeof j.error.message, ctx).toBe('string');
  for (const k of Object.keys(j.error)) expect(['code', 'message', 'field'], `${ctx} 键 ${k}`).toContain(k);
  for (const re of LEAK_PATTERNS) expect(r.body, `${ctx} 泄漏 ${re}`).not.toMatch(re);
}

// ---------------------------------------------------------------------------
// 1. 数据正确性（HTTP 层交叉核对）
// ---------------------------------------------------------------------------
describe('API 正确性：与朴素实现 + Intl 交叉核对（fixture）', () => {
  let w: World;
  let a: App;
  beforeAll(async () => {
    w = newWorld();
    a = await start(w);
  });

  it('summary / periods / timeseries(4 粒度 × 4 时区) / 拆分 / 模型 / 范围 / projects 全部与独立计算一致', async () => {
    const recs = naiveRecords(naiveView(w.root));
    const r = await crossCheck(`http://127.0.0.1:${a.port}`, recs, { now: NOW, tzs: ['UTC', 'Asia/Shanghai', 'America/New_York', 'Asia/Kolkata'] });
    expect(r.fails).toEqual([]);
    expect(r.checks).toBeGreaterThan(200);
  });

  it('/api/projects：含只有 0 字节文件的文件夹；条目数 = 项目数（Scratch 归并后 非 scratch 数+1；children=3）；中文用户名项目显示 demo', async () => {
    const pj = json(await get(a, '/api/projects?tz=Asia%2FShanghai'));
    expect(pj.folderCount).toBe(9); // expected.projectFolderCount
    expect(pj.projectCount).toBe(9 - 3 + 1);
    expect(pj.projects.length).toBe(7);
    const empty = pj.projects.find((p: any) => p.id === 'D--Work-empty');
    expect(empty).toMatchObject({ pathUnknown: true, total: 0, requests: 0, displayName: 'D--Work-empty' });
    const demo = pj.projects.find((p: any) => p.id === 'C--Users-----Work-demo');
    expect([demo.displayName, demo.path]).toEqual(['demo', 'C:\\Users\\王测试\\Work\\demo']);
    const sc = pj.projects.find((p: any) => p.isScratchGroup);
    expect(sc.children.length).toBe(3);
    // 搜索
    expect(json(await get(a, '/api/projects?q=demo')).projects.map((p: any) => p.id)).toEqual(['C--Users-----Work-demo']);
    expect(json(await get(a, '/api/projects?q=zzzz-nothing')).projects).toEqual([]);
    const sq = json(await get(a, '/api/projects?q=scratch-2026-10-12'));
    expect(sq.projects.length).toBe(1);
    expect(sq.projects[0].children.length).toBe(1);
  });

  it('关闭 Scratch 归并后条目数 = 文件夹数（9），再开启恢复', async () => {
    const w2 = newWorld();
    const b = await start(w2);
    expect((await put(b, { groupScratch: false })).status).toBe(200);
    const pj = json(await get(b, '/api/projects'));
    expect(pj.projects.length).toBe(9);
    expect(pj.projects.every((p: any) => !p.isScratchGroup)).toBe(true);
    expect((await put(b, { groupScratch: true })).status).toBe(200);
    expect(json(await get(b, '/api/projects')).projects.length).toBe(7);
  });

  it('/api/status：结构、today 与 periods 一致、usageState 阈值（≤60s generating / ≤10min active / 其他 idle）', async () => {
    const w2 = newWorld();
    let clock = NOW;
    const b = await start(w2, { now: () => clock });
    const last = json(await get(b, '/api/status')).lastRecordTs as number;
    expect(typeof last).toBe('number');
    const probe = async (age: number): Promise<any> => {
      clock = last + age;
      return json(await get(b, '/api/status'));
    };
    expect((await probe(30_000)).usageState).toBe('generating');
    expect((await probe(60_000)).usageState).toBe('generating');
    expect((await probe(60_001)).usageState).toBe('active');
    expect((await probe(600_000)).usageState).toBe('active');
    expect((await probe(600_001)).usageState).toBe('idle');
    expect((await probe(-5000)).usageState).toBe('generating'); // 未来时间戳按 0 处理
    clock = NOW;
    const st = json(await get(b, '/api/status'));
    for (const k of ['state', 'phase', 'filesDone', 'filesTotal', 'bytesDone', 'bytesTotal', 'startedAt', 'lastScanAt', 'dataVersion', 'lastRecordTs', 'usageState', 'today']) expect(st, k).toHaveProperty(k);
    expect(st.state).toBe('idle');
    const sm = json(await get(b, `/api/summary?tz=${encodeURIComponent(st.today.tz)}`));
    expect(st.today.total).toBe(sm.periods.today.summary.total);
  });

  it('数据根不存在：status.state=error、usageState=error、lastError 中文；创建后 POST /api/refresh 恢复；API 不 500', async () => {
    const w2 = newWorld(false);
    fs.rmSync(w2.root, { recursive: true });
    const b = await start(w2);
    let st = json(await get(b, '/api/status'));
    expect([st.state, st.usageState]).toEqual(['error', 'error']);
    expect(st.lastError).toMatch(/数据根目录不存在/);
    for (const p of ['/api/summary', '/api/timeseries', '/api/projects']) expect((await get(b, p)).status, p).toBe(200);
    expect(json(await get(b, '/api/summary')).summary.total).toBe(0);
    fs.mkdirSync(path.join(w2.root, 'P'), { recursive: true });
    fs.writeFileSync(path.join(w2.root, 'P', 's.jsonl'), JSON.stringify({ type: 'assistant', timestamp: '2026-10-10T00:00:00Z', message: { id: 'm', model: 'claude-x', usage: { input_tokens: 5, output_tokens: 5 } } }) + '\n');
    const r = await raw(b.port, { method: 'POST', path: '/api/refresh', headers: { Host: hostOf(b) } });
    expect(r.status).toBe(200);
    st = json(await get(b, '/api/status'));
    expect(st.state).toBe('idle');
    expect(json(await get(b, '/api/summary')).summary.total).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// 2. 参数严格性与错误格式
// ---------------------------------------------------------------------------
describe('参数严格性与统一错误格式', () => {
  let w: World;
  let a: App;
  beforeAll(async () => {
    w = newWorld();
    a = await start(w);
  });

  const bad: Array<[string, string]> = [
    ['/api/summary?granularity=minute', 'INVALID_GRANULARITY'],
    ['/api/timeseries?granularity=DAY', 'INVALID_GRANULARITY'],
    ['/api/timeseries?granularity=day&granularity=hour', 'DUPLICATE_PARAM'],
    ['/api/summary?tz=Mars/Olympus', 'INVALID_TZ'],
    ['/api/summary?tz=Asia/Shanghai&tz=UTC', 'DUPLICATE_PARAM'],
    ['/api/summary?range=forever', 'INVALID_RANGE'],
    ['/api/summary?range=7d&from=2026-10-01&to=2026-10-02', 'INVALID_RANGE'],
    ['/api/summary?range=custom', 'INVALID_RANGE'],
    ['/api/summary?range=custom&from=2026-10-01', 'INVALID_RANGE'],
    ['/api/summary?from=2026-10-09&to=2026-10-01', 'INVALID_RANGE'],
    ['/api/summary?from=2026-02-30&to=2026-03-01', 'INVALID_RANGE'],
    ['/api/summary?from=yesterday&to=today', 'INVALID_RANGE'],
    ['/api/summary?basis=gross', 'INVALID_BASIS'],
    ['/api/timeseries?split=pie', 'INVALID_SPLIT'],
    ['/api/summary?weekStart=friday', 'INVALID_WEEKSTART'],
    ['/api/summary?includeSidechain=yes', 'INVALID_PARAM'],
    ['/api/summary?mergeFamilies=maybe', 'INVALID_PARAM'],
    ['/api/summary?project=does-not-exist', 'UNKNOWN_PROJECT'],
    ['/api/summary?project=all,D--Work-alpha', 'INVALID_PROJECT'],
    ['/api/summary?foo=bar', 'UNKNOWN_PARAM'],
    ['/api/summary?Granularity=day', 'UNKNOWN_PARAM'],
    ['/api/status?x=1', 'UNKNOWN_PARAM'],
    ['/api/projects?sort=random', 'INVALID_SORT'],
    ['/api/projects?basis=x', 'INVALID_BASIS'],
    ['/api/projects?tz=Nope/Nope', 'INVALID_TZ'],
    ['/api/projects?sort=total&sort=name', 'DUPLICATE_PARAM'],
    ['/api/events?x=1', 'UNKNOWN_PARAM'],
  ];
  it.each(bad)('400 %s → %s，格式统一且不泄漏路径/堆栈', async (url, code) => {
    const r = await get(a, url);
    assertErrorShape(r, 400, url);
    expect(JSON.parse(r.body).error.code).toBe(code);
  });

  it('桶数过多 / 超长参数 / 畸形编码 / NUL：4xx 且不是 5xx，随后服务仍正常', async () => {
    const cases = [
      '/api/timeseries?granularity=hour&range=custom&from=1990-01-01&to=2026-10-01',
      `/api/summary?models=${'a,'.repeat(5000)}`,
      `/api/summary?tz=${'x'.repeat(5000)}`,
      '/api/summary?tz=%E0%A4%A',
      '/api/summary?tz=%00',
      '/api/summary?project=%00',
      '/api/summary?%ZZ=1',
      '/api/summary?range=%FF',
    ];
    for (const c of cases) {
      const r = await get(a, c);
      expect(r.status, c.slice(0, 60)).toBeGreaterThanOrEqual(400);
      expect(r.status, c.slice(0, 60)).toBeLessThan(500);
      if (r.headers['content-type']?.includes('json')) assertErrorShape(r, r.status, c.slice(0, 60));
    }
    expect((await get(a, '/api/status')).status).toBe(200);
  });

  it('list 参数 project / models 允许重复出现并合并；空值回退默认（行为记录）', async () => {
    const x = json(await get(a, '/api/summary?project=D--Work-alpha&project=D--Work-beta')).summary.total;
    const y = json(await get(a, '/api/summary?project=D--Work-alpha,D--Work-beta')).summary.total;
    expect(x).toBe(y);
    expect(json(await get(a, '/api/summary?granularity=')).summary.total).toBe(json(await get(a, '/api/summary')).summary.total);
  });

  it('路由错误：未知 API 404、方法不对 405 带 Allow、OPTIONS 405、末尾斜杠 404、错误体统一', async () => {
    assertErrorShape(await get(a, '/api/nope'), 404, '/api/nope');
    assertErrorShape(await get(a, '/api/summary/'), 404, '/api/summary/');
    assertErrorShape(await get(a, '/api'), 404, '/api');
    const m = await raw(a.port, { method: 'DELETE', path: '/api/summary', headers: { Host: hostOf(a) } });
    assertErrorShape(m, 405, 'DELETE');
    expect(m.headers.allow).toMatch(/GET/);
    const post = await raw(a.port, { method: 'POST', path: '/api/summary', headers: { Host: hostOf(a) } });
    assertErrorShape(post, 405, 'POST summary');
    const opt = await raw(a.port, { method: 'OPTIONS', path: '/api/settings', headers: { Host: hostOf(a), Origin: `http://127.0.0.1:${a.port}`, 'Access-Control-Request-Method': 'PUT' } });
    expect(opt.status).toBe(405);
    expect(Object.keys(opt.headers).filter((k) => k.startsWith('access-control'))).toEqual([]);
    for (const p of ['/api/projects', '/api/status', '/api/summary']) expect((await raw(a.port, { method: 'POST', path: p, headers: { Host: hostOf(a) } })).status).toBe(p === '/api/status' ? 405 : 405);
  });

  it('请求行畸形：绝对 URI / // 开头 / 非 / 开头 / 超长 URL / 非 ASCII 路径 → 4xx；服务不崩', async () => {
    const h = hostOf(a);
    const outs = await Promise.all([
      rawSocket(a.port, `GET http://evil.example/api/status HTTP/1.1\r\nHost: ${h}\r\n\r\n`),
      rawSocket(a.port, `GET //evil.example/x HTTP/1.1\r\nHost: ${h}\r\n\r\n`),
      rawSocket(a.port, `GET * HTTP/1.1\r\nHost: ${h}\r\n\r\n`),
      rawSocket(a.port, `GET /${'a'.repeat(70000)} HTTP/1.1\r\nHost: ${h}\r\n\r\n`),
      rawSocket(a.port, `GET /%E4%B8%AD%E6%96%87 HTTP/1.1\r\nHost: ${h}\r\nConnection: close\r\n\r\n`),
      rawSocket(a.port, `NOT-HTTP\r\n\r\n`),
    ]);
    for (const [i, o] of outs.entries()) {
      const m = /^HTTP\/1\.[01] (\d{3})/.exec(o);
      if (m) expect(Number(m[1]), `case ${i}`).toBeLessThan(500);
    }
    expect((await get(a, '/api/status')).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 3. 安全
// ---------------------------------------------------------------------------
describe('安全：Host / Origin / CORS / CSP', () => {
  let w: World;
  let a: App;
  beforeAll(async () => {
    w = newWorld();
    a = await start(w);
  });

  it('server.address() 仅为 127.0.0.1（IPv4 回环）；经本机其它 IPv4 地址连不上', async () => {
    const addr = a.server.address() as net.AddressInfo;
    expect(addr.address).toBe('127.0.0.1');
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list ?? []) {
        if (ni.family !== 'IPv4' || ni.address.startsWith('127.')) continue;
        const ok = await new Promise<boolean>((resolve) => {
          const s = net.connect({ host: ni.address, port: a.port });
          s.setTimeout(1500, () => {
            s.destroy();
            resolve(false);
          });
          s.on('connect', () => {
            s.destroy();
            resolve(true);
          });
          s.on('error', () => resolve(false));
        });
        expect(ok, `经 ${ni.address} 不应可连`).toBe(false);
      }
    }
    // IPv6 回环也不应可连
    const v6 = await new Promise<boolean>((resolve) => {
      const s = net.connect({ host: '::1', port: a.port });
      s.setTimeout(1500, () => { s.destroy(); resolve(false); });
      s.on('connect', () => { s.destroy(); resolve(true); });
      s.on('error', () => resolve(false));
    });
    expect(v6).toBe(false);
  });

  it('Host 校验（DNS rebinding）：非 127.0.0.1/localhost:<port> 的 Host 一律 403，含各种变形', async () => {
    const p = a.port;
    const badHosts = [
      'evil.example', `evil.example:${p}`, '127.0.0.1', 'localhost', `127.0.0.1:${p + 1}`, `127.0.0.1.evil.com:${p}`, `evil.com#127.0.0.1:${p}`,
      `127.0.0.1:${p}.evil.com`, `[::1]:${p}`, `0.0.0.0:${p}`, `127.0.0.2:${p}`, `localhost.:${p}`, `localhost:${p}@evil.com`, `user@127.0.0.1:${p}`, ` 127.0.0.1:${p}x`, `LOCALHOST.evil.com:${p}`, `2130706433:${p}`, `0x7f.0.0.1:${p}`,
    ];
    for (const h of badHosts) {
      const r = await raw(p, { path: '/api/status', headers: { Host: h } });
      expect(r.status, `Host: ${h}`).toBe(403);
      assertErrorShape(r, 403, `Host ${h}`);
    }
    for (const h of [`127.0.0.1:${p}`, `localhost:${p}`, `LocalHost:${p}`]) expect((await raw(p, { path: '/api/status', headers: { Host: h } })).status, h).toBe(200);
    // 缺失 Host（HTTP/1.0）
    const out = await rawSocket(p, 'GET /api/status HTTP/1.0\r\n\r\n');
    expect(out).toMatch(/^HTTP\/1\.[01] 403/);
    // 重复 Host 头
    const dup = await rawSocket(p, `GET /api/status HTTP/1.1\r\nHost: evil.example\r\nHost: 127.0.0.1:${p}\r\nConnection: close\r\n\r\n`);
    expect(dup).toMatch(/^HTTP\/1\.[01] (400|403)/); // 先出现的 Host 为准
    // X-Forwarded-Host 不能绕过
    expect((await raw(p, { path: '/api/status', headers: { Host: 'evil.example', 'X-Forwarded-Host': `127.0.0.1:${p}` } })).status).toBe(403);
    // 静态页同样受保护
    expect((await raw(p, { path: '/', headers: { Host: 'evil.example' } })).status).toBe(403);
    // SSE 也受保护（不应建立流）
    const ev = await raw(p, { path: '/api/events', headers: { Host: 'evil.example' } });
    expect(ev.status).toBe(403);
  });

  it('Origin / Sec-Fetch-Site 校验：所有方法（GET/POST/PUT/SSE）对非同源 Origin 返回 403；同源放行；设置未被改动', async () => {
    const p = a.port;
    const origins = ['http://evil.example', 'null', `http://127.0.0.1.evil.com:${p}`, `https://127.0.0.1:${p}`, `http://127.0.0.1:${p + 1}`, `http://localhost`, `http://[::1]:${p}`, `http://127.0.0.1:${p}/`, '', 'file://'];
    const before = json(await get(a, '/api/settings')).settings;
    for (const o of origins) {
      for (const [method, url] of [['GET', '/api/status'], ['GET', '/api/events'], ['POST', '/api/refresh'], ['POST', '/api/rebuild']] as const) {
        const r = await raw(p, { method, path: url, headers: { Host: hostOf(a), Origin: o } });
        expect(r.status, `${method} ${url} Origin=${o}`).toBe(403);
      }
      const r = await put(a, { theme: 'dark' }, { Origin: o });
      expect(r.status, `PUT Origin=${o}`).toBe(403);
    }
    expect(json(await get(a, '/api/settings')).settings).toEqual(before);
    expect((await raw(p, { path: '/api/status', headers: { Host: hostOf(a), 'Sec-Fetch-Site': 'cross-site' } })).status).toBe(403);
    expect((await raw(p, { path: '/api/status', headers: { Host: hostOf(a), 'Sec-Fetch-Site': 'same-origin', Origin: `http://127.0.0.1:${p}` } })).status).toBe(200);
    expect((await put(a, { theme: 'light' }, { Origin: `http://localhost:${p}` })).status).toBe(200);
    expect((await put(a, { theme: 'system' })).status).toBe(200);
  });

  it('CSRF：PUT 非 JSON 内容类型（表单 / text/plain）被 415，设置不变；JSON 但带 charset 放行', async () => {
    const before = json(await get(a, '/api/settings')).settings;
    for (const ct of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/jsonx', 'text/json', '']) {
      const r = await put(a, '{"theme":"dark"}', ct === '' ? { 'Content-Type': '' } : { 'Content-Type': ct });
      expect(r.status, `CT=${ct}`).toBe(415);
      assertErrorShape(r, 415, `CT=${ct}`);
    }
    expect(json(await get(a, '/api/settings')).settings).toEqual(before);
    expect((await put(a, { theme: 'light' }, { 'Content-Type': 'application/json; charset=utf-8' })).status).toBe(200);
    expect((await put(a, { theme: 'system' })).status).toBe(200);
  });

  it('响应头：任意响应都不带 CORS 头；都带 CSP / nosniff / X-Frame-Options / Referrer-Policy；JSON no-store', async () => {
    const urls = ['/api/status', '/api/summary', '/api/projects', '/api/settings', '/api/nope', '/api/summary?x=1', '/', '/index.html', '/some/page', '/missing.js'];
    for (const u of urls) {
      const r = await get(a, u, { Origin: `http://127.0.0.1:${a.port}` });
      for (const k of Object.keys(r.headers)) expect(k.startsWith('access-control-'), `${u} ${k}`).toBe(false);
      expect(r.headers['content-security-policy'], u).toMatch(/default-src 'self'/);
      expect(r.headers['content-security-policy'], u).toMatch(/frame-ancestors 'none'/);
      expect(r.headers['content-security-policy'], u).not.toMatch(/https?:|\*|unsafe-eval/);
      expect(r.headers['x-content-type-options'], u).toBe('nosniff');
      expect(r.headers['x-frame-options'], u).toBe('DENY');
      expect(r.headers['referrer-policy'], u).toBe('no-referrer');
      if (u.startsWith('/api/')) expect(r.headers['cache-control'], u).toBe('no-store');
    }
    // SSE 响应头
    const sse = await new Promise<http.IncomingMessage>((resolve) => {
      const rq = http.request({ host: '127.0.0.1', port: a.port, path: '/api/events', headers: { Host: hostOf(a) } }, (res) => {
        resolve(res);
        res.destroy();
      });
      rq.end();
    });
    expect(sse.headers['content-type']).toMatch(/text\/event-stream/);
    expect(sse.headers['content-security-policy']).toBeTruthy();
    expect(Object.keys(sse.headers).some((k) => k.startsWith('access-control-'))).toBe(false);
  });

  it('请求体：超过 64KB → 413；空体/非法 JSON → 400；数组/字符串/null → 400；__proto__ 污染无效', async () => {
    assertErrorShape(await put(a, 'x'.repeat(70_000)), 413, 'big');
    assertErrorShape(await put(a, ''), 400, 'empty');
    assertErrorShape(await put(a, '{bad'), 400, 'badjson');
    for (const b of ['[]', '"str"', 'null', '42']) assertErrorShape(await put(a, b), 400, `body ${b}`);
    const r = await put(a, '{"__proto__":{"polluted":true}}');
    expect(r.status).toBe(400);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const r2 = await put(a, '{"constructor":{"prototype":{"x":1}}}');
    expect(r2.status).toBe(400);
    expect((await get(a, '/api/status')).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 4. 静态托管与路径穿越
// ---------------------------------------------------------------------------
describe('静态托管路径穿越', () => {
  let w: World;
  let a: App;
  let web: string;
  const SECRET = 'TOP_SECRET_OUTSIDE_WEBDIR';
  beforeAll(async () => {
    w = newWorld();
    web = path.join(w.base, 'webroot', 'dist');
    fs.mkdirSync(path.join(web, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(web, 'index.html'), '<!doctype html><title>idx</title>INDEX_MARK');
    fs.writeFileSync(path.join(web, 'assets', 'app-abc.js'), 'console.log(1)');
    fs.writeFileSync(path.join(web, '.hidden'), 'HIDDEN_MARK');
    fs.writeFileSync(path.join(w.base, 'webroot', 'secret.txt'), SECRET);
    fs.writeFileSync(path.join(w.base, 'secret.txt'), SECRET);
    fs.mkdirSync(path.join(w.base, 'outside'), { recursive: true });
    fs.writeFileSync(path.join(w.base, 'outside', 'leak.txt'), SECRET);
    try {
      fs.symlinkSync(path.join(w.base, 'outside'), path.join(web, 'linkdir'), 'junction');
    } catch {
      /* 环境不支持则跳过 junction 用例 */
    }
    a = await start(w, { webDir: web });
  });

  it('正常资源：index / assets（immutable）/ SPA 回退 / 缺失资源 404', async () => {
    const r = await get(a, '/');
    expect([r.status, r.body.includes('INDEX_MARK')]).toEqual([200, true]);
    expect(r.headers['cache-control']).toBe('no-cache');
    const js = await get(a, '/assets/app-abc.js');
    expect(js.status).toBe(200);
    expect(js.headers['cache-control']).toMatch(/immutable/);
    expect(js.headers['content-type']).toMatch(/javascript/);
    expect((await get(a, '/analysis/sessions')).body).toContain('INDEX_MARK');
    expect((await get(a, '/assets/missing.js')).status).toBe(404);
    const et = js.headers.etag!;
    expect((await get(a, '/assets/app-abc.js', { 'If-None-Match': et })).status).toBe(304);
  });

  it('穿越 / 编码 / 反斜杠 / 盘符 / 点文件 / 设备名 / ADS：全部 ≥400 或回退页，且绝不泄漏外部文件与点文件内容', async () => {
    const paths = [
      '/../secret.txt', '/..%2fsecret.txt', '/%2e%2e/secret.txt', '/%2e%2e%2fsecret.txt', '/%2E%2E/%2E%2E/secret.txt', '/..%5csecret.txt', '/%5c..%5csecret.txt',
      '/..\\secret.txt', '/assets/../../secret.txt', '/assets/..%2f..%2fsecret.txt', '/assets/%252e%252e/secret.txt', '/....//secret.txt', '/.%2e/secret.txt',
      '/%c0%ae%c0%ae/secret.txt', '/..%c0%afsecret.txt', '/..;/secret.txt', '/./../secret.txt', '/index.html/../../secret.txt',
      '/C:/Windows/win.ini', '/C%3a/Windows/win.ini', '/c:\\windows\\win.ini', `/${path.join(w.base, 'secret.txt').replaceAll('\\', '/')}`, `/${encodeURIComponent(path.join(w.base, 'secret.txt'))}`,
      '/.hidden', '/%2ehidden', '/assets/.hidden', '/index.html::$DATA', '/index.html%00.png', '/%00', '/nul', '/con', '/aux.txt', '/COM1', '/prn.html', '/index.html.', '/index.html ', '/INDEX.HTML',
      '/linkdir/leak.txt', '/linkdir', '/linkdir/', '/linkdir%2fleak.txt', '/LINKDIR/leak.txt',
    ];
    for (const p of paths) {
      const r = await Promise.race([getRaw(a, p), new Promise<Resp>((_, rej) => setTimeout(() => rej(new Error('超时 ' + p)), 5000))]);
      expect(r.status, p).toBeLessThan(500);
      expect(r.body, p).not.toContain(SECRET);
      expect(r.body, p).not.toContain('HIDDEN_MARK');
      expect(r.body, p).not.toContain('[fonts]'); // win.ini 内容
    }
    // 明确应被拒的几个：状态必须是 4xx（不是 200 回退页）
    for (const p of ['/..%2fsecret.txt', '/%2e%2e/secret.txt', '/..\\secret.txt', '/C:/Windows/win.ini', '/.hidden', '/assets/.hidden', '/linkdir/leak.txt']) {
      const r = await getRaw(a, p);
      expect(r.status, p).toBeGreaterThanOrEqual(400);
      expect(r.status, p).toBeLessThan(500);
    }
  });

  it('web/dist 不存在：导航请求返回中文提示页（含 npm run build、无外链），资源 404，API 照常', async () => {
    const w2 = newWorld();
    const b = await start(w2, { webDir: path.join(w2.base, 'nonexistent-dist') });
    const r = await get(b, '/');
    expect(r.status).toBe(200);
    expect(r.body).toContain('npm run build');
    expect(r.body).not.toMatch(/https?:\/\//);
    expect((await get(b, '/x.js')).status).toBe(404);
    expect((await get(b, '/api/status')).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 5. 设置
// ---------------------------------------------------------------------------
describe('设置存储', () => {
  it('默认值；部分更新；非法值整体不生效；重启后保留；文件只在应用数据目录；数据根快照不变', async () => {
    const w = newWorld();
    const rootBefore = JSON.stringify(snapshotDir(w.root));
    let a = await start(w);
    const d = json(await get(a, '/api/settings'));
    expect(d.settings).toEqual({ dataRoot: null, timezone: 'system', weekStart: 'monday', defaultBasis: 'total', autoRefresh: { enabled: true, intervalSec: 5 }, theme: 'system', language: 'zh', groupScratch: true, budget: { daily: null, monthly: null }, subscription: { plan: null, monthlyFeeUsd: null, billingDay: null, feeCurrency: 'USD', cnyPerUsd: 7.2 }, onboarded: false });
    expect((await put(a, { timezone: 'Asia/Shanghai', weekStart: 'sunday', defaultBasis: 'fresh', theme: 'dark', language: 'en', autoRefresh: { intervalSec: 9 }, budget: { daily: 12.5 } })).status).toBe(200);
    const s1 = json(await get(a, '/api/settings')).settings;
    expect(s1).toMatchObject({ timezone: 'Asia/Shanghai', weekStart: 'sunday', defaultBasis: 'fresh', theme: 'dark', language: 'en', autoRefresh: { enabled: true, intervalSec: 9 }, budget: { daily: 12.5, monthly: null } });
    // 非法值（一项非法，整体不生效）
    const badBodies: unknown[] = [
      { theme: 'purple' }, { language: 'fr' }, { weekStart: 'friday' }, { defaultBasis: 'x' }, { timezone: 'Mars/X' }, { timezone: 5 }, { groupScratch: 'yes' },
      { autoRefresh: { intervalSec: 1 } }, { autoRefresh: { intervalSec: 61 } }, { autoRefresh: { intervalSec: 2.5 } }, { autoRefresh: { enabled: 'on' } }, { autoRefresh: 5 }, { autoRefresh: { foo: 1 } },
      { budget: { daily: -1 } }, { budget: { monthly: 'a' } }, { budget: { daily: 1e20 } }, { budget: { x: 1 } }, { unknownKey: 1 }, { dataRoot: 'relative/path' }, { dataRoot: 5 },
      { theme: 'light', language: 'fr' }, // 一好一坏
    ];
    for (const b of badBodies) {
      const r = await put(a, b);
      assertErrorShape(r, 400, JSON.stringify(b));
      expect(json(r).error.code).toBe('INVALID_SETTING');
    }
    expect(json(await get(a, '/api/settings')).settings).toEqual(s1);
    // 设置文件位置
    expect(fs.existsSync(path.join(w.app, 'settings.json'))).toBe(true);
    expect(fs.readdirSync(w.root).some((n) => /settings/i.test(n))).toBe(false);
    expect(JSON.stringify(snapshotDir(w.root))).toBe(rootBefore);
    expect(fs.readdirSync(w.app).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    // 重启保留
    await a.close();
    a = await start(w);
    expect(json(await get(a, '/api/settings')).settings).toEqual(s1);
    // 设置真的生效：tz/默认口径影响 projects 与 summary
    expect(json(await get(a, '/api/projects')).tz).toBe('Asia/Shanghai');
    expect(json(await get(a, '/api/projects')).basis).toBe('fresh');
    expect(json(await get(a, '/api/summary')).query).toMatchObject({ tz: 'Asia/Shanghai', weekStart: 'sunday', basis: 'fresh' });
    expect(json(await get(a, '/api/summary?basis=total')).query.basis).toBe('total'); // 查询参数覆盖设置
  });

  it('设置文件损坏 / 部分非法：回退默认并给 warnings，不崩溃；其余字段保留', async () => {
    const w = newWorld();
    fs.mkdirSync(w.app, { recursive: true });
    fs.writeFileSync(path.join(w.app, 'settings.json'), '{{{ not json');
    let a = await start(w);
    let s = json(await get(a, '/api/settings'));
    expect(s.settings.theme).toBe('system');
    expect(s.warnings.length).toBeGreaterThan(0);
    await a.close();
    fs.writeFileSync(path.join(w.app, 'settings.json'), JSON.stringify({ schema: 1, settings: { theme: 'dark', language: 'xx', timezone: 'Nope', budget: { daily: 3 }, extra: 1 } }));
    a = await start(w);
    s = json(await get(a, '/api/settings'));
    expect(s.settings).toMatchObject({ theme: 'dark', language: 'zh', timezone: 'system', budget: { daily: 3, monthly: null } });
    expect(s.warnings.length).toBeGreaterThanOrEqual(2);
  });

  it('dataRoot：不存在 / 是文件 / 相对路径被拒且当前数据不变；有效目录触发重扫；改回 null 恢复', async () => {
    const w = newWorld();
    const a = await start(w);
    const n0 = json(await get(a, '/api/summary')).summary.requests;
    const missing = path.join(w.base, 'nope');
    const r1 = await put(a, { dataRoot: missing });
    assertErrorShape({ ...r1, body: r1.body.replaceAll(missing, '<p>').replaceAll(missing.replaceAll('\\', '\\\\'), '<p>') }, 400, 'dataRoot missing');
    const file = path.join(w.base, 'afile.txt');
    fs.writeFileSync(file, 'x');
    expect((await put(a, { dataRoot: file })).status).toBe(400);
    expect(json(await get(a, '/api/summary')).summary.requests).toBe(n0);
    const other = path.join(w.base, 'other-root');
    fs.mkdirSync(path.join(other, 'Q'), { recursive: true });
    fs.writeFileSync(path.join(other, 'Q', 's.jsonl'), JSON.stringify({ type: 'assistant', timestamp: '2026-10-10T00:00:00Z', message: { id: 'q1', model: 'claude-x', usage: { input_tokens: 7, output_tokens: 3 } } }) + '\n');
    expect((await put(a, { dataRoot: other })).status).toBe(200);
    await a.store.idle();
    expect(json(await get(a, '/api/summary')).summary.total).toBe(10);
    expect(json(await get(a, '/api/projects')).projects.map((p: any) => p.id)).toEqual(['Q']);
    expect((await put(a, { dataRoot: null })).status).toBe(200);
    await a.store.idle();
    expect(json(await get(a, '/api/summary')).summary.requests).toBe(n0);
  });

  it('应用数据目录被误配进数据根：保存设置被拒（500 WRITE_REFUSED，不泄漏路径），数据根不被写入；API 读取照常', async () => {
    const w = newWorld();
    const before = JSON.stringify(snapshotDir(w.root));
    const a = await start(w, {});
    await a.close();
    const w2 = { ...w, app: path.join(w.root, 'appdata-inside') };
    const b = await start(w2);
    const r = await put(b, { theme: 'dark' });
    expect(r.status).toBe(500);
    expect(json(r).error.code).toBe('WRITE_REFUSED');
    for (const re of LEAK_PATTERNS) expect(r.body).not.toMatch(re);
    expect(json(await get(b, '/api/settings')).settings.theme).toBe('system');
    expect((await get(b, '/api/summary')).status).toBe(200);
    expect(JSON.stringify(snapshotDir(w.root))).toBe(before);
    expect(fs.existsSync(w2.app)).toBe(false);
  });

  // 回归：缺陷 1（第 1 轮发现，已修复）。
  it('PUT dataRoot 为包含应用数据目录的目录时应被拒绝（400），而不是接受后锁死设置', async () => {
    const w = newWorld();
    const a = await start(w);
    const r = await put(a, { dataRoot: w.base });
    expect(r.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// 6. 不泄漏对话正文
// ---------------------------------------------------------------------------
describe('API 响应不含对话正文', () => {
  it('植入标记的数据：所有端点（含 SSE 原始流、静态页、错误页）都不含 SECRET / 用户正文 / 标题', async () => {
    const w = newWorld();
    // 额外植入：custom-title 带标记、user 正文、tool_use.input
    fs.mkdirSync(path.join(w.root, 'D--Work-alpha', 'a1a1a1a1-0000-4000-8000-000000000002'), { recursive: true });
    fs.writeFileSync(path.join(w.root, 'D--Work-alpha', 'a1a1a1a1-0000-4000-8000-000000000002', 'custom-title.json'), JSON.stringify({ customTitle: 'SECRET_BODY_MARKER 标题' }));
    const a = await start(w);
    await a.store.refreshNow();
    const urls = [
      '/api/status', '/api/projects', '/api/projects?sort=name', '/api/projects?sort=recent&q=a', '/api/summary', '/api/summary?range=custom&from=2026-10-01&to=2026-10-31',
      '/api/timeseries', '/api/timeseries?split=model', '/api/timeseries?split=project&granularity=hour', '/api/timeseries?split=tokenType', '/api/settings', '/', '/api/bogus', '/api/summary?x=SECRET_BODY_MARKER',
    ];
    const bad = ['SECRET_BODY_MARKER', 'SECRET', 'Please refactor', 'reply text', 'echo ', 'prefix body', 'thinking about', 'this tail must never', '标题', 'Refactor the parser'];
    for (const u of urls) {
      const r = await get(a, u);
      for (const b of bad) if (u.includes('SECRET') && b.startsWith('SECRET')) continue; else expect(r.body, `${u} 含 ${b}`).not.toContain(b);
    }
    for (const m of ['refresh', 'rebuild']) {
      const r = await raw(a.port, { method: 'POST', path: `/api/${m}`, headers: { Host: hostOf(a) } });
      for (const b of bad) expect(r.body, `POST ${m} 含 ${b}`).not.toContain(b);
    }
    // SSE 原始流（含初始快照 + 一次数据更新事件）
    const stream = await new Promise<string>((resolve) => {
      let buf = '';
      const rq = http.request({ host: '127.0.0.1', port: a.port, path: '/api/events', headers: { Host: hostOf(a) } }, (res) => {
        res.on('data', (c: Buffer) => (buf += c.toString('utf8')));
      });
      rq.end();
      setTimeout(() => {
        void a.store.rebuild();
      }, 100);
      setTimeout(() => {
        rq.destroy();
        resolve(buf);
      }, 1500);
    });
    expect(stream).toMatch(/event: status/);
    for (const b of bad) expect(stream, `SSE 含 ${b}`).not.toContain(b);
  });
});

// ---------------------------------------------------------------------------
// 7. SSE
// ---------------------------------------------------------------------------
interface SseEvent {
  event: string;
  data: any;
  at: number;
}
function openSse(a: App, headers: Record<string, string> = {}): { events: SseEvent[]; raw: () => string; close: () => void; res: Promise<http.IncomingMessage> } {
  const events: SseEvent[] = [];
  let buf = '';
  let all = '';
  const t0 = Date.now();
  const closeFns: Array<() => void> = [];
  const res = new Promise<http.IncomingMessage>((resolve) => {
    const rq = http.request({ host: '127.0.0.1', port: a.port, path: '/api/events', headers: { Host: hostOf(a), ...headers } }, (r) => {
      r.on('data', (c: Buffer) => {
        const t = c.toString('utf8');
        buf += t;
        all += t;
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (ev && data) events.push({ event: ev, data: JSON.parse(data), at: Date.now() - t0 });
        }
      });
      resolve(r);
    });
    rq.end();
    closeFns.push(() => rq.destroy());
  });
  return { events, raw: () => all, close: () => closeFns.forEach((f) => f()), res };
}

describe('SSE', () => {
  it('连接：头、retry、初始 status + dataVersion 事件；心跳；断开重连得到完整快照', async () => {
    const w = newWorld();
    const a = await start(w);
    const c1 = openSse(a);
    const res = await c1.res;
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(res.headers['cache-control']).toMatch(/no-store/);
    await new Promise((r) => setTimeout(r, 900));
    expect(c1.raw()).toMatch(/^retry: 2000/);
    expect(c1.raw()).toContain(': ping'); // 心跳（测试里 300ms）
    const first = c1.events.find((e) => e.event === 'status')!;
    expect(first.data.dataVersion).toBe(a.store.getView().dataVersion);
    expect(c1.events.find((e) => e.event === 'dataVersion')!.data.dataVersion).toBe(a.store.getView().dataVersion);
    expect(a.sse.size).toBe(1);
    c1.close();
    await new Promise((r) => setTimeout(r, 300));
    expect(a.sse.size).toBe(0); // 断开后被清理
    const c2 = openSse(a, { 'Last-Event-ID': '999' });
    await c2.res;
    await new Promise((r) => setTimeout(r, 300));
    expect(c2.events.map((e) => e.event)).toEqual(expect.arrayContaining(['status', 'dataVersion']));
    c2.close();
    // 客户端数量上限：第 101 个连接 503
    const many = Array.from({ length: 100 }, () => openSse(a));
    await Promise.all(many.map((m) => m.res));
    const over = await get(a, '/api/events');
    expect(over.status).toBe(503);
    assertErrorShape(over, 503, 'sse full');
    many.forEach((m) => m.close());
  });

  it('运行中追加数据：≤ 轮询间隔 + 1s 内收到 dataVersion 事件，summary 数字随之精确更新（轮询 2s）', async () => {
    const w = newWorld();
    const a = await start(w, { watcher: { intervalMs: 2000 } });
    const before = json(await get(a, '/api/summary')).summary;
    const c = openSse(a);
    await c.res;
    await new Promise((r) => setTimeout(r, 300));
    const v0 = c.events.filter((e) => e.event === 'dataVersion').pop()!.data.dataVersion as number;
    const tAppend = Date.now();
    fs.appendFileSync(path.join(w.root, 'D--Work-beta', 'bbbbbbbb-0000-4000-8000-000000000001.jsonl'), JSON.stringify({ type: 'assistant', timestamp: '2026-10-19T10:00:00Z', sessionId: 'bbbbbbbb-0000-4000-8000-000000000001', message: { id: 'sse_new', model: 'claude-sonnet-5', usage: { input_tokens: 11, output_tokens: 22, cache_read_input_tokens: 33, cache_creation_input_tokens: 44 } } }) + '\n');
    let ev: SseEvent | undefined;
    while (Date.now() - tAppend < 10_000 && !(ev = c.events.find((e) => e.event === 'dataVersion' && e.data.dataVersion > v0))) await new Promise((r) => setTimeout(r, 50));
    const latency = Date.now() - tAppend;
    c.close();
    expect(ev, '10 秒内应收到 dataVersion 事件').toBeTruthy();
    expect(latency).toBeLessThanOrEqual(3200); // 轮询 2s + 1s 容差
    const after = json(await get(a, '/api/summary')).summary;
    expect(after.requests).toBe(before.requests + 1);
    expect(after.total).toBe(before.total + 11 + 44 + 33 + 22);
    expect(after.cacheRead).toBe(before.cacheRead + 33);
    expect(after.input).toBe(before.input + 11);
  });

  it('status 事件携带扫描进度（scanning → idle）与 usageState；POST /api/rebuild 202 立即返回', async () => {
    const w = newWorld();
    const a = await start(w);
    const c = openSse(a);
    await c.res;
    const r = await raw(a.port, { method: 'POST', path: '/api/rebuild', headers: { Host: hostOf(a) } });
    expect(r.status).toBe(202);
    expect(json(r).accepted).toBe(true);
    await a.store.idle();
    await new Promise((x) => setTimeout(x, 400));
    const sts = c.events.filter((e) => e.event === 'status').map((e) => e.data);
    expect(sts.some((s: any) => s.state === 'scanning' && s.usageState === 'scanning')).toBe(true);
    expect(sts[sts.length - 1].state).toBe('idle');
    const vs = c.events.filter((e) => e.event === 'dataVersion').map((e) => e.data.dataVersion as number);
    for (let i = 1; i < vs.length; i++) expect(vs[i]).toBeGreaterThan(vs[i - 1]!);
    c.close();
  });

  it('设置修改通过 SSE 广播 settings 事件；服务关闭时连接被结束', async () => {
    const w = newWorld();
    const a = await start(w);
    const c = openSse(a);
    const res = await c.res;
    const ended = new Promise<void>((resolve) => res.on('close', () => resolve()));
    await put(a, { theme: 'dark' });
    await new Promise((x) => setTimeout(x, 300));
    expect(c.events.some((e) => e.event === 'settings')).toBe(true);
    await a.close();
    await Promise.race([ended, new Promise((_, rej) => setTimeout(() => rej(new Error('SSE 连接未随服务关闭而结束')), 4000))]);
  });
});

// ---------------------------------------------------------------------------
// 8. 性能（fixture；真实数据见报告中的独立脚本）与并发
// ---------------------------------------------------------------------------
describe('并发与缓存', () => {
  it('同一查询的缓存命中结果与未命中完全一致；数据变化后缓存失效；设置修改后缓存失效', async () => {
    const w = newWorld();
    const a = await start(w);
    const u = '/api/timeseries?tz=UTC&granularity=day&split=model';
    const r1 = (await get(a, u)).body;
    const r2 = (await get(a, u)).body;
    expect(r2).toBe(r1);
    expect((await get(a, '/api/timeseries?split=model&granularity=day&tz=UTC')).body).toBe(r1); // 参数顺序无关
    fs.appendFileSync(path.join(w.root, 'D--Work-beta', 'bbbbbbbb-0000-4000-8000-000000000001.jsonl'), JSON.stringify({ type: 'assistant', timestamp: '2026-10-19T10:00:00Z', message: { id: 'c1', model: 'claude-sonnet-5', usage: { input_tokens: 5, output_tokens: 5 } } }) + '\n');
    await raw(a.port, { method: 'POST', path: '/api/refresh', headers: { Host: hostOf(a) } });
    const r3 = (await get(a, u)).body;
    expect(r3).not.toBe(r1);
    expect(json({ ...({} as Resp), body: r3, status: 200, headers: {} }).summary.total - json({ ...({} as Resp), body: r1, status: 200, headers: {} }).summary.total).toBe(10);
    await put(a, { weekStart: 'sunday' });
    expect(json(await get(a, '/api/summary')).query.weekStart).toBe('sunday');
  });

  it('200 个并发混合请求（含非法参数）全部得到正确状态码，结果互不串扰', async () => {
    const w = newWorld();
    const a = await start(w);
    const ref = (await get(a, '/api/summary?tz=Asia%2FShanghai')).body;
    const jobs: Array<Promise<[string, number, string]>> = [];
    for (let i = 0; i < 200; i++) {
      const kind = i % 4;
      const u = kind === 0 ? '/api/summary?tz=Asia%2FShanghai' : kind === 1 ? '/api/summary?tz=Nope' : kind === 2 ? `/api/timeseries?granularity=${['hour', 'day', 'week', 'month'][i % 16 >> 2]}` : '/api/projects';
      jobs.push(get(a, u).then((r) => [u, r.status, r.body]));
    }
    for (const [u, s, body] of await Promise.all(jobs)) {
      if (u.includes('Nope')) expect(s).toBe(400);
      else expect(s, u).toBe(200);
      if (u === '/api/summary?tz=Asia%2FShanghai') expect(body).toBe(ref);
    }
  });
});

describe('HEAD 方法', () => {
  it('HEAD 对普通 API 返回头无体；HEAD /api/summary 与 GET 的头一致', async () => {
    const w = newWorld();
    const a = await start(w);
    const h = await raw(a.port, { method: 'HEAD', path: '/api/summary', headers: { Host: hostOf(a) } });
    const g = await get(a, '/api/summary');
    expect([h.status, h.body]).toEqual([200, '']);
    expect(h.headers['content-length']).toBe(g.headers['content-length']);
  });

  // 回归：缺陷 3（第 1 轮发现，已修复）。
  it('HEAD /api/events 应在 2 秒内得到明确响应，而不是挂起', async () => {
    const w = newWorld();
    const a = await start(w);
    const out = await new Promise<string>((resolve) => {
      const s = net.connect({ port: a.port, host: '127.0.0.1' });
      let buf = '';
      s.on('data', (d) => (buf += d.toString()));
      setTimeout(() => {
        s.destroy();
        resolve(buf);
      }, 2000);
      s.write(`HEAD /api/events HTTP/1.1\r\nHost: ${hostOf(a)}\r\n\r\n`);
    });
    expect(out).toMatch(/^HTTP\/1\.1 \d{3}/);
  });
});

describe('SSE dataVersion 事件语义', () => {
  // 回归：缺陷 2（第 1 轮发现，已修复）。
  it('数据没有变化时，连接建立后不应再收到与初始快照相同版本号的 dataVersion 事件', async () => {
    const w = newWorld();
    const a = await start(w, { watcher: { intervalMs: 2000 } });
    const c = openSse(a);
    await c.res;
    await new Promise((r) => setTimeout(r, 3200)); // 跨过至少一次轮询
    c.close();
    const dv = c.events.filter((e) => e.event === 'dataVersion').map((e) => e.data.dataVersion);
    expect(dv.length).toBe(1); // 只有初始快照里的那一条
  });
});

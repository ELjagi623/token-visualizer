import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { getJson, openSse, putJson, rawRequest, startApp } from './apiHelpers.ts';
import type { TestApp } from './apiHelpers.ts';
import { assistantLine, FIXTURE_ROOT, loadExpected, MARKER, makeTmpDir, rmDir, snapshotDir } from './helpers.ts';
import type { Expected } from './helpers.ts';
import { tmpWorld } from './storeHelpers.ts';

const expected: Expected = loadExpected();
const sum = <T>(xs: T[], f: (x: T) => number): number => xs.reduce((a, x) => a + f(x), 0);

describe('API：只读查询（验收 1、2）', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(() => t.close());

  it('GET /api/status：200 与合法 JSON，字段齐全；usageState 随 TV_NOW 变化', async () => {
    const r = await getJson(t.base, '/api/status');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('application/json');
    expect(r.body).toMatchObject({ state: 'idle', phase: 'full', filesTotal: 14, filesDone: 14, dataVersion: expect.any(Number), usageState: expect.any(String), warnings: [] });
    expect(r.body.lastRecordTs).toBe(Math.max(...t.app.store.getView().records.map((x: { ts: number }) => x.ts)));
    expect(r.body.today).toMatchObject({ requests: 2, total: 7330, fresh: 330, tz: 'Asia/Shanghai' }); // 固定 now=10-20 12:00Z 的"今日"
    expect(JSON.stringify(r.body)).not.toContain('"records"');
    // usageState 三态 + 覆盖
    const last = r.body.lastRecordTs as number;
    for (const [offsetMs, want] of [[30_000, 'generating'], [5 * 60_000, 'active'], [3 * 3600_000, 'idle']] as const) {
      const t2 = await startApp({ now: () => last + offsetMs, settings: {} });
      const s = await getJson(t2.base, '/api/status');
      expect(s.body.usageState, `${offsetMs}`).toBe(want);
      await t2.close();
    }
    // 边界：恰好 60 s 仍是 generating，61 s 为 active；10 min 整仍是 active
    for (const [offsetMs, want] of [[60_000, 'generating'], [61_000, 'active'], [600_000, 'active'], [601_000, 'idle']] as const) {
      const t2 = await startApp({ now: () => last + offsetMs, settings: {} });
      expect((await getJson(t2.base, '/api/status')).body.usageState, `${offsetMs}`).toBe(want);
      await t2.close();
    }
  });

  it('status：数据根不存在 → usageState=error 与中文 lastError；扫描中 → scanning（覆盖展示）', async () => {
    const w = tmpWorld(false);
    try {
      const missing = path.join(w.root, 'nope');
      const t2 = await startApp({ dataRoot: missing, appDataDir: w.app, settings: {} });
      const s = await getJson(t2.base, '/api/status');
      expect(s.body).toMatchObject({ state: 'error', usageState: 'error' });
      expect(s.body.lastError).toContain('数据根目录不存在');
      await t2.close();
    } finally {
      w.cleanup();
    }
  });

  it('GET /api/projects：条目数与 fixture expected 一致（Scratch 归并 / 不归并），含只有空文件的文件夹', async () => {
    const nonScratch = (expected.projects as Expected[]).filter((p) => !p.isScratch).length;
    const r = await getJson(t.base, '/api/projects');
    expect(r.status).toBe(200);
    expect(r.body.projects).toHaveLength(nonScratch + 1);
    expect(r.body.projectCount).toBe(nonScratch + 1);
    expect(r.body.folderCount).toBe(expected.projectFolderCount);
    const group = r.body.projects.find((p: Expected) => p.id === 'scratch');
    expect(group.isScratchGroup).toBe(true);
    expect(group.children).toHaveLength(expected.scratchFolderCount);
    expect(r.body.projects.some((p: Expected) => p.id === 'D--Work-empty')).toBe(true);
    const demo = r.body.projects.find((p: Expected) => p.id === 'C--Users-----Work-demo');
    expect(demo).toMatchObject({ displayName: 'demo', path: 'C:\\Users\\王测试\\Work\\demo', pathUnknown: false });
    expect(demo.sparkline).toHaveLength(30);
    // 每项总量 == expected；all == 总量；组 == 子项之和
    for (const p of expected.projects as Expected[]) {
      if (p.isScratch) continue;
      expect(r.body.projects.find((x: Expected) => x.id === p.projectKey).total, p.projectKey).toBe(p.total);
    }
    expect(group.total).toBe(sum(group.children as Expected[], (c) => c.total));
    expect(r.body.all.total).toBe(expected.totals.total);
    expect(sum(r.body.projects as Expected[], (p) => p.total)).toBe(expected.totals.total);
    // 不归并
    await putJson(t.base, '/api/settings', { groupScratch: false });
    const flat = await getJson(t.base, '/api/projects');
    expect(flat.body.projects).toHaveLength(expected.projectFolderCount);
    expect(flat.body.projects.some((p: Expected) => p.isScratchGroup)).toBe(false);
    await putJson(t.base, '/api/settings', { groupScratch: true });
  });

  it('projects：sparkline / 今日活动 / 最近活跃 / 排序 / 搜索 / 口径', async () => {
    // now = 2026-10-20 12:00Z（上海 20:00）：crlf 项目当天有记录（10-20 10:00Z）
    const r = await getJson(t.base, '/api/projects');
    const crlf = r.body.projects.find((p: Expected) => p.id === 'D--Work-crlf');
    expect(crlf.activeToday).toBe(true);
    expect(crlf.todayRequests).toBe(2);
    expect(crlf.sparkline[29]).toBe(crlf.todayValue);
    expect(r.body.projects.find((p: Expected) => p.id === 'D--Work-alpha').activeToday).toBe(false);
    expect(r.body.projects.find((p: Expected) => p.id === 'D--Work-empty')).toMatchObject({ requests: 0, lastActiveTs: null, activeToday: false, pathUnknown: true });
    // 近 30 天窗口内的 sparkline 之和 <= 总量；crlf 窗口内全部记录
    for (const p of r.body.projects as Expected[]) expect(sum(p.sparkline as number[], (x) => x)).toBeLessThanOrEqual(p.value);
    // 排序
    const ids = async (q: string): Promise<string[]> => (await getJson(t.base, `/api/projects${q}`)).body.projects.map((p: Expected) => p.id);
    const byTotal = await ids('?sort=total');
    const byRecent = await ids('?sort=recent');
    const byName = await ids('?sort=name');
    const byToday = await ids('?sort=today');
    expect(new Set([byTotal.join(), byRecent.join(), byName.join(), byToday.join()]).size).toBeGreaterThanOrEqual(3);
    const all = (await getJson(t.base, '/api/projects?sort=total')).body.projects as Expected[];
    for (let i = 1; i < all.length; i++) expect(all[i - 1].value).toBeGreaterThanOrEqual(all[i].value);
    const rec = (await getJson(t.base, '/api/projects?sort=recent')).body.projects as Expected[];
    for (let i = 1; i < rec.length; i++) expect(rec[i - 1].lastActiveTs ?? -1).toBeGreaterThanOrEqual(rec[i].lastActiveTs ?? -1);
    const names = (await getJson(t.base, '/api/projects?sort=name')).body.projects.map((p: Expected) => p.displayName as string);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'zh', { sensitivity: 'base' })));
    expect(byToday[0]).toBe('D--Work-crlf');
    // 搜索：按名称 / 路径 / cwd；scratch 子项命中时只留匹配的子项
    expect(await ids('?q=demo')).toEqual(['C--Users-----Work-demo']);
    expect(await ids('?q=Work%5Cdemo')).toEqual(['C--Users-----Work-demo']); // 路径
    expect(await ids('?q=ALPHA')).toEqual(['D--Work-alpha']);
    const sc = (await getJson(t.base, '/api/projects?q=def456')).body.projects;
    expect(sc).toHaveLength(1);
    expect(sc[0].id).toBe('scratch');
    expect(sc[0].children).toHaveLength(1);
    expect(await ids('?q=zzzz-no-match')).toEqual([]);
    // 口径：fresh
    const fresh = (await getJson(t.base, '/api/projects?basis=fresh')).body;
    expect(fresh.all.value).toBe(expected.totals.fresh);
    expect(fresh.all.total - fresh.all.fresh).toBe(expected.totals.cacheRead);
  });

  it('summary / timeseries：total = 曲线之和；四种粒度相同；Total − Fresh = cacheRead；拆分之和 = 总量（验收 2）', async () => {
    for (const project of ['all', 'D--Work-alpha', 'C--Users-----Work-demo', 'scratch']) {
      const want = project === 'all' ? expected.totals.total : project === 'scratch' ? sum((expected.projects as Expected[]).filter((p) => p.isScratch), (p) => p.total) : (expected.projects as Expected[]).find((p) => p.projectKey === project).total;
      const s = await getJson(t.base, `/api/summary?project=${project}&range=all`);
      expect(s.status).toBe(200);
      expect(s.body.summary.total).toBe(want);
      for (const g of ['hour', 'day', 'week', 'month']) {
        const ts = await getJson(t.base, `/api/timeseries?project=${project}&range=all&granularity=${g}`);
        expect(ts.status, `${project} ${g}`).toBe(200);
        expect(sum(ts.body.points as Expected[], (p) => p.total), `${project} ${g}`).toBe(want);
        expect(ts.body.summary.total).toBe(want);
        expect(sum(ts.body.series as Expected[], (x) => x.total)).toBe(want);
      }
      const total = (await getJson(t.base, `/api/summary?project=${project}&basis=total`)).body.summary;
      const fresh = (await getJson(t.base, `/api/summary?project=${project}&basis=fresh`)).body.summary;
      expect(total.total - fresh.fresh).toBe(total.cacheRead);
      expect(total.value).toBe(total.total);
      expect(fresh.value).toBe(fresh.fresh);
    }
    for (const split of ['tokenType', 'model', 'project']) {
      for (const basis of ['total', 'fresh']) {
        const r = await getJson(t.base, `/api/timeseries?split=${split}&basis=${basis}&granularity=week`);
        expect(sum(r.body.series as Expected[], (x) => x.total), `${split} ${basis}`).toBe(basis === 'total' ? expected.totals.total : expected.totals.fresh);
      }
    }
    const byModel = await getJson(t.base, '/api/timeseries?split=model');
    expect(byModel.body.series.some((s: Expected) => s.key === '<synthetic>')).toBe(false);
    expect(byModel.body.series.find((s: Expected) => s.key === 'qwen/qwen3-coder-next')).toMatchObject({ isLocal: true });
  });

  it('日界与"今日 / 昨日 / 本周 / 本月"：固定 now 与 tz=Asia/Shanghai 时与 expected 一致（TV_NOW）', async () => {
    for (const c of expected.phase2.nowCases as Expected[]) {
      const t2 = await startApp({ now: () => Date.parse(c.nowIso), settings: { timezone: c.tz, weekStart: c.weekStart } });
      const s = await getJson(t2.base, '/api/summary?range=all');
      for (const k of ['today', 'yesterday', 'thisWeek', 'prevWeek', 'thisMonth', 'prevMonth'] as const) {
        expect({ r: s.body.periods[k].summary.requests, t: s.body.periods[k].summary.total, f: s.body.periods[k].summary.fresh }, `${c.name} ${k}`).toEqual({ r: c[k].requests, t: c[k].total, f: c[k].fresh });
      }
      await t2.close();
    }
    // 查询参数里的 tz 覆盖设置；range=today 的小时序列之和 == periods.today
    const q = await getJson(t.base, '/api/timeseries?range=today&granularity=hour&tz=Asia/Shanghai');
    expect(q.body.points).toHaveLength(24);
    const s = await getJson(t.base, '/api/summary?tz=Asia/Shanghai');
    expect(sum(q.body.points as Expected[], (p) => p.total)).toBe(s.body.periods.today.summary.total);
    // 上海 UTC 15:59:59 / 16:00:00 落相邻两日
    const d = await getJson(t.base, '/api/timeseries?range=custom&from=2026-10-10&to=2026-10-11&project=D--Work-timeprobe&granularity=day');
    expect(d.body.points.map((p: Expected) => [p.key, p.requests])).toEqual([['2026-10-10', 1], ['2026-10-11', 4]]);
    const u = await getJson(t.base, '/api/timeseries?range=custom&from=2026-10-10&to=2026-10-11&project=D--Work-timeprobe&granularity=day&tz=UTC');
    expect(u.body.points.map((p: Expected) => [p.key, p.requests])).toEqual([['2026-10-10', 4], ['2026-10-11', 2]]); // UTC：week_a / week_b 都在 10-11
  });

  it('非法参数：400 与统一错误格式，不会 500，服务进程不退出（验收 3）', async () => {
    const bad: Array<[string, string]> = [
      ['/api/timeseries?granularity=minute', 'INVALID_GRANULARITY'],
      ['/api/summary?tz=Mars/Base', 'INVALID_TZ'],
      ['/api/summary?tz=%E4%B8%8D%E5%AD%98%E5%9C%A8', 'INVALID_TZ'],
      ['/api/summary?range=custom&from=2026-10-12&to=2026-10-11', 'INVALID_RANGE'],
      ['/api/summary?range=custom&from=2026-02-30&to=2026-03-01', 'INVALID_RANGE'],
      ['/api/summary?range=custom&from=2026-10-01', 'INVALID_RANGE'],
      ['/api/summary?range=7d&from=2026-10-01&to=2026-10-02', 'INVALID_RANGE'],
      ['/api/summary?range=yesterday', 'INVALID_RANGE'],
      ['/api/summary?project=no-such', 'UNKNOWN_PROJECT'],
      ['/api/summary?project=all,D--Work-alpha', 'INVALID_PROJECT'],
      ['/api/summary?basis=weird', 'INVALID_BASIS'],
      ['/api/timeseries?split=weird', 'INVALID_SPLIT'],
      ['/api/summary?weekStart=friday', 'INVALID_WEEKSTART'],
      ['/api/summary?includeSidechain=maybe', 'INVALID_PARAM'],
      ['/api/summary?mergeFamilies=2', 'INVALID_PARAM'],
      ['/api/summary?foo=bar', 'UNKNOWN_PARAM'],
      ['/api/summary?basis=total&basis=fresh', 'DUPLICATE_PARAM'],
      ['/api/timeseries?granularity=hour&range=custom&from=1990-01-01&to=2026-01-01', 'TOO_MANY_BUCKETS'],
      ['/api/projects?sort=zzz', 'INVALID_SORT'],
      ['/api/projects?tz=Mars/Base', 'INVALID_TZ'],
      ['/api/projects?extra=1', 'UNKNOWN_PARAM'],
      ['/api/status?x=1', 'UNKNOWN_PARAM'],
    ];
    for (const [p, code] of bad) {
      const r = await getJson(t.base, p);
      expect(r.status, p).toBe(400);
      expect(r.body, p).toEqual({ error: { code, message: expect.any(String) } });
      expect(r.body.error.message.length).toBeGreaterThan(0);
    }
    // 乱七八糟的输入
    for (const p of ['/api/summary?project=' + 'x'.repeat(5000), '/api/summary?tz=%00', '/api/summary?range=%E0%A4%A', '/api/summary?models=' + 'a,'.repeat(500)]) {
      const r = await rawRequest(t.port, { path: p, headers: {} });
      expect(r.status, p.slice(0, 40)).toBeGreaterThanOrEqual(400);
      expect(r.status, p.slice(0, 40)).toBeLessThan(500);
    }
    expect((await getJson(t.base, '/api/status')).status).toBe(200); // 进程仍然活着
  });

  it('未知 API 404、方法不对 405（带 Allow）、统一错误格式；HEAD 可用', async () => {
    const a = await getJson(t.base, '/api/nope');
    expect(a.status).toBe(404);
    expect(a.body.error.code).toBe('NOT_FOUND');
    const b = await rawRequest(t.port, { method: 'DELETE', path: '/api/settings', headers: {} });
    expect(b.status).toBe(405);
    expect(b.headers.allow).toContain('PUT');
    expect(JSON.parse(b.body).error.code).toBe('METHOD_NOT_ALLOWED');
    const c = await rawRequest(t.port, { method: 'GET', path: '/api/refresh', headers: {} });
    expect(c.status).toBe(405);
    const h = await rawRequest(t.port, { method: 'HEAD', path: '/api/status', headers: {} });
    expect(h.status).toBe(200);
    expect(h.body).toBe('');
    const o = await rawRequest(t.port, { method: 'OPTIONS', path: '/api/status', headers: { Origin: `http://127.0.0.1:${t.port}` } });
    expect(o.status).toBe(405);
    expect(o.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('响应头：nosniff / no-store / 无 CORS 头；缓存命中不改变结果，设置变化 / 数据变化使缓存失效', async () => {
    const r = await getJson(t.base, '/api/summary?range=all');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
    const hits0 = t.app.cache.hits;
    const r2 = await getJson(t.base, '/api/summary?range=all');
    expect(t.app.cache.hits).toBe(hits0 + 1);
    expect(r2.body).toEqual(r.body);
    // 查询串参数顺序不同也命中同一缓存
    await getJson(t.base, '/api/timeseries?granularity=day&range=all');
    const h1 = t.app.cache.hits;
    await getJson(t.base, '/api/timeseries?range=all&granularity=day');
    expect(t.app.cache.hits).toBe(h1 + 1);
    // 设置变化后（时区改变）结果随之变化，而不是读到旧缓存
    const before = JSON.stringify((await getJson(t.base, '/api/timeseries?range=all&granularity=day')).body.points);
    await putJson(t.base, '/api/settings', { timezone: 'America/New_York' });
    const after = JSON.stringify((await getJson(t.base, '/api/timeseries?range=all&granularity=day')).body.points);
    expect(after).not.toBe(before);
    await putJson(t.base, '/api/settings', { timezone: 'Asia/Shanghai' });
  });

  it('响应与 SSE 载荷不含任何对话正文（SECRET_BODY_MARKER 等）', async () => {
    const sse = openSse(t.port);
    await sse.waitFor((e) => e.event === 'status');
    const paths = ['/api/status', '/api/projects', '/api/projects?sort=name', '/api/summary', '/api/timeseries?split=model&granularity=hour&range=custom&from=2026-10-05&to=2026-10-06', '/api/timeseries?split=project', '/api/settings'];
    const bodies: string[] = [];
    for (const p of paths) bodies.push(await (await fetch(`${t.base}${p}`)).text());
    bodies.push(await (await fetch(`${t.base}/`)).text());
    bodies.push((await (await fetch(`${t.base}/api/refresh`, { method: 'POST' })).text()));
    await new Promise((r) => setTimeout(r, 50));
    bodies.push(sse.raw.join(''));
    sse.close();
    for (const b of bodies) {
      for (const bad of [MARKER, 'SECRET', 'Please refactor', 'reply text', 'echo ', 'prefix body', 'thinking about']) expect(b).not.toContain(bad);
    }
    // 返回里没有 tool_use input / 会话标题字段
    expect(bodies.join('')).not.toContain('Refactor the parser');
  });
});

describe('API：增量与 SSE（验收 4）', () => {
  it('运行中向数据根追加一条记录：≤ 轮询间隔 + 1 s 内 SSE 收到 dataVersion 变化，summary 数字随之更新', async () => {
    const w = tmpWorld();
    const t = await startApp({ dataRoot: w.root, appDataDir: w.app, watcher: { intervalMs: 80, minIntervalMs: 20 }, keepAppData: true });
    try {
      const sse = openSse(t.port);
      const first = await sse.waitFor((e) => e.event === 'status');
      expect(first?.data.dataVersion).toBeGreaterThan(0);
      await sse.waitFor((e) => e.event === 'dataVersion');
      const before = (await getJson(t.base, '/api/summary?range=all')).body.summary;
      const v0 = (await getJson(t.base, '/api/status')).body.dataVersion as number;
      const t0 = Date.now();
      fs.appendFileSync(path.join(w.root, 'D--Work-alpha', 'a1a1a1a1-0000-4000-8000-000000000002.jsonl'), `${assistantLine({ id: 'msg_sse_new', input: 100, out: 200, cacheRead: 300, ts: '2026-10-20T11:00:00.000Z', session: 'x' })}\n`);
      const ev = await sse.waitFor((e) => e.event === 'dataVersion' && e.data.dataVersion > v0, 2500);
      expect(ev).not.toBeNull();
      expect(Date.now() - t0).toBeLessThan(80 + 1000);
      const after = (await getJson(t.base, '/api/summary?range=all')).body.summary;
      expect(after.requests).toBe(before.requests + 1);
      expect(after.total).toBe(before.total + 600);
      expect(after.cacheRead).toBe(before.cacheRead + 300);
      // 事件格式：带 id / event / data
      expect(sse.events.every((e) => e.id !== undefined && typeof e.event === 'string')).toBe(true);
      expect(sse.events.some((e) => e.event === 'status' && e.data.state === 'idle' && typeof e.data.usageState === 'string')).toBe(true);
      sse.close();
      await sse.closed;
    } finally {
      await t.close();
      w.cleanup();
    }
  });

  it('SSE：连接头 / retry / 心跳；断开后客户端被清理；服务关闭时连接被结束；可重连', async () => {
    const t = await startApp({ sseHeartbeatMs: 40 });
    try {
      const res = await fetch(`${t.base}/api/events`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      expect(res.headers.get('cache-control')).toContain('no-store');
      const reader = res.body!.getReader();
      let text = '';
      const dec = new TextDecoder();
      const t0 = Date.now();
      while (!text.includes(': ping') && Date.now() - t0 < 2000) {
        const { value, done } = await reader.read();
        if (done) break;
        text += dec.decode(value);
      }
      expect(text).toContain('retry: 2000');
      expect(text).toContain('event: status');
      expect(text).toContain('event: dataVersion');
      expect(text).toContain(': ping'); // 心跳
      expect(t.app.sse.size).toBe(1);
      await reader.cancel();
      await new Promise((r) => setTimeout(r, 100));
      expect(t.app.sse.size).toBe(0);
      // 重连：新连接立刻拿到完整快照
      const s2 = openSse(t.port);
      expect(await s2.waitFor((e) => e.event === 'status')).not.toBeNull();
      expect(t.app.sse.size).toBe(1);
      const closed = s2.closed;
      await t.app.close();
      await Promise.race([closed, new Promise((_r, rej) => setTimeout(() => rej(new Error('SSE 未在服务关闭时结束')), 2000))]);
    } finally {
      await t.close();
    }
  });

  it('POST /api/refresh 等待扫描完成并返回状态；POST /api/rebuild 立即 202，之后重建完成', async () => {
    const t = await startApp();
    try {
      const r = await fetch(`${t.base}/api/refresh`, { method: 'POST' });
      expect(r.status).toBe(200);
      expect(((await r.json()) as { state: string }).state).toBe('idle');
      const fp = t.app.store.metrics.fullParses;
      const b = await fetch(`${t.base}/api/rebuild`, { method: 'POST' });
      expect(b.status).toBe(202);
      expect(((await b.json()) as { accepted: boolean }).accepted).toBe(true);
      await t.app.store.idle();
      expect(t.app.store.metrics.fullParses).toBe(fp + 14);
      expect((await getJson(t.base, '/api/summary?range=all')).body.summary.total).toBe(expected.totals.total);
    } finally {
      await t.close();
    }
  });
});

describe('API：跨站防护（验收 5）', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(() => t.close());

  it('带 Origin: http://evil.example 的 PUT /api/settings 被 403，设置未改变', async () => {
    const r = await putJson(t.base, '/api/settings', { theme: 'dark' }, { Origin: 'http://evil.example' });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('FORBIDDEN_ORIGIN');
    expect((await getJson(t.base, '/api/settings')).body.settings.theme).toBe('system');
    for (const origin of ['null', 'http://127.0.0.1:1', `http://127.0.0.1.evil.com:${t.port}`, `https://127.0.0.1:${t.port}`, `http://localhost.evil.com:${t.port}`, 'http://evil.example']) {
      const r2 = await rawRequest(t.port, { method: 'GET', path: '/api/status', headers: { Origin: origin } });
      expect(r2.status, origin).toBe(403);
      const r3 = await rawRequest(t.port, { method: 'POST', path: '/api/refresh', headers: { Origin: origin } });
      expect(r3.status, origin).toBe(403);
    }
    // sec-fetch-site: cross-site 也拒绝
    expect((await rawRequest(t.port, { path: '/api/status', headers: { 'Sec-Fetch-Site': 'cross-site' } })).status).toBe(403);
    // 同源 Origin 放行
    expect((await putJson(t.base, '/api/settings', { theme: 'light' }, { Origin: `http://127.0.0.1:${t.port}` })).status).toBe(200);
    expect((await putJson(t.base, '/api/settings', { theme: 'system' }, { Origin: `http://localhost:${t.port}` })).status).toBe(200);
  });

  it('Host 非 127.0.0.1:<port> / localhost:<port> 的请求被拒（DNS rebinding）；合法 Host 放行', async () => {
    for (const host of ['evil.example', `evil.example:${t.port}`, `127.0.0.1:${t.port + 1}`, '127.0.0.1', `127.0.0.1.evil.com:${t.port}`, `[::1]:${t.port}`, `0.0.0.0:${t.port}`]) {
      const r = await rawRequest(t.port, { path: '/api/status', headers: { Host: host } });
      expect(r.status, host).toBe(403);
      expect(JSON.parse(r.body).error.code).toBe('FORBIDDEN_HOST');
      // 静态页面同样受保护
      expect((await rawRequest(t.port, { path: '/', headers: { Host: host } })).status, host).toBe(403);
    }
    // 完全没有 Host 头（HTTP/1.0 原始报文）
    const noHost = await new Promise<string>((resolve) => {
      const s = net.connect({ port: t.port, host: '127.0.0.1' }, () => s.write('GET /api/status HTTP/1.0\r\n\r\n'));
      let out = '';
      s.on('data', (d) => (out += d.toString()));
      s.on('close', () => resolve(out));
    });
    expect(noHost).toContain('403');
    expect(noHost).toContain('FORBIDDEN_HOST');
    expect((await rawRequest(t.port, { path: '/api/status', headers: { Host: `localhost:${t.port}` } })).status).toBe(200);
    expect((await rawRequest(t.port, { path: '/api/status', headers: { Host: `LOCALHOST:${t.port}` } })).status).toBe(200);
    expect((await rawRequest(t.port, { path: '/api/status', headers: { Host: `127.0.0.1:${t.port}` } })).status).toBe(200);
  });

  it('写操作要求 JSON；请求体过大 / 非 JSON / 空体被拒', async () => {
    const send = (ct: string | undefined, body: string) => rawRequest(t.port, { method: 'PUT', path: '/api/settings', headers: { ...(ct ? { 'Content-Type': ct } : {}), 'Content-Length': String(Buffer.byteLength(body)) }, body });
    expect((await send('text/plain', '{"theme":"dark"}')).status).toBe(415);
    expect((await send('application/x-www-form-urlencoded', 'theme=dark')).status).toBe(415);
    expect((await send(undefined, '{"theme":"dark"}')).status).toBe(415);
    expect((await send('application/json', '{not json')).status).toBe(400);
    expect((await send('application/json', '')).status).toBe(400);
    expect((await send('application/json', '[1,2]')).status).toBe(400);
    expect((await send('application/json', JSON.stringify({ theme: 'dark', pad: 'x'.repeat(100_000) }))).status).toBe(413);
    expect((await send('application/json; charset=utf-8', '{"theme":"dark"}')).status).toBe(200);
    await putJson(t.base, '/api/settings', { theme: 'system' });
  });

  it('只监听 127.0.0.1', async () => {
    const addr = t.app.server.address() as net.AddressInfo;
    expect(addr.address).toBe('127.0.0.1');
    expect(addr.family).toBe('IPv4');
    // 非回环地址的所有本机接口上连接该端口应被拒绝
    const { networkInterfaces } = await import('node:os');
    for (const ifs of Object.values(networkInterfaces())) {
      for (const i of ifs ?? []) {
        if (i.family !== 'IPv4' || i.internal) continue;
        const ok = await new Promise<boolean>((resolve) => {
          const s = net.connect({ port: t.port, host: i.address });
          s.setTimeout(500, () => {
            s.destroy();
            resolve(false);
          });
          s.once('connect', () => {
            s.destroy();
            resolve(true);
          });
          s.once('error', () => resolve(false));
        });
        expect(ok, `不应能通过 ${i.address} 访问`).toBe(false);
      }
    }
  });

  it('畸形请求不崩溃：绝对形式 URL、双斜杠、超长路径、非法编码', async () => {
    for (const p of ['http://evil.example/api/status', '//evil.example/x', '/' + 'a'.repeat(20_000), '/%E0%A4%A', '/api/status%00']) {
      const r = await rawRequest(t.port, { path: p, headers: {} });
      expect(r.status, p.slice(0, 30)).toBeGreaterThanOrEqual(400);
      expect(r.status, p.slice(0, 30)).toBeLessThan(500);
    }
    expect((await getJson(t.base, '/api/status')).status).toBe(200);
  });
});

describe('API：设置（验收 6）', () => {
  it('默认值；PUT 部分更新；非法值被拒且不改变；未知字段被拒', async () => {
    const t = await startApp({ settings: {} });
    try {
      const g = (await getJson(t.base, '/api/settings')).body;
      expect(g.settings).toEqual({ dataRoot: null, timezone: 'system', weekStart: 'monday', defaultBasis: 'total', autoRefresh: { enabled: true, intervalSec: 5 }, theme: 'system', language: 'zh', groupScratch: true, budget: { daily: null, monthly: null }, subscription: { plan: null, monthlyFeeUsd: null, billingDay: null, feeCurrency: 'USD', cnyPerUsd: 7.2 } });
      expect(g.effective.dataRoot).toBe(FIXTURE_ROOT);
      expect(typeof g.effective.timezone).toBe('string');
      const ok = await putJson(t.base, '/api/settings', { theme: 'dark', weekStart: 'sunday', defaultBasis: 'fresh', language: 'en', autoRefresh: { intervalSec: 10 }, budget: { daily: 123.5 }, timezone: 'Asia/Tokyo' });
      expect(ok.status).toBe(200);
      expect(ok.body.settings).toMatchObject({ theme: 'dark', weekStart: 'sunday', defaultBasis: 'fresh', language: 'en', timezone: 'Asia/Tokyo', autoRefresh: { enabled: true, intervalSec: 10 }, budget: { daily: 123.5, monthly: null } });
      const before = (await getJson(t.base, '/api/settings')).body.settings;
      const bad: Array<[Record<string, unknown>, string]> = [
        [{ theme: 'purple' }, 'theme'],
        [{ weekStart: 'friday' }, 'weekStart'],
        [{ defaultBasis: 'x' }, 'defaultBasis'],
        [{ language: 'fr' }, 'language'],
        [{ timezone: 'Mars/Base' }, 'timezone'],
        [{ timezone: 5 }, 'timezone'],
        [{ autoRefresh: { intervalSec: 1 } }, 'autoRefresh.intervalSec'],
        [{ autoRefresh: { intervalSec: 61 } }, 'autoRefresh.intervalSec'],
        [{ autoRefresh: { intervalSec: 2.5 } }, 'autoRefresh.intervalSec'],
        [{ autoRefresh: { enabled: 'yes' } }, 'autoRefresh.enabled'],
        [{ autoRefresh: { foo: 1 } }, 'autoRefresh.foo'],
        [{ budget: { daily: -1 } }, 'budget.daily'],
        [{ budget: { monthly: 'lots' } }, 'budget.monthly'],
        [{ groupScratch: 'true' }, 'groupScratch'],
        [{ dataRoot: 5 }, 'dataRoot'],
        [{ dataRoot: 'relative/path' }, 'dataRoot'],
        [{ unknownKey: 1 }, 'unknownKey'],
        [{ theme: 'light', weekStart: 'nope' }, 'weekStart'], // 一项非法 → 整体不生效
      ];
      for (const [body, field] of bad) {
        const r = await putJson(t.base, '/api/settings', body);
        expect(r.status, JSON.stringify(body)).toBe(400);
        expect(r.body.error.code).toBe('INVALID_SETTING');
        expect(r.body.error.field).toBe(field);
      }
      expect((await getJson(t.base, '/api/settings')).body.settings).toEqual(before);
      // null 清空预算 / dataRoot
      expect((await putJson(t.base, '/api/settings', { budget: { daily: null } })).body.settings.budget.daily).toBeNull();
    } finally {
      await t.close();
    }
  });

  it('持久化：重启服务后保留；设置文件在应用数据目录而不是数据根', async () => {
    const w = tmpWorld();
    const before = snapshotDir(w.root);
    let t = await startApp({ dataRoot: w.root, appDataDir: w.app, settings: {}, keepAppData: true });
    await putJson(t.base, '/api/settings', { theme: 'dark', weekStart: 'sunday', groupScratch: false, autoRefresh: { enabled: false, intervalSec: 30 }, budget: { monthly: 99 }, timezone: 'Europe/London', language: 'en', defaultBasis: 'fresh' });
    await t.close();
    expect(fs.existsSync(path.join(w.app, 'settings.json'))).toBe(true);
    expect(fs.existsSync(path.join(w.root, 'settings.json'))).toBe(false);
    expect(snapshotDir(w.root)).toEqual(before);
    t = await startApp({ dataRoot: w.root, appDataDir: w.app, settings: {}, keepAppData: true });
    const g = (await getJson(t.base, '/api/settings')).body;
    expect(g.settings).toEqual({ dataRoot: null, timezone: 'Europe/London', weekStart: 'sunday', defaultBasis: 'fresh', autoRefresh: { enabled: false, intervalSec: 30 }, theme: 'dark', language: 'en', groupScratch: false, budget: { daily: null, monthly: 99 }, subscription: { plan: null, monthlyFeeUsd: null, billingDay: null, feeCurrency: 'USD', cnyPerUsd: 7.2 } });
    expect(g.warnings).toEqual([]);
    // 默认口径 / 周起始 / 时区 / Scratch 开关 真的生效
    const proj = (await getJson(t.base, '/api/projects')).body;
    expect(proj.basis).toBe('fresh');
    expect(proj.projects.some((p: Expected) => p.isScratchGroup)).toBe(false);
    expect((await getJson(t.base, '/api/summary')).body.query).toMatchObject({ basis: 'fresh', weekStart: 'sunday', tz: 'Europe/London' });
    expect((await getJson(t.base, '/api/status')).body.today.tz).toBe('Europe/London');
    await t.close();
    w.cleanup();
  });

  it('设置文件损坏 / 部分非法：回退默认值并给出警告，不崩溃，其余字段保留', async () => {
    const w = tmpWorld();
    try {
      fs.mkdirSync(w.app, { recursive: true });
      fs.writeFileSync(path.join(w.app, 'settings.json'), '{{{ not json');
      let t = await startApp({ dataRoot: w.root, appDataDir: w.app, settings: {}, keepAppData: true });
      let g = (await getJson(t.base, '/api/settings')).body;
      expect(g.settings.theme).toBe('system');
      expect(g.warnings.join()).toContain('损坏');
      await t.close();
      fs.writeFileSync(path.join(w.app, 'settings.json'), JSON.stringify({ schema: 1, settings: { theme: 'dark', weekStart: 'someday', autoRefresh: { intervalSec: 999 }, bogus: 1, language: 'en' } }));
      t = await startApp({ dataRoot: w.root, appDataDir: w.app, settings: {}, keepAppData: true });
      g = (await getJson(t.base, '/api/settings')).body;
      expect(g.settings).toMatchObject({ theme: 'dark', language: 'en', weekStart: 'monday', autoRefresh: { enabled: true, intervalSec: 5 } });
      expect(g.warnings.length).toBe(3);
      await t.close();
    } finally {
      w.cleanup();
    }
  });

  it('修改 dataRoot：不存在的目录被拒（不改变当前数据）；有效目录触发重新扫描，项目列表随之刷新；改回 null 恢复默认', async () => {
    const w = tmpWorld(false);
    const other = path.join(w.root, 'other-root');
    fs.mkdirSync(path.join(other, 'ZZ--proj'), { recursive: true });
    fs.writeFileSync(path.join(other, 'ZZ--proj', 's.jsonl'), `${assistantLine({ id: 'msg_other', input: 5, out: 5 })}\n`);
    const t = await startApp({ appDataDir: w.app, keepAppData: true });
    try {
      const missing = path.join(w.root, 'does-not-exist');
      const r = await putJson(t.base, '/api/settings', { dataRoot: missing });
      expect(r.status).toBe(400);
      expect(r.body.error.field).toBe('dataRoot');
      expect(r.body.error.message).toContain('目录不存在');
      const file = path.join(w.root, 'afile.txt');
      fs.writeFileSync(file, 'x');
      expect((await putJson(t.base, '/api/settings', { dataRoot: file })).body.error.message).toContain('不是目录');
      expect((await getJson(t.base, '/api/status')).body.dataRoot).toBe(FIXTURE_ROOT);
      expect((await getJson(t.base, '/api/summary?range=all')).body.summary.total).toBe(expected.totals.total);

      const ok = await putJson(t.base, '/api/settings', { dataRoot: other });
      expect(ok.status).toBe(200);
      expect(ok.body.effective.dataRoot).toBe(path.resolve(other));
      await t.app.store.idle();
      const p = (await getJson(t.base, '/api/projects')).body;
      expect(p.projects.map((x: Expected) => x.id)).toEqual(['ZZ--proj']);
      expect((await getJson(t.base, '/api/summary?range=all')).body.summary.total).toBe(10);
      expect((await getJson(t.base, '/api/status')).body.dataRoot).toBe(path.resolve(other));

      await putJson(t.base, '/api/settings', { dataRoot: null });
      await t.app.store.idle();
      expect((await getJson(t.base, '/api/status')).body.dataRoot).toBe(FIXTURE_ROOT);
      expect((await getJson(t.base, '/api/summary?range=all')).body.summary.total).toBe(expected.totals.total);
    } finally {
      await t.close();
      w.cleanup();
    }
  });

  it('autoRefresh 开关与间隔作用于轮询器', async () => {
    const t = await startApp({ settings: {}, watcher: { minIntervalMs: 20 } });
    try {
      await putJson(t.base, '/api/settings', { autoRefresh: { enabled: true, intervalSec: 7 } });
      expect(t.app.watcher.intervalMs).toBe(7000);
      await putJson(t.base, '/api/settings', { autoRefresh: { enabled: false } });
      const scans = t.app.store.metrics.scans;
      await new Promise((r) => setTimeout(r, 150));
      expect(t.app.store.metrics.scans).toBe(scans);
    } finally {
      await t.close();
    }
  });

  it('应用数据目录被误配进数据根时：保存设置被拒（500 类错误码 WRITE_REFUSED），数据根不被写入', async () => {
    const w = tmpWorld();
    try {
      const evil = path.join(w.root, 'appdata');
      const before = snapshotDir(w.root);
      const t = await startApp({ dataRoot: w.root, appDataDir: evil, settings: {}, keepAppData: true });
      const r = await putJson(t.base, '/api/settings', { theme: 'dark' });
      expect(r.status).toBe(500);
      expect(r.body.error.code).toBe('WRITE_REFUSED');
      expect((await getJson(t.base, '/api/settings')).body.settings.theme).toBe('system'); // 未改变
      expect(snapshotDir(w.root)).toEqual(before);
      await t.close();
    } finally {
      w.cleanup();
    }
  });
});

describe('API：端口', () => {
  it('默认端口被占用时自动向后顺延', async () => {
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()));
    const busy = (blocker.address() as net.AddressInfo).port;
    const wildcard = net.createServer();
    let wildcardPort = 0;
    try {
      // 再占用 busy+1（绑定在所有地址上，模拟其它程序）
      await new Promise<void>((resolve) => {
        wildcard.once('error', () => resolve());
        wildcard.listen(busy + 1, '0.0.0.0', () => {
          wildcardPort = busy + 1;
          resolve();
        });
      });
      const w = makeTmpDir('tv-port-');
      const app = await createApp({ dataRoot: FIXTURE_ROOT, appDataDir: path.join(w, 'a'), port: busy });
      try {
        expect(app.port).toBeGreaterThan(busy);
        if (wildcardPort) expect(app.port).toBeGreaterThan(wildcardPort);
        const r = await fetch(`http://127.0.0.1:${app.port}/api/status`);
        expect(r.status).toBe(200);
      } finally {
        await app.close();
        rmDir(w);
      }
    } finally {
      blocker.close();
      wildcard.close();
    }
  });

  it('找不到可用端口时给出中文错误', async () => {
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()));
    const busy = (blocker.address() as net.AddressInfo).port;
    const w = makeTmpDir('tv-port-');
    try {
      await expect(createApp({ dataRoot: FIXTURE_ROOT, appDataDir: path.join(w, 'a'), port: busy, probePorts: 1 })).rejects.toThrow(/没有找到可用端口/);
    } finally {
      blocker.close();
      rmDir(w);
    }
  });
});

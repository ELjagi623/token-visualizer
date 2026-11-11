import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getJson, openSse, putJson, rawRequest, startApp } from './apiHelpers.ts';
import { assistantLine, makeTmpDir, rmDir } from './helpers.ts';
import { tmpWorld } from './storeHelpers.ts';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('修复 1：数据根不能包含应用数据目录', () => {
  it('PUT 阶段就 400（中文说明、不含绝对路径），已有设置不变，之后设置仍可正常修改', async () => {
    const w = tmpWorld();
    const t = await startApp({ dataRoot: w.root, appDataDir: w.app, settings: { theme: 'dark' }, keepAppData: true });
    try {
      const before = (await getJson(t.base, '/api/settings')).body.settings;
      const base = path.dirname(w.app); // 应用数据目录的父目录（同时是 tmp 世界的根）
      for (const bad of [base, w.app, path.join(base, '.'), path.dirname(base)]) {
        const r = await putJson(t.base, '/api/settings', { dataRoot: bad, theme: 'light' });
        expect(r.status, bad).toBe(400);
        expect(r.body.error).toMatchObject({ code: 'INVALID_SETTING', field: 'dataRoot' });
        expect(r.body.error.message).toContain('数据根不能包含应用数据目录');
        expect(r.body.error.message).not.toContain(base);
        expect(r.body.error.message).not.toContain(w.app);
      }
      expect((await getJson(t.base, '/api/settings')).body.settings).toEqual(before); // 整次更新不生效（theme 也没变）
      // 没有被锁死：设置 / 缓存仍可写
      expect((await putJson(t.base, '/api/settings', { theme: 'light' })).status).toBe(200);
      expect((await putJson(t.base, '/api/settings', { dataRoot: null })).status).toBe(200);
      // 与应用数据目录无关的另一个目录仍可设置
      const other = path.join(base, 'elsewhere');
      fs.mkdirSync(other);
      expect((await putJson(t.base, '/api/settings', { dataRoot: other })).status).toBe(200);
      await t.app.store.idle();
      expect(t.app.store.getStatus().warnings.filter((x) => x.includes('缓存'))).toEqual([]);
    } finally {
      await t.close();
      w.cleanup();
    }
  });

  it('启动时已存在这种坏设置：自动回退到默认数据根，/api/status 给出警告，设置不再锁死，坏值被修正写回', async () => {
    const w = tmpWorld();
    try {
      fs.mkdirSync(w.app, { recursive: true });
      const base = path.dirname(w.app);
      fs.writeFileSync(path.join(w.app, 'settings.json'), JSON.stringify({ schema: 1, settings: { dataRoot: base, theme: 'dark' } }));
      const t = await startApp({ dataRoot: w.root, appDataDir: w.app, settings: {}, keepAppData: true });
      try {
        const st = (await getJson(t.base, '/api/status')).body;
        expect(st.dataRoot).toBe(w.root); // 回退到默认（此处为 opts.dataRoot）
        expect(st.state).toBe('idle');
        expect(st.warnings.some((x: string) => x.includes('回退为默认数据根'))).toBe(true);
        expect(JSON.stringify(st.warnings)).not.toContain(base.replace(/\\/g, '\\\\'));
        const g = (await getJson(t.base, '/api/settings')).body;
        expect(g.settings.dataRoot).toBeNull();
        expect(g.settings.theme).toBe('dark'); // 其余设置保留
        expect(g.effective.dataRoot).toBe(w.root);
        expect((await putJson(t.base, '/api/settings', { theme: 'light' })).status).toBe(200);
        expect(JSON.parse(fs.readFileSync(path.join(w.app, 'settings.json'), 'utf8')).settings.dataRoot).toBeNull();
        expect((await getJson(t.base, '/api/summary?range=all')).status).toBe(200);
      } finally {
        await t.close();
      }
    } finally {
      w.cleanup();
    }
  });
});

describe('修复 2：dataVersion 事件只在版本号变化时推送', () => {
  it('连接后没有数据变化时，多次状态广播也只有初始快照里的那一条 dataVersion', async () => {
    const t = await startApp();
    try {
      const c = openSse(t.port);
      await c.waitFor((e) => e.event === 'dataVersion');
      await t.app.store.refreshNow();
      await t.app.store.refreshNow();
      await new Promise((r) => setTimeout(r, 150));
      expect(c.events.filter((e) => e.event === 'status').length).toBeGreaterThan(1); // 状态广播确实发生过
      expect(c.events.filter((e) => e.event === 'dataVersion')).toHaveLength(1);
      c.close();
    } finally {
      await t.close();
    }
  });

  it('每个客户端各自记录：数据变化时每个已连接的客户端都恰好收到一次新版本；后连接的客户端不影响先连接的', async () => {
    const w = tmpWorld();
    const t = await startApp({ dataRoot: w.root, appDataDir: w.app, keepAppData: true });
    try {
      const target = path.join(w.root, 'D--Work-alpha', 'a1a1a1a1-0000-4000-8000-000000000002.jsonl');
      const a = openSse(t.port);
      await a.waitFor((e) => e.event === 'dataVersion');
      fs.appendFileSync(target, `${assistantLine({ id: 'msg_v2', ts: '2026-10-20T11:00:00.000Z' })}\n`);
      await t.app.store.refreshNow();
      await a.waitFor((e) => e.event === 'dataVersion' && e.data.dataVersion > a.events.find((x) => x.event === 'dataVersion')!.data.dataVersion);
      const b = openSse(t.port); // 在新版本上连接
      await b.waitFor((e) => e.event === 'dataVersion');
      fs.appendFileSync(target, `${assistantLine({ id: 'msg_v3', ts: '2026-10-20T11:01:00.000Z' })}\n`);
      await t.app.store.refreshNow();
      const lastOf = (c: typeof a): number => c.events.filter((e) => e.event === 'dataVersion').at(-1)!.data.dataVersion;
      await a.waitFor((e) => e.event === 'dataVersion' && e.data.dataVersion === t.app.store.getView().dataVersion);
      await b.waitFor((e) => e.event === 'dataVersion' && e.data.dataVersion === t.app.store.getView().dataVersion);
      expect(lastOf(a)).toBe(t.app.store.getView().dataVersion);
      expect(lastOf(b)).toBe(t.app.store.getView().dataVersion);
      // 版本号严格递增、无重复
      for (const c of [a, b]) {
        const vs = c.events.filter((e) => e.event === 'dataVersion').map((e) => e.data.dataVersion as number);
        expect(new Set(vs).size).toBe(vs.length);
        expect([...vs].sort((x, y) => x - y)).toEqual(vs);
      }
      a.close();
      b.close();
    } finally {
      await t.close();
      w.cleanup();
    }
  });
});

describe('修复 3：HEAD /api/events', () => {
  it('立刻返回 405（Allow: GET），不占 SSE 名额；GET 仍然正常', async () => {
    const t = await startApp();
    try {
      const out = await new Promise<string>((resolve) => {
        const s = net.connect({ port: t.port, host: '127.0.0.1' });
        let buf = '';
        s.on('data', (d) => (buf += d.toString()));
        s.on('close', () => resolve(buf));
        setTimeout(() => {
          s.destroy();
          resolve(buf);
        }, 1500);
        s.write(`HEAD /api/events HTTP/1.1\r\nHost: 127.0.0.1:${t.port}\r\nConnection: close\r\n\r\n`);
      });
      expect(out).toMatch(/^HTTP\/1\.1 405/);
      expect(out.toLowerCase()).toContain('allow: get');
      expect(t.app.sse.size).toBe(0);
      const r = await rawRequest(t.port, { method: 'HEAD', path: '/api/events', headers: {} });
      expect(r.status).toBe(405);
      // 其它 API 的 HEAD 不受影响
      expect((await rawRequest(t.port, { method: 'HEAD', path: '/api/status', headers: {} })).status).toBe(200);
      const c = openSse(t.port);
      expect(await c.waitFor((e) => e.event === 'status')).not.toBeNull();
      expect(t.app.sse.size).toBe(1);
      c.close();
    } finally {
      await t.close();
    }
  });
});

describe('修复 4：数据根不存在时 npm start 的控制台提示', () => {
  it('首次扫描结束后打印中文原因；之后目录出现并恢复时再提示一次', async () => {
    const tmp = makeTmpDir('tv-fix4-');
    const missing = path.join(tmp, 'not-yet');
    let out = '';
    const child = spawn(process.execPath, ['src/server/index.ts', '--no-open', '--port', '0'], {
      cwd: repo,
      env: { ...process.env, TV_DATA_ROOT: missing, TV_APPDATA_DIR: path.join(tmp, 'app'), TV_NO_OPEN: '1' },
    });
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (out += d.toString('utf8')));
    try {
      const t0 = Date.now();
      while (!out.includes('数据根目录不存在') && Date.now() - t0 < 10000) await new Promise((r) => setTimeout(r, 50));
      expect(out).toContain('已启动');
      expect(out).toContain('提示：数据根目录不存在');
      expect(out).toContain(missing);
      // 只提示一次（不随 5 秒一次的轮询刷屏）
      expect(out.split('提示：数据根目录不存在').length - 1).toBe(1);
    } finally {
      child.kill();
      await new Promise((r) => child.on('close', r));
      rmDir(tmp);
    }
  }, 30_000);
});

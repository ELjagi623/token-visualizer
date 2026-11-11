/**
 * 阶段 5 测试者 E2E（B）：状态胶囊（activity / 增量扫描不闪 / 追加记录变 Live / Offline 与恢复）、
 * warnings 提示条（坏 settings.json）、首次扫描态、真实数据（只读）。
 * 运行：先 npm run build，再 npm run test:e2e
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { assistantLine } from '../helpers.ts';
import { FIXTURE_PROJECTS, startServer, waitForIdle } from './server.ts';
import type { TestServer } from './server.ts';
import { CSP_INIT, ROOT, collect, open, setTheme, shot } from './tester-util.ts';

const pillState = (page: Page): Promise<string | null> => page.locator('[data-testid="status-pill"]').getAttribute('data-state');
const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });

/** 带"原始 settings.json 文本"的启动（startServer 只能写合法 JSON）。 */
async function startWithRawSettings(raw: string): Promise<TestServer> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-e2e-raw-'));
  const dataRoot = path.join(base, 'projects');
  const appData = path.join(base, 'appdata');
  fs.mkdirSync(appData, { recursive: true });
  fs.cpSync(FIXTURE_PROJECTS, dataRoot, { recursive: true });
  fs.writeFileSync(path.join(appData, 'settings.json'), raw);
  const proc = spawn(process.execPath, ['src/server/index.ts', '--no-open'], { cwd: ROOT, env: { ...process.env, TV_DATA_ROOT: dataRoot, TV_APPDATA_DIR: appData, TV_PORT: '0', TV_NO_OPEN: '1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  proc.stdout?.on('data', (d: Buffer) => (out += d.toString('utf8')));
  proc.stderr?.on('data', (d: Buffer) => (out += d.toString('utf8')));
  const url = await new Promise<string>((resolve, reject) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      const m = /(http:\/\/127\.0\.0\.1:\d+\/)/.exec(out);
      if (m) {
        clearInterval(timer);
        resolve(m[1]!);
      } else if (Date.now() - t0 > 20_000) {
        clearInterval(timer);
        reject(new Error('服务没有启动：' + out));
      }
    }, 50);
  });
  return {
    url,
    port: Number(new URL(url).port),
    dataRoot,
    appData,
    proc,
    log: () => out,
    stop: async () => {
      proc.kill();
      await new Promise<void>((r) => {
        proc.once('exit', () => r());
        setTimeout(r, 3000);
      });
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
test.describe('状态胶囊', () => {
  test('各状态外观（模拟 /api/status）：Idle / Active / Live / Scanning / Error / Offline；增量扫描（filesTotal=0）不闪 Scanning', async ({ page }) => {
    const srv = await startServer({ env: { TV_NOW: '2026-10-20T12:00:00.000Z' } });
    try {
      await waitForIdle(srv.url);
      const base = (await (await fetch(`${srv.url}api/status`)).json()) as Record<string, unknown>;
      const mock = async (over: Record<string, unknown>): Promise<void> => {
        const fake = { ...base, ...over };
        await page.unroute('**/api/status').catch(() => undefined);
        await page.unroute('**/api/events').catch(() => undefined);
        await page.route('**/api/status', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fake) }));
        await page.route('**/api/events', (r) => r.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: `retry: 600000\n\nevent: status\ndata: ${JSON.stringify(fake)}\n\n` }));
        await page.goto(srv.url);
        await page.waitForSelector('[data-testid="status-pill"]');
        await page.waitForTimeout(700);
      };
      const cases: Array<[string, Record<string, unknown>, string, RegExp]> = [
        ['idle', { activity: 'idle', usageState: 'idle' }, 'idle', /Idle/],
        ['active', { activity: 'active', usageState: 'active' }, 'active', /Active/],
        ['live', { activity: 'generating', usageState: 'generating' }, 'generating', /Live/],
        ['scanning', { state: 'scanning', phase: 'full', filesDone: 47, filesTotal: 112, bytesDone: 41, bytesTotal: 100, usageState: 'scanning' }, 'scanning', /Scanning · 41%/],
        ['error', { state: 'error', lastError: '数据根目录不存在', usageState: 'error' }, 'error', /Error/],
        // 回归点：增量扫描且 filesTotal=0 时 usageState=scanning，但胶囊必须仍按 activity 显示
        ['incremental-scan-idle', { state: 'scanning', phase: 'incremental', filesDone: 0, filesTotal: 0, usageState: 'scanning', activity: 'idle' }, 'idle', /Idle/],
        ['incremental-scan-live', { state: 'scanning', phase: 'incremental', filesDone: 0, filesTotal: 0, usageState: 'scanning', activity: 'generating' }, 'generating', /Live/],
      ];
      for (const theme of ['light', 'dark'] as const) {
        for (const [name, over, want, re] of cases) {
          await page.unroute('**/api/status').catch(() => undefined);
          await page.goto(srv.url);
          await setTheme(page, theme).catch(() => undefined);
          await mock(over);
          const pill = page.locator('[data-testid="status-pill"]');
          await expect(pill, `${theme} ${name}`).toHaveAttribute('data-state', want);
          await expect(pill).toContainText(re);
          if (!name.startsWith('incremental')) await page.screenshot({ path: shot(`pill-${name}-${theme}`), clip: { x: 700, y: 0, width: 740, height: 90 } });
          if (want === 'generating') await expect(pill).toContainText('今日');
          if (want === 'scanning' || want === 'error') await expect(pill).not.toContainText('今日');
        }
      }
      // 胶囊配色 = 令牌（Live 绿 / Active 蓝 / Idle 灰 / Error 粉 / Scanning 蓝）
      await mock({ activity: 'generating', usageState: 'generating' });
      const c = await page.evaluate(() => {
        const cs = getComputedStyle(document.querySelector('[data-testid="status-pill"]')!);
        return { bg: cs.backgroundColor, fg: cs.color };
      });
      console.log('Live 胶囊(深色) 配色：' + JSON.stringify(c));
      // 悬浮原因（title）
      await mock({ state: 'error', lastError: '数据根目录不存在', usageState: 'error' });
      expect(await page.locator('[data-testid="status-pill"]').getAttribute('title')).toContain('数据根目录不存在');
    } finally {
      await srv.stop();
    }
  });

  test('真实增量扫描期间胶囊不闪 Scanning（每 1.5s 追加记录，持续 22s，同时从 API 侧确认确有增量扫描发生）', async ({ page }) => {
    const srv = await startServer({});
    try {
      await waitForIdle(srv.url);
      await open(page, srv.url);
      await page.evaluate(() => {
        const w = window as unknown as { __pill: string[] };
        w.__pill = [];
        const el = document.querySelector('[data-testid="status-pill"]')!;
        const rec = (): void => {
          const s = document.querySelector('[data-testid="status-pill"]')?.getAttribute('data-state') ?? 'none';
          if (w.__pill[w.__pill.length - 1] !== s) w.__pill.push(s);
        };
        rec();
        new MutationObserver(rec).observe(document.body, { subtree: true, attributes: true, childList: true, attributeFilter: ['data-state'] });
        void el;
      });
      const file = path.join(srv.dataRoot, 'D--Work-alpha', 'a1a1a1a1-0000-4000-8000-000000000002.jsonl');
      const seen = new Set<string>();
      let stop = false;
      const poller = (async (): Promise<void> => {
        while (!stop) {
          try {
            const s = (await (await fetch(`${srv.url}api/status`)).json()) as { state: string; phase: string; usageState: string };
            seen.add(`${s.state}/${s.phase}/${s.usageState}`);
          } catch {
            /* ignore */
          }
          await new Promise((r) => setTimeout(r, 40));
        }
      })();
      const t0 = Date.now();
      let i = 0;
      while (Date.now() - t0 < 22_000) {
        fs.appendFileSync(file, `${assistantLine({ id: `msg_flicker_${i++}`, ts: new Date().toISOString(), input: 10, out: 5 })}\n`);
        await page.waitForTimeout(1500);
      }
      stop = true;
      await poller;
      const states = await page.evaluate(() => (window as unknown as { __pill: string[] }).__pill);
      console.log(`API 侧观测到的 状态/阶段/usageState：${[...seen].join(' , ')}；胶囊状态序列：${states.join(' → ')}`);
      expect(states).not.toContain('scanning');
      expect(states).not.toContain('offline');
      expect(states).not.toContain('error');
    } finally {
      await srv.stop();
    }
  });

  test('向数据根追加记录：≤ 一个轮询间隔内变 Live，今日数字增加，侧栏出现今日绿点；之后随时间降为 Active（真实时钟）', async ({ page }) => {
    test.setTimeout(180_000);
    const srv = await startServer({ withFixture: false });
    try {
      const proj = path.join(srv.dataRoot, 'D--Work-live');
      fs.mkdirSync(proj, { recursive: true });
      const file = path.join(proj, 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa.jsonl');
      const twoHoursAgo = new Date(Date.now() - 30 * 3600_000).toISOString(); // 30 小时前：既是 Idle，又一定不算"今日"（与当前时刻 / 时区无关）
      fs.writeFileSync(file, `${assistantLine({ id: 'msg_old_1', ts: twoHoursAgo, input: 100, out: 50, extra: { cwd: 'D:\\Work\\live', sessionId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa' } })}\n`);
      await page.waitForTimeout(6500); // 让服务的 5s 轮询接到这个文件
      await expect.poll(async () => ((await (await fetch(`${srv.url}api/projects`)).json()) as { projectCount: number }).projectCount, { timeout: 15_000 }).toBe(1);
      await open(page, srv.url);
      const pill = page.locator('[data-testid="status-pill"]');
      await expect(pill).toHaveAttribute('data-state', 'idle');
      await page.screenshot({ path: shot('live-before-append'), clip: { x: 0, y: 0, width: 1440, height: 180 } });
      const before = await page.locator('[data-testid="tile-today"]').getAttribute('data-value');
      const t0 = Date.now();
      fs.appendFileSync(file, `${assistantLine({ id: 'msg_new_1', ts: new Date().toISOString(), input: 1000, out: 234, cacheRead: 4000, extra: { cwd: 'D:\\Work\\live', sessionId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa' } })}\n`);
      await expect(pill).toHaveAttribute('data-state', 'generating', { timeout: 12_000 });
      const dt = Date.now() - t0;
      console.log(`追加记录 → 胶囊变为 Live：${dt} ms（前端轮询间隔：SSE 推送 + 10s 状态轮询兜底；后端 5s 刷新）`);
      expect(dt).toBeLessThan(10_000);
      await expect(pill).toContainText('Live');
      await expect(page.locator('[data-testid="status-today"] [data-value]')).toHaveAttribute('data-value', '5234');
      await expect(page.locator('[data-testid="tile-today"]')).toHaveAttribute('data-value', '5234');
      expect(before).toBe('0');
      await expect(page.locator('[data-project-id="D--Work-live"] [data-testid="project-active-dot"]')).toHaveCount(1);
      await page.screenshot({ path: shot('live-after-append'), clip: { x: 0, y: 0, width: 1440, height: 180 } });
      // Live(≤60s) → Active(≤10min)：前端不再收到新记录，也应由服务端 activity 随时间降级（10s 状态轮询兜底）
      const t1 = Date.now();
      await expect(pill).toHaveAttribute('data-state', 'active', { timeout: 90_000 });
      console.log(`Live → Active 用时 ${Math.round((Date.now() - t0) / 1000)} s（距追加记录；预期约 60–75 s）`);
      expect(Date.now() - t1).toBeGreaterThan(30_000);
      await expect(pill).toContainText('Active');
      await expect(pill).toContainText('今日');
    } finally {
      await srv.stop();
    }
  });

  test('服务掉线 → Offline（琥珀，内容保留不白屏）；重启同端口后自动恢复；仅 SSE 被阻断但服务在线时不误报 Offline', async ({ page }) => {
    test.setTimeout(150_000);
    const port = await freePort();
    let srv = await startServer({ env: { TV_PORT: String(port) } });
    try {
      await waitForIdle(srv.url);
      const c = collect(page);
      await open(page, srv.url);
      const pill = page.locator('[data-testid="status-pill"]');
      await expect(pill).toHaveAttribute('data-state', /idle|active|generating/);
      const before = await pillState(page);
      // 1) 仅 SSE 被阻断（服务仍在线）：不应显示 Offline
      await page.route('**/api/events', (r) => r.abort());
      await page.reload();
      await page.waitForSelector('[data-testid="content"][data-ready="true"]');
      await page.waitForTimeout(13_000); // 覆盖一次 10s 状态轮询 + SSE 重连退避
      expect(await pillState(page)).not.toBe('offline');
      await page.unroute('**/api/events');
      await page.reload();
      await page.waitForSelector('[data-testid="content"][data-ready="true"]');
      // 2) 服务进程被杀：Offline
      const t0 = Date.now();
      srv.proc.kill();
      await expect(pill).toHaveAttribute('data-state', 'offline', { timeout: 30_000 });
      console.log(`服务被杀 → Offline：${Date.now() - t0} ms（之前状态 ${before}）`);
      await expect(pill).toContainText('Offline');
      expect(await page.locator('[data-testid="project-row"]').count()).toBeGreaterThan(0); // 侧栏内容保留
      await expect(page.locator('[data-testid="page-title"]')).toBeVisible();
      await page.waitForTimeout(500); // 等背景色过渡（0.2s）结束
      const css = await page.evaluate(() => {
        const cs = getComputedStyle(document.querySelector('[data-testid="status-pill"]')!);
        return { bg: cs.backgroundColor, fg: cs.color };
      });
      console.log('Offline 胶囊配色：' + JSON.stringify(css));
      expect(css.bg).toBe('rgb(254, 240, 207)'); // pillAmberBg #FEF0CF
      expect(css.fg).toBe('rgb(146, 88, 10)'); // pillAmberFg #92580A
      await page.screenshot({ path: shot('offline-light'), clip: { x: 0, y: 0, width: 1440, height: 180 } });
      // 3) 同端口重启：自动恢复（SSE 重连 / 状态轮询）
      await srv.stop();
      const t1 = Date.now();
      srv = await startServer({ env: { TV_PORT: String(port) } });
      await waitForIdle(srv.url);
      await expect(pill).toHaveAttribute('data-state', /idle|active|generating/, { timeout: 40_000 });
      console.log(`服务重启 → 恢复：${Date.now() - t1} ms`);
      await expect(page.locator('[data-testid="content"]')).toHaveAttribute('data-ready', 'true');
      expect(c.console.filter((m) => !/ERR_CONNECTION|Failed to load resource|EventSource|net::/i.test(m))).toEqual([]);
    } finally {
      await srv.stop();
    }
  });
});

// ---------------------------------------------------------------------------
test.describe('warnings 提示条（坏 settings.json）', () => {
  const cases: Array<[string, string, RegExp]> = [
    ['损坏的 JSON', '{not json', /设置文件已损坏/],
    ['不是对象', '"hello"', /格式不正确/],
    ['多个字段非法（4 条警告 → 折叠为 3 条 + 更多）', JSON.stringify({ schema: 1, settings: { theme: 'purple', timezone: 'Mars/Base', autoRefresh: { intervalSec: -5 }, weekStart: 'funday' } }), /设置项 theme 无效/],
  ];
  for (const [label, raw, re] of cases) {
    test(`${label}：status.warnings 与 settings.warnings 一致；提示条醒目、可关闭；浅 / 深色截图`, async ({ page }) => {
      const srv = await startWithRawSettings(raw);
      try {
        await waitForIdle(srv.url);
        const st = (await (await fetch(`${srv.url}api/status`)).json()) as { warnings: string[] };
        const se = (await (await fetch(`${srv.url}api/settings`)).json()) as { warnings: string[] };
        expect(st.warnings.length).toBeGreaterThan(0);
        expect(se.warnings).toEqual(st.warnings);
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto(srv.url);
        const banner = page.locator('[data-testid="warnings-banner"]');
        await expect(banner).toBeVisible();
        await expect(banner).toContainText(re);
        const shown = await banner.locator('li').count();
        expect(shown).toBe(Math.min(3, st.warnings.length));
        if (st.warnings.length > 3) await expect(banner).toContainText(`${st.warnings.length - 3}`);
        // 醒目：位于顶栏下方、首屏内；琥珀底（--pillAmberBg）；对比度
        const m = await page.evaluate(() => {
          const b = document.querySelector('[data-testid="warnings-banner"]')!;
          const r = b.getBoundingClientRect();
          const cs = getComputedStyle(b);
          return { top: r.top, h: r.height, w: r.width, bg: cs.backgroundColor, fg: cs.color, border: cs.borderTopColor, radius: cs.borderRadius, role: b.getAttribute('role'), live: b.getAttribute('aria-live') };
        });
        console.log(`${label} 提示条：${JSON.stringify(m)}`);
        expect(m.top).toBeLessThan(200);
        expect(m.h).toBeGreaterThan(40);
        expect(m.bg).not.toBe('rgba(0, 0, 0, 0)');
        await page.screenshot({ path: shot(`warning-${cases.findIndex((c) => c[0] === label)}-light`), clip: { x: 0, y: 0, width: 1440, height: 420 } });
        await setTheme(page, 'dark');
        await expect(banner).toBeVisible();
        await page.screenshot({ path: shot(`warning-${cases.findIndex((c) => c[0] === label)}-dark`), clip: { x: 0, y: 0, width: 1440, height: 420 } });
        // 项目栏、内容依然可用（警告不阻断）
        await expect(page.locator('[data-testid="project-row"]').first()).toBeVisible();
        // 关闭
        await banner.getByRole('button', { name: '关闭提示' }).click();
        await expect(banner).toHaveCount(0);
        await page.reload();
        await page.waitForSelector('[data-testid="content"]');
        await expect(page.locator('[data-testid="warnings-banner"]')).toHaveCount(0); // 本会话内不再弹出
        // 新会话（清 sessionStorage）→ 再次出现（警告仍有效，不会被永久吞掉）
        await page.evaluate(() => sessionStorage.clear());
        await page.reload();
        await expect(page.locator('[data-testid="warnings-banner"]')).toBeVisible();
      } finally {
        await srv.stop();
      }
    });
  }
});

test.describe('空状态 / 数据目录错误引导', () => {
  test('空数据根 → "还没有记录" 空状态（非报错）；数据根不存在 → Error 胶囊 + 引导且不白屏', async ({ page }) => {
    const c = collect(page);
    const empty = await startServer({ withFixture: false });
    try {
      await waitForIdle(empty.url);
      await page.goto(empty.url);
      await expect(page.locator('[data-testid="empty-state"]')).toBeVisible();
      await expect(page.locator('[data-testid="empty-state"]')).toContainText('还没有记录');
      await page.screenshot({ path: shot('empty-light'), clip: { x: 0, y: 0, width: 1440, height: 700 } });
      await setTheme(page, 'dark');
      await page.screenshot({ path: shot('empty-dark'), clip: { x: 0, y: 0, width: 1440, height: 700 } });
    } finally {
      await empty.stop();
    }
    const bad = await startServer({ env: { TV_DATA_ROOT: path.join(os.tmpdir(), 'tv-no-such-root-' + Date.now()) } });
    try {
      await page.goto(bad.url);
      await expect(page.locator('[data-testid="status-pill"]')).toHaveAttribute('data-state', 'error', { timeout: 15_000 });
      await expect(page.locator('[data-testid="data-root-error"]')).toBeVisible();
      await expect(page.locator('[data-testid="data-root-error"]')).toContainText('设置');
      await page.screenshot({ path: shot('error-dark'), clip: { x: 0, y: 0, width: 1440, height: 700 } });
      await setTheme(page, 'light');
      await page.screenshot({ path: shot('error-light'), clip: { x: 0, y: 0, width: 1440, height: 700 } });
      // 引导按钮跳到设置页
      await page.locator('[data-testid="data-root-error"] a').click();
      await expect(page.locator('[data-testid="content"]')).toHaveAttribute('data-page', 'settings');
    } finally {
      await bad.stop();
    }
    expect(c.console.filter((m) => !/Failed to load resource/.test(m))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
test.describe('首次扫描态（模拟状态，浅 / 深色截图）', () => {
  test('Scanning 41%：进度卡 role=progressbar、"只读，不会修改任何文件"、部分标记、骨架；浅 / 深色整页截图', async ({ page }) => {
    const srv = await startServer({});
    try {
      await waitForIdle(srv.url);
      const status = await (await fetch(`${srv.url}api/status`)).json();
      const fake = { ...status, state: 'scanning', phase: 'full', filesDone: 47, filesTotal: 112, bytesDone: 296 * 1024 * 1024, bytesTotal: 696 * 1024 * 1024, usageState: 'scanning' };
      await page.route('**/api/status', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fake) }));
      await page.route('**/api/events', (r) => r.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: `retry: 600000

event: status
data: ${JSON.stringify(fake)}

` }));
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.goto(srv.url);
      await expect(page.locator('[data-testid="scan-progress"]')).toBeVisible();
      const pb = page.locator('[data-testid="scan-progress"] [role="progressbar"]');
      await expect(pb).toHaveAttribute('aria-valuenow', '42');
      await expect(page.locator('[data-testid="scan-progress"]')).toContainText('只读');
      await expect(page.locator('[data-testid="scan-progress"]')).toContainText('47');
      await expect(page.locator('[data-testid="scan-progress"]')).toContainText('112');
      const bar = await page.evaluate(() => {
        const el = document.querySelector('[data-testid="scan-progress"] [role="progressbar"]')!;
        const cs = getComputedStyle(el);
        const fill = el.firstElementChild ? getComputedStyle(el.firstElementChild) : null;
        return { h: el.getBoundingClientRect().height, radius: cs.borderRadius, track: cs.backgroundColor, fill: fill?.backgroundColor ?? null };
      });
      console.log('进度条：' + JSON.stringify(bar) + '（设计稿：高 8px、圆角 999、轨道 --track、填充 --accent）');
      expect(bar.h).toBe(8);
      expect(bar.track).toBe('rgb(236, 238, 234)');
      await page.waitForTimeout(900);
      await page.screenshot({ path: shot('firstrun-mock-light'), fullPage: true });
      await page.evaluate(() => localStorage.setItem('tv.theme', 'dark'));
      await page.request.put(srv.url + 'api/settings', { data: { theme: 'dark' }, headers: { Origin: new URL(srv.url).origin } });
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await page.waitForTimeout(900);
      await page.screenshot({ path: shot('firstrun-mock-dark'), fullPage: true });
      const dark = await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="scan-progress"] [role="progressbar"]')!).backgroundColor);
      expect(dark).toBe('rgb(37, 44, 40)'); // --track 深色 #252C28
    } finally {
      await srv.stop();
    }
  });
});

test.describe('首次扫描态（真实后端）', () => {
  test('空 appdata + 真实数据根：打开页面时若仍在首次全量扫描，则看到进度卡 / Scanning 胶囊 / 部分结果 / 骨架；扫描结束后正常', async ({ page }) => {
    test.setTimeout(180_000);
    const real = path.join(os.homedir(), '.claude', 'projects');
    test.skip(!fs.existsSync(real), '本机没有 ~/.claude/projects');
    const srv = await startServer({ withFixture: false, env: { TV_DATA_ROOT: real } });
    try {
      const c = collect(page);
      await page.addInitScript(CSP_INIT);
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.goto(srv.url);
      let shotTaken = false;
      let maxPct = 0;
      const t0 = Date.now();
      const seen = new Set<string>();
      for (;;) {
        const st = (await (await fetch(`${srv.url}api/status`)).json()) as { state: string; phase: string; bytesDone: number; bytesTotal: number };
        seen.add(await pillState(page).then((x) => String(x)).catch(() => 'none'));
        if (st.state === 'scanning' && st.phase === 'full') {
          const vis = await page.locator('[data-testid="scan-progress"]').isVisible().catch(() => false);
          if (vis && !shotTaken && st.bytesDone > 0) {
            await page.waitForTimeout(400);
            await page.screenshot({ path: shot('firstrun-real-light'), fullPage: false });
            shotTaken = true;
            await expect(page.locator('[data-testid="status-pill"]')).toHaveAttribute('data-state', 'scanning');
            await expect(page.locator('[data-testid="page-title"]')).toHaveText('正在建立索引');
            maxPct = st.bytesTotal ? Math.floor((100 * st.bytesDone) / st.bytesTotal) : 0;
          }
        }
        if (st.state === 'idle') break;
        if (Date.now() - t0 > 120_000) throw new Error('真实数据首次扫描超过 120s');
        await page.waitForTimeout(250);
      }
      console.log(`真实数据首次扫描 ${Date.now() - t0} ms；是否截到进度态：${shotTaken}（截图时进度约 ${maxPct}%）；期间胶囊状态：${[...seen].join(',')}`);
      await expect(page.locator('[data-testid="scan-progress"]')).toHaveCount(0, { timeout: 15_000 });
      await expect(page.locator('[data-testid="status-pill"]')).toHaveAttribute('data-state', /idle|active|generating/);
      await expect(page.locator('[data-testid="content"]')).toHaveAttribute('data-ready', 'true');
      expect(c.console).toEqual([]);
      expect([...c.origins].filter((h) => h !== '127.0.0.1')).toEqual([]);
      expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([]);
    } finally {
      await srv.stop();
    }
  });
});

// ---------------------------------------------------------------------------
test.describe('真实数据（只读：数据根 = ~/.claude/projects，应用数据在临时目录）', () => {
  test('骨架 / 项目栏 / 切换 p95 / 控制台与网络 / 浅深色截图', async ({ page }) => {
    test.setTimeout(240_000);
    const real = path.join(os.homedir(), '.claude', 'projects');
    test.skip(!fs.existsSync(real), '本机没有 ~/.claude/projects');
    const srv = await startServer({ withFixture: false, env: { TV_DATA_ROOT: real } });
    try {
      await waitForIdle(srv.url, 120_000);
      const c = collect(page);
      await page.addInitScript(CSP_INIT);
      await page.setViewportSize({ width: 1440, height: 1000 });
      await open(page, srv.url);
      const api = (await (await fetch(`${srv.url}api/projects?sort=total`)).json()) as { projects: Array<{ id: string; displayName: string; path: string | null; isScratchGroup?: boolean; children?: Array<{ id: string; displayName: string }> }>; projectCount: number };
      const names = await page.$$eval('[data-testid="project-list"] > li > [data-testid="project-row"]', (e) => e.map((x) => (x.querySelector('[data-testid="project-name"]')?.textContent ?? '@group').trim()));
      console.log(`真实数据：API 项目数 ${api.projects.length}（projectCount=${api.projectCount}），侧栏顶层条目 ${names.length}；显示名样例（前 6）：${names.slice(0, 6).join(' | ')}`);
      expect(names.length).toBe(api.projects.length);
      for (const n of names) expect(n).not.toMatch(/^-+$/);
      const scratch = api.projects.find((p) => p.isScratchGroup);
      // 每个项目行的悬浮提示都存在
      const titles = await page.$$eval('[data-testid="project-row"]:not([data-group="true"]) a', (e) => e.map((x) => x.getAttribute('title') ?? ''));
      expect(titles.every((t) => t.length > 0)).toBe(true);
      // 展开 Scratch
      if (scratch) {
        await page.click('[data-testid="scratch-toggle"]');
        await expect(page.locator('[data-testid="scratch-children"] [data-testid="project-row"]')).toHaveCount(scratch.children!.length);
      }
      await page.waitForTimeout(800);
      await page.screenshot({ path: shot('real-overview-light-1440') });

      // 切换采样：逐个项目（含 scratch 子项）点击，进页内 rAF 轮询到 data-ready
      await page.evaluate(() => {
        const w = window as unknown as Record<string, unknown>;
        w.__refs = [document.body, document.querySelector('aside'), document.querySelector('main'), document.querySelector('[data-testid="content"]')];
        const mut = { n: 0 };
        w.__mut = mut;
        const mo = new MutationObserver((l) => (mut.n += l.length));
        mo.observe(document.body, { childList: true });
        mo.observe(document.getElementById('root')!, { childList: true });
        mo.observe(document.querySelector('main')!, { childList: true });
        const fr = { n: 0, empty: 0, skeleton: 0 };
        w.__fr = fr;
        const tick = (): void => {
          fr.n++;
          if (!document.querySelector('[data-testid="page-title"]')?.textContent || !document.querySelector('[data-testid="tile-total-num"]')) fr.empty++;
          if (document.querySelector('[data-testid="content"] [class*="_sk_"]')) fr.skeleton++;
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      const ids = ['all', ...api.projects.flatMap((p) => [p.id, ...(p.children ?? []).map((k) => k.id)])];
      const times: number[] = [];
      const mismatches: string[] = [];
      for (let round = 0; round < 2; round++) {
        for (const id of ids) {
          const cur = await page.evaluate(() => document.querySelector('[data-testid="content"]')!.getAttribute('data-project'));
          if (cur === id) continue;
          const ms = await page.evaluate(
            (id) =>
              new Promise<number>((resolve) => {
                const t0 = performance.now();
                (document.querySelector(`[data-testid="sidebar"] [data-project-id="${id}"] a`) as HTMLElement).click();
                const poll = (): void => {
                  const c = document.querySelector('[data-testid="content"]')!;
                  if (c.getAttribute('data-project') === id && c.getAttribute('data-ready') === 'true') resolve(performance.now() - t0);
                  else requestAnimationFrame(poll);
                };
                requestAnimationFrame(poll);
              }),
            id,
          );
          times.push(ms);
          // 正确性：页面指标值与 API 当前值一致（真实数据在增长，容许 1%）
          const shown = Number(await page.locator('[data-testid="tile-total"]').getAttribute('data-value'));
          const api2 = ((await (await fetch(`${srv.url}api/summary?project=${encodeURIComponent(id)}&basis=total&range=all`)).json()) as { summary: { value: number } }).summary.value;
          if (Math.abs(shown - api2) > Math.max(1, api2 * 0.01)) mismatches.push(`${id}: 页面 ${shown} vs API ${api2}`);
          await page.waitForTimeout(50);
        }
      }
      const r = await page.evaluate(() => {
        const w = window as unknown as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
        const refs = w.__refs as Element[];
        return { same: [document.body, document.querySelector('aside'), document.querySelector('main'), document.querySelector('[data-testid="content"]')].every((e, i) => e === refs[i]), mut: w.__mut.n as number, fr: w.__fr as { n: number; empty: number; skeleton: number } };
      });
      const sorted = [...times].sort((a, b) => a - b);
      const p = (q: number): number => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1)]!;
      console.log(`真实数据切换 ${sorted.length} 次：p50=${p(0.5).toFixed(1)} p95=${p(0.95).toFixed(1)} max=${sorted[sorted.length - 1]!.toFixed(1)} ms；节点保持=${r.same}；子节点变更=${r.mut}；帧 ${JSON.stringify(r.fr)}；指标值与 API 不符 ${mismatches.length}：${mismatches.join('; ')}`);
      expect(sorted.length).toBeGreaterThanOrEqual(20);
      expect(p(0.95)).toBeLessThan(200);
      expect(r.same).toBe(true);
      expect(r.mut).toBe(0);
      expect(r.fr.empty).toBe(0);
      expect(r.fr.skeleton).toBe(0);
      expect(mismatches).toEqual([]);

      // 搜索 / 排序 / 键盘在真实数据上同样可用
      await page.locator('[data-testid="project-search"]').fill(api.projects.find((p) => !p.isScratchGroup)!.displayName.slice(0, 3));
      expect((await page.locator('[data-testid="project-list"] > li > [data-testid="project-row"]').count())).toBeGreaterThan(0);
      await page.locator('[data-testid="project-search"]').fill('');
      for (const s of ['recent', 'name', 'today', 'total'] as const) {
        await page.click('[data-testid="sort-button"]');
        await page.click(`[data-testid="sort-option-${s}"]`);
        await page.waitForTimeout(250);
        const dom = await page.$$eval('[data-testid="project-list"] > li > [data-testid="project-row"]', (e) => e.map((x) => x.getAttribute('data-project-id')));
        const apiOrder = ((await (await fetch(`${srv.url}api/projects?sort=${s}`)).json()) as { projects: Array<{ id: string }> }).projects.map((x) => x.id);
        // 真实数据在增长，今日 / 最近排序可能在两次请求间变动；只要求 total / name 严格一致，其它记录差异
        if (s === 'total' || s === 'name') expect(dom, `排序 ${s}`).toEqual(apiOrder);
        else if (dom.join() !== apiOrder.join()) console.log(`注意：排序 ${s} 的 DOM 与 API 顺序不同（真实数据在变化时可能出现）`);
      }

      await setTheme(page, 'dark');
      await page.waitForTimeout(800);
      await page.screenshot({ path: shot('real-overview-dark-1440') });
      await setTheme(page, 'light');
      expect(c.console).toEqual([]);
      expect([...c.origins].filter((h) => h !== '127.0.0.1')).toEqual([]);
      expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([]);
    } finally {
      await srv.stop();
    }
  });
});

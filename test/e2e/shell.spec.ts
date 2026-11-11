/**
 * 外壳 / 引导 E2E：首次引导弹窗、设置页点项目回总览、顶栏与项目栏固定（只有内容区滚动）、图表悬浮提示。
 * 运行：先 npm run build，再 npx playwright test -c test/e2e/playwright.config.ts shell
 */
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { startServer, waitForIdle } from './server.ts';
import type { TestServer } from './server.ts';

const NOW = '2026-10-20T12:00:00.000Z';
const settingsOf = async (srv: TestServer): Promise<any> => ((await (await fetch(`${srv.url}api/settings`)).json()) as any).settings;

async function open(page: Page, srv: TestServer, hash = ''): Promise<void> {
  await page.goto(`${srv.url}${hash}`);
  await page.waitForSelector('[data-testid="content"]');
}

test.describe('首次引导', () => {
  test('首次启动弹出；选档位 + 续费日 → 完成后写入设置且不再弹出', async ({ page }) => {
    const srv = await startServer({ env: { TV_NOW: NOW }, onboarded: false });
    try {
      await waitForIdle(srv.url);
      await open(page, srv);
      const dlg = page.getByTestId('onboarding');
      await expect(dlg).toBeVisible();
      await page.getByTestId('onboarding-plan').getByRole('button', { name: 'Max 5x' }).click();
      await expect(page.getByTestId('onboarding-fee')).toHaveValue('100');
      await page.getByTestId('onboarding-day').selectOption('15');
      await page.getByTestId('onboarding-done').click();
      await expect(dlg).toHaveCount(0);
      const s = await settingsOf(srv);
      expect(s.onboarded).toBe(true);
      expect(s.subscription).toMatchObject({ plan: 'max5x', monthlyFeeUsd: 100, billingDay: 15 });
      await page.reload();
      await page.waitForSelector('[data-testid="content"]');
      await expect(page.getByTestId('onboarding')).toHaveCount(0);
    } finally {
      await srv.stop();
    }
  });

  test('"稍后设置"与 Esc 只标记已引导，不改订阅；已引导的用户不会被打扰', async ({ page }) => {
    const srv = await startServer({ env: { TV_NOW: NOW }, onboarded: false });
    try {
      await waitForIdle(srv.url);
      await open(page, srv);
      await page.getByTestId('onboarding-skip').click();
      await expect(page.getByTestId('onboarding')).toHaveCount(0);
      const s = await settingsOf(srv);
      expect(s.onboarded).toBe(true);
      expect(s.subscription.plan).toBeNull();
    } finally {
      await srv.stop();
    }
    const srv2 = await startServer({ env: { TV_NOW: NOW }, onboarded: false });
    try {
      await waitForIdle(srv2.url);
      await open(page, srv2);
      await expect(page.getByTestId('onboarding')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('onboarding')).toHaveCount(0);
      expect((await settingsOf(srv2)).onboarded).toBe(true);
    } finally {
      await srv2.stop();
    }
    // 老用户：设置文件里已有档位、没有 onboarded 字段 → 不弹
    const srv3 = await startServer({ env: { TV_NOW: NOW }, onboarded: false, settingsJson: { schema: 1, settings: { subscription: { plan: 'pro', monthlyFeeUsd: 20 } } } });
    try {
      await waitForIdle(srv3.url);
      await open(page, srv3);
      await expect(page.getByTestId('onboarding')).toHaveCount(0);
    } finally {
      await srv3.stop();
    }
  });
});

test.describe('外壳', () => {
  let srv: TestServer;
  test.beforeAll(async () => {
    srv = await startServer({ env: { TV_NOW: NOW } });
    await waitForIdle(srv.url);
  });
  test.afterAll(async () => {
    await srv.stop();
  });

  test('在设置页点左侧项目 → 跳到该项目的总览（含"全部项目"）', async ({ page }) => {
    await open(page, srv, '#/settings');
    await expect(page.getByTestId('content')).toHaveAttribute('data-page', 'settings');
    const row = page.getByTestId('project-row').first();
    const id = await row.getAttribute('data-project-id');
    await row.locator('a').first().click();
    await expect(page.getByTestId('content')).toHaveAttribute('data-page', 'overview');
    await expect(page.getByTestId('content')).toHaveAttribute('data-project', id!);
    await page.goto(`${srv.url}#/settings`);
    await page.getByTestId('project-row-all').locator('a').click();
    await expect(page.getByTestId('content')).toHaveAttribute('data-page', 'overview');
    // 在分析页点项目仍留在分析页
    await page.goto(`${srv.url}#/analysis`);
    await page.getByTestId('project-row').first().locator('a').click();
    await expect(page.getByTestId('content')).toHaveAttribute('data-page', 'analysis');
  });

  test('只有内容区滚动：顶栏与项目栏位置不变，页面本身不滚动', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 520 });
    await open(page, srv, '#/settings');
    await page.waitForSelector('[data-testid="content"][data-ready="true"]');
    const pos = async () => ({
      header: (await page.locator('header').boundingBox())!.y,
      sidebar: (await page.getByTestId('sidebar').boundingBox())!.y,
    });
    const before = await pos();
    const main = page.locator('#main');
    const dims = await main.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }));
    expect(dims.sh).toBeGreaterThan(dims.ch);
    await main.evaluate((el) => el.scrollTo({ top: 400 }));
    expect(await main.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    expect(await pos()).toEqual(before);
    expect(await page.evaluate(() => document.scrollingElement!.scrollTop)).toBe(0);
    // 切页后内容区回到顶部
    await page.getByRole('link', { name: '分析' }).first().click();
    await expect(page.getByTestId('content')).toHaveAttribute('data-page', 'analysis');
    expect(await main.evaluate((el) => el.scrollTop)).toBe(0);
  });

  test('下拉菜单永远在最上层：不被左侧项目栏盖住，也不被内容区裁掉（窄 / 宽窗口、范围 / 模型 / 导出）', async ({ page }) => {
    for (const width of [1000, 1440]) {
      await page.setViewportSize({ width, height: 800 });
      await open(page, srv, '#/overview');
      await page.waitForSelector('[data-testid="content"][data-ready="true"]');
      for (const [btn, pop] of [['range-button', '[role="listbox"]'], ['models-button', '[data-testid="filter-bar"] [role="dialog"]'], ['export-button', '[data-testid="export-pop"]']] as const) {
        await page.getByTestId(btn).click();
        const panel = page.locator(pop).first();
        await expect(panel).toBeVisible();
        const b = (await panel.boundingBox())!;
        expect(b.x, `${btn}@${width} 左边缘在视口内`).toBeGreaterThanOrEqual(0);
        expect(b.x + b.width, `${btn}@${width} 右边缘在视口内`).toBeLessThanOrEqual(width);
        // 面板四角与中心点命中的都是面板自己（没有被项目栏 / 其它元素盖住）
        const hits = await panel.evaluate((el) => {
          const r = el.getBoundingClientRect();
          return [[r.left + 6, r.top + 6], [r.right - 6, r.top + 6], [r.left + 6, r.bottom - 6], [r.right - 6, r.bottom - 6], [r.left + r.width / 2, r.top + r.height / 2]].map(([x, y]) => el.contains(document.elementFromPoint(x!, y!)));
        });
        expect(hits, `${btn}@${width} 不被遮挡`).toEqual([true, true, true, true, true]);
        await page.keyboard.press('Escape');
        await expect(panel).toHaveCount(0);
      }
    }
  });

  test('Token 时间曲线：悬浮提示不透明，且出现时隐藏峰值标签', async ({ page }) => {
    await open(page, srv, '#/overview');
    await page.waitForSelector('[data-testid="content"][data-ready="true"]');
    const chart = page.getByTestId('time-chart').first();
    await chart.scrollIntoViewIfNeeded(); const box = (await chart.boundingBox())!;
    await page.mouse.move(box.x + 20, box.y + 100);
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5, { steps: 8 });
    await page.waitForTimeout(150);
    const tip = page.locator('div[style*="z-index"]:has-text("次请求")').first();
    await expect(tip).toBeVisible();
    const opacity = await tip.evaluate((el) => getComputedStyle(el).opacity);
    expect(Number(opacity)).toBe(1);
    const tb = (await tip.boundingBox())!;
    expect(tb.x).toBeGreaterThanOrEqual(box.x - 1);
    expect(tb.x + tb.width).toBeLessThanOrEqual(box.x + box.width + 1);
  });
});

test.describe('JPG 导出', () => {
  let srv: TestServer;
  test.beforeAll(async () => {
    srv = await startServer({ env: { TV_NOW: NOW }, settingsJson: { schema: 1, settings: { timezone: 'Asia/Shanghai', theme: 'light', subscription: { plan: 'max5x', monthlyFeeUsd: 100, billingDay: 15 } } } });
    await waitForIdle(srv.url);
  });
  test.afterAll(async () => {
    await srv.stop();
  });

  /** 读 JPEG 头里的宽高（SOF 段）。 */
  function jpegSize(buf: Buffer): { w: number; h: number } | null {
    if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
    let i = 2;
    while (i < buf.length) {
      if (buf[i] !== 0xff) return null;
      const marker = buf[i + 1]!;
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
      i += 2 + len;
    }
    return null;
  }

  for (const [name, hash] of [['overview', '#/overview'], ['cost', '#/cost'], ['sessions', '#/sessions']] as const) {
    test(`导出 JPG：${name} 页整页渲染（内容区全高，不含顶栏 / 项目栏），文件名与格式正确`, async ({ page }, info) => {
      await page.setViewportSize({ width: 1280, height: 720 });
      await open(page, srv, hash);
      await page.waitForSelector('[data-testid="content"][data-ready="true"]');
      await page.waitForTimeout(900);
      const contentH = await page.locator('#main [data-testid="content"]').evaluate((el) => el.scrollHeight);
      expect(contentH).toBeGreaterThan(720); // 需要滚动才能看全 = 能证明导出的不是一屏截图
      await page.getByTestId('export-button').click();
      await page.getByTestId('export-format').getByRole('button', { name: 'JPG' }).click();
      await expect(page.getByTestId('export-kind')).toHaveCount(0); // JPG 与粒度无关
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), page.getByTestId('export-download').click()]);
      const fname = dl.suggestedFilename();
      expect(fname.startsWith(`token-visualizer-${name}-`) && /-[0-9]{8}-[0-9]{4}[.]jpg$/.test(fname), fname).toBe(true);
      const out = info.outputPath(`${name}.jpg`);
      await dl.saveAs(out);
      const buf = fs.readFileSync(out);
      const size = jpegSize(buf);
      expect(size, '是有效的 JPEG').not.toBeNull();
      // 逻辑宽 = 内容宽 + 2×24；高 = 内容高 + 2×24；倍率 ≤ 2
      const ratio = size!.h / (contentH + 48);
      expect(ratio).toBeGreaterThan(0.9);
      expect(ratio).toBeLessThanOrEqual(2.01);
      fs.mkdirSync(path.resolve(import.meta.dirname, '..', 'screenshots', 'export'), { recursive: true });
      fs.copyFileSync(out, path.resolve(import.meta.dirname, '..', 'screenshots', 'export', `${name}.jpg`));
      await expect(page.getByTestId('export-error')).toHaveCount(0);
      // 页面状态不受影响（面板已关闭、内容仍在）
      await expect(page.getByTestId('export-pop')).toHaveCount(0);
    });
  }
});

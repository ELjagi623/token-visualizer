/**
 * 语言 E2E：默认英文、首次引导里的语言切换、设置页顶部的语言切换，以及英文下的布局冒烟
 * （逐页、三种宽度：不允许文字被截断 / 横向溢出 / 互相重叠）。
 * 运行：先 npm run build，再 npx playwright test -c test/e2e/playwright.config.ts i18n
 */
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { startServer, waitForIdle } from './server.ts';
import type { TestServer } from './server.ts';

const NOW = '2026-10-20T12:00:00.000Z';
const SHOTS = path.resolve(import.meta.dirname, '..', 'screenshots', 'i18n');
fs.mkdirSync(SHOTS, { recursive: true });
const settingsOf = async (srv: TestServer): Promise<any> => ((await (await fetch(`${srv.url}api/settings`)).json()) as any).settings;

async function open(page: Page, srv: TestServer, hash = ''): Promise<void> {
  await page.goto(`${srv.url}${hash}`);
  await page.waitForSelector('[data-testid="content"]');
}

test.describe('默认英文与语言切换', () => {
  test('真正的首次启动：界面与引导都是英文，引导里可切到中文，选择写入设置并在刷新后保持', async ({ page }) => {
    const srv = await startServer({ env: { TV_NOW: NOW }, fresh: true });
    try {
      await waitForIdle(srv.url);
      await open(page, srv);
      expect(await page.evaluate(() => document.documentElement.lang)).toBe('en');
      const dlg = page.getByTestId('onboarding');
      await expect(dlg).toBeVisible();
      await expect(dlg.getByRole('heading')).toHaveText('Set up your plan first');
      await expect(page.getByRole('navigation').getByRole('link', { name: 'Overview' })).toBeVisible();
      const toggle = page.getByTestId('onboarding-language');
      await expect(toggle.getByRole('button', { name: 'English' })).toHaveAttribute('aria-pressed', 'true');
      await toggle.getByRole('button', { name: '中文' }).click();
      await expect(dlg.getByRole('heading')).toHaveText('先设置你的订阅');
      await expect(page.getByRole('navigation').getByRole('link', { name: '总览' })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.lang)).toBe('zh-CN');
      expect((await settingsOf(srv)).language).toBe('zh');
      expect((await settingsOf(srv)).onboarded).toBe(false); // 只是换了语言，引导还没处理
      await page.reload();
      await page.waitForSelector('[data-testid="content"]');
      await expect(page.getByTestId('onboarding').getByRole('heading')).toHaveText('先设置你的订阅');
    } finally {
      await srv.stop();
    }
  });

  test('设置页最上面是语言：切换后顶栏 / 标题 / <html lang> 立即变化，刷新后保持', async ({ page }) => {
    const srv = await startServer({ env: { TV_NOW: NOW }, language: 'en' });
    try {
      await waitForIdle(srv.url);
      await open(page, srv, '#/settings');
      await page.waitForSelector('[data-testid="content"][data-ready="true"]');
      // 语言分区是设置页的第一个分区
      const first = page.locator('[data-testid="content"] section').first();
      await expect(first).toHaveAttribute('data-testid', 'settings-language-section');
      await expect(page.getByTestId('page-title')).toHaveText('Settings');
      await page.getByTestId('settings-language').getByRole('button', { name: '中文' }).click();
      await expect(page.getByTestId('page-title')).toHaveText('设置');
      await expect(page.getByRole('navigation').getByRole('link', { name: '分析' })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.lang)).toBe('zh-CN');
      await page.reload();
      await page.waitForSelector('[data-testid="content"][data-ready="true"]');
      await expect(page.getByTestId('page-title')).toHaveText('设置');
      await page.getByTestId('settings-language').getByRole('button', { name: 'English' }).click();
      await expect(page.getByTestId('page-title')).toHaveText('Settings');
      expect((await settingsOf(srv)).language).toBe('en');
    } finally {
      await srv.stop();
    }
  });

  test('已保存中文的老用户：保持中文，不受默认英文影响', async ({ page }) => {
    const srv = await startServer({ env: { TV_NOW: NOW }, settingsJson: { schema: 1, settings: { language: 'zh', subscription: { plan: 'pro', monthlyFeeUsd: 20 } } } });
    try {
      await waitForIdle(srv.url);
      await open(page, srv);
      await expect(page.getByRole('navigation').getByRole('link', { name: '总览' })).toBeVisible();
      await expect(page.getByTestId('onboarding')).toHaveCount(0);
    } finally {
      await srv.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// 布局冒烟（英文）：文字不被截断、不横向溢出、不互相重叠
// ---------------------------------------------------------------------------

interface Issue {
  kind: 'truncated' | 'overflow' | 'overlap';
  text: string;
  detail: string;
}

/** 在页面里执行的检查（序列化后运行，不能引用外部变量）。 */
async function audit(page: Page, rootSel?: string): Promise<Issue[]> {
  return page.evaluate((rootSel) => {
    const root: Element = rootSel ? document.querySelector(rootSel)! : document.body;
    const issues: Array<{ kind: 'truncated' | 'overflow' | 'overlap'; text: string; detail: string }> = [];
    const visible = (el: Element): boolean => {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return false;
      for (let e: Element | null = el; e; e = e.parentElement) {
        const cs = getComputedStyle(e);
        if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
      }
      return true;
    };
    const short = (s: string): string => s.replace(/\s+/g, ' ').trim().slice(0, 60);
    const all = Array.from(root.querySelectorAll('*')).filter((e) => !['SCRIPT', 'STYLE', 'CANVAS', 'SVG', 'PATH'].includes(e.tagName.toUpperCase()));

    // 1) 被截断的文字：overflow 被裁（hidden / ellipsis / clip）且内容比盒子宽
    for (const el of all) {
      if (!visible(el)) continue;
      const cs = getComputedStyle(el);
      const clips = cs.textOverflow === 'ellipsis' || cs.overflowX === 'hidden' || cs.overflowX === 'clip';
      if (!clips || /sr-?only/i.test(el.getAttribute('class') ?? '')) continue; // 屏幕阅读器专用的 1px 元素不算
      const own = Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? '').trim().length > 0);
      if (!own && cs.textOverflow !== 'ellipsis') continue;
      const h = el as HTMLElement;
      if (h.scrollWidth > h.clientWidth + 1 && (el.textContent ?? '').trim().length > 0) {
        issues.push({ kind: 'truncated', text: short(el.textContent ?? ''), detail: `${el.tagName}.${(el.getAttribute('class') ?? '').split(' ')[0]} scrollWidth ${h.scrollWidth} > clientWidth ${h.clientWidth}` });
      }
    }

    // 2) 横向溢出：按钮 / 标签 / 胶囊的文字超出自己的盒子
    for (const el of all) {
      if (!visible(el)) continue;
      const tag = el.tagName;
      if (!['BUTTON', 'A', 'LABEL', 'TH', 'H1', 'H2', 'H3'].includes(tag) && !(el.getAttribute('class') ?? '').match(/pill|chip|badge|tile|seg/i)) continue;
      const h = el as HTMLElement;
      const cs = getComputedStyle(h);
      if (cs.overflowX === 'auto' || cs.overflowX === 'scroll') continue;
      if (h.scrollWidth > h.clientWidth + 1 && cs.display !== 'inline') {
        issues.push({ kind: 'overflow', text: short(h.textContent ?? ''), detail: `${tag}.${(el.getAttribute('class') ?? '').split(' ')[0]} scrollWidth ${h.scrollWidth} > clientWidth ${h.clientWidth}` });
      }
    }

    // 3) 文字互相重叠：取每个文本节点的实际矩形，两两比较（祖先 / 后代之间不算）
    const boxes: Array<{ el: Element; r: DOMRect; text: string }> = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = (n.textContent ?? '').trim();
      const el = n.parentElement;
      if (!t || !el || !visible(el)) continue;
      if (['SCRIPT', 'STYLE'].includes(el.tagName)) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      const r = range.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      // 被滚动容器 / overflow 裁掉的部分不算（取最近的裁剪祖先的可视区）
      let clip: DOMRect | null = null;
      for (let p: Element | null = el; p && p !== document.body; p = p.parentElement) {
        const cs = getComputedStyle(p);
        if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
          const pr = p.getBoundingClientRect();
          clip = clip ? new DOMRect(Math.max(clip.x, pr.x), Math.max(clip.y, pr.y), Math.max(0, Math.min(clip.right, pr.right) - Math.max(clip.x, pr.x)), Math.max(0, Math.min(clip.bottom, pr.bottom) - Math.max(clip.y, pr.y))) : pr;
        }
      }
      let rr = r;
      if (clip) {
        const x = Math.max(r.x, clip.x);
        const y = Math.max(r.y, clip.y);
        const w = Math.min(r.right, clip.right) - x;
        const hh = Math.min(r.bottom, clip.bottom) - y;
        if (w < 2 || hh < 2) continue;
        rr = new DOMRect(x, y, w, hh);
      }
      boxes.push({ el, r: rr, text: t });
    }
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        if (a.el === b.el || a.el.contains(b.el) || b.el.contains(a.el)) {
          if (a.el !== b.el) continue;
        }
        const ox = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
        const oy = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
        if (ox > 3 && oy > 4) {
          // 同一元素内的多个文本节点（换行）不算；不同元素相交才算
          if (a.el === b.el) continue;
          issues.push({ kind: 'overlap', text: `"${short(a.text)}" × "${short(b.text)}"`, detail: `overlap ${Math.round(ox)}×${Math.round(oy)}px` });
        }
      }
    }
    return issues;
  }, rootSel);
}

/** 内容区是唯一的滚动容器：一屏一屏滚下去，每屏都检查，覆盖整页（可视区外的内容会被裁掉，单次检查看不到）。 */
async function auditWholePage(page: Page): Promise<Issue[]> {
  const out: Issue[] = [];
  const main = page.locator('#main');
  const { sh, ch } = await main.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }));
  const step = Math.max(200, Math.floor(ch * 0.7));
  for (let y = 0; y < sh; y += step) {
    await main.evaluate((el, top) => el.scrollTo({ top }), y);
    await page.waitForTimeout(80);
    out.push(...(await audit(page)));
  }
  await main.evaluate((el) => el.scrollTo({ top: 0 }));
  return out;
}

const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 900, height: 700 },
];
const PAGES: Array<[string, string]> = [
  ['overview', '#/overview'],
  ['analysis', '#/analysis'],
  ['sessions', '#/sessions'],
  ['settings', '#/settings'],
  ['cost', '#/cost'],
];

test.describe('英文布局冒烟', () => {
  let srv: TestServer;
  test.beforeAll(async () => {
    // 订阅已设置（成本页 / 回本卡完整显示），英文
    srv = await startServer({ env: { TV_NOW: NOW }, language: 'en', settingsJson: { schema: 1, settings: { timezone: 'Asia/Shanghai', theme: 'light', subscription: { plan: 'max5x', monthlyFeeUsd: 100, billingDay: 15 } } } });
    await waitForIdle(srv.url);
  });
  test.afterAll(async () => {
    await srv.stop();
  });

  for (const vp of VIEWPORTS) {
    for (const [name, hash] of PAGES) {
      test(`${name} @ ${vp.width}px：无截断 / 溢出 / 重叠`, async ({ page }) => {
        await page.setViewportSize(vp);
        await open(page, srv, hash);
        await page.waitForSelector('[data-testid="content"][data-ready="true"]');
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(700); // 等图表与数字动画结束
        await page.screenshot({ path: path.join(SHOTS, `${name}-${vp.width}.png`) });
        // 整页滚动内容区：逐屏检查（固定外壳后只有 #main 滚动）
        const issues = await auditWholePage(page);
        const seen = new Set<string>();
        const uniq = issues.filter((i) => {
          const k = `${i.kind}|${i.text}`;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
        expect(uniq.map((i) => `${i.kind}: ${i.text} — ${i.detail}`)).toEqual([]);
      });
    }
    test(`首次引导 @ ${vp.width}px：无截断 / 溢出 / 重叠`, async ({ page }) => {
      const fresh = await startServer({ env: { TV_NOW: NOW }, fresh: true });
      try {
        await waitForIdle(fresh.url);
        await page.setViewportSize(vp);
        await open(page, fresh);
        await page.getByTestId('onboarding-plan').getByRole('button', { name: 'Custom' }).click();
        await page.waitForTimeout(300);
        await page.screenshot({ path: path.join(SHOTS, `onboarding-${vp.width}.png`) });
        const issues = await audit(page, '[data-testid="onboarding"] [role="dialog"]'); // 只查弹窗本身（背景被遮罩盖住）
        expect(issues.map((i) => `${i.kind}: ${i.text} — ${i.detail}`)).toEqual([]);
      } finally {
        await fresh.stop();
      }
    });
  }
});

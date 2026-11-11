/**
 * 阶段 5 E2E：前端骨架、设计系统、主题、项目栏、状态胶囊、响应式、离线。
 * 运行：先 npm run build，再 npm run test:e2e
 */
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { assistantLine } from '../helpers.ts';
import { startServer, waitForIdle } from './server.ts';
import type { TestServer } from './server.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SHOTS = path.join(ROOT, 'test', 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });

const NOW_ISO = '2026-10-20T12:00:00.000Z';

interface ApiProject {
  id: string;
  displayName: string;
  path: string | null;
  children?: ApiProject[];
}

async function apiProjects(url: string, sort = 'total'): Promise<{ projects: ApiProject[]; projectCount: number }> {
  return (await (await fetch(`${url}api/projects?sort=${sort}`)).json()) as { projects: ApiProject[]; projectCount: number };
}

async function open(page: Page, url: string, hash = ''): Promise<void> {
  // 批次 B 起默认时间范围是近 30 天；这些用例按"全部"范围对账，所以补上 range=all；鼠标放到项目栏上（方向键只在项目栏聚焦 / 悬停时生效）
  if (hash === '' || (hash.startsWith('#/overview') && !hash.includes('range='))) hash = `${hash === '' ? '#/overview' : hash}${hash.includes('?') ? '&' : '?'}range=all`;
  await page.goto(`${url}${hash}`);
  await page.waitForSelector('[data-testid="content"][data-ready="true"]');
  await page.hover('[data-testid="sidebar"]', { timeout: 800 }).catch(() => undefined);
  await page.evaluate(() => document.fonts.ready);
}

async function topLevelNames(page: Page): Promise<string[]> {
  return page.$$eval('[data-testid="project-list"] > li > [data-testid="project-row"]', (els) => els.map((e) => (e.querySelector('[data-testid="project-name"]')?.textContent ?? (e.getAttribute('data-group') === 'true' ? '@group' : '')).trim()));
}

function ratio(fg: string, bg: string): number {
  const parse = (c: string): [number, number, number, number] => {
    const m = /rgba?\(([^)]+)\)/.exec(c);
    const p = (m?.[1] ?? '0,0,0').split(/[ ,/]+/).filter(Boolean).map(Number);
    return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0, p[3] ?? 1];
  };
  const lum = ([r, g, b]: [number, number, number, number]): number => {
    const f = (v: number): number => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const a = lum(parse(fg));
  const b = lum(parse(bg));
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** 取元素文字色与"有效背景色"（向上找第一个不透明背景）。 */
async function colors(page: Page, selector: string): Promise<{ fg: string; bg: string }> {
  return page.$eval(selector, (el) => {
    const fg = getComputedStyle(el).color;
    let n: Element | null = el;
    let bg = 'rgb(255, 255, 255)';
    while (n) {
      const c = getComputedStyle(n).backgroundColor;
      const m = /rgba?\(([^)]+)\)/.exec(c);
      const parts = (m?.[1] ?? '').split(/[ ,/]+/).filter(Boolean).map(Number);
      const alpha = parts[3] ?? 1;
      if (m && alpha > 0.99) {
        bg = c;
        break;
      }
      n = n.parentElement;
    }
    return { fg, bg };
  });
}

// ---------------------------------------------------------------------------
// 主流程：fixture 数据根 + 固定当前时间
// ---------------------------------------------------------------------------

test.describe('前端骨架（fixture）', () => {
  let srv: TestServer;
  test.beforeAll(async () => {
    srv = await startServer({ env: { TV_NOW: NOW_ISO } });
    await waitForIdle(srv.url);
    // 时区固定为 Asia/Shanghai（与 expected 一致）
    const res = await fetch(`${srv.url}api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ timezone: 'Asia/Shanghai' }) });
    expect(res.status).toBe(200);
  });
  test.afterAll(async () => {
    await srv?.stop();
  });

  test('渲染完整骨架；控制台无错误/警告；网络请求全部是 127.0.0.1；字体已加载', async ({ page }) => {
    const consoleIssues: string[] = [];
    const origins = new Set<string>();
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') consoleIssues.push(`${m.type()}: ${m.text()}`);
    });
    page.on('pageerror', (e) => consoleIssues.push(`pageerror: ${e.message}`));
    page.on('request', (r) => origins.add(new URL(r.url()).hostname));

    await open(page, srv.url);
    await expect(page.locator('header')).toBeVisible();
    await expect(page.locator('[data-testid="sidebar"]')).toBeVisible();
    await expect(page.locator('[data-testid="content"]')).toBeVisible();
    await expect(page.locator('nav[aria-label] a')).toHaveCount(4);
    await expect(page.locator('nav a[aria-current="page"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="status-pill"]')).toBeVisible();
    await expect(page.locator('[data-testid="tiles"] > article')).toHaveCount(9);

    // 字体：Outfit 已加载；中文文字用 Noto Sans SC 分片
    const fonts = await page.evaluate(async () => {
      await document.fonts.ready;
      const loaded = [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replaceAll('"', ''));
      return {
        outfit: document.fonts.check('600 40px Outfit'),
        outfitFamilies: [...new Set(loaded)],
        notoCheck: document.fonts.check('600 20px "Noto Sans SC"', '全部项目'),
        bodyFont: getComputedStyle(document.body).fontFamily,
        numericVariant: getComputedStyle(document.body).fontVariantNumeric,
      };
    });
    expect(fonts.outfit).toBe(true);
    expect(fonts.outfitFamilies).toContain('Outfit');
    expect(fonts.outfitFamilies).toContain('Noto Sans SC');
    expect(fonts.notoCheck).toBe(true);
    expect(fonts.bodyFont.startsWith('Outfit')).toBe(true);
    expect(fonts.numericVariant).toContain('tabular-nums');

    await page.waitForTimeout(600);
    expect([...origins]).toEqual(['127.0.0.1']);
    expect(consoleIssues).toEqual([]);
  });

  test('项目栏：条目数、中文用户名项目显示 demo、悬浮完整路径、搜索、Scratch 折叠/展开', async ({ page }) => {
    await open(page, srv.url);
    const api = await apiProjects(srv.url);
    const rows = page.locator('[data-testid="project-list"] > li > [data-testid="project-row"]');
    await expect(rows).toHaveCount(api.projectCount); // Scratch 折叠为 1 项
    expect(api.projectCount).toBe(api.projects.length);

    const demo = page.locator('[data-testid="project-row"][data-project-id="C--Users-----Work-demo"]');
    await expect(demo.locator('[data-testid="project-name"]')).toHaveText('demo');
    await expect(demo.locator('a')).toHaveAttribute('title', 'C:\\Users\\王测试\\Work\\demo');
    await expect(page.locator('[data-testid="project-name"]', { hasText: '-----' })).toHaveCount(0);

    // Scratch 默认折叠，展开后子项数 = scratch 文件夹数
    await expect(page.locator('[data-testid="scratch-children"]')).toHaveCount(0);
    await page.click('[data-testid="scratch-toggle"]');
    await expect(page.locator('[data-testid="scratch-children"] [data-testid="project-row"]')).toHaveCount(3);
    await page.click('[data-testid="scratch-toggle"]');
    await expect(page.locator('[data-testid="scratch-children"]')).toHaveCount(0);

    // 搜索 demo：只剩匹配项（"全部项目" 固定保留）
    await page.fill('[data-testid="project-search"]', 'demo');
    await expect(rows).toHaveCount(1);
    await expect(rows.first().locator('[data-testid="project-name"]')).toHaveText('demo');
    // 按路径搜索（王测试 只出现在 demo 的路径与 scratch 子项的路径里）
    await page.fill('[data-testid="project-search"]', 'Work\\demo');
    await expect(rows).toHaveCount(1);
    await page.fill('[data-testid="project-search"]', 'zzz-no-match');
    await expect(rows).toHaveCount(0);
    await expect(page.getByText('没有匹配的项目')).toBeVisible();
    await page.fill('[data-testid="project-search"]', '');
    await expect(rows).toHaveCount(api.projectCount);
  });

  test('四种排序：顺序与 API 一致，且互不全同；刷新页面后排序选择保留', async ({ page }) => {
    await open(page, srv.url);
    const orders: Record<string, string> = {};
    for (const sort of ['total', 'recent', 'name', 'today'] as const) {
      await page.click('[data-testid="sort-button"]');
      await page.click(`[data-testid="sort-option-${sort}"]`);
      await expect(page.locator('[data-testid="sort-button"]')).toHaveAttribute('data-sort', sort);
      const api = await apiProjects(srv.url, sort);
      const expected = api.projects.map((p) => (p.id === 'scratch' ? '@group' : p.displayName));
      await expect.poll(() => topLevelNames(page)).toEqual(expected);
      orders[sort] = expected.join('|');
    }
    expect(new Set(Object.values(orders)).size).toBeGreaterThanOrEqual(3);
    expect(orders.today).not.toBe(orders.total); // 固定 now 下 crlf 今日有用量，应排到最前

    // 记住选择：当前是 today，刷新后仍然是
    await page.reload();
    await page.waitForSelector('[data-testid="content"][data-ready="true"]');
    await expect(page.locator('[data-testid="sort-button"]')).toHaveAttribute('data-sort', 'today');
    await expect.poll(() => topLevelNames(page)).toEqual((await apiProjects(srv.url, 'today')).projects.map((p) => (p.id === 'scratch' ? '@group' : p.displayName)));
    await page.evaluate(() => localStorage.removeItem('tv.projectSort'));
  });

  test('方向键 ↑/↓ 切换选中项；点击切换；URL 保留项目', async ({ page }) => {
    await open(page, srv.url);
    const api = await apiProjects(srv.url, 'total'); // 默认排序
    const first = api.projects[0]!;
    const second = api.projects[1]!;
    await expect(page.locator('[data-testid="content"]')).toHaveAttribute('data-project', 'all');
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('[data-testid="content"]')).toHaveAttribute('data-project', first.id);
    await expect(page.locator(`[data-testid="project-row"][data-project-id="${first.id}"]`)).toHaveAttribute('data-selected', 'true');
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('[data-testid="content"]')).toHaveAttribute('data-project', second.id);
    await page.keyboard.press('ArrowUp');
    await expect(page.locator('[data-testid="content"]')).toHaveAttribute('data-project', first.id);
    await page.keyboard.press('ArrowUp');
    await expect(page.locator('[data-testid="content"]')).toHaveAttribute('data-project', 'all');
    await page.keyboard.press('ArrowUp'); // 到顶不越界
    await expect(page.locator('[data-testid="content"]')).toHaveAttribute('data-project', 'all');

    // 在搜索框里按方向键不切换项目
    await page.click('[data-testid="project-search"]');
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('[data-testid="content"]')).toHaveAttribute('data-project', 'all');

    // 点击项目 → URL 带 project，刷新后还原；标题 = 项目名
    await page.click(`[data-testid="project-row"][data-project-id="C--Users-----Work-demo"] a`);
    await expect(page.locator('[data-testid="page-title"]')).toHaveText('demo');
    expect(page.url()).toContain('project=C--Users-----Work-demo');
    await page.reload();
    await page.waitForSelector('[data-testid="content"][data-ready="true"]');
    await expect(page.locator('[data-testid="content"]')).toHaveAttribute('data-project', 'C--Users-----Work-demo');
    await expect(page.locator('[data-testid="page-title"]')).toHaveText('demo');
  });

  test('项目切换体验：连续 20 次，p95 < 200 ms；页面骨架不卸载、无空白帧', async ({ page }) => {
    await open(page, srv.url);
    const api = await apiProjects(srv.url);
    const ids = ['all', ...api.projects.filter((p) => p.id !== 'scratch').map((p) => p.id)];

    await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      w.__refs = { body: document.body, shell: document.querySelector('#root > div'), main: document.querySelector('main'), content: document.querySelector('[data-testid="content"]'), aside: document.querySelector('aside') };
      const counts = { body: 0, root: 0, main: 0 };
      w.__mut = counts;
      new MutationObserver((l) => (counts.body += l.length)).observe(document.body, { childList: true });
      new MutationObserver((l) => (counts.root += l.length)).observe(document.getElementById('root')!, { childList: true });
      new MutationObserver((l) => (counts.main += l.length)).observe(document.querySelector('main')!, { childList: true });
      const blank = { frames: 0, empty: 0 };
      w.__blank = blank;
      const tick = (): void => {
        blank.frames++;
        const title = document.querySelector('[data-testid="page-title"]')?.textContent ?? '';
        const tile = document.querySelector('[data-testid="tile-total-num"]');
        if (!title || !tile) blank.empty++;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      (window as unknown as { __tvPerf?: { samples: unknown[] } }).__tvPerf = { samples: [], ...(window as unknown as { __tvPerf?: object }).__tvPerf } as never;
    });

    for (let i = 0; i < 20; i++) {
      const id = ids[(i + 1) % ids.length]!;
      await page.click(`[data-project-id="${id}"] a`);
      await page.waitForSelector(`[data-testid="content"][data-project="${id}"][data-ready="true"]`);
    }

    const result = await page.evaluate(() => {
      const w = window as unknown as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      const samples: number[] = (w.__tvPerf?.samples ?? []).map((s: { ms: number }) => s.ms);
      return {
        samples,
        sameBody: w.__refs.body === document.body,
        sameShell: w.__refs.shell === document.querySelector('#root > div'),
        sameMain: w.__refs.main === document.querySelector('main'),
        sameContent: w.__refs.content === document.querySelector('[data-testid="content"]'),
        sameAside: w.__refs.aside === document.querySelector('aside'),
        mut: w.__mut,
        blank: w.__blank,
      };
    });
    expect(result.samples.length).toBeGreaterThanOrEqual(20);
    const sorted = [...result.samples].sort((a, b) => a - b);
    const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!;
    console.log(`项目切换 ${sorted.length} 次：p50=${sorted[Math.floor(sorted.length / 2)]!.toFixed(1)} ms  p95=${p95.toFixed(1)} ms  max=${sorted[sorted.length - 1]!.toFixed(1)} ms；空白帧 ${result.blank.empty}/${result.blank.frames}`);
    expect(p95).toBeLessThan(200);
    expect(result).toMatchObject({ sameBody: true, sameShell: true, sameMain: true, sameContent: true, sameAside: true });
    expect(result.mut).toEqual({ body: 0, root: 0, main: 0 });
    expect(result.blank.empty).toBe(0);
  });

  test('主题：一键深色（非纯黑）、刷新保留、跟随系统、对比度 ≥ 4.5', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await open(page, srv.url);
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.waitForSelector('[data-testid="content"][data-ready="true"]');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    const lightBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(lightBg).toBe('rgb(246, 246, 243)');

    const checkContrast = async (label: string): Promise<void> => {
      for (const sel of ['[data-testid="page-title"]', '[data-testid="tile-total-num"]', '[data-testid="tile-total"] .unit', '[data-testid="sidebar-footer"]', '[data-testid="project-name"]']) {
        const { fg, bg } = await colors(page, sel);
        const r = ratio(fg, bg);
        expect(r, `${label} ${sel} ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    };
    await checkContrast('light');

    await page.click('[aria-label="切换深色主题"]');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    const darkBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(darkBg).toBe('rgb(14, 18, 16)');
    expect(darkBg).not.toBe('rgb(0, 0, 0)');
    await checkContrast('dark');
    await page.screenshot({ path: path.join(SHOTS, 'phase5-1440-dark.png'), fullPage: true });

    await page.reload();
    await page.waitForSelector('[data-testid="content"][data-ready="true"]');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark'); // 记住选择
    // 服务端设置里也已记住
    const st = (await (await fetch(`${srv.url}api/settings`)).json()) as { settings: { theme: string } };
    expect(st.settings.theme).toBe('dark');

    // 跟随系统：系统为浅色 → 浅色；切到深色 → 深色
    await page.click('[data-testid="theme-menu-button"]');
    await page.click('[data-testid="theme-option-system"]');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.reload();
    await page.waitForSelector('[data-testid="content"][data-ready="true"]');
    await expect(page.locator('[data-testid="theme-toggle"]')).toHaveAttribute('data-theme-pref', 'system');

    // 还原
    await page.click('[data-testid="theme-menu-button"]');
    await page.click('[data-testid="theme-option-light"]');
  });

  test('排版：大数字 44px、单位 16px 且更浅、tabular-nums、卡片圆角 24px', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await open(page, srv.url);
    await page.evaluate(() => localStorage.setItem('tv.theme', 'light'));
    const m = await page.evaluate(() => {
      const num = document.querySelector('[data-testid="tile-total-num"]')!;
      const unit = document.querySelector('[data-testid="tile-total"] .unit')!;
      const card = document.querySelector('[data-testid="tile-total"]')!;
      const csn = getComputedStyle(num);
      const csu = getComputedStyle(unit);
      return { numSize: csn.fontSize, numColor: csn.color, numWeight: csn.fontWeight, numVariant: csn.fontVariantNumeric, unitSize: csu.fontSize, unitColor: csu.color, radius: getComputedStyle(card).borderRadius, border: getComputedStyle(card).borderTopWidth, shadow: getComputedStyle(card).boxShadow };
    });
    expect(parseFloat(m.numSize)).toBeGreaterThanOrEqual(36);
    expect(parseFloat(m.numSize)).toBeLessThanOrEqual(48);
    expect(parseFloat(m.unitSize)).toBeGreaterThanOrEqual(14);
    expect(parseFloat(m.unitSize)).toBeLessThanOrEqual(16);
    expect(m.numVariant).toContain('tabular-nums');
    expect(parseFloat(m.radius)).toBeGreaterThanOrEqual(20);
    expect(parseFloat(m.radius)).toBeLessThanOrEqual(24);
    expect(m.border).toBe('1px');
    expect(m.shadow).not.toBe('none');
    expect(m.numWeight).toBe('600');
    // 单位颜色比数字浅（亮度更高）
    const lum = (c: string): number => {
      const p = (/rgba?\(([^)]+)\)/.exec(c)?.[1] ?? '').split(/[ ,/]+/).map(Number);
      return 0.2126 * (p[0] ?? 0) + 0.7152 * (p[1] ?? 0) + 0.0722 * (p[2] ?? 0);
    };
    expect(lum(m.unitColor)).toBeGreaterThan(lum(m.numColor));
    // 精确值：data-value 与悬浮提示
    const tile = page.locator('[data-testid="tile-total"]');
    const exact = Number(await tile.getAttribute('data-value'));
    const sum = (await (await fetch(`${srv.url}api/summary?range=all&project=all`)).json()) as { summary: { value: number } };
    expect(exact).toBe(sum.summary.value);
    await expect(page.locator('[data-testid="tile-total-num"]')).toHaveAttribute('title', new RegExp(exact.toLocaleString('en-US').replaceAll(',', ',')));
  });

  test('Tab 遍历：所有可交互控件都有清晰的焦点样式', async ({ page }) => {
    await open(page, srv.url);
    const report: string[] = [];
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press('Tab');
      const info = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return null;
        const own = getComputedStyle(el);
        const wrap = el.closest('label');
        const cs = own.outlineStyle !== 'none' && parseFloat(own.outlineWidth) >= 2 ? own : wrap ? getComputedStyle(wrap) : own;
        // label:focus-within 的焦点环在 label 上
        const wrapFocus = wrap && wrap.matches(':focus-within') ? getComputedStyle(wrap) : null;
        const use = wrapFocus && wrapFocus.outlineStyle !== 'none' ? wrapFocus : cs;
        const r = el.getBoundingClientRect();
        return { tag: el.tagName, label: el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 16) ?? '', outline: use.outlineStyle, width: parseFloat(use.outlineWidth), color: use.outlineColor, visible: r.width > 0 && r.height > 0 };
      });
      if (!info) continue;
      expect(info.visible, `${info.tag} ${info.label}`).toBe(true);
      expect(info.outline, `${info.tag} ${info.label}`).not.toBe('none');
      expect(info.width, `${info.tag} ${info.label}`).toBeGreaterThanOrEqual(2);
      report.push(`${info.tag}:${info.label}`);
    }
    expect(report.length).toBeGreaterThan(15);
    await page.screenshot({ path: path.join(SHOTS, 'phase5-focus.png') });
  });

  test('响应式：1000 / 1280 / 1600 无横向滚动与重叠；< 900 项目栏折叠为抽屉', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    for (const w of [1000, 1280, 1600]) {
      await page.setViewportSize({ width: w, height: 1000 });
      await open(page, srv.url);
      await page.evaluate(() => localStorage.setItem('tv.theme', 'light'));
      await page.waitForTimeout(700);
      await page.screenshot({ path: path.join(SHOTS, `phase5-${w}-light.png`), fullPage: true });
      const m = await page.evaluate(() => {
        const rect = (sel: string): DOMRect => document.querySelector(sel)!.getBoundingClientRect();
        const brand = document.querySelector('header > a')!.getBoundingClientRect();
        const nav = document.querySelector('header nav')!.getBoundingClientRect();
        const right = document.querySelector('header > div')!.getBoundingClientRect();
        const aside = rect('aside');
        const main = rect('main');
        const overlap = (a: DOMRect, b: DOMRect): boolean => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
        const tiles = [...document.querySelectorAll('[data-testid^="tile-"]')].filter((e) => e.getAttribute('data-testid')!.split('-').length === 2).map((e) => e.getBoundingClientRect());
        let tileOverlap = false;
        for (let i = 0; i < tiles.length; i++) for (let j = i + 1; j < tiles.length; j++) if (overlap(tiles[i]!, tiles[j]!)) tileOverlap = true;
        return {
          scrollW: document.documentElement.scrollWidth,
          innerW: window.innerWidth,
          headerOverlap: overlap(brand, nav) || overlap(nav, right) || overlap(brand, right),
          sideMain: overlap(aside, main),
          tileOverlap,
          tiles: tiles.length,
          cols: new Set(tiles.map((t) => Math.round(t.left))).size,
        };
      });
      expect(m.scrollW, `宽度 ${w}`).toBeLessThanOrEqual(m.innerW);
      expect(m.headerOverlap, `宽度 ${w}`).toBe(false);
      expect(m.sideMain, `宽度 ${w}`).toBe(false);
      expect(m.tileOverlap, `宽度 ${w}`).toBe(false);
      expect(m.tiles).toBe(9);
      await expect(page.locator('[data-testid="sidebar"]')).toBeVisible();
    }

    // 窄于 900：项目栏折叠，页头出现打开按钮；抽屉可打开 / 选择后关闭 / Esc 关闭
    await page.setViewportSize({ width: 880, height: 900 });
    await open(page, srv.url);
    await page.waitForTimeout(300);
    await expect(page.locator('[data-testid="sidebar"]')).toBeHidden();
    const sw = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, w: window.innerWidth }));
    expect(sw.s).toBeLessThanOrEqual(sw.w);
    await page.screenshot({ path: path.join(SHOTS, 'phase5-880-collapsed.png'), fullPage: true });
    await page.click('[data-testid="sidebar-open"]');
    await expect(page.locator('[data-testid="sidebar"]')).toBeVisible();
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(SHOTS, 'phase5-880-drawer.png') });
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="sidebar"]')).toBeHidden();
    await page.click('[data-testid="sidebar-open"]');
    await page.click('[data-testid="project-row"][data-project-id="C--Users-----Work-demo"] a');
    await expect(page.locator('[data-testid="sidebar"]')).toBeHidden();
    await expect(page.locator('[data-testid="page-title"]')).toHaveText('demo');

    // 宽屏下手动折叠 / 展开
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForTimeout(200);
    await page.click('[data-testid="sidebar-close"]');
    await expect(page.locator('[data-testid="sidebar"]')).toBeHidden();
    await page.click('[data-testid="sidebar-open"]');
    await expect(page.locator('[data-testid="sidebar"]')).toBeVisible();
  });

  test('导航：分析 / 会话 / 设置占位页，项目选择在页面间保留', async ({ page }) => {
    await open(page, srv.url, '#/overview?project=D--Work-alpha');
    await page.click('nav a:has-text("分析")');
    await expect(page.locator('[data-testid="content"]')).toHaveAttribute('data-page', 'analysis');
    expect(page.url()).toContain('project=D--Work-alpha');
    await expect(page.locator('nav a[aria-current="page"]')).toHaveText('分析');
    await page.click('nav a:has-text("会话")');
    await expect(page.locator('[data-testid="content"]')).toHaveAttribute('data-page', 'sessions');
    await page.click('nav a:has-text("设置")');
    await expect(page.locator('[data-testid="content"]')).toHaveAttribute('data-page', 'settings');
    await page.click('nav a:has-text("总览")');
    await expect(page.locator('[data-testid="content"]')).toHaveAttribute('data-page', 'overview');
    await expect(page.locator('[data-testid="content"]')).toHaveAttribute('data-project', 'D--Work-alpha');
    // 不存在的项目 id → 回到"全部项目"，不白屏
    await page.goto(`${srv.url}#/overview?project=does-not-exist`);
    await expect(page.locator('[data-testid="content"]')).toHaveAttribute('data-project', 'all');
  });

  test('口径切换：Total ⇄ Fresh 数字同步变化，差 = 缓存读', async ({ page }) => {
    await open(page, srv.url);
    const total = Number(await page.locator('[data-testid="tile-total"]').getAttribute('data-value'));
    await page.click('[data-testid="basis-toggle"] button:has-text("Fresh")');
    await page.waitForFunction((t) => Number(document.querySelector('[data-testid="tile-total"]')?.getAttribute('data-value')) !== t, total);
    const fresh = Number(await page.locator('[data-testid="tile-total"]').getAttribute('data-value'));
    const sum = (await (await fetch(`${srv.url}api/summary?range=all`)).json()) as { summary: { cacheRead: number; total: number } };
    expect(total).toBe(sum.summary.total);
    expect(total - fresh).toBe(sum.summary.cacheRead);
    await page.click('[data-testid="basis-toggle"] button:has-text("Total")');
    await page.waitForFunction((t) => Number(document.querySelector('[data-testid="tile-total"]')?.getAttribute('data-value')) === t, total);
  });

  test('今日环比：昨日为 0 时显示 —，不出现 NaN / Infinity', async ({ page }) => {
    await open(page, srv.url);
    const delta = page.locator('[data-testid="tile-today-delta"]');
    await expect(delta).toHaveText('—'); // 固定 now 下昨日为 0
    const text = await page.locator('[data-testid="content"]').innerText();
    expect(text).not.toMatch(/NaN|Infinity|∞/);
  });

  test('图标 / Logo / favicon 为本地资源', async ({ page }) => {
    await open(page, srv.url);
    await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', '/favicon.svg');
    const res = await page.request.get(`${srv.url}favicon.svg`);
    expect(res.status()).toBe(200);
    expect(await res.text()).toContain('<svg');
  });
});

// ---------------------------------------------------------------------------
// 状态胶囊：服务端追加一条记录后 ≤ 10 s 内文字 / 数字变化；呼吸动画与减少动效
// ---------------------------------------------------------------------------

test.describe('状态胶囊', () => {
  // 固定"当前时间"为 fixture 之后的某一天：初始 Idle；追加一条 3 秒前的记录 → Live
  const FIXED_NOW = Date.parse('2026-11-20T04:00:00.000Z');
  let srv: TestServer;
  test.beforeAll(async () => {
    srv = await startServer({ env: { TV_NOW: new Date(FIXED_NOW).toISOString() } });
    await waitForIdle(srv.url);
  });
  test.afterAll(async () => {
    await srv?.stop();
  });

  test('追加记录后 ≤ 10 s 变为 Live 且今日数字增加；Live 圆点有呼吸动画；减少动效时关闭', async ({ page }) => {
    await open(page, srv.url);
    const pill = page.locator('[data-testid="status-pill"]');
    await expect(pill).toHaveAttribute('data-state', 'idle');
    await expect(pill).toContainText('Idle');
    const before = await page.evaluate(() => document.querySelector('[data-testid="status-today"]')?.firstElementChild?.getAttribute('data-value') ?? null);
    expect(before).toBe('0');

    const file = path.join(srv.dataRoot, 'D--Work-alpha', 'a1a1a1a1-0000-4000-8000-000000000002.jsonl');
    const t0 = Date.now();
    fs.appendFileSync(file, `${assistantLine({ id: 'msg_e2e_live', ts: new Date(FIXED_NOW - 3000).toISOString(), input: 1000, out: 234, cacheRead: 5000 })}\n`);

    await expect(pill).toHaveAttribute('data-state', 'generating', { timeout: 10_000 });
    const elapsed = Date.now() - t0;
    console.log(`追加记录 → 胶囊变化：${elapsed} ms`);
    expect(elapsed).toBeLessThan(10_000);
    await expect(pill).toContainText('Live');
    await expect(page.locator('[data-testid="status-today"] [data-value]')).toHaveAttribute('data-value', '6234');
    await expect(page.locator('[data-testid="status-today"]')).toContainText('6,234');

    const anim = await page.evaluate(() => {
      const dot = document.querySelector('[data-testid="status-pill"] > span')!;
      return getComputedStyle(dot).animationName;
    });
    expect(anim).toBe('tv-pulse');

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect
      .poll(() =>
        page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="status-pill"] > span')!).animationName),
      )
      .toBe('none');
    await page.emulateMedia({ reducedMotion: 'no-preference' });

    // 侧栏同步：alpha 今日有活动绿点
    await expect(page.locator('[data-testid="project-row"][data-project-id="D--Work-alpha"] [data-testid="project-active-dot"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="tile-today"]')).toHaveAttribute('data-value', '6234');
    await page.screenshot({ path: path.join(SHOTS, 'phase5-live-pill.png') });
  });

  test('手动刷新按钮：触发 /api/refresh，页脚更新时间有值', async ({ page }) => {
    await open(page, srv.url);
    const reqs: string[] = [];
    page.on('request', (r) => reqs.push(`${r.method()} ${new URL(r.url()).pathname}`));
    await page.click('[data-testid="refresh-button"]');
    await expect.poll(() => reqs.includes('POST /api/refresh')).toBe(true);
    await expect(page.locator('[data-testid="sidebar-footer"]')).toContainText(/\d{2}:\d{2}:\d{2}/);
  });
});

// ---------------------------------------------------------------------------
// 状态 / 空 / 错误 / 警告 / 首次扫描
// ---------------------------------------------------------------------------

test.describe('空状态与错误引导', () => {
  test('空数据根：显示"还没有记录"空状态而非报错', async ({ page }) => {
    const srv = await startServer({ withFixture: false });
    try {
      await waitForIdle(srv.url);
      await page.goto(srv.url);
      await expect(page.locator('[data-testid="empty-state"]')).toBeVisible();
      await expect(page.locator('[data-testid="empty-state"]')).toContainText('还没有记录，去用一用 Claude Code 吧');
      await expect(page.locator('[data-testid="status-pill"]')).toHaveAttribute('data-state', 'idle');
      await expect(page.getByText('暂无项目')).toBeVisible();
      await page.screenshot({ path: path.join(SHOTS, 'phase5-empty.png'), fullPage: true });
    } finally {
      await srv.stop();
    }
  });

  test('数据根不存在：Error 胶囊 + "数据目录不可用，请在设置中重新选择"引导，不白屏', async ({ page }) => {
    const missing = path.join(ROOT, 'test', 'fixtures', '__no_such_dir__');
    const srv = await startServer({ env: { TV_DATA_ROOT: missing } });
    try {
      await page.goto(srv.url);
      await expect(page.locator('[data-testid="status-pill"]')).toHaveAttribute('data-state', 'error');
      await expect(page.locator('[data-testid="data-root-error"]')).toContainText('数据目录不可用，请在设置中重新选择');
      await expect(page.locator('[data-testid="data-root-error"] a')).toHaveAttribute('href', /#\/settings/);
      const tip = await page.locator('[data-testid="status-pill"]').getAttribute('title');
      expect(tip).toContain('读取数据出错');
      await expect(page.locator('header')).toBeVisible();
      await page.screenshot({ path: path.join(SHOTS, 'phase5-error.png'), fullPage: true });
    } finally {
      await srv.stop();
    }
  });

  test('启动自检回退坏数据根：警告在顶部琥珀提示条里醒目展示，可关闭', async ({ page }) => {
    // 已保存的数据根 = 应用数据目录的父目录（包含应用数据目录）→ 服务启动时回退并给出警告
    const srv = await startServer({ settingsJson: ({ base }: { base: string }) => ({ schema: 1, settings: { dataRoot: base } }) });
    try {
      await waitForIdle(srv.url);
      await page.goto(srv.url);
      const banner = page.locator('[data-testid="warnings-banner"]');
      await expect(banner).toBeVisible();
      await expect(banner).toContainText('数据根目录');
      await page.screenshot({ path: path.join(SHOTS, 'phase5-warning.png'), fullPage: true });
      await banner.getByRole('button', { name: '关闭提示' }).click();
      await expect(banner).toHaveCount(0);
      await page.reload();
      await expect(page.locator('[data-testid="warnings-banner"]')).toHaveCount(0); // 本次会话已确认
    } finally {
      await srv.stop();
    }
  });
});

test.describe('首次扫描加载态（模拟服务端状态）', () => {
  test('Scanning 41%：胶囊与进度卡、部分结果标记、骨架', async ({ page }) => {
    const srv = await startServer({});
    try {
      await waitForIdle(srv.url);
      const status = await (await fetch(`${srv.url}api/status`)).json();
      const fake = { ...status, state: 'scanning', phase: 'full', filesDone: 47, filesTotal: 112, bytesDone: 296 * 1024 * 1024, bytesTotal: 696 * 1024 * 1024, usageState: 'scanning' };
      await page.route('**/api/status', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fake) }));
      await page.route('**/api/events', (r) => r.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: `retry: 600000\n\nevent: status\ndata: ${JSON.stringify(fake)}\n\n` }));
      await page.goto(srv.url);
      await expect(page.locator('[data-testid="status-pill"]')).toHaveAttribute('data-state', 'scanning');
      await expect(page.locator('[data-testid="status-pill"]')).toContainText('Scanning · 42%');
      await expect(page.locator('[data-testid="scan-progress"]')).toBeVisible();
      await expect(page.locator('[data-testid="scan-progress"] [role="progressbar"]')).toHaveAttribute('aria-valuenow', '42');
      await expect(page.locator('[data-testid="page-title"]')).toHaveText('正在建立索引');
      await page.waitForTimeout(800);
      await page.screenshot({ path: path.join(SHOTS, 'phase5-firstrun.png'), fullPage: true });
    } finally {
      await srv.stop();
    }
  });

  test('服务断开：Offline 胶囊（琥珀），恢复后自动回到正常状态', async ({ page }) => {
    const srv = await startServer({});
    try {
      await waitForIdle(srv.url);
      await open(page, srv.url);
      await expect(page.locator('[data-testid="status-pill"]')).toHaveAttribute('data-state', /idle|active|generating/);
      // 阻断 API：状态轮询失败 → Offline
      await page.route('**/api/**', (r) => r.abort());
      await page.evaluate(() => window.dispatchEvent(new Event('offline')));
      await expect(page.locator('[data-testid="status-pill"]')).toHaveAttribute('data-state', 'offline', { timeout: 20_000 });
      await page.unroute('**/api/**');
      await expect(page.locator('[data-testid="status-pill"]')).toHaveAttribute('data-state', /idle|active|generating/, { timeout: 30_000 });
    } finally {
      await srv.stop();
    }
  });
});

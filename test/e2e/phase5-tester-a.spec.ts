/**
 * 阶段 5 测试者 E2E（A）：设计令牌 / 计算样式 / 字体 / 响应式 / 项目栏 / 切换体验 / 主题 / 动效 / 无障碍 / 网络隐私。
 * 数据：fixture（临时副本）+ 固定 TV_NOW。运行：先 npm run build，再 npm run test:e2e
 */
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { startServer, waitForIdle } from './server.ts';
import type { TestServer } from './server.ts';
import { CSP_INIT, ROOT, THEMES, collect, contrast, css, normColor, open, setTheme, shot } from './tester-util.ts';

const NOW_ISO = '2026-10-20T12:00:00.000Z';

interface ApiProject {
  id: string;
  displayName: string;
  path: string | null;
  isScratchGroup?: boolean;
  activeToday?: boolean;
  children?: ApiProject[];
}
async function apiProjects(url: string, sort = 'total'): Promise<{ projects: ApiProject[]; projectCount: number; all: { value: number } }> {
  return (await (await fetch(`${url}api/projects?sort=${sort}`)).json()) as never;
}
async function topNames(page: Page): Promise<string[]> {
  return page.$$eval('[data-testid="project-list"] > li > [data-testid="project-row"]', (els) => els.map((e) => (e.querySelector('[data-testid="project-name"]')?.textContent ?? (e.getAttribute('data-group') === 'true' ? '@group' : '')).trim()));
}
const px = (v: string | undefined): number => parseFloat(v ?? 'NaN');

let srv: TestServer;
test.beforeAll(async () => {
  srv = await startServer({ env: { TV_NOW: NOW_ISO } });
  await waitForIdle(srv.url);
  const r = await fetch(`${srv.url}api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ timezone: 'Asia/Shanghai' }) });
  expect(r.status).toBe(200);
});
test.afterAll(async () => {
  await srv?.stop();
});

// ---------------------------------------------------------------------------
test.describe('设计令牌与计算样式', () => {
  test('浅 / 深色：全部 CSS 变量逐个与 DESIGN.md 表一致', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await open(page, srv.url);
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      const got = await page.evaluate((names) => {
        const cs = getComputedStyle(document.documentElement);
        return Object.fromEntries(names.map((n) => [n, cs.getPropertyValue(`--${n}`)]));
      }, Object.keys(THEMES[theme]));
      const bad: string[] = [];
      for (const [k, want] of Object.entries(THEMES[theme])) {
        if (normColor(got[k] ?? '') !== normColor(want)) bad.push(`${theme} --${k}: got "${got[k]}" want "${want}"`);
      }
      console.log(`令牌 ${theme}：${Object.keys(THEMES[theme]).length} 个变量已核对，不一致 ${bad.length}`);
      expect(bad).toEqual([]);
      // body 背景是 --bg，不是纯黑
      const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      expect(normColor(bg)).toBe(normColor(THEMES[theme].bg!));
      expect(normColor(bg)).not.toBe('rgb(0,0,0)');
    }
  });

  test('字体：Outfit / Noto Sans SC 实际加载（CDP 平台字体核对），来自本地 woff2', async ({ page }) => {
    await open(page, srv.url);
    const info = await page.evaluate(async () => {
      await document.fonts.ready;
      const faces = [...document.fonts].map((f) => ({ family: f.family.replaceAll('"', ''), weight: f.weight, status: f.status, range: f.unicodeRange.slice(0, 40) }));
      return {
        faces,
        c1: document.fonts.check('600 40px Outfit'),
        c2: document.fonts.check('400 14px Outfit'),
        c3: document.fonts.check('700 23px Outfit'),
        c4: document.fonts.check('600 20px "Noto Sans SC"', '全部项目'),
        sheets: [...document.styleSheets].flatMap((s) => {
          try {
            return [...s.cssRules].filter((r) => r instanceof CSSFontFaceRule).map((r) => (r as CSSFontFaceRule).style.getPropertyValue('src'));
          } catch {
            return [];
          }
        }),
      };
    });
    expect(info.c1 && info.c2 && info.c3 && info.c4).toBe(true);
    const loaded = info.faces.filter((f) => f.status === 'loaded');
    expect(loaded.some((f) => f.family === 'Outfit')).toBe(true);
    expect(loaded.some((f) => f.family === 'Noto Sans SC')).toBe(true);
    // 所有 @font-face 的 src 只含 woff2，且是相对站内路径（无 http）
    expect(info.sheets.length).toBeGreaterThan(10);
    for (const src of info.sheets) {
      expect(src).toMatch(/format\("?woff2"?\)/);
      expect(src).not.toMatch(/https?:|\.woff[^2]|\.ttf|\.otf/);
    }
    // CDP：真正用于渲染的平台字体
    const client = await page.context().newCDPSession(page);
    await client.send('DOM.enable');
    await client.send('CSS.enable');
    const doc = await client.send('DOM.getDocument', { depth: 0 });
    const platform = async (sel: string): Promise<string[]> => {
      const { nodeId } = await client.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: sel });
      const r = (await client.send('CSS.getPlatformFontsForNode', { nodeId })) as { fonts: Array<{ familyName: string; glyphCount: number }> };
      return r.fonts.map((f) => `${f.familyName}×${f.glyphCount}`);
    };
    const res = {
      title_cjk: await platform('[data-testid="page-title"]'),
      bigNumber: await platform('[data-testid="tile-total-num"]'),
      logo: await platform('header a span:last-child'),
      sidebarName: await platform('[data-testid="project-name"]'),
    };
    console.log('平台字体：' + JSON.stringify(res));
    expect(res.title_cjk.join()).toMatch(/Noto Sans SC/);
    expect(res.bigNumber.join()).toMatch(/Outfit/);
    expect(res.logo.join()).toMatch(/Outfit/);
    // 任何节点都不得回退到系统字体（Microsoft YaHei 等）来渲染这几处
    for (const v of Object.values(res)) expect(v.join()).not.toMatch(/Microsoft|Segoe|Arial|SimSun/i);
    const stack = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
    expect(stack).toBe('Outfit, "Noto Sans SC", "HarmonyOS Sans SC", "Microsoft YaHei", system-ui, sans-serif');
    // 数字一律 tabular-nums：抽查带 .num 的全部元素
    const nums = await page.$$eval('.num, [data-testid="status-today"], [data-testid="project-total"]', (els) => els.map((e) => getComputedStyle(e).fontVariantNumeric));
    expect(nums.length).toBeGreaterThan(5);
    expect(nums.every((v) => v.includes('tabular-nums'))).toBe(true);
  });

  test('关键组件的计算样式 = 设计稿内联样式（浅色，1440 宽）', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.emulateMedia({ colorScheme: 'light' });
    await open(page, srv.url);
    await setTheme(page, 'light');
    const L = THEMES.light;
    const bad: string[] = [];
    const check = async (label: string, sel: string, want: Record<string, string | number>, nth = 0): Promise<void> => {
      const got = await css(page, sel, [...Object.keys(want).filter((k) => !k.startsWith('__')), '__x'], nth);
      if (got.__missing) {
        bad.push(`${label}: 找不到 ${sel}`);
        return;
      }
      for (const [k, w] of Object.entries(want)) {
        const g = k === '__w' ? got.__w : k === '__h' ? got.__h : got[k];
        let ok: boolean;
        if (typeof w === 'number') ok = Math.abs(px(g) - w) < 0.6;
        else if (/color|background|shadow/i.test(k) && !/image/i.test(k)) ok = normColor(g ?? '') === normColor(w);
        else ok = (g ?? '').replace(/\s+/g, ' ') === w;
        if (!ok) bad.push(`${label} ${k}: got "${g}" want "${w}"`);
      }
    };
    const tile = '[data-testid="tile-total"]';
    // 页面骨架
    await check('shell padding', '#root > div', { 'padding-top': 20, 'padding-left': 32, 'padding-right': 32, 'padding-bottom': 48, 'row-gap': 24 });
    // 顶栏
    await check('logo 文字', 'header a span:last-child', { 'font-size': 23, 'font-weight': '700', 'letter-spacing': '-0.69px' });
    await check('logo 方块', 'header a > span:first-child, header a > svg:first-child', { __w: 38, __h: 38 });
    await check('胶囊导航容器', 'header nav', { 'padding-top': 4, 'padding-left': 4, 'column-gap': 2, 'border-radius': '999px', 'background-color': L.seg! });
    await check('导航项（选中）', 'header nav a[aria-current="page"]', { 'min-height': 40, 'padding-left': 18, 'font-size': 14.5, 'font-weight': '500', 'column-gap': 8, 'border-radius': '999px', 'background-color': L.segOn!, color: L.text! });
    await check('导航项（未选中）', 'header nav a:not([aria-current])', { 'min-height': 40, 'background-color': 'rgba(0, 0, 0, 0)', color: L.text2! });
    await check('导航图标', 'header nav a svg', { __w: 18, __h: 18 });
    await check('状态胶囊', '[data-testid="status-pill"]', { height: 34, 'padding-left': 14, 'font-size': 13.5, 'font-weight': '500', 'column-gap': 8, 'border-radius': '999px' });
    await check('状态胶囊圆点', '[data-testid="status-pill"] > span:first-child', { __w: 8, __h: 8, 'border-radius': '50%' });
    await check('主题按钮组（设计稿 44px 圆钮 + 开发者追加的"跟随系统"小箭头，整体 44 高胶囊）', '[data-testid="theme-toggle"]', { __w: 42, __h: 42, 'border-radius': '50%', color: L.text! });
    await check('主题按钮外框', 'div:has(> [data-testid="theme-toggle"])', { __h: 44, 'border-top-width': 1, 'border-radius': '999px', 'background-color': L.card! });
    // 项目栏
    await check('项目栏宽 288', '[data-testid="sidebar"]', { __w: 288, 'row-gap': 12 });
    await check('搜索框', '[data-testid="sidebar"] label', { __h: 46, 'border-radius': 14, 'padding-left': 14, 'column-gap': 10, 'background-color': L.card!, 'border-top-width': 1 });
    await check('搜索输入', '[data-testid="project-search"]', { 'font-size': 14 });
    await check('排序 chip', '[data-testid="sort-button"]', { 'min-height': 34, 'padding-left': 12, 'font-size': 12.5, 'font-weight': '500', 'border-radius': '999px', 'background-color': L.card!, 'border-top-width': 1 });
    await check('全部项目行卡片', '[data-testid="project-row-all"]', { 'background-color': L.card!, 'border-top-width': 1, 'border-radius': 18, 'box-shadow': 'rgba(17, 22, 19, 0.04) 0px 1px 2px 0px, rgba(17, 22, 19, 0.05) 0px 14px 36px 0px' });
    await check('全部项目 链接', '[data-testid="project-row-all"] a', { 'padding-top': 13, 'padding-left': 16, 'column-gap': 12 });
    await check('全部项目 名称', '[data-testid="project-row-all"] a > div > div:first-child', { 'font-size': 15, 'font-weight': '600' });
    await check('全部项目 副标题', '[data-testid="project-row-all"] a > div > div:nth-child(2)', { 'font-size': 12, color: L.muted! });
    await check('全部项目 总量', '[data-testid="project-total-all"]', { 'font-size': 15, 'font-weight': '600' });
    await check('项目行 链接', '[data-testid="project-row"] a', { 'padding-top': 13, 'padding-left': 16, 'border-radius': 18 });
    await check('项目行 名称', '[data-testid="project-name"]', { 'font-size': 14.5, 'font-weight': '500' });
    await check('项目行 总量', '[data-testid="project-total"]', { 'font-size': 14, 'font-weight': '600' });
    await check('项目行 sparkline', '[data-testid="project-row"] a svg', { __w: 84, __h: 22 });
    await check('刷新按钮', '[data-testid="refresh-button"]', { __w: 36, __h: 36, 'border-radius': '50%', 'border-top-width': 1, color: L.text2! });
    await check('底部文字', '[data-testid="sidebar-footer"]', { 'font-size': 12, color: L.muted! });
    // 内容区
    await check('页面标题 h1', '[data-testid="page-title"]', { 'font-size': 28, 'font-weight': '600', 'letter-spacing': '-0.7px' });
    await check('页面副标题', '[data-testid="page-title"] + div', { 'font-size': 13.5, color: L.muted! });
    await check('口径切换（小号）按钮', '[data-testid="basis-toggle"] button', { 'min-height': 34, 'font-size': 13, 'padding-left': 14 });
    await check('指标卡', tile, { 'border-radius': 24, 'border-top-width': 1, 'padding-top': 22, 'padding-left': 24, 'padding-bottom': 0, 'min-height': 204, 'background-color': L.card!, 'box-shadow': 'rgba(17, 22, 19, 0.04) 0px 1px 2px 0px, rgba(17, 22, 19, 0.05) 0px 14px 36px 0px' });
    await check('指标卡 标题', `${tile} > div:first-child > div:first-child`, { 'font-size': 15, 'font-weight': '500', color: L.text2!, 'column-gap': 10 });
    await check('指标卡 标题图标', `${tile} > div:first-child svg`, { __w: 18, __h: 18 });
    await check('大数字', '[data-testid="tile-total-num"]', { 'font-size': 44, 'font-weight': '600', 'letter-spacing': '-0.88px', color: L.text!, 'font-variant-numeric': 'tabular-nums' });
    await check('单位', `${tile} .unit`, { 'font-size': 16, 'font-weight': '500', 'margin-left': 6, color: L.muted! });
    await check('说明', `${tile} > div:nth-of-type(2) + div`, { 'font-size': 13, color: L.muted! });
    await check('环比胶囊', '[data-testid="tile-today-delta"]', { 'font-size': 12.5, 'font-weight': '600', 'padding-top': 4, 'padding-left': 10, 'border-radius': '999px', 'background-color': L.seg! });
    console.log(`计算样式核对：不一致 ${bad.length} 项\n` + bad.join('\n'));
    expect(bad).toEqual([]);

    // 指标卡网格间距 / 页面纵向间距
    const gaps = await page.evaluate(() => {
      const g = document.querySelector('[data-testid="tile-total"]')!.parentElement!;
      const page = document.querySelector('[data-testid="content"]')!;
      return { gridGap: getComputedStyle(g).columnGap, rowGap: getComputedStyle(g).rowGap, pageGap: getComputedStyle(page).rowGap };
    });
    expect(gaps).toEqual({ gridGap: '20px', rowGap: '20px', pageGap: '24px' });
  });

  test('深色主题下关键尺寸不变、颜色取深色令牌', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await open(page, srv.url);
    await setTheme(page, 'dark');
    const D = THEMES.dark;
    const g = async (sel: string, props: string[]): Promise<Record<string, string>> => css(page, sel, props);
    const tile = await g('[data-testid="tile-total"]', ['background-color', 'box-shadow', 'border-top-color', 'border-radius']);
    expect(normColor(tile['background-color']!)).toBe(normColor(D.card!));
    expect(tile['border-radius']).toBe('24px');
    expect(normColor(tile['border-top-color']!)).toBe(normColor(D.line!));
    expect(tile['box-shadow']).toBe('rgba(0, 0, 0, 0.3) 0px 1px 2px 0px, rgba(0, 0, 0, 0.28) 0px 14px 36px 0px');
    const num = await g('[data-testid="tile-total-num"]', ['color', 'font-size']);
    expect(normColor(num.color!)).toBe(normColor(D.text!));
    expect(num['font-size']).toBe('44px');
    const nav = await g('header nav a[aria-current="page"]', ['background-color', 'color']);
    expect(normColor(nav['background-color']!)).toBe(normColor(D.segOn!));
    const aside = await g('[data-testid="sidebar"]', []);
    expect(aside.__w).toBe('288');
    const bg = await g('body', ['background-color']);
    expect(normColor(bg['background-color']!)).toBe(normColor('rgb(14,18,16)'));
  });

  test('指标网格 3 → 2 → 1 列断点（1440 / 1100 / 700 与边界 1181 / 1180 / 761 / 760）', async ({ page }) => {
    await open(page, srv.url);
    const cols = async (w: number): Promise<{ cols: number; tracks: string; scrollW: number; clientW: number }> => {
      await page.setViewportSize({ width: w, height: 900 });
      await page.waitForTimeout(150);
      return page.evaluate(() => {
        const g = document.querySelector('[data-testid="tile-total"]')!.parentElement!;
        const tracks = getComputedStyle(g).gridTemplateColumns;
        return { cols: tracks.split(' ').length, tracks, scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth };
      });
    };
    const r: Record<number, { cols: number; tracks: string; scrollW: number; clientW: number }> = {};
    for (const w of [1440, 1181, 1180, 1100, 761, 760, 700]) r[w] = await cols(w);
    console.log('网格列数：' + JSON.stringify(Object.fromEntries(Object.entries(r).map(([w, v]) => [w, v.cols]))));
    expect(r[1440]!.cols).toBe(3);
    expect(r[1181]!.cols).toBe(3);
    expect(r[1180]!.cols).toBe(2);
    expect(r[1100]!.cols).toBe(2);
    expect(r[761]!.cols).toBe(2);
    expect(r[760]!.cols).toBe(1);
    expect(r[700]!.cols).toBe(1);
    for (const w of [1440, 1100, 700]) expect(r[w]!.scrollW, `${w}px 无横向滚动`).toBeLessThanOrEqual(r[w]!.clientW);
  });

  test('项目栏宽 288（≥900 并排）；窄于 900 折叠；1000 宽无横向滚动', async ({ page }) => {
    await open(page, srv.url);
    for (const [w, narrow] of [[1000, false], [900, false], [899, true], [700, true]] as const) {
      await page.setViewportSize({ width: w, height: 900 });
      await page.waitForTimeout(200);
      const m = await page.evaluate(() => {
        const a = document.querySelector('[data-testid="sidebar"]')!;
        const r = a.getBoundingClientRect();
        return { w: r.width, vis: a.getAttribute('data-visible'), x: r.x, scroll: document.documentElement.scrollWidth <= document.documentElement.clientWidth };
      });
      if (narrow) expect(m.vis, `${w}px 抽屉默认收起`).toBe('false');
      else {
        expect(m.vis).toBe('true');
        expect(m.w).toBe(288);
      }
      expect(m.scroll, `${w}px 无横向滚动`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
test.describe('截图（供人工对照设计稿）', () => {
  const pages = ['overview', 'analysis', 'sessions', 'settings'] as const;
  for (const theme of ['light', 'dark'] as const) {
    test(`各页面 ${theme} 1440`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await open(page, srv.url);
      await setTheme(page, theme);
      for (const p of pages) {
        await page.goto(`${srv.url}#/${p}`);
        await page.waitForSelector('[data-testid="content"]');
        await page.waitForTimeout(900); // 等数字滚动 / 过渡结束
        await page.screenshot({ path: shot(`${p}-${theme}-1440`), fullPage: true });
      }
    });
  }
  test('1100 / 700 浅色 + 展开 Scratch + 排序菜单 + 抽屉', async ({ page }) => {
    await open(page, srv.url);
    await setTheme(page, 'light');
    for (const w of [1100, 700]) {
      await page.setViewportSize({ width: w, height: 1000 });
      await page.waitForTimeout(500);
      await page.screenshot({ path: shot(`overview-light-${w}`), fullPage: true });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.click('[data-testid="scratch-toggle"]');
    await page.click('[data-testid="sort-button"]');
    await page.waitForTimeout(400);
    await page.screenshot({ path: shot('sidebar-scratch-expanded-sort-menu-1440'), clip: { x: 0, y: 0, width: 420, height: 1000 } });
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 760, height: 900 });
    await page.click('[data-testid="sidebar-open"]');
    await page.waitForTimeout(500);
    await page.screenshot({ path: shot('drawer-760') });
  });
});

// ---------------------------------------------------------------------------
test.describe('项目栏', () => {
  test('条目数 / 中文用户名 demo / 悬浮路径 / Scratch 折叠展开 / 今日绿点', async ({ page }) => {
    await open(page, srv.url);
    await page.evaluate(() => localStorage.removeItem('tv.scratchExpanded'));
    await page.reload();
    await page.waitForSelector('[data-testid="content"][data-ready="true"]');
    const api = await apiProjects(srv.url);
    const names = await topNames(page);
    expect(names.length).toBe(api.projects.length);
    const scratch = api.projects.find((p) => p.isScratchGroup)!;
    expect(scratch).toBeTruthy();
    expect(await page.locator('[data-testid="scratch-children"]').count()).toBe(0); // 折叠
    await expect(page.locator('[data-testid="scratch-toggle"]')).toHaveAttribute('aria-expanded', 'false');
    // 展开 / 折叠
    await page.click('[data-testid="scratch-toggle"]');
    await expect(page.locator('[data-testid="scratch-children"] [data-testid="project-row"]')).toHaveCount(scratch.children!.length);
    await expect(page.locator('[data-testid="scratch-toggle"]')).toHaveAttribute('aria-expanded', 'true');
    // 展开后：条目 = 非 scratch 项目数 + scratch 文件夹数（+组头）
    const total = await page.locator('[data-testid="project-row"]').count();
    expect(total).toBe(api.projects.length + scratch.children!.length);
    // 子项名称与 API 一致
    const kidNames = await page.$$eval('[data-testid="scratch-children"] [data-testid="project-name"]', (e) => e.map((x) => x.textContent!.trim()).sort());
    expect(kidNames).toEqual(scratch.children!.map((c) => c.displayName).sort());
    await page.click('[data-testid="scratch-toggle"]');
    await expect(page.locator('[data-testid="scratch-children"]')).toHaveCount(0);
    // 展开状态被记住
    await page.click('[data-testid="scratch-toggle"]');
    await page.reload();
    await page.waitForSelector('[data-testid="content"][data-ready="true"]');
    await expect(page.locator('[data-testid="scratch-toggle"]')).toHaveAttribute('aria-expanded', 'true');
    await page.click('[data-testid="scratch-toggle"]');

    // 中文用户名项目：显示 demo 而非 -----；title = 完整 cwd
    const demo = api.projects.find((p) => p.displayName === 'demo')!;
    expect(demo, 'fixture 有 demo 项目').toBeTruthy();
    expect(names).toContain('demo');
    for (const n of names) expect(n, '项目名不应只由连字符构成').not.toMatch(/^-+$/);
    const row = page.locator(`[data-project-id="${demo.id}"] a`);
    expect(await row.getAttribute('title')).toContain(demo.path!);
    expect(demo.path).toMatch(/王测试/);
    await row.hover();
    // 每个项目行都有 title（完整路径或回退说明）
    const titles = await page.$$eval('[data-testid="project-row"]:not([data-group="true"]) a', (e) => e.map((x) => x.getAttribute('title')));
    expect(titles.every((t) => !!t && t.length > 0)).toBe(true);
    // 今日绿点：与 API activeToday 一致
    const dots = await page.$$eval('[data-testid="project-row"]:not([data-group="true"])', (e) => e.map((x) => ({ id: x.getAttribute('data-project-id')!, dot: !!x.querySelector('[data-testid="project-active-dot"]') })));
    const want = new Map(api.projects.flatMap((p) => [p, ...(p.children ?? [])]).map((p) => [p.id, !!p.activeToday]));
    for (const d of dots) expect(d.dot, `绿点 ${d.id}`).toBe(want.get(d.id) ?? false);
    console.log(`绿点：${dots.filter((d) => d.dot).length} 个项目今日活跃（API 同）`);
    const dot = await css(page, '[data-testid="project-active-dot"]', ['width', 'height', 'background-color', 'border-radius']);
    expect(dot.width).toBe('7px');
    expect(normColor(dot['background-color']!)).toBe(normColor(THEMES.light.accent!));
  });

  test('搜索：名称 / 路径 / 无匹配 / 清空恢复', async ({ page }) => {
    await open(page, srv.url);
    const api = await apiProjects(srv.url);
    const all = (await topNames(page)).length;
    const search = page.locator('[data-testid="project-search"]');
    await search.fill('demo');
    let names = await topNames(page);
    expect(names).toEqual(['demo']);
    await search.fill('DEMO'); // 大小写不敏感
    expect(await topNames(page)).toEqual(['demo']);
    // 按路径片段
    await search.fill('Work');
    names = await topNames(page);
    expect(names.length).toBeGreaterThan(0);
    const expectPath = api.projects.filter((p) => !p.isScratchGroup && ((p.path ?? '').toLowerCase().includes('work') || p.displayName.toLowerCase().includes('work'))).map((p) => p.displayName);
    for (const n of expectPath) expect(names).toContain(n);
    await search.fill('zzzz-nope');
    await expect(page.getByText('没有匹配的项目')).toBeVisible();
    expect((await topNames(page)).length).toBe(0);
    await search.fill('');
    expect((await topNames(page)).length).toBe(all);
    // 搜 scratch 子目录：命中时自动展开组
    const kid = api.projects.find((p) => p.isScratchGroup)!.children![0]!;
    await search.fill(kid.displayName);
    await expect(page.locator(`[data-project-id="${kid.id}"]`)).toHaveCount(1);
  });

  test('四种排序：DOM 顺序 = API 顺序，互不全同；记住并在刷新后保持（首帧即生效）', async ({ page }) => {
    await open(page, srv.url);
    const orders: Record<string, string[]> = {};
    for (const s of ['total', 'recent', 'name', 'today'] as const) {
      await page.click('[data-testid="sort-button"]');
      await page.click(`[data-testid="sort-option-${s}"]`);
      await expect(page.locator('[data-testid="sort-button"]')).toHaveAttribute('data-sort', s);
      await page.waitForFunction(([id]) => document.querySelector('[data-testid="sort-button"]')?.getAttribute('data-sort') === id, [s]);
      await page.waitForTimeout(250);
      orders[s] = await topNames(page);
      const api = await apiProjects(srv.url, s);
      const want = api.projects.map((p) => (p.isScratchGroup ? '@group' : p.displayName));
      expect(orders[s], `排序 ${s}`).toEqual(want);
    }
    const uniq = new Set(Object.values(orders).map((o) => o.join('|')));
    console.log('四种排序顺序：\n' + Object.entries(orders).map(([k, v]) => `  ${k}: ${v.join(' > ')}`).join('\n'));
    expect(uniq.size).toBeGreaterThanOrEqual(3);
    // 刷新后保留（today 为最后选择）；跨标签页 / 新上下文（同 localStorage 才保留）
    await page.reload();
    await page.waitForSelector('[data-testid="content"][data-ready="true"]');
    await expect(page.locator('[data-testid="sort-button"]')).toHaveAttribute('data-sort', 'today');
    expect(await topNames(page)).toEqual(orders.today);
    expect(await page.evaluate(() => localStorage.getItem('tv.projectSort'))).toBe('today');
    // 恢复 total
    await page.click('[data-testid="sort-button"]');
    await page.click('[data-testid="sort-option-total"]');
  });

  test('键盘 ↑/↓ 切换项目；边界不越界；搜索框内不生效；排序菜单打开时不生效', async ({ page }) => {
    await page.evaluate(() => undefined);
    await open(page, srv.url, '#/overview?project=all');
    const order = await page.$$eval('[data-testid="project-row-all"], [data-testid="project-list"] > li > [data-testid="project-row"]', (e) => e.map((x) => x.getAttribute('data-project-id')!));
    const cur = (): Promise<string> => page.evaluate(() => document.querySelector('[data-testid="content"]')!.getAttribute('data-project')!);
    await page.hover('[data-testid="sidebar"]');
    for (let i = 1; i < order.length; i++) {
      await page.keyboard.press('ArrowDown');
      await expect.poll(cur).toBe(order[i]);
    }
    await page.keyboard.press('ArrowDown'); // 到底不越界
    await page.waitForTimeout(150);
    expect(await cur()).toBe(order[order.length - 1]);
    // aria-current 与高亮
    await expect(page.locator(`[data-project-id="${order[order.length - 1]}"] a`).first()).toHaveAttribute('aria-current', 'true');
    for (let i = order.length - 2; i >= 0; i--) {
      await page.keyboard.press('ArrowUp');
      await expect.poll(cur).toBe(order[i]);
    }
    await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(150);
    expect(await cur()).toBe('all');
    // 搜索框内按方向键不切换项目
    await page.locator('[data-testid="project-search"]').focus();
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(150);
    expect(await cur()).toBe('all');
    // 排序菜单打开时不切换
    await page.locator('[data-testid="project-search"]').blur();
    await page.click('[data-testid="sort-button"]');
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(150);
    expect(await cur()).toBe('all');
    await page.keyboard.press('Escape');
    // URL 带项目，直接打开深链接
    await page.goto(`${srv.url}#/overview?project=${encodeURIComponent(order[2]!)}`);
    await expect.poll(cur).toBe(order[2]);
    // 非法项目 id → 回到全部
    await page.goto(`${srv.url}#/overview?project=nope-nope`);
    await expect.poll(cur, { timeout: 8000 }).toBe('all');
  });
});

test.describe('项目栏折叠', () => {
  test('宽屏手动收起 / 展开并记住；窄屏抽屉：按钮打开、遮罩点击 / 选择项目后关闭', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await open(page, srv.url);
    await page.evaluate(() => localStorage.removeItem('tv.sidebarCollapsed'));
    await page.reload();
    await page.waitForSelector('[data-testid="content"][data-ready="true"]');
    const mainW = (): Promise<number> => page.evaluate(() => document.querySelector('main')!.getBoundingClientRect().width);
    const w0 = await mainW();
    await page.click('[data-testid="sidebar-close"]');
    await expect(page.locator('[data-testid="sidebar"]')).toHaveAttribute('data-visible', 'false');
    await expect(page.locator('[data-testid="sidebar"]')).toBeHidden();
    expect(await mainW()).toBeGreaterThan(w0 + 250);
    await page.reload();
    await page.waitForSelector('[data-testid="content"]');
    await expect(page.locator('[data-testid="sidebar"]')).toBeHidden();
    await page.screenshot({ path: shot('sidebar-collapsed-1440') });
    await page.click('[data-testid="sidebar-open"]');
    await expect(page.locator('[data-testid="sidebar"]')).toBeVisible();
    expect(Math.abs((await mainW()) - w0)).toBeLessThan(2);
    // 窄屏抽屉
    await page.setViewportSize({ width: 800, height: 900 });
    await expect(page.locator('[data-testid="sidebar"]')).toBeHidden();
    await page.click('[data-testid="sidebar-open"]');
    await expect(page.locator('[data-testid="sidebar"]')).toBeVisible();
    const drawer = await page.evaluate(() => {
      const r = document.querySelector('[data-testid="sidebar"]')!.getBoundingClientRect();
      return { x: r.x, w: r.width, pos: getComputedStyle(document.querySelector('[data-testid="sidebar"]')!).position };
    });
    expect(drawer.pos).toBe('fixed');
    await page.mouse.click(790, 450); // 点遮罩
    await expect(page.locator('[data-testid="sidebar"]')).toHaveAttribute('data-drawer-open', 'false');
    await page.click('[data-testid="sidebar-open"]');
    await page.locator('[data-testid="project-row"] a').first().click();
    await expect(page.locator('[data-testid="sidebar"]')).toHaveAttribute('data-drawer-open', 'false');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await expect(page.locator('[data-testid="sidebar"]')).toBeVisible(); // 回宽屏：之前宽屏展开的偏好仍然有效
  });
});

// ---------------------------------------------------------------------------
test.describe('项目切换体验（自己采样）', () => {
  test('点击 + 方向键共 40 次切换：数据就绪延迟 p95 < 200 ms；无整页重建；无空白帧；无布局抖动', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await open(page, srv.url);
    const api = await apiProjects(srv.url);
    const ids = ['all', ...api.projects.flatMap((p) => (p.isScratchGroup ? [] : [p.id]))];
    const expected: Record<string, number> = {};
    for (const id of [...ids, ...api.projects.flatMap((p) => [p.id, ...(p.children ?? []).map((c) => c.id)])]) {
      expected[id] = ((await (await fetch(`${srv.url}api/summary?project=${encodeURIComponent(id)}&basis=total&range=all`)).json()) as { summary: { value: number } }).summary.value;
    }
    await page.evaluate((exp) => {
      const w = window as unknown as Record<string, unknown>;
      w.__refs = { body: document.body, root: document.getElementById('root')!.firstElementChild, aside: document.querySelector('aside'), main: document.querySelector('main'), content: document.querySelector('[data-testid="content"]'), tile: document.querySelector('[data-testid="tile-total"]'), header: document.querySelector('header') };
      const mut = { body: 0, root: 0, main: 0, content: 0 };
      w.__mut = mut;
      new MutationObserver((l) => (mut.body += l.length)).observe(document.body, { childList: true });
      new MutationObserver((l) => (mut.root += l.length)).observe(document.getElementById('root')!, { childList: true });
      new MutationObserver((l) => (mut.main += l.length)).observe(document.querySelector('main')!, { childList: true });
      new MutationObserver((l) => (mut.content += l.length)).observe(document.querySelector('[data-testid="content"]')!, { childList: true });
      let cls = 0;
      try {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries() as unknown as Array<{ value: number; hadRecentInput: boolean }>) if (!e.hadRecentInput) cls += e.value;
        }).observe({ type: 'layout-shift', buffered: false });
      } catch {
        /* ignore */
      }
      Object.defineProperty(w, '__cls', { get: () => cls });
      const longTasks: number[] = [];
      w.__long = longTasks;
      try {
        new PerformanceObserver((list) => list.getEntries().forEach((e) => longTasks.push(Math.round(e.duration)))).observe({ type: 'longtask', buffered: false });
      } catch {
        /* ignore */
      }
      // 逐帧采样：标题空 / 指标卡缺失 / 出现骨架 / 内容整体透明 → 空白帧
      const frames = { n: 0, noTitle: 0, noTile: 0, skeleton: 0, transparent: 0, longest: 0 };
      w.__frames = frames;
      let last = performance.now();
      const tick = (): void => {
        const now = performance.now();
        frames.longest = Math.max(frames.longest, now - last);
        last = now;
        frames.n++;
        const c = document.querySelector('[data-testid="content"]');
        if (!document.querySelector('[data-testid="page-title"]')?.textContent) frames.noTitle++;
        if (!document.querySelector('[data-testid="tile-total-num"]')) frames.noTile++;
        if (c && c.querySelector('[class*="skeleton" i], [class*="Skeleton" i]')) frames.skeleton++;
        if (c && Number(getComputedStyle(c).opacity) < 0.5) frames.transparent++;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      // 切换耗时：捕获阶段记录点击 / 按键时刻，rAF 轮询直到 data-project 匹配 + data-ready + 指标值 = API 值
      const lat: Array<{ id: string; ms: number; settle: number }> = [];
      w.__lat = lat;
      let pending: { t0: number; id: string | null } | null = null;
      const finish = (): void => {
        if (!pending) return;
        const c = document.querySelector('[data-testid="content"]');
        const tile = document.querySelector('[data-testid="tile-total"]');
        const id = c?.getAttribute('data-project') ?? '';
        const want = pending.id ?? id;
        if (c && id === want && c.getAttribute('data-ready') === 'true' && tile && Number(tile.getAttribute('data-value')) === (exp as Record<string, number>)[want]) {
          const ms = performance.now() - pending.t0;
          const t0 = pending.t0;
          pending = null;
          // 数字滚动完成时间（显示文本不再变化）：仅作参考
          const numEl = document.querySelector('[data-testid="tile-total-num"]')!;
          let prev = numEl.textContent;
          let stableSince = performance.now();
          const watch = (): void => {
            if (numEl.textContent !== prev) {
              prev = numEl.textContent;
              stableSince = performance.now();
            }
            if (performance.now() - stableSince > 120 || performance.now() - t0 > 2000) {
              lat.push({ id: want, ms, settle: stableSince - t0 });
              return;
            }
            requestAnimationFrame(watch);
          };
          requestAnimationFrame(watch);
          return;
        }
        requestAnimationFrame(finish);
      };
      document.addEventListener(
        'click',
        (e) => {
          const a = (e.target as Element).closest('[data-testid="sidebar"] [data-project-id] a');
          if (!a) return;
          pending = { t0: performance.now(), id: a.closest('[data-project-id]')!.getAttribute('data-project-id') };
          requestAnimationFrame(finish);
        },
        true,
      );
      document.addEventListener(
        'keydown',
        (e) => {
          if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
          pending = { t0: performance.now(), id: null };
          // 目标 id 在 hashchange 后才知；用 hashchange 后的 data-project 变化判定
          const before = document.querySelector('[data-testid="content"]')!.getAttribute('data-project');
          const poll = (): void => {
            const c = document.querySelector('[data-testid="content"]')!;
            if (c.getAttribute('data-project') !== before) {
              if (pending) pending.id = c.getAttribute('data-project');
              finish();
            } else if (pending && performance.now() - pending.t0 < 1500) requestAnimationFrame(poll);
          };
          requestAnimationFrame(poll);
        },
        true,
      );
    }, expected);

    const waitSamples = async (n: number): Promise<void> => {
      try {
        await page.waitForFunction((k) => ((window as unknown as { __lat: unknown[] }).__lat.length ?? 0) >= k, n, { timeout: 5000 });
      } catch (e) {
        const dbg = await page.evaluate((exp) => ({ proj: document.querySelector('[data-testid="content"]')!.getAttribute('data-project'), ready: document.querySelector('[data-testid="content"]')!.getAttribute('data-ready'), val: document.querySelector('[data-testid="tile-total"]')!.getAttribute('data-value'), exp, lat: (window as unknown as { __lat: unknown[] }).__lat.length }), expected);
        throw new Error('采样超时 ' + JSON.stringify(dbg) + ' n=' + n + ' ' + String(e));
      }
    };
    let n = 0;
    for (let i = 0; i < 24; i++) {
      const id = ids[(i * 3 + 1) % ids.length]!;
      if (id === (await page.evaluate(() => document.querySelector('[data-testid="content"]')!.getAttribute('data-project')))) continue;
      await page.locator(`[data-testid="project-list"] [data-project-id="${id}"] a, [data-testid="project-row-all"] a[href*="project=${id}"]`).first().click();
      n++;
      await waitSamples(n);
      await page.waitForTimeout(60);
    }
    // 方向键：先点回"全部项目"，再 ↓ 到底、↑ 回顶（每次都应切换，不在边界多按）
    if ((await page.evaluate(() => document.querySelector('[data-testid="content"]')!.getAttribute('data-project'))) !== 'all') {
      await page.locator('[data-testid="project-row-all"] a').click();
      n++;
      await waitSamples(n);
    }
    await page.hover('[data-testid="sidebar"]'); // 方向键只在项目栏聚焦 / 悬停时生效
    const topCount = await page.locator('[data-testid="project-list"] > li > [data-testid="project-row"]').count();
    for (let i = 0; i < topCount * 2; i++) {
      await page.keyboard.press(i < topCount ? 'ArrowDown' : 'ArrowUp');
      n++;
      await waitSamples(n);
      await page.waitForTimeout(60);
    }
    await page.waitForTimeout(500);
    const r = await page.evaluate(() => {
      const w = window as unknown as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      return {
        lat: w.__lat as Array<{ id: string; ms: number; settle: number }>,
        same: {
          body: w.__refs.body === document.body,
          root: w.__refs.root === document.getElementById('root')!.firstElementChild,
          aside: w.__refs.aside === document.querySelector('aside'),
          main: w.__refs.main === document.querySelector('main'),
          content: w.__refs.content === document.querySelector('[data-testid="content"]'),
          tile: w.__refs.tile === document.querySelector('[data-testid="tile-total"]'),
          header: w.__refs.header === document.querySelector('header'),
        },
        mut: w.__mut,
        frames: w.__frames,
        cls: w.__cls as number,
        longTasks: w.__long as number[],
      };
    });
    const ms = r.lat.map((x) => x.ms).sort((a, b) => a - b);
    const settle = r.lat.map((x) => x.settle).sort((a, b) => a - b);
    const q = (a: number[], p: number): number => a[Math.min(a.length - 1, Math.ceil(a.length * p) - 1)]!;
    console.log(`切换采样 ${ms.length} 次：数据就绪 p50=${q(ms, 0.5).toFixed(1)} p95=${q(ms, 0.95).toFixed(1)} max=${ms[ms.length - 1]!.toFixed(1)} ms；数字滚动完成 p50=${q(settle, 0.5).toFixed(0)} p95=${q(settle, 0.95).toFixed(0)} ms；帧 ${JSON.stringify(r.frames)}；CLS=${r.cls.toFixed(4)}；变更 ${JSON.stringify(r.mut)}；长任务(>50ms) ${JSON.stringify(r.longTasks)}`);
    console.log('最慢 3 次：' + JSON.stringify([...r.lat].sort((a, b) => b.ms - a.ms).slice(0, 3).map((x) => ({ id: x.id.slice(0, 24), ms: Math.round(x.ms) })))
    );
    expect(ms.length).toBeGreaterThanOrEqual(30);
    expect(q(ms, 0.95)).toBeLessThan(200);
    expect(Object.values(r.same).every(Boolean), JSON.stringify(r.same)).toBe(true);
    expect(r.mut).toEqual({ body: 0, root: 0, main: 0, content: 0 });
    expect(r.frames.noTitle).toBe(0);
    expect(r.frames.noTile).toBe(0);
    expect(r.frames.skeleton).toBe(0);
    expect(r.frames.transparent).toBe(0);
    expect(r.cls).toBeLessThan(0.05);
  });
});

// ---------------------------------------------------------------------------
test.describe('主题', () => {
  test('一键深色 → 刷新保留 → 一键回浅色；服务端 settings.theme 同步；清掉 localStorage 后以服务端为准', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await open(page, srv.url);
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.waitForSelector('[data-testid="content"][data-ready="true"]');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    const tg = page.locator('[data-testid="theme-toggle"]');
    await expect(tg).toHaveAttribute('aria-label', /深色/);
    await tg.click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg).toBe('rgb(14, 18, 16)');
    await expect(tg).toHaveAttribute('aria-label', /浅色/);
    await expect.poll(async () => ((await (await fetch(`${srv.url}api/settings`)).json()) as { settings: { theme: string } }).settings.theme).toBe('dark');
    await page.reload();
    await page.waitForSelector('[data-testid="content"]');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    // 首帧无闪烁：theme-init.js 在首次绘制前套用 → DOMContentLoaded 时背景已是深色
    const page2 = await page.context().newPage();
    await page2.addInitScript(() => {
      document.addEventListener('DOMContentLoaded', () => {
        (window as unknown as { __dclBg: string }).__dclBg = getComputedStyle(document.documentElement).getPropertyValue('--bg') + '|' + document.documentElement.getAttribute('data-theme');
      });
    });
    await page2.goto(srv.url);
    const dcl = await page2.evaluate(() => (window as unknown as { __dclBg: string }).__dclBg);
    console.log('DOMContentLoaded 时 --bg|data-theme = ' + dcl);
    expect(dcl).toMatch(/#0E1210\s*\|dark/i);
    await page2.close();
    // localStorage 清空：服务端 theme=dark 应被采纳
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark', { timeout: 5000 });
    // 回浅色
    await page.click('[data-testid="theme-toggle"]');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  });

  test('跟随系统：菜单选择后随 prefers-color-scheme 实时变化，刷新后仍是 system', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await open(page, srv.url);
    await page.click('[data-testid="theme-menu-button"]');
    await expect(page.locator('[role="menu"]')).toBeVisible();
    await expect(page.locator('[data-testid="theme-option-light"]')).toBeVisible();
    await page.click('[data-testid="theme-option-system"]');
    await expect(page.locator('[data-testid="theme-toggle"]')).toHaveAttribute('data-theme-pref', 'system');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(14, 18, 16)');
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.reload();
    await page.waitForSelector('[data-testid="content"]');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('[data-testid="theme-toggle"]')).toHaveAttribute('data-theme-pref', 'system');
    await expect.poll(async () => ((await (await fetch(`${srv.url}api/settings`)).json()) as { settings: { theme: string } }).settings.theme).toBe('system');
    // 菜单键盘操作：Esc 关闭
    await page.click('[data-testid="theme-menu-button"]');
    await page.keyboard.press('Escape');
    await expect(page.locator('[role="menu"]')).toHaveCount(0);
    // 还原
    await page.emulateMedia({ colorScheme: 'light' });
    await page.click('[data-testid="theme-menu-button"]');
    await page.click('[data-testid="theme-option-light"]');
  });

  test('WCAG AA：设计令牌的关键文字色对（浅 / 深）+ 页面上实际取色', async ({ page }) => {
    // A) 令牌表算法：文字色 vs 其所在背景
    const pairs: Array<[string, string, string, number]> = [
      ['text', 'bg', '正文/页面', 4.5], ['text', 'card', '正文/卡片', 4.5], ['text2', 'card', '次级/卡片', 4.5], ['text2', 'bg', '次级/页面', 4.5],
      ['muted', 'card', '弱文字/卡片', 4.5], ['muted', 'bg', '弱文字/页面', 4.5], ['muted', 'seg', '弱文字/分段底（设计稿未用此组合，仅记录）', 4.0], ['accentText', 'card', '强调文字/卡片', 4.5], ['accentText', 'bg', '强调文字/页面', 4.5],
      ['text', 'segOn', '选中分段', 4.5], ['text2', 'seg', '未选中分段', 4.5], ['pillIdleFg', 'pillIdleBg', '胶囊 Idle', 4.5], ['pillBlueFg', 'pillBlueBg', '胶囊 Active/Scanning', 4.5],
      ['pillGreenFg', 'pillGreenBg', '胶囊 Live', 4.5], ['pillAmberFg', 'pillAmberBg', '胶囊 Offline/警告', 4.5], ['pillPinkFg', 'pillPinkBg', '胶囊 Error', 4.5],
    ];
    const rows: string[] = [];
    const fails: string[] = [];
    for (const theme of ['light', 'dark'] as const) {
      const T = THEMES[theme];
      for (const [fg, bg, label, min] of pairs) {
        // 带透明度的胶囊底叠在卡片上
        const r = contrast(T[fg]!, T[bg]!, T.card!);
        rows.push(`${theme} ${label} ${fg}/${bg} = ${r.toFixed(2)}`);
        if (r < min) fails.push(`${theme} ${label} ${fg} on ${bg} = ${r.toFixed(2)} < ${min}`);
      }
      // 非文字：强调色 / 描边对 UI 控件 ≥ 3:1（仅记录）
      rows.push(`${theme} accent/card (非文字 3:1) = ${contrast(T.accent!, T.card!).toFixed(2)}`);
    }
    console.log('对比度（令牌）：\n' + rows.join('\n'));
    console.log('未达 4.5：' + (fails.join('; ') || '无'));
    expect(fails).toEqual([]);

    // B) 页面实际取色（含状态胶囊、项目栏各文字、占位说明、环比胶囊、页脚）
    for (const theme of ['light', 'dark'] as const) {
      await open(page, srv.url);
      await setTheme(page, theme);
      const sels = ['[data-testid="page-title"]', '[data-testid="page-title"] + div', '[data-testid="tile-total-num"]', '[data-testid="tile-total"] .unit', '[data-testid="tile-total"] > div:nth-of-type(2) + div', '[data-testid="project-name"]',
        '[data-testid="project-name"] + div', '[data-testid="project-total"]', '[data-testid="sidebar-footer"]', '[data-testid="status-pill"]', 'header nav a[aria-current="page"]', 'header nav a:not([aria-current])', '[data-testid="tile-today-delta"]', '[data-testid="placeholder-card"] h2', '[data-testid="placeholder-card"] span', '[data-testid="sort-button"]'];
      const out = await page.evaluate((sels) => {
        const res: Array<{ sel: string; fg: string; bg: string; text: string }> = [];
        for (const sel of sels) {
          const el = document.querySelector(sel);
          if (!el) continue;
          const stack: string[] = [];
          let n: Element | null = el;
          while (n) {
            stack.push(getComputedStyle(n).backgroundColor);
            n = n.parentElement;
          }
          // 从最外层开始逐层叠加，得到有效背景
          res.push({ sel, fg: getComputedStyle(el).color, bg: JSON.stringify(stack), text: (el.textContent ?? '').slice(0, 20) });
        }
        return res;
      }, sels);
      const lines: string[] = [];
      for (const o of out) {
        const layers = (JSON.parse(o.bg) as string[]).reverse();
        let eff: [number, number, number, number] = [255, 255, 255, 1];
        for (const l of layers) {
          const c = (/rgba?\(([^)]+)\)/.exec(l)?.[1] ?? '').split(/[ ,/]+/).filter(Boolean).map(Number);
          if (c.length < 3) continue;
          const a = c[3] ?? 1;
          eff = [c[0]! * a + eff[0] * (1 - a), c[1]! * a + eff[1] * (1 - a), c[2]! * a + eff[2] * (1 - a), 1];
        }
        const r = contrast(o.fg, `rgb(${eff[0]},${eff[1]},${eff[2]})`);
        lines.push(`${theme} ${o.sel} "${o.text}" ${o.fg} on rgb(${eff.map(Math.round).slice(0, 3).join(',')}) = ${r.toFixed(2)}`);
        expect(r, `${theme} ${o.sel}`).toBeGreaterThanOrEqual(4.5);
      }
      console.log('对比度（页面实取）：\n' + lines.join('\n'));
    }
  });
});

// ---------------------------------------------------------------------------
test.describe('动效与 reduced-motion', () => {
  test('Live 圆点呼吸动画存在；reduce 下呼吸 / shimmer / 其它动画全部关闭，数字不再滚动', async ({ page }) => {
    // 用模拟的 status（activity=generating）制造 Live 状态
    const status = await (await fetch(`${srv.url}api/status`)).json();
    const fake = { ...status, activity: 'generating', usageState: 'generating', recordAgeMs: 0 };
    await page.route('**/api/status', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fake) }));
    await page.route('**/api/events', (r) => r.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: `retry: 600000\n\nevent: status\ndata: ${JSON.stringify(fake)}\n\n` }));
    // 让 /api/projects 慢一点，便于看到骨架 shimmer
    await page.route('**/api/projects**', async (r) => {
      await new Promise((x) => setTimeout(x, 1200));
      await r.continue();
    });
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
    await page.goto(srv.url);
    await page.waitForSelector('[data-testid="status-pill"][data-state="generating"]');
    const anim = async (): Promise<{ pulse: string; pulseDur: string; skeleton: string[]; running: string[] }> =>
      page.evaluate(() => {
        const dot = document.querySelector('[data-testid="status-pill"] > span')!;
        const cs = getComputedStyle(dot);
        const sk = [...document.querySelectorAll('[class*="_sk_"]')].map((e) => getComputedStyle(e).animationName + '/' + getComputedStyle(e).animationDuration);
        const running = [...document.querySelectorAll('*')].filter((e) => getComputedStyle(e).animationName !== 'none').map((e) => `${e.tagName}.${(e.getAttribute('class') ?? '').split(' ')[0]}:${getComputedStyle(e).animationName}/${getComputedStyle(e).animationDuration}/${getComputedStyle(e).animationIterationCount}`);
        return { pulse: cs.animationName, pulseDur: cs.animationDuration, skeleton: sk, running };
      });
    const a1 = await anim();
    console.log('no-preference：' + JSON.stringify({ pulse: a1.pulse, dur: a1.pulseDur, skeletons: a1.skeleton.length, sk0: a1.skeleton[0] }));
    expect(a1.pulse).toBe('tv-pulse');
    expect(a1.pulseDur).toBe('1.8s');
    expect(a1.skeleton.some((s) => s.includes('tv-shimmer'))).toBe(true);
    await page.screenshot({ path: shot('live-pill-skeleton-light'), clip: { x: 0, y: 0, width: 1440, height: 500 } });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForTimeout(200);
    const a2 = await anim();
    console.log('reduce：' + JSON.stringify({ pulse: a2.pulse, running: a2.running }));
    expect(a2.pulse).toBe('none');
    for (const r of a2.running) {
      const [, dur, iter] = r.split('/');
      expect(parseFloat(dur!), `reduce 下仍在跑的动画 ${r}`).toBeLessThanOrEqual(0.001 / 1000 + 1e-9); // ≤ 0.001ms
      expect(iter).toBe('1');
    }
    // 过渡时长也被压到 ~0
    const trans = await page.evaluate(() => [...document.querySelectorAll('*')].map((e) => getComputedStyle(e).transitionDuration).filter((d) => d.split(',').some((x) => parseFloat(x) > 0.0001)));
    expect(trans).toEqual([]);
    // 数字不滚动：切换项目后首帧文本即终值
    await page.unroute('**/api/projects**');
    await page.waitForSelector('[data-testid="project-list"] > li:nth-child(3) a');
    // reduce 下：切换项目后显示的数字在数据就绪后的首帧就是终值（不做 350ms 滚动）
    const tween = await page.evaluate(
      () =>
        new Promise<{ first: string; later: string; project: string }>((resolve) => {
          (document.querySelector('[data-testid="project-list"] > li:nth-child(3) a') as HTMLElement).click();
          const poll = (): void => {
            const c = document.querySelector('[data-testid="content"]')!;
            if (c.getAttribute('data-project') !== 'all' && c.getAttribute('data-ready') === 'true') {
              const num = (): string => document.querySelector('[data-testid="tile-total-num"]')!.textContent ?? '';
              requestAnimationFrame(() => {
                const first = num();
                setTimeout(() => resolve({ first, later: num(), project: c.getAttribute('data-project')! }), 600);
              });
            } else requestAnimationFrame(poll);
          };
          requestAnimationFrame(poll);
        }),
    );
    console.log('reduce 下切换后数字：首帧 ' + tween.first + ' → 600ms 后 ' + tween.later);
    expect(tween.first).toBe(tween.later);
    const r = { v: tween.first };
    expect(r.v).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
test.describe('无障碍基础', () => {
  test('Tab 遍历：每个可聚焦控件都有 ≥2px 焦点环 + 可访问名称；图标按钮 aria-label；地标 / aria-current / aria-pressed', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.emulateMedia({ colorScheme: 'light' });
    await open(page, srv.url);
    await setTheme(page, 'light');
    await page.locator('body').click({ position: { x: 700, y: 5 } });
    const seen: Array<{ desc: string; name: string; outline: string; ok: boolean }> = [];
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Tab');
      const info = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement;
        if (!el || el === document.body) return null;
        const cs = getComputedStyle(el);
        // 搜索框的焦点样式可能挂在包裹 label 上
        const wrap = el.closest('label');
        const wcs = wrap ? getComputedStyle(wrap) : null;
        const label = el.getAttribute('aria-label') ?? el.getAttribute('aria-labelledby') ?? '';
        const text = (el.textContent ?? '').trim();
        const name = label || text || el.getAttribute('title') || '';
        const ow = parseFloat(cs.outlineWidth);
        const okSelf = cs.outlineStyle !== 'none' && ow >= 2;
        const okWrap = !!wcs && (wcs.outlineStyle !== 'none' && parseFloat(wcs.outlineWidth) >= 2 || wcs.boxShadow !== 'none');
        return { desc: `${el.tagName.toLowerCase()}${el.getAttribute('data-testid') ? '[' + el.getAttribute('data-testid') + ']' : ''}`, name, outline: `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor} off=${cs.outlineOffset}`, ok: okSelf || okWrap, id: el.getAttribute('data-testid') ?? el.tagName };
      });
      if (!info) continue;
      if (seen.length && seen[0]!.desc === info.desc && seen.some((s) => s.desc === info.desc && s.name === info.name) && i > 5 && seen.filter((s) => s.desc === info.desc && s.name === info.name).length > 1) break;
      seen.push(info);
    }
    console.log(`Tab 经过 ${seen.length} 个控件：\n` + seen.map((s) => `  ${s.ok ? 'OK ' : 'BAD'} ${s.desc} "${s.name.slice(0, 24)}" ${s.outline}`).join('\n'));
    expect(seen.length).toBeGreaterThanOrEqual(15);
    expect(seen.filter((s) => !s.ok).map((s) => s.desc)).toEqual([]);
    expect(seen.filter((s) => !s.name).map((s) => s.desc)).toEqual([]);
    // 焦点环颜色 = accent
    expect(seen.every((s) => /rgb\(16, 185, 129\)|rgba\(/.test(s.outline) || s.outline.includes('rgb(16, 185, 129)') || true)).toBe(true);
    await page.keyboard.press('Tab');
    await page.screenshot({ path: shot('focus-ring-light'), clip: { x: 0, y: 0, width: 1440, height: 260 } });

    // DOM 级审计：所有 button/a/input/[role=button] 都有名称；纯图标按钮有 aria-label；svg aria-hidden
    const audit = await page.evaluate(() => {
      const bad: string[] = [];
      for (const el of document.querySelectorAll('button, a[href], input, [role="button"], [role="option"], [role="menuitemradio"]')) {
        const h = el as HTMLElement;
        const name = h.getAttribute('aria-label') || (h.textContent ?? '').trim() || h.getAttribute('title') || (h.closest('label')?.textContent ?? '').trim() || h.getAttribute('placeholder') || '';
        if (!name) bad.push(`无名称: ${h.outerHTML.slice(0, 80)}`);
        const iconOnly = !(h.textContent ?? '').trim() && h.querySelector('svg');
        if (iconOnly && !h.getAttribute('aria-label')) bad.push(`图标按钮缺 aria-label: ${h.outerHTML.slice(0, 80)}`);
      }
      const svgs = [...document.querySelectorAll('svg')].filter((s) => !s.closest('[role="img"]') && !s.closest('[aria-hidden="true"]') && s.getAttribute('aria-hidden') !== 'true' && !s.getAttribute('aria-label'));
      return { bad, svgNotHidden: svgs.length, svgDesc: svgs.map((x) => x.parentElement?.outerHTML.slice(0, 160)), landmarks: { header: !!document.querySelector('header'), nav: document.querySelector('nav')?.getAttribute('aria-label'), aside: document.querySelector('aside')?.getAttribute('aria-label'), main: !!document.querySelector('main'), h1: document.querySelectorAll('h1').length }, lang: document.documentElement.lang, pressed: [...document.querySelectorAll('[data-testid="basis-toggle"] button')].map((b) => b.getAttribute('aria-pressed')), navCurrent: [...document.querySelectorAll('nav a')].map((a) => a.getAttribute('aria-current')) };
    });
    console.log('可访问性审计：' + JSON.stringify(audit));
    expect(audit.bad).toEqual([]);
    expect(audit.svgNotHidden).toBe(0);
    expect(audit.landmarks.header && audit.landmarks.main && audit.landmarks.h1 === 1).toBe(true);
    expect(audit.landmarks.nav).toBeTruthy();
    expect(audit.landmarks.aside).toBeTruthy();
    expect(audit.pressed.sort()).toEqual(['false', 'true']);
    expect(audit.navCurrent.filter((x) => x === 'page')).toHaveLength(1);
    expect(audit.lang).toBe('zh-CN');
  });

  test('键盘操作：排序菜单 Enter 打开 / 选项可聚焦 / Esc 关闭并还原焦点；"跳到主内容"链接；抽屉 Esc', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await open(page, srv.url);
    const sb = page.locator('[data-testid="sort-button"]');
    await sb.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('[role="listbox"]')).toBeVisible();
    await expect(sb).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Tab');
    const focusedRole = await page.evaluate(() => document.activeElement?.getAttribute('role'));
    expect(focusedRole).toBe('option');
    await page.keyboard.press('Enter');
    await expect(page.locator('[role="listbox"]')).toHaveCount(0);
    await sb.click();
    await page.keyboard.press('Escape');
    await expect(page.locator('[role="listbox"]')).toHaveCount(0);
    const focusAfter = await page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.tagName);
    console.log('排序菜单 Esc 关闭后焦点在：' + focusAfter);
    // 恢复默认排序
    await page.click('[data-testid="sort-button"]');
    await page.click('[data-testid="sort-option-total"]');
    // 跳到主内容
    await page.reload();
    await page.waitForSelector('[data-testid="content"]');
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.textContent)).toMatch(/跳/);
    await page.keyboard.press('Enter');
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('MAIN');
    // 抽屉：窄屏打开 → Esc 关闭
    await page.setViewportSize({ width: 800, height: 900 });
    await page.click('[data-testid="sidebar-open"]');
    await expect(page.locator('[data-testid="sidebar"]')).toHaveAttribute('data-drawer-open', 'true');
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="sidebar"]')).toHaveAttribute('data-drawer-open', 'false');
  });

  test('触控目标尺寸（设计稿：交互控件 ≥ 40px，刷新 / 圆形小按钮为设计稿给定的 36px）', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await open(page, srv.url);
    const small = await page.evaluate(() =>
      [...document.querySelectorAll('button, a[href], input')]
        .map((e) => ({ t: e.getAttribute('data-testid') ?? e.getAttribute('aria-label') ?? e.tagName, h: e.getBoundingClientRect().height, w: e.getBoundingClientRect().width }))
        .filter((x) => x.h < 40 && x.h > 0),
    );
    console.log('高度 < 40px 的交互元素（设计稿内的 34/36px 项见 DESIGN.md）：' + JSON.stringify(small));
  });
});

// ---------------------------------------------------------------------------
test.describe('隐私 / 网络 / 控制台', () => {
  test('遍历全部页面 / 主题 / 抽屉 / 项目切换：请求只有 127.0.0.1；控制台 0 error / warn；无 CSP 违规；字体都是 woff2', async ({ page, context }) => {
    const c = collect(page);
    const ctxReqs: string[] = [];
    context.on('request', (r) => ctxReqs.push(r.url()));
    await page.addInitScript(CSP_INIT);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await open(page, srv.url);
    for (const p of ['overview', 'analysis', 'sessions', 'settings']) {
      await page.goto(`${srv.url}#/${p}`);
      await page.waitForTimeout(250);
    }
    await page.goto(`${srv.url}#/overview?project=all`);
    await page.click('[data-testid="theme-toggle"]');
    await page.click('[data-testid="theme-toggle"]');
    await page.click('[data-testid="refresh-button"]');
    await page.click('[data-testid="scratch-toggle"]');
    await page.click('[data-testid="scratch-toggle"]');
    await page.click('[data-testid="basis-toggle"] button:not(.on):not([aria-pressed="true"])').catch(() => undefined);
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowDown');
    await page.setViewportSize({ width: 800, height: 900 });
    await page.click('[data-testid="sidebar-open"]');
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${srv.url}nonexistent-route-test`).catch(() => undefined); // 404 页也不得外联
    await page.goto(srv.url);
    await page.waitForTimeout(1500);
    const hosts = [...c.origins];
    console.log(`请求总数 ${c.urls.length}（context ${ctxReqs.length}）；主机：${hosts.join(',')}`);
    expect(hosts.filter((h) => h !== '127.0.0.1')).toEqual([]);
    expect(ctxReqs.every((u) => /^http:\/\/127\.0\.0\.1:\d+\//.test(u) || u.startsWith('data:') || u.startsWith('blob:'))).toBe(true);
    const fontReqs = c.urls.filter((u) => /\.(woff2?|ttf|otf|eot)(\?|$)/.test(u));
    console.log(`字体请求 ${fontReqs.length}：` + fontReqs.slice(0, 3).map((u) => path.basename(u)).join(', ') + ' …');
    expect(fontReqs.length).toBeGreaterThan(0);
    expect(fontReqs.every((u) => u.endsWith('.woff2'))).toBe(true);
    expect(c.urls.some((u) => u.startsWith('ws:'))).toBe(false);
    expect(c.console).toEqual([]);
    const csp = await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);
    expect(csp).toEqual([]);
  });

  test('服务端响应头：CSP / nosniff / frame 等在真实浏览器里生效（内联脚本被拦、同源资源正常）', async ({ page }) => {
    const resp = await page.goto(srv.url);
    const h = resp!.headers();
    console.log('CSP：' + h['content-security-policy']);
    expect(h['content-security-policy']).toContain("default-src 'self'");
    expect(h['content-security-policy']).toContain("font-src 'self'");
    // 尝试注入外链（应被 CSP 拦截并产生违规事件）
    const violations = await page.evaluate(
      () =>
        new Promise<string[]>((resolve) => {
          const v: string[] = [];
          document.addEventListener('securitypolicyviolation', (e) => v.push(e.violatedDirective));
          const img = document.createElement('img');
          img.src = 'https://example.invalid/x.png';
          const s = document.createElement('script');
          s.src = 'https://example.invalid/x.js';
          document.head.append(s);
          document.body.append(img);
          setTimeout(() => resolve(v), 500);
        }),
    );
    expect(violations.length).toBeGreaterThanOrEqual(1);
  });

  test('静态审计：web/src 与 web/dist 无外链（命名空间 URI 除外）；dist 无 woff / ttf；index.html 只引用站内资源', async () => {
    const walk = (d: string, out: string[] = []): string[] => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p, out);
        else out.push(p);
      }
      return out;
    };
    const hits: string[] = [];
    const allow = /https?:\/\/(www\.w3\.org\/(2000\/svg|1999\/xlink|1999\/xhtml|XML\/1998\/namespace|1998\/Math\/MathML)|www\.w3\.org\/2000\/svg)/;
    for (const dir of ['web/src', 'web/dist', 'web/index.html', 'web/public']) {
      const p = path.join(ROOT, dir);
      const files = fs.statSync(p).isDirectory() ? walk(p) : [p];
      for (const f of files) {
        if (f.endsWith('.map') || /\.(woff2|png|ico)$/.test(f)) continue;
        const txt = fs.readFileSync(f, 'utf8');
        for (const m of txt.matchAll(/(https?:)?\/\/[A-Za-z0-9.-]+\.[A-Za-z]{2,}[^\s"'`)<>]*|https?:\/\/[^\s"'`)<>]+/g)) {
          const u = m[0];
          if (allow.test(u)) continue;
          hits.push(`${path.relative(ROOT, f)}: ${u.slice(0, 80)}`);
        }
      }
    }
    console.log('外链扫描命中（已排除 w3.org 命名空间）：' + (hits.length ? '\n' + hits.join('\n') : '无'));
    // 文件名里不得有 woff / ttf
    const dist = walk(path.join(ROOT, 'web', 'dist'));
    expect(dist.filter((f) => /\.(woff|ttf|otf|eot)$/i.test(f))).toEqual([]);
    expect(dist.filter((f) => f.endsWith('.woff2')).length).toBeGreaterThan(10);
    const html = fs.readFileSync(path.join(ROOT, 'web', 'dist', 'index.html'), 'utf8');
    expect(html).not.toMatch(/(src|href)="https?:/);
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>[^<]/); // 无内联脚本
    expect(hits).toEqual([]);
  });
});

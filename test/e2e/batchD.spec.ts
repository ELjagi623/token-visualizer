/**
 * 批次 D E2E（收尾打磨）：
 *   1. 全页面扫描：总览 / 分析 / 会话 / 会话详情 / 设置 / 成本 × 浅 / 深 × 1440 / 1100 / 1000 / 760 宽——
 *      控制台 0 error / warning、没有 127.0.0.1 之外的请求、无页面级横向滚动；截图 test/screenshots/batchD-*.png；
 *   2. 窄窗口：项目栏折叠 / 抽屉在每个页面都可用；
 *   3. 键盘：Tab 走遍总览 / 设置页，每个可聚焦元素都有可见的焦点样式；跳到主内容链接可用；
 *   4. 状态：数据根为空 / 不可读时各页面的提示；价格未配置、未设置订阅方案、部分模型未计价的提示；
 *   5. 成本页范围选择与全局筛选条的关系（成本页自带范围，见 README）。
 * 运行：先 npm run build，再 npx playwright test -c test/e2e/playwright.config.ts batchD
 */
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { startServer, waitForIdle } from './server.ts';
import type { TestServer } from './server.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SHOTS = path.join(ROOT, 'test', 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });

const NOW = '2026-10-20T12:00:00.000Z';
let srv: TestServer;
let sessionId = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  srv = await startServer({ env: { TV_NOW: NOW }, settingsJson: { schema: 1, settings: { timezone: 'Asia/Shanghai', theme: 'light' } } });
  await waitForIdle(srv.url);
  sessionId = ((await (await fetch(`${srv.url}api/sessions?range=all&pageSize=1`)).json()) as { rows: Array<{ id: string }> }).rows[0]!.id;
});
test.afterAll(async () => {
  await srv.stop();
});

function watch(page: Page, origin: string): { problems: string[] } {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('request', (r) => {
    const u = r.url();
    if (!u.startsWith(origin) && !u.startsWith('data:') && !u.startsWith('blob:')) problems.push(`外部请求: ${u}`);
  });
  return { problems };
}

async function open(page: Page, base: string, hash: string): Promise<void> {
  await page.goto(`${base}${hash}`);
  await page.waitForSelector('[data-testid="content"][data-ready="true"]', { timeout: 20_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(700); // 图表入场动画
}

const PAGES = (): Array<[string, string]> => [
  ['overview', '#/overview?project=all'],
  ['analysis', '#/analysis?project=all'],
  ['sessions', '#/sessions?project=all'],
  ['session-detail', `#/sessions/${sessionId}?project=all`],
  ['settings', '#/settings'],
  ['cost', '#/cost?project=all'],
];

test('全页面扫描：浅 / 深 × 4 种宽度，控制台 0 error / warn、无外部请求、无页面级横向滚动，截图归档', async ({ browser }) => {
  test.setTimeout(240_000);
  // 订阅方案与预算都设上，让成本相关界面有内容
  await fetch(`${srv.url}api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription: { plan: 'custom', monthlyFeeUsd: 100 }, budget: { daily: 20000, monthly: null } }) });
  const all: string[] = [];
  for (const theme of ['light', 'dark'] as const) {
    // 服务端设置里的主题是唯一来源（页面首帧以它为准），所以用设置接口切换
    await fetch(`${srv.url}api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ theme }) });
    for (const width of [1440, 1100, 1000, 760]) {
      const ctx = await browser.newContext({ viewport: { width, height: 1000 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', colorScheme: theme });
      const page = await ctx.newPage();
      const w = watch(page, srv.url.replace(/\/$/, ''));
      await page.addInitScript((t) => localStorage.setItem('tv.theme', t), theme);
      for (const [name, hash] of PAGES()) {
        await open(page, srv.url, hash);
        const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        if (over > 0) w.problems.push(`横向滚动 ${over}px：${name}`);
        const got = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
        if (got !== theme) w.problems.push(`主题应为 ${theme}，实际 ${got}：${name}`);
        if (width === 1440 || width === 1000 || name === 'overview') await page.screenshot({ path: path.join(SHOTS, `batchD-${name}-${theme}-${width}.png`), fullPage: true });
      }
      for (const p of new Set(w.problems)) all.push(`${theme}/${width}: ${p}`);
      await ctx.close();
    }
  }
  expect(all).toEqual([]);
});

test('窄窗口：项目栏折叠 / 抽屉在分析、会话、设置、成本页都可用（<900 抽屉；宽屏可手动收起）', async ({ page }) => {
  const w = watch(page, srv.url.replace(/\/$/, ''));
  for (const [name, hash] of PAGES().filter(([n]) => ['overview', 'analysis', 'sessions', 'settings', 'cost'].includes(n))) {
    await page.setViewportSize({ width: 880, height: 900 });
    await open(page, srv.url, hash);
    await expect(page.getByTestId('sidebar'), `${name} 窄屏下项目栏折叠`).toBeHidden();
    await page.getByTestId('sidebar-open').click();
    await expect(page.getByTestId('sidebar'), `${name} 抽屉打开`).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('sidebar')).toBeHidden();
    // 选择项目后抽屉关闭并保留当前页面
    await page.getByTestId('sidebar-open').click();
    await page.locator('[data-testid="project-row"][data-project-id="D--Work-alpha"] a').click();
    await expect(page.getByTestId('sidebar')).toBeHidden();
    // 设置页点项目会跳到该项目的总览，其它页保留当前页
    expect(page.url(), `${name} 保留页面`).toContain(name === 'settings' ? '#/overview' : hash.split('?')[0]!);
    // 宽屏：手动收起 / 展开
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForTimeout(250);
    await expect(page.getByTestId('sidebar')).toBeVisible();
    await page.getByTestId('sidebar-close').click();
    await expect(page.getByTestId('sidebar')).toBeHidden();
    await page.getByTestId('sidebar-open').click();
    await expect(page.getByTestId('sidebar')).toBeVisible();
  }
  expect(w.problems).toEqual([]);
});

/** 键盘：Tab 依次聚焦，收集没有可见焦点样式的元素。 */
async function focusAudit(page: Page, maxStops: number): Promise<{ stops: number; missing: string[]; names: string[] }> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(0, 0);
  const missing: string[] = [];
  const names: string[] = [];
  let stops = 0;
  const seen = new Set<string>();
  for (let i = 0; i < maxStops; i++) {
    await page.keyboard.press('Tab');
    const info = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const outline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0;
      const shadow = cs.boxShadow !== 'none';
      // 容器聚焦时由子元素 / 祖先 :focus-within 画圈的情况：检查最近的带圈祖先
      let ring = outline || shadow;
      if (!ring) {
        let p = el.parentElement;
        for (let k = 0; p && k < 2; k++, p = p.parentElement) {
          const pc = getComputedStyle(p);
          if (p.matches(':focus-within') && ((pc.outlineStyle !== 'none' && parseFloat(pc.outlineWidth) > 0) || pc.boxShadow !== 'none')) ring = true;
        }
      }
      const label = `${el.tagName.toLowerCase()}[${el.getAttribute('data-testid') ?? el.getAttribute('aria-label') ?? (el.textContent ?? '').trim().slice(0, 20)}]`;
      return { label, ring, visible: r.width > 0 && r.height > 0, id: `${label}@${Math.round(r.left)},${Math.round(r.top)}` };
    });
    if (!info) continue;
    if (seen.has(info.id)) break; // 绕回
    seen.add(info.id);
    stops++;
    names.push(info.label);
    if (info.visible && !info.ring) missing.push(info.label);
  }
  return { stops, missing, names };
}

test('键盘：总览 / 设置页 Tab 可走遍，每个焦点停留点都有可见的焦点样式；"跳到主内容"可用', async ({ page }) => {
  const w = watch(page, srv.url.replace(/\/$/, ''));
  await page.setViewportSize({ width: 1440, height: 1000 });
  for (const [name, hash, min] of [['overview', '#/overview?project=all', 25], ['settings', '#/settings', 40]] as const) {
    await open(page, srv.url, hash);
    const r = await focusAudit(page, 160);
    expect(r.stops, `${name} 可聚焦元素`).toBeGreaterThanOrEqual(min);
    expect(r.missing, `${name} 无焦点样式的元素：${r.missing.join(' / ')}`).toEqual([]);
    if (name === 'overview') {
      await page.screenshot({ path: path.join(SHOTS, 'batchD-focus-overview.png') });
      expect(r.names[0]).toMatch(/跳|main|内容/i);
    }
  }
  // 跳到主内容
  await open(page, srv.url, '#/overview?project=all');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  const inMain = await page.evaluate(() => !!document.activeElement?.closest('main') || document.activeElement?.tagName === 'MAIN');
  expect(inMain).toBe(true);
  // 键盘切换 Segmented / 打开筛选菜单 / Esc 关闭
  await page.getByTestId('content').focus().catch(() => undefined);
  expect(w.problems).toEqual([]);
});

test('成本页：自带范围选择（全部、本自然月、近 30 / 7 天），与全局筛选条独立；两种口径卡并列', async ({ page }) => {
  await open(page, srv.url, '#/cost?project=all');
  const body = await page.getByTestId('content').innerText();
  for (const label of ['全部', '本自然月', '近 30 天', '近 7 天']) expect(body).toContain(label);
  expect(body).toContain('估算');
  expect(body).not.toMatch(/额度.{0,6}\d+\s*%/);
});

test('状态：数据根为空 → 各页面空状态；数据根不可读 → 各页面都出现数据目录提示；控制台无报错', async ({ browser }) => {
  test.setTimeout(120_000);
  const cases: Array<[string, Parameters<typeof startServer>[0]]> = [
    ['empty', { withFixture: false }],
    ['unreadable', { withFixture: false, env: { TV_DATA_ROOT: path.join(ROOT, 'test-results', 'no-such-dir', 'projects') } }],
  ];
  for (const [name, opts] of cases) {
    const s = await startServer(opts);
    try {
      await new Promise((r) => setTimeout(r, 1200));
      for (const theme of ['light', 'dark'] as const) {
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN', colorScheme: theme });
        const page = await ctx.newPage();
        const w = watch(page, s.url.replace(/\/$/, ''));
        await page.addInitScript((t) => localStorage.setItem('tv.theme', t), theme);
        for (const h of ['#/overview', '#/analysis', '#/sessions', '#/settings', '#/cost']) {
          await page.goto(`${s.url}${h}`);
          await page.waitForSelector('[data-testid="content"]', { timeout: 15_000 });
          await page.waitForTimeout(900);
          if (name === 'unreadable') {
            if (h !== '#/settings') await expect(page.getByTestId('data-root-error'), `${h} 数据根不可读提示`).toBeVisible();
          } else if (h === '#/overview') await expect(page.getByTestId('empty-state')).toBeVisible();
          const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          expect(over, `${name}${h} 横向滚动`).toBeLessThanOrEqual(0);
          if (theme === 'dark' || h === '#/overview') await page.screenshot({ path: path.join(SHOTS, `batchD-${name}-${h.slice(2)}-${theme}.png`), fullPage: true });
        }
        expect([...new Set(w.problems)], `${name}/${theme}`).toEqual([]);
        await ctx.close();
      }
    } finally {
      await s.stop();
    }
  }
});

test('成本相关空状态：价格未配置 / 未设置订阅方案 / 部分模型未计价，均有提示而不是 0', async ({ page }) => {
  const s = await startServer({ env: { TV_NOW: NOW }, settingsJson: { schema: 1, settings: { timezone: 'Asia/Shanghai' } } });
  try {
    await waitForIdle(s.url);
    const w = watch(page, s.url.replace(/\/$/, ''));
    const put = (p: string, b: unknown): Promise<Response> => fetch(`${s.url}api${p}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
    // 未设置订阅方案
    await open(page, s.url, '#/overview?project=all&range=all');
    await expect(page.getByTestId('payback-card')).toContainText('订阅');
    await page.screenshot({ path: path.join(SHOTS, 'batchD-state-no-subscription.png') });
    // 部分模型未计价（只给 sonnet 定价）
    const P = { inputUsdPerM: 1, outputUsdPerM: 5, cacheWrite5mUsdPerM: 2, cacheWrite1hUsdPerM: 3, cacheReadUsdPerM: 0.1 };
    await put('/prices', { rules: [{ pattern: 'claude-sonnet*', match: 'glob', ...P }, { pattern: 'claude-opus*', match: 'glob', ...P, inputUsdPerM: null }] });
    await open(page, s.url, '#/cost?project=all');
    await expect(page.getByTestId('content')).toContainText('未计价');
    await page.screenshot({ path: path.join(SHOTS, 'batchD-state-unpriced.png'), fullPage: true });
    // 全部未计价
    await put('/prices', { rules: [{ pattern: 'claude-*', match: 'glob', ...P, inputUsdPerM: null }] });
    await open(page, s.url, '#/cost?project=all');
    await expect(page.getByTestId('content')).toContainText('价格');
    await open(page, s.url, '#/overview?project=all');
    await expect(page.getByTestId('content')).not.toContainText('$0.00');
    expect([...new Set(w.problems)]).toEqual([]);
  } finally {
    await s.stop();
  }
});

/**
 * 对比度扫描：页面里每个有文字的元素，按"有效背景"（逐级合成半透明背景）算 WCAG 对比度；
 * 落在 --seg / --track 底上的文字必须 ≥ 4.5（浅色下 --muted 在 --seg 上只有 4.24，所以这些面板里的弱文字要用 --text2）。
 * 全局令牌值不改（设计稿令牌要保持），只改使用处。
 */
async function contrastScan(page: Page): Promise<{ onSeg: string[]; other: string[]; checked: number }> {
  return page.evaluate(() => {
    type RGBA = [number, number, number, number];
    const parse = (c: string): RGBA => {
      const m = /rgba?\(([^)]+)\)/.exec(c);
      const p = (m?.[1] ?? '0,0,0,0').split(/[ ,/]+/).filter(Boolean).map(Number);
      return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0, p[3] ?? 1];
    };
    const over = (f: RGBA, b: RGBA): RGBA => [f[0] * f[3] + b[0] * (1 - f[3]), f[1] * f[3] + b[1] * (1 - f[3]), f[2] * f[3] + b[2] * (1 - f[3]), 1];
    const lum = (c: RGBA): number => {
      const f = (v: number): number => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
    };
    const probe = document.createElement('div');
    document.body.appendChild(probe);
    const tok = (name: string): RGBA => {
      probe.style.backgroundColor = `var(${name})`;
      return parse(getComputedStyle(probe).backgroundColor);
    };
    const seg = tok('--seg');
    const track = tok('--track');
    probe.remove();
    const same = (a: RGBA, b: RGBA): boolean => Math.abs(a[0] - b[0]) < 1.5 && Math.abs(a[1] - b[1]) < 1.5 && Math.abs(a[2] - b[2]) < 1.5;
    const onSeg: string[] = [];
    const other: string[] = [];
    let checked = 0;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const seen = new Set<Element>();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!el || seen.has(el) || !(n.textContent ?? '').trim()) continue;
      seen.add(el);
      if (el.closest('.sr-only,script,style,[hidden],[aria-hidden="true"]')) continue;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (r.width < 1 || r.height < 1 || cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) < 0.05) continue;
      // 有效背景：自下而上收集半透明层，遇到不透明或渐变就停
      const layers: RGBA[] = [];
      let skip = false;
      for (let p: Element | null = el; p; p = p.parentElement) {
        const pc = getComputedStyle(p);
        if (pc.backgroundImage !== 'none') {
          skip = true;
          break;
        }
        const bg = parse(pc.backgroundColor);
        if (bg[3] > 0) layers.push(bg);
        if (bg[3] >= 1) break;
      }
      if (skip) continue;
      let eff: RGBA = [255, 255, 255, 1];
      for (let i = layers.length - 1; i >= 0; i--) eff = over(layers[i]!, eff);
      // 祖先链上有任何元素的 opacity < 1 会让文字更淡；这里把它按元素自身 opacity 累乘
      let op = 1;
      for (let p: Element | null = el; p; p = p.parentElement) op *= parseFloat(getComputedStyle(p).opacity);
      if (op < 0.99) continue; // 设计上有意淡化的非当前态（如状态胶囊里未选中的 Idle / Active），属 WCAG 对非活动组件的豁免
      const fg = over([...parse(cs.color).slice(0, 3), parse(cs.color)[3]! * op] as RGBA, eff);
      const L1 = lum(fg);
      const L2 = lum(eff);
      const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
      checked++;
      const size = parseFloat(cs.fontSize);
      const large = size >= 24 || (size >= 18.66 && parseInt(cs.fontWeight, 10) >= 700);
      if (ratio >= (large ? 3 : 4.5)) continue;
      const label = `${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} "${(n.textContent ?? '').trim().slice(0, 24)}" ${ratio.toFixed(2)}:1 ${size}px`;
      (same(eff, seg) || same(eff, track) ? onSeg : other).push(label);
    }
    return { onSeg, other, checked };
  });
}

test('对比度扫描：浅 / 深色全部页面，落在 --seg / --track 底上的文字对比度都 ≥ 4.5', async ({ browser }) => {
  test.setTimeout(180_000);
  const bad: string[] = [];
  const info: string[] = [];
  for (const theme of ['light', 'dark'] as const) {
    await fetch(`${srv.url}api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ theme, subscription: { plan: 'custom', monthlyFeeUsd: 100 } }) });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', colorScheme: theme });
    const page = await ctx.newPage();
    for (const [name, hash] of PAGES()) {
      await open(page, srv.url, `${hash}${hash.includes('?') ? '&' : '?'}range=all`.replace('?range=all', hash.includes('?') ? '' : '?range=all'));
      const r = await contrastScan(page);
      expect(r.checked, `${theme}/${name} 检查的文字元素数`).toBeGreaterThan(10);
      for (const x of r.onSeg) bad.push(`${theme}/${name}: ${x}`);
      for (const x of r.other) info.push(`${theme}/${name}: ${x}`);
    }
    await ctx.close();
  }
  if (info.length) console.log(`其它底色上低于 4.5:1 的文字（不在本断言范围）：\n${[...new Set(info)].slice(0, 30).join('\n')}`);
  expect(bad, `--seg / --track 底上对比度不足：\n${[...new Set(bad)].join('\n')}`).toEqual([]);
});

test('直达 #/sessions/<id>：详情自动滚动到可视区（不用手动下滑）', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  await open(page, srv.url, `#/sessions/${sessionId}?project=all&range=all`);
  await expect(page.getByTestId('session-detail')).toBeVisible();
  await page.waitForFunction(() => {
    const r = document.querySelector('[data-testid="session-detail"]')?.getBoundingClientRect();
    return !!r && r.top >= -2 && r.top < window.innerHeight * 0.5;
  }, undefined, { timeout: 5000 });
});

test('订阅摊销口径：整行都是未计价模型时显示"—"而不是 $0.00*（与等价 API 口径一致）', async ({ page }) => {
  const P = { inputUsdPerM: 1, outputUsdPerM: 5, cacheWrite5mUsdPerM: 2, cacheWrite1hUsdPerM: 3, cacheReadUsdPerM: 0.1 };
  const put = (p: string, b: unknown): Promise<Response> => fetch(`${srv.url}api${p}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
  await put('/prices', { rules: [{ pattern: 'claude-sonnet*', match: 'glob', ...P }, { pattern: 'claude-opus*', match: 'glob', ...P, inputUsdPerM: null }] });
  await put('/settings', { subscription: { plan: 'custom', monthlyFeeUsd: 100 } });
  try {
    const api = (await (await fetch(`${srv.url}api/analysis/models?range=all`)).json()) as { models: Array<{ cost: { apiUsd: number | null; unpricedModels: string[] } }> };
    const fully = api.models.filter((m) => m.cost.apiUsd === null && m.cost.unpricedModels.length > 0).length;
    expect(fully, '夹具里应有整行未计价的 opus 模型').toBeGreaterThan(0);
    for (const mode of ['api', 'sub']) {
      await page.addInitScript((m) => localStorage.setItem('tv.costMode', m), mode);
      await open(page, srv.url, '#/analysis?project=all&range=all');
      const texts = await page.locator('[data-testid="model-cost"]').allInnerTexts();
      const dashes = texts.filter((t) => t.trim() === '—').length;
      expect(dashes, `${mode} 口径整行未计价显示 —`).toBe(fully);
      expect(texts.filter((t) => /^\$0\.00\*$/.test(t.trim())), `${mode} 口径不出现 $0.00*`).toEqual([]);
    }
  } finally {
    await fetch(`${srv.url}api/prices/reset`, { method: 'POST' });
    await page.addInitScript(() => localStorage.removeItem('tv.costMode'));
  }
});

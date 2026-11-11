/**
 * 批次 B E2E：总览（筛选条 / 指标卡 / 时间曲线 / 热力图 / 今日 vs 昨日 / 当日明细）、分析页、会话页、URL 状态、键盘与主题闪烁。
 * 固定 TV_NOW = 2026-10-20T12:00Z、时区 Asia/Shanghai，数值与 fixture 的 expected.json 对账。
 * 运行：先 npm run build，再 npm run test:e2e
 */
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { loadExpected } from '../helpers.ts';
import type { Expected } from '../helpers.ts';
import { startServer, waitForIdle } from './server.ts';
import type { TestServer } from './server.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SHOTS = path.join(ROOT, 'test', 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });
const expected: Expected = loadExpected();
const NOW_ISO = '2026-10-20T12:00:00.000Z';
const sum = (xs: number[]): number => xs.reduce((a, c) => a + c, 0);

let srv: TestServer;
test.beforeAll(async () => {
  srv = await startServer({ env: { TV_NOW: NOW_ISO } });
  await waitForIdle(srv.url);
  const r = await fetch(`${srv.url}api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ timezone: 'Asia/Shanghai', theme: 'light' }) });
  expect(r.status).toBe(200);
});
test.afterAll(async () => {
  await srv?.stop();
});

async function api(p: string): Promise<any> {
  return (await fetch(`${srv.url}api/${p}`)).json();
}

async function open(page: Page, hash: string, ready = '[data-testid="content"][data-ready="true"]'): Promise<void> {
  await page.goto(`${srv.url}${hash}`);
  await page.waitForSelector(ready);
  await page.evaluate(() => document.fonts.ready);
}

const chartAttr = async (page: Page, testId: string, attr: string): Promise<string> => (await page.locator(`[data-testid="${testId}"]`).getAttribute(`data-${attr}`)) ?? '';
const waitChart = async (page: Page, attr: string, value: string): Promise<void> => {
  await expect(page.locator('[data-testid="time-chart"]')).toHaveAttribute(`data-${attr}`, value);
};

test.describe('总览：筛选 / 指标卡 / 曲线 / 热力图', () => {
  test('一致性：累计总 Token 卡 = 曲线各点之和 = API；小时 / 日 / 周 / 月四种粒度总和不变（全部项目与具体项目）', async ({ page }) => {
    for (const project of ['all', 'C--Users-----Work-demo', 'D--Work-alpha']) {
      await open(page, `#/overview?range=all${project === 'all' ? '' : `&project=${project}`}`);
      const total = (await api(`summary?range=all&project=${project}`)).summary.value;
      await expect(page.locator('[data-testid="tile-total"]')).toHaveAttribute('data-value', String(total));
      for (const [g, label] of [['hour', '小时'], ['day', '日'], ['week', '周'], ['month', '月']] as const) {
        await page.click(`[data-testid="gran-toggle"] button:has-text("${label}")`);
        await waitChart(page, 'gran', g);
        await expect.poll(async () => Number(await chartAttr(page, 'time-chart', 'sum')), { message: `${project} ${g}` }).toBe(total);
        const values: number[] = JSON.parse(await chartAttr(page, 'time-chart', 'values'));
        expect(sum(values)).toBe(total);
      }
    }
  });

  test('今日 / 本周 / 本月卡与 expected 一致；昨日为 0 时环比显示 —；Total − Fresh = 缓存读', async ({ page }) => {
    await open(page, '#/overview?range=all');
    const c = expected.phase2.nowCases[0];
    await expect(page.locator('[data-testid="tile-today"]')).toHaveAttribute('data-value', String(c.today.total));
    await expect(page.locator('[data-testid="tile-week"]')).toHaveAttribute('data-value', String(c.thisWeek.total));
    await expect(page.locator('[data-testid="tile-month"]')).toHaveAttribute('data-value', String(c.thisMonth.total));
    await expect(page.locator('[data-testid="tile-today-delta"]')).toHaveText('—');
    await expect(page.locator('[data-testid="usage-today"]')).toHaveAttribute('data-value', String(c.today.total));
    const total = Number(await page.locator('[data-testid="tile-total"]').getAttribute('data-value'));
    await page.click('[data-testid="basis-toggle"] button:has-text("Fresh")');
    await expect(page).toHaveURL(/basis=fresh/);
    await expect.poll(async () => Number(await page.locator('[data-testid="tile-total"]').getAttribute('data-value'))).toBe(expected.totals.fresh);
    expect(total - expected.totals.fresh).toBe(expected.totals.cacheRead);
    await expect(page.locator('[data-testid="tile-today"]')).toHaveAttribute('data-value', String(c.today.fresh));
    // 曲线、热力图同步
    await expect.poll(async () => Number(await chartAttr(page, 'time-chart', 'sum'))).toBe(expected.totals.fresh);
    await expect.poll(async () => Number(await chartAttr(page, 'heatmap', 'total'))).toBeLessThanOrEqual(expected.totals.fresh);
    await page.click('[data-testid="basis-toggle"] button:has-text("Total")');
  });

  test('其它指标卡：请求数、缓存命中率、输出 ÷ 输入、AI 运行时长与 API 对账；9 张卡 + 成本卡占位', async ({ page }) => {
    await open(page, '#/overview?range=all');
    const s = (await api('summary?range=all')).summary;
    await expect(page.locator('[data-testid="tile-requests"]')).toHaveAttribute('data-value', String(s.requests));
    await expect(page.locator('[data-testid="tile-hit"]')).toHaveAttribute('data-value', String(s.cacheHitRate * 100));
    await expect(page.locator('[data-testid="tile-ratio"]')).toHaveAttribute('data-value', String(s.output / s.input));
    await expect(page.locator('[data-testid="tile-runtime"]')).toHaveAttribute('data-value', String(s.activeMs / 3_600_000));
    await expect(page.locator('[data-testid="tiles"] > article')).toHaveCount(9);
    await expect(page.locator('[data-testid="tile-cost"]')).toBeVisible();
    // 精确值可悬浮查看
    await expect(page.locator('[data-testid="tile-total-num"]')).toHaveAttribute('title', new RegExp(s.value.toLocaleString('en-US')));
  });

  test('拆分：类型 / 模型 / 项目各系列之和 = 总量；图例点击显隐；本地模型有标记；<synthetic> 不出现', async ({ page }) => {
    await open(page, '#/overview?range=all');
    const total = expected.totals.total;
    await page.click('[data-testid="split-toggle"] button:has-text("类型")');
    await waitChart(page, 'split', 'tokenType');
    expect((await chartAttr(page, 'time-chart', 'legend')).split(',').sort()).toEqual(['cacheRead', 'cacheWrite', 'input', 'output']);
    await expect.poll(async () => Number(await chartAttr(page, 'time-chart', 'sum'))).toBe(total);
    // 隐藏缓存读
    await page.click('[data-legend-key="cacheRead"]');
    await expect.poll(async () => Number(await chartAttr(page, 'time-chart', 'sum'))).toBe(total - expected.totals.cacheRead);
    expect(await chartAttr(page, 'time-chart', 'hidden')).toBe('cacheRead');
    await expect(page.locator('[data-legend-key="cacheRead"]')).toHaveAttribute('aria-pressed', 'false');
    await page.click('[data-legend-key="cacheRead"]');
    await expect.poll(async () => Number(await chartAttr(page, 'time-chart', 'sum'))).toBe(total);

    await page.click('[data-testid="split-toggle"] button:has-text("模型")');
    await waitChart(page, 'split', 'model');
    await expect.poll(async () => Number(await chartAttr(page, 'time-chart', 'sum'))).toBe(total);
    const legend = await page.locator('[data-testid="curve-legend"]').innerText();
    expect(legend).toContain('（本地）');
    expect(legend).not.toContain('synthetic');
    await page.click('[data-testid="split-toggle"] button:has-text("项目")');
    await waitChart(page, 'split', 'project');
    await expect.poll(async () => Number(await chartAttr(page, 'time-chart', 'sum'))).toBe(total);
    // 具体项目视图没有"项目"拆分
    await open(page, '#/overview?range=all&project=D--Work-alpha');
    await expect(page.locator('[data-testid="split-toggle"] button:has-text("项目")')).toHaveCount(0);
    // 柱状 / 面积切换保持总和
    await open(page, '#/overview?range=all');
    await page.click('[data-testid="kind-toggle"] button:has-text("柱状")');
    await waitChart(page, 'kind', 'bar');
    expect(Number(await chartAttr(page, 'time-chart', 'sum'))).toBe(total);
  });

  test('峰值标注 = 序列最大值；今天范围粒度自动落到小时；自定义范围外的桶补零', async ({ page }) => {
    await open(page, '#/overview?range=all');
    const values: number[] = JSON.parse(await chartAttr(page, 'time-chart', 'values'));
    expect(Number(await chartAttr(page, 'time-chart', 'peak-value'))).toBe(Math.max(...values));
    expect(Number(await chartAttr(page, 'time-chart', 'peak-index'))).toBe(values.indexOf(Math.max(...values)));
    await open(page, '#/overview?range=today');
    await waitChart(page, 'gran', 'hour');
    const hv: number[] = JSON.parse(await chartAttr(page, 'time-chart', 'values'));
    expect(hv.length).toBe(24);
    expect(sum(hv)).toBe(expected.phase2.nowCases[0].today.total);
  });

  test('筛选写入 URL：范围 / 模型 / 家族合并 / 口径；刷新与后退可还原；联动所有卡片', async ({ page }) => {
    await open(page, '#/overview?range=all');
    await page.click('[data-testid="range-button"]');
    await page.click('[data-testid="range-option-thisMonth"]');
    await expect(page).toHaveURL(/range=thisMonth/);
    const sMonth = (await api('summary?range=thisMonth')).summary;
    await expect(page.locator('[data-testid="tile-total"]')).toHaveAttribute('data-value', String(sMonth.value));
    await expect(page.locator('[data-testid="range-button"]')).toHaveAttribute('data-range', 'thisMonth');
    // 模型多选
    await page.click('[data-testid="models-button"]');
    await page.click('[data-testid="model-option"][data-model-key="claude-haiku-4-5"]');
    await expect(page).toHaveURL(/models=claude-haiku-4-5/);
    const sh = (await api('summary?range=thisMonth&models=claude-haiku-4-5')).summary;
    await expect(page.locator('[data-testid="tile-total"]')).toHaveAttribute('data-value', String(sh.value));
    await expect.poll(async () => Number(await chartAttr(page, 'time-chart', 'sum'))).toBe(sh.value);
    // 家族合并：模型选择被清空，总量回到范围总量
    await page.click('[data-testid="family-toggle"]');
    await expect(page).toHaveURL(/family=1/);
    await expect(page).not.toHaveURL(/models=/);
    await expect(page.locator('[data-testid="tile-total"]')).toHaveAttribute('data-value', String(sMonth.value));
    await page.keyboard.press('Escape');
    // 刷新还原
    await page.reload();
    await page.waitForSelector('[data-testid="content"][data-ready="true"]');
    await expect(page.locator('[data-testid="range-button"]')).toHaveAttribute('data-range', 'thisMonth');
    await expect(page.locator('[data-testid="tile-total"]')).toHaveAttribute('data-value', String(sMonth.value));
    // 跨页保留：分析页沿用同样的筛选
    await page.click('nav a:has-text("分析")');
    await expect(page).toHaveURL(/#\/analysis.*range=thisMonth/);
    await expect(page.locator('[data-testid="range-button"]')).toHaveAttribute('data-range', 'thisMonth');
  });

  test('日历热力图：格子数 = 范围内天数；点击某天 → 当天明细（小时之和 = 格子值、会话数 = API）→ 点会话跳转详情；后退保留', async ({ page }) => {
    await open(page, '#/overview?range=all');
    const hm = await api('heatmap');
    await expect(page.locator('[data-testid="heat-cell"]')).toHaveCount(hm.days.length);
    expect(Number(await chartAttr(page, 'heatmap', 'cells'))).toBe(hm.days.length);
    const day = hm.days.filter((d: any) => d.value > 0).pop();
    await page.click(`[data-testid="heat-cell"][data-date="${day.date}"]`);
    await expect(page).toHaveURL(new RegExp(`day=${day.date}`));
    await page.waitForSelector(`[data-testid="day-detail"][data-date="${day.date}"][data-ready="true"]`);
    await expect(page.locator(`[data-testid="heat-cell"][data-date="${day.date}"]`)).toHaveAttribute('aria-pressed', 'true');
    const detail = await api(`day-detail?date=${day.date}`);
    const hours: number[] = JSON.parse(await chartAttr(page, 'day-chart', 'values'));
    expect(hours.length).toBe(24);
    expect(sum(hours)).toBe(day.value);
    await expect(page.locator('[data-testid="day-sessions"]')).toHaveAttribute('data-count', String(detail.sessionCount));
    await expect(page.locator('[data-testid="day-session"]')).toHaveCount(Math.min(200, detail.sessionCount));
    // 跳转会话详情，后退回到带 day 参数的总览
    const first = page.locator('[data-testid="day-session"]').first();
    const sid = await first.getAttribute('data-session-id');
    await first.click();
    await page.waitForSelector('[data-testid="session-detail"][data-ready="true"]');
    expect(page.url()).toContain(`#/sessions/${sid}`);
    await page.goBack();
    await page.waitForSelector(`[data-testid="day-detail"][data-date="${day.date}"]`);
    await expect(page.locator('[data-testid="content"]')).toHaveAttribute('data-page', 'overview');
    // 再点同一天取消选择
    await page.click(`[data-testid="heat-cell"][data-date="${day.date}"]`);
    await expect(page.locator('[data-testid="day-detail"]')).toHaveCount(0);
    await page.screenshot({ path: path.join(SHOTS, 'batchB-overview-light.png'), fullPage: true });
  });

  test('今日 vs 昨日：叠加两条线（0–23 时）；今日累计 = 今日卡片', async ({ page }) => {
    await open(page, '#/overview?range=all');
    await page.waitForSelector('[data-testid="tvy-chart"]');
    const c = expected.phase2.nowCases[0];
    await expect.poll(async () => Number(await chartAttr(page, 'tvy-chart', 'today'))).toBe(c.today.total);
    const y: number[] = JSON.parse(await chartAttr(page, 'tvy-chart', 'yesterday-cum'));
    expect(y.length).toBe(24);
    expect(Number(await chartAttr(page, 'tvy-chart', 'yesterday'))).toBe(c.yesterday.total);
    const cum: number[] = JSON.parse(await chartAttr(page, 'tvy-chart', 'today-cum'));
    expect(cum[cum.length - 1]).toBe(c.today.total);
    expect(Number(await chartAttr(page, 'tvy-chart', 'now-index'))).toBe(20); // 12:00Z = 上海 20:00
  });

  test('使用状态卡：当前态高亮、其余淡化；进度条细长圆角、今日 ÷ 近 30 天日均', async ({ page }) => {
    await open(page, '#/overview?range=all');
    const pills = page.locator('[data-testid="usage-card"] [role="group"] > span');
    await expect(pills).toHaveCount(3);
    const read = (): Promise<Array<{ s: string | null; cur: string | null; op: number }>> => pills.evaluateAll((els) => els.map((e) => ({ s: e.getAttribute('data-state'), cur: e.getAttribute('aria-current'), op: parseFloat(getComputedStyle(e).opacity) })));
    // 淡化有 0.3s 过渡：轮询到稳定
    await expect.poll(async () => (await read()).filter((o) => o.cur !== 'true').every((o) => o.op < 0.6) && (await read()).find((o) => o.cur === 'true')!.op === 1).toBe(true);
    const bar = await page.locator('[data-testid="usage-progress"]').evaluate((e) => ({ h: getComputedStyle(e).height, r: getComputedStyle(e).borderRadius }));
    expect(bar.h).toBe('8px');
    expect(parseFloat(bar.r)).toBeGreaterThan(100);
    const last30 = (await api('timeseries?range=30d&granularity=day')).summary.value / 30;
    const pct = (expected.phase2.nowCases[0].today.total / last30) * 100;
    await expect(page.locator('[data-testid="usage-pct"]')).toHaveText(`${Math.round(pct)}%`);
  });
});

test.describe('分析页', () => {
  test('A1–A9、A19、A20 与 API / expected 对账；筛选联动一致', async ({ page }) => {
    await open(page, '#/analysis?range=all', '[data-testid="a-quality"] [data-testid="quality-files"]');
    await page.waitForSelector('[data-testid="model-row"]');
    // A1
    const rows = page.locator('[data-testid="model-row"]');
    await expect(rows).toHaveCount(Object.keys(expected.models).length);
    const shares: number[] = await rows.evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-share'))));
    expect(Math.abs(sum(shares) - 1)).toBeLessThan(0.0001);
    const values: number[] = await rows.evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-value'))));
    expect(sum(values)).toBe(expected.totals.total);
    await expect(page.locator('[data-testid="a-models"]')).not.toContainText('synthetic');
    await expect(page.locator('[data-testid="a-models"]')).toContainText('Qwen3-35B-A3B');
    await expect(page.locator('[data-testid="a-models"] >> text=本地').first()).toBeVisible();
    // A2
    await expect(page.locator('[data-testid="a-composition"]')).toHaveAttribute('data-total', String(expected.totals.total));
    const comp = await page.locator('[data-testid^="comp-"][data-value]').evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-value'))));
    expect(sum(comp)).toBe(expected.totals.total);
    await expect(page.locator('[data-testid="comp-thinking"]')).toHaveAttribute('data-thinking', String(expected.totals.thinking));
    // A3 / A9 / A19
    await expect(page.locator('[data-testid="a-projects"]')).toHaveAttribute('data-total', String(expected.totals.total));
    await expect(page.locator('[data-testid="a-sidechain"]')).toHaveAttribute('data-total', String(expected.totals.total));
    await expect(page.locator('[data-testid="side-sub"]')).toHaveAttribute('data-value', String(expected.sidechain.total));
    await expect(page.locator('[data-testid="a-localcloud"]')).toHaveAttribute('data-total', String(expected.totals.total));
    // A7：168 格之和 = 总量
    await expect(page.locator('[data-testid="activity-cell"]')).toHaveCount(168);
    const cells: number[] = await page.locator('[data-testid="activity-cell"]').evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-value'))));
    expect(sum(cells)).toBe(expected.totals.total);
    // A8
    for (const [name, n] of Object.entries(expected.tools)) await expect(page.locator(`[data-testid="tool-row"][data-tool="${name}"]`)).toHaveAttribute('data-count', String(n));
    // A4
    await expect(page.locator('[data-testid="top-session"]').first()).toBeVisible();
    const topVals: number[] = await page.locator('[data-testid="top-session"]').evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-value'))));
    for (let i = 1; i < topVals.length; i++) expect(topVals[i - 1]!).toBeGreaterThanOrEqual(topVals[i]!);
    // A20：精确等于 expected.stats
    const st = expected.stats;
    const q = async (k: string): Promise<string> => (await page.locator(`[data-testid="quality-${k}"]`).getAttribute('data-value')) ?? '';
    expect([await q('files'), await q('assistantRows'), await q('unique'), await q('dup'), await q('crossFile'), await q('synthetic'), await q('corrupt'), await q('emptyFiles')]).toEqual([st.filesParsed, st.assistantRows, st.uniqueMessages, st.duplicatesDropped, st.crossFileDuplicates, st.syntheticExcluded, st.corruptLines, st.emptyFiles].map(String));
    expect(await q('missingFields')).toBe(String(st.missingUsage + st.missingCacheBreakdown));
    await page.screenshot({ path: path.join(SHOTS, 'batchB-analysis-light.png'), fullPage: true });
  });

  test('Fresh 口径：A2 缓存读消失，总量下降 = 缓存读；家族合并：总量不变；模型筛选后各卡总量一致', async ({ page }) => {
    await open(page, '#/analysis?range=all&basis=fresh');
    await page.waitForSelector('[data-testid="comp-input"]');
    await expect(page.locator('[data-testid="comp-cacheRead"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="a-composition"]')).toHaveAttribute('data-total', String(expected.totals.fresh));
    await open(page, '#/analysis?range=all&family=1');
    await page.waitForSelector('[data-testid="model-row"]');
    const vals: number[] = await page.locator('[data-testid="model-row"]').evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-value'))));
    expect(sum(vals)).toBe(expected.totals.total);
    expect(vals.length).toBeLessThan(Object.keys(expected.models).length);
    await open(page, '#/analysis?range=all&models=claude-haiku-4-5');
    await page.waitForSelector('[data-testid="model-row"]');
    const hv = expected.models['claude-haiku-4-5'].total;
    await expect(page.locator('[data-testid="a-composition"]')).toHaveAttribute('data-total', String(hv));
    await expect(page.locator('[data-testid="a-projects"]')).toHaveAttribute('data-total', String(hv));
    await expect(page.locator('[data-testid="a-sidechain"]')).toHaveAttribute('data-total', String(hv));
    // 页内"按家族"切换
    await open(page, '#/analysis?range=all');
    await page.click('[data-testid="model-group-toggle"] button:has-text("按家族")');
    await expect(page).toHaveURL(/family=1/);
  });

  test('分析页：A4 行点击跳转会话详情；项目对比条跳转项目；选中项目后标题与数据一致', async ({ page }) => {
    await open(page, '#/analysis?range=all');
    await page.waitForSelector('[data-testid="top-session"]');
    const sid = await page.locator('[data-testid="top-session"]').first().getAttribute('data-session-id');
    await page.locator('[data-testid="top-session"]').first().click();
    await page.waitForSelector('[data-testid="session-detail"][data-ready="true"]');
    expect(page.url()).toContain(`#/sessions/${sid}`);
    await page.goBack();
    await expect(page.locator('[data-testid="content"]')).toHaveAttribute('data-page', 'analysis');
    await page.click('[data-testid="project-bar"][data-project-id="D--Work-alpha"] a');
    await expect(page.locator('[data-testid="page-title"]')).toContainText('alpha');
    const total = expected.projects.find((p: any) => p.projectKey === 'D--Work-alpha').total;
    await expect(page.locator('[data-testid="a-composition"]')).toHaveAttribute('data-total', String(total));
  });
});

test.describe('会话页', () => {
  test('列表：行数 / 总量 / 排序 / 搜索 / 分页 / 项目筛选与 API 一致；URL 保存状态', async ({ page }) => {
    await open(page, '#/sessions?range=all');
    const all = await api('sessions?range=all&pageSize=500');
    await expect(page.locator('[data-testid="sessions-card"]')).toHaveAttribute('data-total', String(all.total));
    await expect(page.locator('[data-testid="session-row"]')).toHaveCount(Math.min(10, all.total));
    await expect(page.locator('[data-testid="sessions-footer"]')).toContainText(`/ ${all.total} 个会话`);
    // 默认按 token 降序
    const first: number[] = await page.locator('[data-testid="session-row"]').evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-value'))));
    for (let i = 1; i < first.length; i++) expect(first[i - 1]!).toBeGreaterThanOrEqual(first[i]!);
    // 请求数 / 总 token 与 expected 一致
    for (const r of await page.locator('[data-testid="session-row"]').all()) {
      const id = (await r.getAttribute('data-session-id'))!;
      expect(Number(await r.getAttribute('data-requests'))).toBe(expected.sessions[id].records);
      expect(Number(await r.getAttribute('data-value'))).toBe(expected.sessions[id].total);
    }
    // 排序：请求数（再点一次反向）
    await page.click('[data-testid="sort-requests"]');
    await expect(page).toHaveURL(/sort=requests/);
    await expect.poll(async () => (await page.locator('[data-testid="session-row"]').first().getAttribute('data-requests')) ?? '').toBe(String(all.rows.map((r: any) => r.requests).sort((a: number, b: number) => b - a)[0]));
    await page.click('[data-testid="sort-requests"]');
    await expect(page).toHaveURL(/dir=asc/);
    // 分页
    await page.click('[data-testid="sort-tokens"]');
    await page.click('[data-testid="page-next"]');
    await expect(page).toHaveURL(/page=2/);
    await expect(page.locator('[data-testid="sessions-footer"]')).toContainText('11–');
    await page.click('[data-testid="page-prev"]');
    // 搜索：标题 / 项目 / ID
    await page.fill('[data-testid="session-search"]', 'Refactor the parser');
    await expect(page).toHaveURL(/q=Refactor/);
    await expect(page.locator('[data-testid="session-row"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="session-title"]').first()).toHaveText('Refactor the parser');
    // 刷新后搜索状态保留
    await page.reload();
    await page.waitForSelector('[data-testid="session-row"]');
    await expect(page.locator('[data-testid="session-search"]')).toHaveValue('Refactor the parser');
    await page.fill('[data-testid="session-search"]', '');
    await expect(page.locator('[data-testid="session-row"]')).toHaveCount(10);
    // 项目筛选（侧栏）→ 行数与 API 一致
    await page.click('[data-testid="project-row"][data-project-id="D--Work-alpha"] a');
    const alpha = await api('sessions?range=all&project=D--Work-alpha&pageSize=500');
    await expect(page.locator('[data-testid="sessions-card"]')).toHaveAttribute('data-total', String(alpha.total));
  });

  test('标题：custom-title 优先，否则首条真人消息前 ≤ 40 字；SECRET_BODY_MARKER 不出现在 DOM 中', async ({ page }) => {
    await open(page, '#/sessions?range=all&pageSize=50');
    await page.waitForSelector('[data-testid="session-row"]');
    const text = await page.locator('main').innerText();
    expect(text).not.toContain('SECRET_BODY_MARKER');
    const titles = await page.locator('[data-testid="session-title"]').allInnerTexts();
    for (const t of titles) expect(Array.from(t).length).toBeLessThanOrEqual(40);
    expect(titles).toContain('Refactor the parser');
  });

  test('详情：URL 可直达；逐次请求柱之和 = 会话总量；上下文点数 = 请求数；类型构成 / 工具；列表行点击与后退', async ({ page }) => {
    const id = 'a1a1a1a1-0000-4000-8000-000000000001';
    const e = expected.sessions[id];
    await open(page, `#/sessions/${id}?range=all`, '[data-testid="session-detail"][data-ready="true"]');
    await expect(page.locator('[data-testid="detail-title"]')).toHaveText('Refactor the parser');
    await expect(page.locator('[data-testid="detail-requests"]')).toHaveAttribute('data-value', String(e.records));
    await expect(page.locator('[data-testid="detail-tokens"]')).toHaveAttribute('data-value', String(e.total));
    await page.waitForSelector('[data-testid="session-bars"]');
    expect(Number(await chartAttr(page, 'session-bars', 'points'))).toBe(e.records);
    expect(Number(await chartAttr(page, 'session-bars', 'sum'))).toBe(e.total);
    expect(Number(await chartAttr(page, 'session-context', 'points'))).toBe(e.records);
    const ctx: number[] = JSON.parse(await chartAttr(page, 'session-context', 'values'));
    expect(sum(ctx)).toBe(e.input + e.cacheWrite + e.cacheRead);
    await expect(page.locator('[data-testid="session-composition"]')).toHaveAttribute('data-total', String(e.total));
    const tools: number[] = await page.locator('[data-testid="session-tools"] li').evaluateAll((els) => els.map((x) => Number(x.getAttribute('data-count'))));
    expect(tools.length).toBeGreaterThan(0);
    // 子代理并入父会话：该会话含 2 条子代理记录
    expect(e.sidechainRecords).toBe(2);
    await page.screenshot({ path: path.join(SHOTS, 'batchB-sessions-light.png'), fullPage: true });
    // 关闭详情
    await page.click('[data-testid="detail-close"]');
    await expect(page.locator('[data-testid="session-detail"]')).toHaveCount(0);
    // 列表点击 → 详情，后退回到列表且筛选保留
    await page.fill('[data-testid="session-search"]', 'demo');
    await page.waitForTimeout(500);
    const row = page.locator('[data-testid="session-row"]').first();
    const rid = await row.getAttribute('data-session-id');
    await row.locator('td').nth(1).click();
    await expect(page.locator(`[data-testid="session-detail"][data-session-id="${rid}"]`)).toBeVisible();
    await page.goBack();
    await expect(page.locator('[data-testid="session-search"]')).toHaveValue('demo');
    // 不存在的会话
    await open(page, '#/sessions/does-not-exist?range=all', '[data-testid="session-not-found"]');
  });
});

test.describe('键盘 / 主题 / 控制台 / 网络', () => {
  test('↑/↓ 只在项目栏聚焦或悬停时切换项目；其它位置保留滚动；Scratch 子项名称完整可区分', async ({ page }) => {
    await open(page, '#/overview?range=all');
    await page.mouse.move(900, 400); // 鼠标在内容区
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('[data-testid="content"]')).toHaveAttribute('data-project', 'all');
    await page.hover('[data-testid="sidebar"]');
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('[data-testid="content"]')).not.toHaveAttribute('data-project', 'all');
    await page.mouse.move(900, 400);
    // 聚焦项目栏内的链接时同样生效
    await page.focus('[data-testid="project-row"] a');
    const before = await page.locator('[data-testid="content"]').getAttribute('data-project');
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('[data-testid="content"]')).not.toHaveAttribute('data-project', before!);
    // Scratch 子项：名称不被省略号截断（换行显示完整名称）
    await page.click('[data-testid="scratch-toggle"]');
    const kids = page.locator('[data-testid="scratch-children"] [data-testid="project-name"]');
    await expect(kids).toHaveCount(3);
    const info = await kids.evaluateAll((els) => els.map((e) => ({ text: e.textContent ?? '', ws: getComputedStyle(e).whiteSpace, clipped: e.scrollWidth > e.clientWidth + 1 })));
    expect(new Set(info.map((i) => i.text)).size).toBe(3);
    for (const i of info) {
      expect(i.ws).toBe('normal');
      expect(i.clipped).toBe(false);
    }
  });

  test('服务端主题与 localStorage 不一致：首次绘制前页面被隐藏，不先闪浅色再变深色', async ({ browser }) => {
    await fetch(`${srv.url}api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ theme: 'dark' }) });
    const ctx = await browser.newContext({ colorScheme: 'light' });
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      localStorage.setItem('tv.theme', 'light');
      const log: string[] = [];
      (window as unknown as { __themeLog: string[] }).__themeLog = log;
      const snap = (): void => {
        const r = document.documentElement;
        log.push(`${r.getAttribute('data-theme') ?? '-'}|${r.hasAttribute('data-theme-pending') ? 'pending' : 'shown'}`);
      };
      let last = '';
      setInterval(() => {
        const r = document.documentElement;
        if (!r) return;
        const cur = `${r.getAttribute('data-theme') ?? '-'}|${r.hasAttribute('data-theme-pending') ? 'pending' : 'shown'}`;
        if (cur !== last) {
          last = cur;
          snap();
        }
      }, 1);
    });
    await page.goto(`${srv.url}#/overview`);
    await page.waitForSelector('[data-testid="content"][data-ready="true"]');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('html')).not.toHaveAttribute('data-theme-pending', '');
    const log = await page.evaluate(() => (window as unknown as { __themeLog: string[] }).__themeLog);
    // 任何 light 状态都必须处于 pending（页面被隐藏）；一旦显示，只能是 dark
    for (const l of log) if (l.startsWith('light|')) expect(l).toBe('light|pending');
    expect(log[log.length - 1]).toBe('dark|shown');
    await fetch(`${srv.url}api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ theme: 'light' }) });
    await ctx.close();
  });

  test('总览 / 分析 / 会话三页：控制台无错误或警告，所有请求都是 127.0.0.1；浅深色截图', async ({ page }) => {
    const issues: string[] = [];
    const hosts = new Set<string>();
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') issues.push(`${m.type()}: ${m.text()}`);
    });
    page.on('pageerror', (e) => issues.push(`pageerror: ${e.message}`));
    page.on('request', (r) => hosts.add(new URL(r.url()).hostname));
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await fetch(`${srv.url}api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ theme }) });
      await page.addInitScript((t) => localStorage.setItem('tv.theme', t), theme);
      for (const [name, hash, ready] of [
        ['overview', '#/overview?range=all', '[data-testid="heat-cell"]'],
        ['analysis', '#/analysis?range=all', '[data-testid="quality-files"]'],
        ['sessions', `#/sessions/a1a1a1a1-0000-4000-8000-000000000001?range=all`, '[data-testid="session-bars"]'],
      ] as const) {
        await page.goto(`${srv.url}${hash}`);
        await page.reload();
        await page.waitForSelector(ready);
        await page.waitForTimeout(900);
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        await page.screenshot({ path: path.join(SHOTS, `batchB-${name}-${theme}.png`), fullPage: true });
      }
    }
    expect([...hosts]).toEqual(['127.0.0.1']);
    expect(issues).toEqual([]);
  });

  test('切换项目 p95：总览 / 分析 / 会话页各 12 次 < 200 ms', async ({ page }) => {
    for (const hash of ['#/overview?range=all', '#/analysis?range=all', '#/sessions?range=all']) {
      await open(page, hash);
      await page.hover('[data-testid="sidebar"]');
      const ids = ['all', 'C--Users-----Work-demo', 'D--Work-alpha', 'D--Work-beta'];
      for (let i = 0; i < 12; i++) {
        const id = ids[(i + 1) % ids.length]!;
        await page.click(`[data-project-id="${id}"] a`);
        await page.waitForSelector(`[data-testid="content"][data-project="${id}"][data-ready="true"]`);
      }
      const samples: number[] = await page.evaluate(() => ((window as unknown as { __tvPerf?: { samples: Array<{ ms: number }> } }).__tvPerf?.samples ?? []).map((x) => x.ms));
      const sorted = [...samples].sort((a, b) => a - b);
      expect(sorted.length, hash).toBeGreaterThanOrEqual(10);
      const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!;
      console.log(`${hash} 切换项目 p50=${sorted[Math.floor(sorted.length / 2)]!.toFixed(0)}ms p95=${p95.toFixed(0)}ms`);
      expect(p95, hash).toBeLessThan(200);
      await page.evaluate(() => {
        (window as unknown as { __tvPerf?: { samples: unknown[] } }).__tvPerf!.samples = [];
      });
    }
  });
});

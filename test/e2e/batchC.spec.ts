/**
 * 批次 C E2E：设置页 / 价格表 / 订阅方案 / 项目管理 / 成本模块 / 导出菜单。
 * 运行：先 npm run build，再 npx playwright test -c test/e2e/playwright.config.ts batchC
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

let srv: TestServer;
const errors: string[] = [];

test.beforeAll(async () => {
  srv = await startServer({
    env: { TV_NOW: '2026-10-20T12:00:00.000Z' },
    settingsJson: { schema: 1, settings: { timezone: 'Asia/Shanghai', theme: 'light' } },
  });
  await waitForIdle(srv.url);
});
test.afterAll(async () => {
  await srv.stop();
});

test.beforeEach(async ({ page }) => {
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
});

async function open(page: Page, hash: string): Promise<void> {
  await page.goto(`${srv.url}${hash}`);
  await page.waitForSelector('[data-testid="content"][data-ready="true"]');
  await page.evaluate(() => document.fonts.ready);
}

const api = async (p: string): Promise<any> => (await fetch(`${srv.url}api${p}`)).json();
const put = async (p: string, body: unknown): Promise<any> => (await fetch(`${srv.url}api${p}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();

test.describe.configure({ mode: 'serial' });

test('设置页：各分区渲染、控制台无错误、截图（浅 / 深）', async ({ page }) => {
  await open(page, '#/settings');
  for (const id of ['source', 'display', 'refresh', 'prices', 'subscription', 'budget', 'projects']) {
    await expect(page.getByTestId(`settings-${id}`)).toBeVisible();
  }
  // 价格表：内置规则都已配置，且带 fast 标注
  await expect(page.getByTestId('price-row').first()).toBeVisible();
  expect(await page.getByTestId('price-row').count()).toBeGreaterThan(5);
  await expect(page.getByTestId('settings-prices-warn')).toHaveCount(0);
  // 订阅未设置：警示条
  await expect(page.getByTestId('settings-sub-warn')).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, 'batchC-settings-light.png'), fullPage: true });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.getByTestId('settings-theme').getByRole('button', { name: '深色' }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, 'batchC-settings-dark.png'), fullPage: true });
  await page.getByTestId('settings-theme').getByRole('button', { name: '浅色' }).click();
  expect(errors).toEqual([]);
});

test('数据根：非法路径中文报错且不改当前数据；有效路径给出统计', async ({ page }) => {
  await open(page, '#/settings');
  const before = (await api('/status')).dataRoot;
  const input = page.getByTestId('settings-root-input');
  await input.fill(path.join(srv.dataRoot, 'no-such-dir'));
  await page.getByTestId('settings-root-check').click();
  await expect(page.getByTestId('settings-root-error')).toContainText('不存在');
  await input.fill('relative/path');
  await page.getByTestId('settings-root-check').click();
  await expect(page.getByTestId('settings-root-error')).toContainText('绝对路径');
  await page.getByTestId('settings-root-apply').click();
  expect((await api('/status')).dataRoot).toBe(before);
  expect((await api('/settings')).settings.dataRoot).toBeNull();
  await input.fill(srv.dataRoot);
  await page.getByTestId('settings-root-check').click();
  await expect(page.getByTestId('settings-root-ok')).toContainText('9 个项目文件夹');
  await page.screenshot({ path: path.join(SHOTS, 'batchC-settings-root.png') });
});

test('订阅方案：选档位预填月费；手改月费归为自定义；设置后警示消失', async ({ page }) => {
  await open(page, '#/settings');
  await page.getByTestId('settings-plan').getByRole('button', { name: 'Max 5x' }).click();
  await expect(page.getByTestId('settings-fee')).toHaveValue('100');
  expect((await api('/settings')).settings.subscription).toMatchObject({ plan: 'max5x', monthlyFeeUsd: 100 });
  await expect(page.getByTestId('settings-sub-warn')).toHaveCount(0);
  await expect(page.getByTestId('settings-plan-note')).toContainText('核对于');
  await page.getByTestId('settings-fee').fill('31');
  await page.getByTestId('settings-fee').press('Enter');
  await expect.poll(async () => (await api('/settings')).settings.subscription).toMatchObject({ plan: 'custom', monthlyFeeUsd: 31 });
  // 非法值
  await page.getByTestId('settings-fee').fill('abc');
  await page.getByTestId('settings-fee').press('Enter');
  await expect(page.getByRole('button', { name: 'Pro' })).toBeVisible();
  expect((await api('/settings')).settings.subscription.monthlyFeeUsd).toBe(31);
});

test('预算：M tokens → tokens 保存；非法值提示', async ({ page }) => {
  await open(page, '#/settings');
  await page.getByTestId('settings-budget-daily').fill('50');
  await page.getByTestId('settings-budget-daily').press('Enter');
  await expect.poll(async () => (await api('/settings')).settings.budget.daily).toBe(50_000_000);
  await page.getByTestId('settings-budget-monthly').fill('-3');
  await page.getByTestId('settings-budget-monthly').press('Enter');
  await expect(page.getByTestId('settings-budget').getByText('请输入')).toBeVisible();
  expect((await api('/settings')).settings.budget.monthly).toBeNull();
});

test('价格表：编辑后保存 → 成本变化；清空 = 未配置（成本不当 0）；新增 / 还原 / 恢复默认', async ({ page }) => {
  await open(page, '#/settings');
  const base = (await api('/cost/summary?range=all')).api.totalUsd as number;
  expect(base).toBeGreaterThan(0);
  const row = page.locator('[data-testid="price-row"][data-id="claude-sonnet-5-5"]');
  await row.getByTestId('price-outputUsdPerM').fill('20'); // 官方 10 → 20
  await expect(page.getByTestId('price-save')).toBeEnabled();
  await page.getByTestId('price-save').click();
  await expect.poll(async () => (await api('/prices')).rules.length).toBe(1);
  const after = (await api('/cost/summary?range=all')).api.totalUsd as number;
  expect(after).toBeGreaterThan(base);
  await expect(row).toHaveAttribute('data-origin', 'user');
  // 清空一个价格 → 未配置
  await row.getByTestId('price-cacheReadUsdPerM').fill('');
  await expect(row.getByTestId('price-status')).toHaveText('未配置');
  await expect(page.getByTestId('settings-prices-warn')).toBeVisible();
  await page.getByTestId('price-save').click();
  await expect.poll(async () => (await api('/cost/summary?range=all')).api.unpricedModels).toContain('claude-sonnet-5-5');
  const un = await api('/cost/summary?range=all');
  expect(un.api.totalUsd).toBeLessThan(after); // 该模型成本不计入，而不是按 0 计入一个"假的完整合计"
  expect(un.notes.join('')).toContain('部分模型未计价');
  await page.screenshot({ path: path.join(SHOTS, 'batchC-prices-unset.png'), fullPage: true });
  // 还原为内置
  await row.getByTestId('price-revert').click();
  await page.getByTestId('price-save').click();
  await expect.poll(async () => (await api('/prices')).rules.length).toBe(0);
  expect((await api('/cost/summary?range=all')).api.totalUsd).toBeCloseTo(base, 5);
  // 新增规则 + 非法数字
  await page.getByTestId('price-add').click();
  await page.getByTestId('price-pattern').first().fill('my-model-*');
  const newRow = page.locator('[data-testid="price-row"][data-origin="user"]').first();
  await newRow.getByTestId('price-inputUsdPerM').fill('abc');
  await page.getByTestId('price-save').click();
  await expect(page.getByTestId('settings-prices-error')).toContainText('不是有效的数字');
  expect((await api('/prices')).rules.length).toBe(0);
  await newRow.getByTestId('price-inputUsdPerM').fill('1');
  await page.getByTestId('price-save').click();
  await expect.poll(async () => (await api('/prices')).rules.length).toBe(1);
  // 恢复默认
  await page.getByTestId('price-reset').click();
  await page.getByTestId('price-reset-confirm').click();
  await expect.poll(async () => (await api('/prices')).rules.length).toBe(0);
});

test('项目管理：重命名 / 置顶 / 隐藏 / 恢复，项目栏同步，隐藏项目不计入合计', async ({ page }) => {
  await open(page, '#/settings');
  const total0 = (await api('/summary?range=all')).summary.total as number;
  const alpha = page.locator('[data-testid="manage-row"][data-id="D--Work-alpha"]');
  await alpha.getByTestId('manage-rename').click();
  await page.getByTestId('manage-rename-input').fill('阿尔法');
  await page.getByTestId('manage-rename-input').press('Enter');
  await expect(page.locator('[data-testid="project-row"][data-project-id="D--Work-alpha"] [data-testid="project-name"]')).toHaveText('阿尔法');
  await alpha.getByTestId('manage-pin').click();
  await expect(page.locator('[data-testid="project-list"] > li').nth(1).locator('[data-testid="project-pin"]')).toBeVisible(); // 全部项目之后第一项
  await page.screenshot({ path: path.join(SHOTS, 'batchC-projects-pinned.png') });
  // 隐藏
  const alphaTotal = (await api('/projects')).projects.find((p: any) => p.id === 'D--Work-alpha').total as number;
  await alpha.getByTestId('manage-hide').click();
  await expect(page.locator('[data-testid="project-row"][data-project-id="D--Work-alpha"]')).toHaveCount(0);
  await expect(page.getByTestId('hidden-toggle')).toContainText('已隐藏 1 个');
  await expect(page.getByTestId('manage-hidden-count')).toContainText('已隐藏 1 个项目');
  await expect.poll(async () => (await api('/summary?range=all')).summary.total).toBe(total0 - alphaTotal);
  const allShown = await page.getByTestId('project-total-all').getAttribute('data-value');
  expect(Number(allShown)).toBe(total0 - alphaTotal);
  await page.screenshot({ path: path.join(SHOTS, 'batchC-projects-hidden.png'), fullPage: true });
  // 项目栏底部恢复
  await page.getByTestId('hidden-toggle').click();
  await page.getByTestId('hidden-restore').click();
  await expect(page.locator('[data-testid="project-row"][data-project-id="D--Work-alpha"]')).toHaveCount(1);
  await expect.poll(async () => (await api('/summary?range=all')).summary.total).toBe(total0);
  // 清理
  await alpha.getByTestId('manage-rename-reset').click();
  await alpha.getByTestId('manage-pin').click();
  await expect.poll(async () => (await api('/project-overrides')).overrides).toEqual({});
});

test('成本模块：两种口径、空状态、每日图、按项目表；切换范围', async ({ page }) => {
  // 先把价格全部清空 → 价格未配置空状态
  await put('/prices', { rules: [{ pattern: 'claude-*', match: 'glob', inputUsdPerM: null, outputUsdPerM: null, cacheWrite5mUsdPerM: null, cacheWrite1hUsdPerM: null, cacheReadUsdPerM: null }] });
  await put('/settings', { subscription: { plan: null, monthlyFeeUsd: null } });
  await open(page, '#/cost');
  await expect(page.getByTestId('cost-banner-prices')).toBeVisible();
  await expect(page.getByTestId('cost-api-total')).toHaveText('—');
  await expect(page.getByTestId('cost-sub-total')).toHaveText('—');
  await expect(page.getByTestId('cost-setup-sub')).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, 'batchC-cost-empty.png'), fullPage: true });
  // 恢复价格 + 订阅方案
  await fetch(`${srv.url}api/prices/reset`, { method: 'POST' });
  await put('/settings', { subscription: { plan: 'custom', monthlyFeeUsd: 31 } });
  await open(page, '#/cost');
  await page.getByTestId('cost-range').getByRole('button', { name: '全部' }).click();
  const sum = await api('/cost/summary?range=all');
  await expect(page.getByTestId('cost-api-total')).toContainText('$');
  const money = (n: number): string => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  await expect(page.getByTestId('cost-api-total')).toHaveText(money(sum.api.totalUsd));
  await expect(page.getByTestId('cost-sub-total')).toHaveText(money(sum.subscription.totalUsd));
  await expect(page.getByTestId('cost-total-api')).toHaveText(money(sum.api.totalUsd));
  await expect(page.getByTestId('cost-fee-line')).toHaveCount(1);
  expect(await page.getByTestId('cost-bar').count()).toBe(sum.daily.length);
  expect(await page.getByTestId('cost-project-row').count()).toBe(sum.byProject.length);
  // 页面上没有"额度百分比"字样
  const body = await page.locator('main').innerText();
  expect(body).not.toMatch(/额度(使用|用了)?\s*\d+\s*%/);
  await page.screenshot({ path: path.join(SHOTS, 'batchC-cost-light.png'), fullPage: true });
  await page.getByTestId('settings-theme').count();
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await page.screenshot({ path: path.join(SHOTS, 'batchC-cost-dark.png'), fullPage: true });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  // 口径切换：强调的列跟随
  await page.getByTestId('cost-mode').getByRole('button', { name: '订阅摊销' }).click();
  await expect(page.getByTestId('cost-card-sub')).toBeVisible();
  // 窄屏
  await page.setViewportSize({ width: 760, height: 1000 });
  await page.waitForTimeout(300);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(overflow).toBe(false);
  await page.screenshot({ path: path.join(SHOTS, 'batchC-cost-760.png'), fullPage: true });
});

test('导出菜单：下载链接遵从筛选；文件带 BOM', async ({ page }) => {
  await open(page, '#/cost');
  await page.getByTestId('export-button').click();
  await page.getByTestId('export-kind').getByRole('button', { name: '按模型' }).click();
  const href = await page.getByTestId('export-download').getAttribute('href');
  expect(href).toContain('kind=model');
  expect(href).toContain('format=csv');
  expect(href).toContain('range=30d');
  const r = await fetch(`${srv.url.replace(/\/$/, '')}${href}`);
  const buf = new Uint8Array(await r.arrayBuffer());
  expect([...buf.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  await page.screenshot({ path: path.join(SHOTS, 'batchC-export.png') });
});

test('接线：总览成本卡 / 回本卡 / 成本口径切换 / 曲线 Token⇄成本 / 预算进度条 / 导出；会话与分析成本', async ({ page }) => {
  const money = (n: number): string => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  await put('/prices', { rules: [{ pattern: 'claude-*', match: 'glob', inputUsdPerM: 1, outputUsdPerM: 5, cacheWrite5mUsdPerM: 2, cacheWrite1hUsdPerM: 3, cacheReadUsdPerM: 0.1 }] });
  await put('/settings', { subscription: { plan: 'custom', monthlyFeeUsd: 0.05 }, budget: { daily: 10_000, monthly: null } });
  await open(page, '#/overview?range=all');
  // 成本卡 = 本月至今（API 的周期卡）
  const sm = await api('/summary?range=all');
  await expect(page.getByTestId('tile-cost')).toBeVisible();
  const month = sm.periods.thisMonth.cost.apiUsd as number;
  await expect(page.getByTestId('tile-cost-num')).toHaveText(money(month));
  await expect(page.getByTestId('tile-cost')).toContainText('估算');
  // 回本卡：与 API 一致
  const pb = await api('/subscription/payback');
  await expect(page.getByTestId('payback-card')).toBeVisible();
  await expect(page.getByTestId('payback-api')).toHaveText(money(pb.apiUsdMtd));
  await expect(page.getByTestId('payback-multiple')).toContainText('×');
  expect(pb.paidBack).toBe(true);
  await expect(page.getByTestId('payback-savings')).toContainText('省下');
  // 成本口径切换 → 订阅摊销
  await page.getByTestId('cost-mode').getByRole('button', { name: '订阅摊销' }).click();
  await expect(page.getByTestId('tile-cost')).toContainText('订阅摊销成本');
  // 第 9 张卡仍是 AI 运行时长
  await expect(page.getByTestId('tile-runtime')).toBeVisible();
  // 曲线：Token ⇄ 成本
  await page.getByTestId('unit-toggle').getByRole('button', { name: '成本' }).click();
  const ts = await api('/timeseries?range=all&granularity=day&basis=total');
  const apiSum = ts.points.reduce((a: number, p: any) => a + (p.cost.apiUsd ?? 0), 0);
  await page.getByTestId('cost-mode').getByRole('button', { name: '等价 API' }).click();
  await expect(page.getByTestId('time-chart')).toHaveAttribute('data-unit', 'cost');
  await expect.poll(async () => Number(await page.getByTestId('time-chart').getAttribute('data-sum'))).toBeCloseTo(apiSum, 4);
  await page.screenshot({ path: path.join(SHOTS, 'batchC-overview-cost-light.png'), fullPage: true });
  await page.getByTestId('unit-toggle').getByRole('button', { name: 'Token' }).click();
  // 预算：每日预算 10,000 tokens，今日 7,330 → 73%；超出变色
  await expect(page.getByTestId('usage-progress')).toHaveAttribute('data-mode', 'daily');
  await expect(page.getByTestId('usage-pct')).toHaveText('73%');
  await put('/settings', { budget: { daily: 5_000 } });
  await expect(page.getByTestId('usage-progress')).toHaveAttribute('data-over', 'true');
  await put('/settings', { budget: { daily: null } });
  await expect(page.getByTestId('usage-progress')).toHaveAttribute('data-mode', 'avg');
  // 导出菜单在总览页头，query 带当前筛选
  await page.getByTestId('export-button').click();
  expect(await page.getByTestId('export-download').getAttribute('href')).toContain('range=all');
  // 会话页：成本列
  await open(page, '#/sessions?range=all');
  await expect.poll(async () => page.getByTestId('session-cost').count()).toBeGreaterThan(3);
  const ss = await api('/sessions?range=all&pageSize=500');
  const first = page.locator('[data-testid="session-row"]').first();
  const id = await first.getAttribute('data-session-id');
  const row = ss.rows.find((r: any) => r.id === id);
  await page.getByTestId('cost-mode').getByRole('button', { name: '订阅摊销' }).click();
  await expect(first.getByTestId('session-cost')).toHaveAttribute('data-usd', String(row.cost.subUsd ?? ''));
  await page.getByTestId('cost-mode').getByRole('button', { name: '等价 API' }).click();
  await expect(first.getByTestId('session-cost')).toHaveAttribute('data-usd', String(row.cost.apiUsd ?? ''));
  await first.click();
  await expect(page.getByTestId('detail-cost')).toContainText('$');
  await page.screenshot({ path: path.join(SHOTS, 'batchC-sessions-cost.png'), fullPage: true });
  // 分析页：模型 / 项目条目带成本
  await open(page, '#/analysis?range=all');
  await expect(page.getByTestId('model-cost').first()).toContainText('$');
  await expect(page.getByTestId('project-cost').first()).toContainText('$');
  await page.screenshot({ path: path.join(SHOTS, 'batchC-analysis-cost.png'), fullPage: true });
  // 未设置订阅方案：回本卡给引导
  await put('/settings', { subscription: { plan: null, monthlyFeeUsd: null } });
  await open(page, '#/overview?range=all');
  await expect(page.getByTestId('payback-card')).toHaveAttribute('data-state', 'unconfigured');
  await expect(page.getByTestId('payback-setup')).toBeVisible();
  await fetch(`${srv.url}api/prices/reset`, { method: 'POST' });
});

test('深色主题截图：总览（成本卡 / 回本卡 / 成本曲线）/ 会话 / 成本模块', async ({ page }) => {
  await put('/settings', { theme: 'dark', subscription: { plan: 'custom', monthlyFeeUsd: 31 } });
  await page.addInitScript(() => localStorage.setItem('tv.theme', 'dark'));
  await open(page, '#/overview?range=all');
  await page.getByTestId('unit-toggle').getByRole('button', { name: '成本' }).click();
  await expect(page.getByTestId('time-chart')).toHaveAttribute('data-unit', 'cost');
  expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('dark');
  await page.screenshot({ path: path.join(SHOTS, 'batchC-overview-cost-dark.png'), fullPage: true });
  await open(page, '#/sessions?range=all');
  await page.screenshot({ path: path.join(SHOTS, 'batchC-sessions-cost-dark.png'), fullPage: true });
  await open(page, '#/cost');
  await page.screenshot({ path: path.join(SHOTS, 'batchC-cost-dark-2.png'), fullPage: true });
  await put('/settings', { theme: 'light', subscription: { plan: null, monthlyFeeUsd: null } });
});

test('收尾：全程控制台无 error / warning', async () => {
  expect(errors).toEqual([]);
});

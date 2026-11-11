/**
 * 批次 C：成本（两种口径）、价格表、订阅回本、项目覆盖（隐藏 / 重命名 / 置顶）、导出。
 * 期望值全部由测试自己手算（不调用被测的成本代码）：
 *   - 用固定价格表（输入 1、输出 5、5m 写 2、1h 写 3、读 0.1，USD/M）对 expected.models 手算总成本；
 *   - 用"5m = 1h 价"的价格表对朴素视图（naiveView，独立实现）的逐条记录手算每日 / 每项目成本与订阅摊销。
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PriceBook } from '../src/server/cost/prices.ts';
import type { PriceRule } from '../src/server/cost/prices.ts';
import { startApp, getJson, putJson } from './apiHelpers.ts';
import type { TestApp } from './apiHelpers.ts';
import { FIXTURE_ROOT, loadExpected, MARKER, snapshotDir } from './helpers.ts';
import { naiveRecords, naiveView } from './naiveView.ts';

const NOW = Date.parse('2026-10-20T12:00:00.000Z');
const TZ = 'Asia/Shanghai';

function rule(over: Partial<PriceRule> & { pattern: string }): PriceRule {
  return {
    id: over.id ?? `${over.match ?? 'exact'}:${over.pattern}`,
    match: 'exact',
    inputUsdPerM: 1,
    outputUsdPerM: 5,
    cacheWrite5mUsdPerM: 2,
    cacheWrite1hUsdPerM: 3,
    cacheReadUsdPerM: 0.1,
    fastMultiplier: null,
    sourceUrl: null,
    checkedAt: null,
    ...over,
  };
}

const close = (a: number | null, b: number, eps = 1e-6): void => {
  expect(a).not.toBeNull();
  expect(Math.abs((a as number) - b)).toBeLessThan(eps);
};

// ---------------------------------------------------------------------------
// 价格匹配（纯函数）
// ---------------------------------------------------------------------------
describe('PriceBook 匹配', () => {
  const builtin = [rule({ pattern: 'claude-opus-5', inputUsdPerM: 9 }), rule({ pattern: 'claude-sonnet-5-5', inputUsdPerM: 7 })];

  it('exact > 最长 prefix > glob；先用户后内置', () => {
    const user = [
      rule({ pattern: 'claude-', match: 'prefix', inputUsdPerM: 11 }),
      rule({ pattern: 'claude-opus-', match: 'prefix', inputUsdPerM: 12 }),
      rule({ pattern: 'claude-*-5', match: 'glob', inputUsdPerM: 13 }),
      rule({ pattern: 'claude-opus-5', match: 'exact', inputUsdPerM: 14 }),
    ];
    const b = new PriceBook(user, builtin);
    expect(b.resolve('claude-opus-5').rule?.inputUsdPerM).toBe(14); // exact
    expect(b.resolve('claude-opus-9').rule?.inputUsdPerM).toBe(12); // 最长 prefix
    expect(b.resolve('claude-haiku-5').rule?.inputUsdPerM).toBe(11); // prefix 优先于 glob
    expect(b.resolve('claude-opus-5').origin).toBe('user');
    const onlyGlob = new PriceBook([rule({ pattern: 'gpt-*', match: 'glob' }), rule({ pattern: 'gpt-4*', match: 'glob', inputUsdPerM: 5 })], builtin);
    expect(onlyGlob.resolve('gpt-4o').rule?.inputUsdPerM).toBe(5); // glob 字面字符多者优先
    // 用户规则没命中 → 内置
    expect(new PriceBook([], builtin).resolve('claude-sonnet-5-5').origin).toBe('builtin');
    expect(new PriceBook([], builtin).resolve('claude-sonnet-5-5').rule?.inputUsdPerM).toBe(7);
  });

  it('exact 忽略日期 / [1m] 后缀与大小写；本地模型恒为本地；无匹配 = 未计价', () => {
    const b = new PriceBook([], builtin);
    expect(b.resolve('claude-opus-5-20251101').rule?.inputUsdPerM).toBe(9);
    expect(b.resolve('Claude-Opus-5[1m]').rule?.inputUsdPerM).toBe(9);
    expect(b.resolve('C:\\Users\\x\\Models\\Qwen3-35B-A3B-Q4_K_M.gguf')).toMatchObject({ local: true, priced: false, rule: null });
    expect(b.resolve('qwen/qwen3-coder-next').local).toBe(true);
    // claude- 前缀但无价格 = 未计价（提示补全）；非 claude- 前缀的名字（无路径）一律视为本地 / 非 Anthropic：成本不适用、不进未计价
    expect(b.resolve('claude-mystery-9')).toMatchObject({ local: false, priced: false, rule: null });
    for (const m of ['qwen3-coder-next-uncensored-heretic.i1', 'grok-4.7', 'gpt-4o', 'sonnet']) expect(b.resolve(m), m).toMatchObject({ local: true, priced: false, rule: null });
    // 用户为无路径的非 claude- 名字写了价格规则 → 按用户规则计价；路径型 / org/name 恒为本地
    const ub = new PriceBook([rule({ pattern: 'grok-*', match: 'glob', inputUsdPerM: 3 })], builtin);
    expect(ub.resolve('grok-4.7')).toMatchObject({ local: false, priced: true });
    expect(new PriceBook([rule({ pattern: '*', match: 'glob' })], builtin).resolve('qwen/qwen3-coder-next').local).toBe(true);
  });

  it('任一价格为 null = 未配置（视为未计价，不当 0）', () => {
    const b = new PriceBook([rule({ pattern: 'claude-opus-5', cacheWrite1hUsdPerM: null })], []);
    const r = b.resolve('claude-opus-5');
    expect(r.rule).not.toBeNull();
    expect(r.priced).toBe(false);
  });
});

describe('内置价格 / 订阅档位来源', () => {
  it('每条非空内置价格都带 https sourceUrl 与 checkedAt；订阅档位同理', async () => {
    const { builtinDefaults } = await import('../src/server/cost/prices.ts');
    const { builtinPlans } = await import('../src/server/cost/plans.ts');
    const rules = builtinDefaults().rules;
    expect(rules.length).toBeGreaterThan(0);
    for (const r of rules) {
      const hasPrice = [r.inputUsdPerM, r.outputUsdPerM, r.cacheWrite5mUsdPerM, r.cacheWrite1hUsdPerM, r.cacheReadUsdPerM].some((x) => x !== null);
      if (hasPrice) {
        expect(r.sourceUrl, r.id).toMatch(/^https:\/\//);
        expect(r.checkedAt, r.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
    for (const p of builtinPlans().plans) {
      if (p.monthlyFeeUsd !== null) {
        expect(p.sourceUrl, p.id).toMatch(/^https:\/\//);
        expect(p.checkedAt, p.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
    // 数据里出现过的模型都有内置价格
    for (const m of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-opus-5']) {
      expect(new PriceBook([]).resolve(m).priced, m).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// API：固定价格表 → 手算对账
// ---------------------------------------------------------------------------
describe('成本 API（固定价格表手算）', () => {
  let t: TestApp;
  const expected = loadExpected();

  const FLAT = { inputUsdPerM: 1, outputUsdPerM: 5, cacheWrite5mUsdPerM: 2, cacheWrite1hUsdPerM: 3, cacheReadUsdPerM: 0.1 };

  beforeAll(async () => {
    t = await startApp();
    const r = await putJson(t.base, '/api/prices', { rules: [{ pattern: 'claude-*', match: 'glob', ...FLAT }] });
    expect(r.status).toBe(200);
  });
  afterAll(async () => {
    await t.close();
  });

  it('总成本 = 手算（含"缺 5m/1h 细分按 5m 价"）；本地模型 0 且不进未计价；byType 求和 = 总', async () => {
    let apiUsd = 0;
    const byType = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
    let assumed = 0;
    for (const [model, u] of Object.entries(expected.models as Record<string, any>)) {
      if (!model.startsWith('claude-')) continue; // 本地模型：0
      const unknown = Math.max(0, u.cacheWrite - u.cacheWrite5m - u.cacheWrite1h);
      assumed += unknown;
      byType.input += (u.input * 1) / 1e6;
      byType.output += (u.output * 5) / 1e6;
      byType.cacheWrite += (u.cacheWrite5m * 2 + u.cacheWrite1h * 3 + unknown * 2) / 1e6;
      byType.cacheRead += (u.cacheRead * 0.1) / 1e6;
    }
    apiUsd = byType.input + byType.output + byType.cacheWrite + byType.cacheRead;
    const { status, body } = await getJson(t.base, '/api/cost/summary?range=all');
    expect(status).toBe(200);
    expect(body.currency).toBe('USD');
    close(body.api.totalUsd, apiUsd, 1e-5);
    close(body.api.byType.input, byType.input, 1e-5);
    close(body.api.byType.output, byType.output, 1e-5);
    close(body.api.byType.cacheWrite, byType.cacheWrite, 1e-5);
    close(body.api.byType.cacheRead, byType.cacheRead, 1e-5);
    const sumTypes = Object.values(body.api.byType as Record<string, number>).reduce((a, b) => a + b, 0);
    close(sumTypes, body.api.totalUsd, 1e-5);
    expect(body.api.unpricedTokens).toBe(0);
    expect(body.api.unpricedModels).toEqual([]);
    expect(body.api.assumedCacheWrite5mTokens).toBe(assumed);
    expect(body.api.fastPremiumApplied).toBe(false);
    // 本地模型不出现在按模型表的"已计价"里，且不算未计价
    const local = body.byModel.filter((m: any) => m.local);
    expect(local.length).toBeGreaterThan(0);
    for (const m of local) {
      expect(m.cost.apiUsd).toBeNull();
      expect(m.cost.unpricedTokens).toBe(0);
    }
    expect(body.subscription.configured).toBe(false);
    expect(body.subscription.totalUsd).toBeNull();
    expect(JSON.stringify(body)).not.toContain(MARKER);
  });

  it('summary / timeseries / projects 的 cost 字段口径一致，分组之和 = 合计', async () => {
    const cs = (await getJson(t.base, '/api/cost/summary?range=all')).body;
    const sm = (await getJson(t.base, '/api/summary?range=all')).body;
    close(sm.cost.apiUsd, cs.api.totalUsd, 1e-9);
    close(sm.summary.cost.apiUsd, cs.api.totalUsd, 1e-9);
    for (const g of ['hour', 'day', 'week', 'month']) {
      const ts = (await getJson(t.base, `/api/timeseries?range=all&granularity=${g}&tz=${TZ}`)).body;
      const sum = ts.points.reduce((a: number, p: any) => a + (p.cost.apiUsd ?? 0), 0);
      close(sum, cs.api.totalUsd, 1e-5);
      for (const split of ['model', 'project', 'tokenType']) {
        const ts2 = (await getJson(t.base, `/api/timeseries?range=all&granularity=${g}&split=${split}&tz=${TZ}`)).body;
        const s2 = ts2.series.reduce((a: number, s: any) => a + s.costValues.api.reduce((x: number, y: number) => x + y, 0), 0);
        close(s2, cs.api.totalUsd, 1e-5);
        for (const s of ts2.series) close(s.cost.apiUsd ?? 0, s.costValues.api.reduce((x: number, y: number) => x + y, 0), 1e-5);
      }
    }
    const pr = (await getJson(t.base, '/api/projects')).body;
    const top = pr.projects.reduce((a: number, p: any) => a + (p.cost.apiUsd ?? 0), 0);
    close(top, cs.api.totalUsd, 1e-5);
    close(pr.all.cost.apiUsd, cs.api.totalUsd, 1e-9);
    // 项目表（成本模块）求和
    close(cs.byProject.reduce((a: number, p: any) => a + (p.cost.apiUsd ?? 0), 0), cs.api.totalUsd, 1e-5);
    close(cs.byModel.reduce((a: number, p: any) => a + (p.cost.apiUsd ?? 0), 0), cs.api.totalUsd, 1e-5);
  });

  it('未计价模型：unpricedModels / unpricedTokens 与 expected 一致，已计价部分不为 0，绝不当 0 静默处理', async () => {
    const r = await putJson(t.base, '/api/prices', { rules: [{ pattern: 'claude-sonnet*', match: 'glob', ...FLAT }] });
    expect(r.status).toBe(200);
    // 把内置里的 sonnet 也盖住即可；其它 claude 模型会命中内置价格 → 先用 exact 把内置价格改成不完整，制造"未配置"
    const r2 = await putJson(t.base, '/api/prices', {
      rules: [
        { pattern: 'claude-sonnet*', match: 'glob', ...FLAT },
        { pattern: 'claude-opus-5-5', match: 'exact', ...FLAT, inputUsdPerM: null },
        { pattern: 'claude-opus-5', match: 'exact', ...FLAT, outputUsdPerM: null },
        { pattern: 'claude-haiku*', match: 'glob', ...FLAT, cacheReadUsdPerM: null },
      ],
    });
    expect(r2.status).toBe(200);
    const body = (await getJson(t.base, '/api/cost/summary?range=all')).body;
    const m = expected.models as Record<string, any>;
    const un = ['claude-opus-5-5', 'claude-opus-5', 'claude-haiku-4-5'];
    expect(body.api.unpricedModels).toEqual([...un].sort());
    expect(body.api.unpricedTokens).toBe(un.reduce((a, k) => a + m[k].total, 0));
    expect(body.api.totalUsd).toBeGreaterThan(0);
    expect(body.notes.join('')).toContain('部分模型未计价');
    // 已计价部分 = sonnet 两个模型手算
    let usd = 0;
    for (const k of ['claude-sonnet-5', 'claude-sonnet-5-5']) {
      const u = m[k];
      const unknown = Math.max(0, u.cacheWrite - u.cacheWrite5m - u.cacheWrite1h);
      usd += (u.input * 1 + u.output * 5 + u.cacheWrite5m * 2 + u.cacheWrite1h * 3 + unknown * 2 + u.cacheRead * 0.1) / 1e6;
    }
    close(body.api.totalUsd, usd, 1e-5);
    // 全部不计价 → apiUsd 为 null（不是 0）
    await putJson(t.base, '/api/prices', { rules: [{ pattern: 'claude-*', match: 'glob', ...FLAT, inputUsdPerM: null }] });
    const none = (await getJson(t.base, '/api/cost/summary?range=all')).body;
    expect(none.api.totalUsd).toBeNull();
    expect(none.api.unpricedModels.length).toBeGreaterThan(0);
    const sm = (await getJson(t.base, '/api/summary?range=all')).body;
    expect(sm.cost.apiUsd).toBeNull();
    // 恢复
    await putJson(t.base, '/api/prices', { rules: [{ pattern: 'claude-*', match: 'glob', ...FLAT }] });
  });

  it('价格表接口：校验 / 重置 / 未知字段与非法数值 400 / 持久化只落应用数据目录', async () => {
    const bad = [
      { rules: [{ pattern: 'x', match: 'regex', ...FLAT }] },
      { rules: [{ pattern: '', match: 'exact', ...FLAT }] },
      { rules: [{ pattern: 'x', match: 'exact', ...FLAT, inputUsdPerM: -1 }] },
      { rules: [{ pattern: 'x', match: 'exact', ...FLAT, inputUsdPerM: 1e9 }] },
      { rules: [{ pattern: 'x', match: 'exact', ...FLAT, inputUsdPerM: '3' }] },
      { rules: [{ pattern: 'x', match: 'exact', ...FLAT, bogus: 1 }] },
      { rules: [{ pattern: 'x', match: 'exact', ...FLAT, fastMultiplier: 0.5 }] },
      { rules: [{ pattern: 'x', match: 'exact', ...FLAT, checkedAt: 'yesterday' }] },
      { rules: [{ id: 'a', pattern: 'x', match: 'exact', ...FLAT }, { id: 'a', pattern: 'y', match: 'exact', ...FLAT }] },
      { rules: 'nope' },
      { other: 1 },
    ];
    for (const b of bad) {
      const r = await putJson(t.base, '/api/prices', b);
      expect(r.status, JSON.stringify(b)).toBe(400);
      expect(r.body.error.code).toBe('INVALID_PRICE');
    }
    const g = (await getJson(t.base, '/api/prices')).body;
    expect(g.rules).toHaveLength(1); // 非法请求没有改动
    expect(g.builtinCount).toBeGreaterThan(5);
    expect(typeof g.defaultsVersion).toBe('string');
    expect(g.effective.some((r: any) => r.origin === 'builtin')).toBe(true);
    expect(fs.existsSync(path.join(t.appData, 'prices.json'))).toBe(true);
    const rs = await fetch(`${t.base}/api/prices/reset`, { method: 'POST' });
    expect(rs.status).toBe(200);
    expect((await getJson(t.base, '/api/prices')).body.rules).toEqual([]);
    await putJson(t.base, '/api/prices', { rules: [{ pattern: 'claude-*', match: 'glob', ...FLAT }] });
    // 未知参数 400
    expect((await getJson(t.base, '/api/cost/summary?bogus=1')).status).toBe(400);
    expect((await getJson(t.base, '/api/subscription/payback?x=1')).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// 订阅摊销 / 回本：用 5m=1h 价，对独立朴素视图逐条记录手算
// ---------------------------------------------------------------------------
describe('订阅摊销与回本（独立手算）', () => {
  let t: TestApp;
  const FEE = 31; // 十月 31 天 → 每日恰好 $1；十一月 30 天
  const P = { inputUsdPerM: 1, outputUsdPerM: 5, cacheWrite5mUsdPerM: 2, cacheWrite1hUsdPerM: 2, cacheReadUsdPerM: 0.1 };

  const view = naiveView(FIXTURE_ROOT);
  const recs = naiveRecords(view);
  const dateOf = (ts: number): string =>
    new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts));
  const isCloud = (m: string): boolean => m.startsWith('claude-');
  const costOf = (r: (typeof recs)[number]): number => (isCloud(r.model) ? (r.input * 1 + r.output * 5 + r.cacheWrite * 2 + r.cacheRead * 0.1) / 1e6 : 0);
  const dim = (date: string): number => new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)), 0)).getUTCDate();

  const todayStr = dateOf(NOW);

  beforeAll(async () => {
    t = await startApp();
    expect((await putJson(t.base, '/api/prices', { rules: [{ pattern: 'claude-*', match: 'glob', ...P }] })).status).toBe(200);
    expect((await putJson(t.base, '/api/settings', { subscription: { plan: 'custom', monthlyFeeUsd: FEE } })).status).toBe(200);
  });
  afterAll(async () => {
    await t.close();
  });

  it('设置：subscription 校验；未设置时口径②为空', async () => {
    for (const bad of [{ subscription: { monthlyFeeUsd: -1 } }, { subscription: { monthlyFeeUsd: 1e9 } }, { subscription: { monthlyFeeUsd: '20' } }, { subscription: { plan: 'ultra' } }, { subscription: { x: 1 } }, { subscription: 5 }]) {
      const r = await putJson(t.base, '/api/settings', bad);
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
    const s = (await getJson(t.base, '/api/settings')).body.settings;
    expect(s.subscription).toEqual({ plan: 'custom', monthlyFeeUsd: FEE, billingDay: null, feeCurrency: 'USD', cnyPerUsd: 7.2 });
    const pl = (await getJson(t.base, '/api/subscription/plans')).body;
    expect(pl.plans.map((p: any) => p.id)).toEqual(['pro', 'max5x', 'max20x']);
  });

  it('每个有用量的日子各条目分摊额之和 = 当天日订阅费；subUsd + idleUsd = 范围内日订阅费之和；闲置日进 idleUsd', async () => {
    // 独立手算：按本地日汇总成本
    const dayCost = new Map<string, number>();
    for (const r of recs) {
      const d = dateOf(r.ts);
      dayCost.set(d, (dayCost.get(d) ?? 0) + costOf(r));
    }
    const first = [...dayCost.keys()].sort()[0]!;
    let expSub = 0;
    let expIdle = 0;
    let expFeeSum = 0;
    for (let ms = Date.parse(`${first}T12:00:00Z`); dateOf(ms) <= todayStr; ms += 86_400_000) {
      const d = new Date(ms).toISOString().slice(0, 10);
      const fee = FEE / dim(d);
      expFeeSum += fee;
      if ((dayCost.get(d) ?? 0) > 0) expSub += fee;
      else expIdle += fee;
    }
    const body = (await getJson(t.base, `/api/cost/summary?range=all&tz=${TZ}`)).body;
    expect(body.subscription.configured).toBe(true);
    expect(body.subscription.plan).toBe('custom');
    expect(body.subscription.monthlyFeeUsd).toBe(FEE);
    // 总分摊 = 有用量的日子（不晚于今天）的日订阅费之和；fixture 里晚于"今天"的记录不分摊
    close(body.subscription.totalUsd, expSub, 1e-5);
    close(body.subscription.idleUsd, expIdle, 1e-5);
    expect(expIdle).toBeGreaterThan(0); // fixture 里确有无记录的日子
    close(body.subscription.totalUsd + body.subscription.idleUsd, expFeeSum, 1e-5);
    close(body.subscription.feeSumUsd, expFeeSum, 1e-5);
    // 日订阅费：十月每日 $1
    const octDay = body.daily.find((d: any) => d.date === '2026-10-05');
    close(octDay.feeUsd, 1, 1e-9);
    // 各项目 / 模型 subUsd 之和 = 总 subUsd
    close(body.byProject.reduce((a: number, p: any) => a + (p.cost.subUsd ?? 0), 0), body.subscription.totalUsd, 1e-5);
    close(body.byModel.reduce((a: number, p: any) => a + (p.cost.subUsd ?? 0), 0), body.subscription.totalUsd, 1e-5);
    // 衍生：折算价 / 同量 API 价 / 倍数
    const tokensM = body.tokens / 1e6;
    close(body.subscription.perMillionTokensUsd, body.subscription.totalUsd / tokensM, 1e-5);
    close(body.subscription.apiPerMillionTokensUsd, body.api.totalUsd / tokensM, 1e-5);
    close(body.subscription.multiple, body.api.totalUsd / (body.subscription.totalUsd + body.subscription.idleUsd), 1e-3);
  });

  it('逐项目手算：各项目 subUsd = Σ_日 日订阅费 × 该项目当日成本 ÷ 当日总成本', async () => {
    const dayCost = new Map<string, number>();
    const dayProj = new Map<string, Map<string, number>>();
    for (const r of recs) {
      const d = dateOf(r.ts);
      const c = costOf(r);
      dayCost.set(d, (dayCost.get(d) ?? 0) + c);
      const m = dayProj.get(d) ?? new Map<string, number>();
      m.set(r.folder, (m.get(r.folder) ?? 0) + c);
      dayProj.set(d, m);
    }
    const subByFolder = new Map<string, number>();
    for (const [d, m] of dayProj) {
      if (d > todayStr || (dayCost.get(d) ?? 0) <= 0) continue;
      const fee = FEE / dim(d);
      for (const [f, c] of m) subByFolder.set(f, (subByFolder.get(f) ?? 0) + (fee * c) / dayCost.get(d)!);
    }
    const body = (await getJson(t.base, `/api/projects?tz=${TZ}`)).body;
    let checked = 0;
    for (const p of body.projects) {
      const keys: string[] = p.isScratchGroup ? p.children.map((c: any) => c.id) : [p.id];
      const exp = keys.reduce((a, k) => a + (subByFolder.get(k) ?? 0), 0);
      if (p.cost.subUsd === null) throw new Error('subUsd 不应为 null');
      close(p.cost.subUsd, exp, 1e-5);
      checked++;
    }
    expect(checked).toBeGreaterThan(3);
    close(body.all.cost.subUsd, [...subByFolder.values()].reduce((a, b) => a + b, 0), 1e-5);
  });

  it('时间序列：各点 subUsd 求和 = 总 subUsd（四种粒度，拆分后各系列之和也相等）', async () => {
    const total = (await getJson(t.base, `/api/summary?range=all&tz=${TZ}`)).body.cost.subUsd;
    for (const g of ['hour', 'day', 'week', 'month']) {
      const ts = (await getJson(t.base, `/api/timeseries?range=all&granularity=${g}&tz=${TZ}`)).body;
      close(ts.points.reduce((a: number, p: any) => a + (p.cost.subUsd ?? 0), 0), total, 1e-5);
      const ts2 = (await getJson(t.base, `/api/timeseries?range=all&granularity=${g}&split=model&tz=${TZ}`)).body;
      close(ts2.series.reduce((a: number, s: any) => a + s.costValues.sub.reduce((x: number, y: number) => x + y, 0), 0), total, 1e-5);
    }
  });

  it('订阅回本：multipleMtd / savingsUsd / projected 与手算一致；未超过月费时 paidBack=false', async () => {
    const start = Date.parse('2026-09-30T16:00:00Z'); // 2026-10-01 00:00 +08
    let mtd = 0;
    for (const r of recs) if (r.ts >= start && r.ts <= NOW) mtd += costOf(r);
    const pb = (await getJson(t.base, '/api/subscription/payback')).body;
    expect(pb.configured).toBe(true);
    expect(pb.month).toBe('2026-10');
    expect(pb.elapsedDays).toBe(20);
    expect(pb.daysInMonth).toBe(31);
    close(pb.apiUsdMtd, mtd, 1e-5);
    expect(pb.monthlyFeeUsd).toBe(FEE);
    close(pb.proratedFeeUsd, (FEE * 20) / 31, 1e-5);
    close(pb.multipleMtd, mtd / FEE, 1e-3);
    close(pb.projected.apiUsd, ((mtd / 20) * 31), 1e-5);
    close(pb.projected.multiple, ((mtd / 20) * 31) / FEE, 1e-3);
    expect(pb.paidBack).toBe(mtd >= FEE);
    close(pb.savingsUsd, Math.max(0, mtd - FEE), 1e-5);
    // fixture 的本月成本只有几美分：远低于月费 → 尚未回本，省下金额为 0 而不是负数
    expect(pb.paidBack).toBe(false);
    expect(pb.savingsUsd).toBe(0);
    // 月费调到很低 → 回本
    await putJson(t.base, '/api/settings', { subscription: { monthlyFeeUsd: 0.01 } });
    const pb2 = (await getJson(t.base, '/api/subscription/payback')).body;
    expect(pb2.paidBack).toBe(true);
    close(pb2.savingsUsd, mtd - 0.01, 1e-5);
    await putJson(t.base, '/api/settings', { subscription: { monthlyFeeUsd: FEE } });
  });

  it('未设置订阅方案：口径②与回本为空状态，等价 API 成本不受影响', async () => {
    await putJson(t.base, '/api/settings', { subscription: { plan: null, monthlyFeeUsd: null } });
    const pb = (await getJson(t.base, '/api/subscription/payback')).body;
    expect(pb.configured).toBe(false);
    expect(pb.monthlyFeeUsd).toBeNull();
    expect(pb.multipleMtd).toBeNull();
    expect(pb.paidBack).toBe(false);
    const cs = (await getJson(t.base, '/api/cost/summary?range=all')).body;
    expect(cs.subscription.configured).toBe(false);
    expect(cs.subscription.totalUsd).toBeNull();
    expect(cs.subscription.idleUsd).toBeNull();
    expect(cs.api.totalUsd).toBeGreaterThan(0);
    const sm = (await getJson(t.base, '/api/summary?range=all')).body;
    expect(sm.cost.subUsd).toBeNull();
    await putJson(t.base, '/api/settings', { subscription: { plan: 'custom', monthlyFeeUsd: FEE } });
  });
});

// ---------------------------------------------------------------------------
// 项目管理：重命名 / 隐藏 / 置顶
// ---------------------------------------------------------------------------
describe('项目管理', () => {
  let t: TestApp;
  const before = snapshotDir(FIXTURE_ROOT);

  beforeAll(async () => {
    t = await startApp();
    await putJson(t.base, '/api/prices', { rules: [{ pattern: 'claude-*', match: 'glob', inputUsdPerM: 1, outputUsdPerM: 5, cacheWrite5mUsdPerM: 2, cacheWrite1hUsdPerM: 3, cacheReadUsdPerM: 0.1 }] });
    await putJson(t.base, '/api/settings', { subscription: { plan: 'custom', monthlyFeeUsd: 31 } });
  });
  afterAll(async () => {
    await t.close();
  });

  const totals = async (qs = ''): Promise<{ sum: number; req: number; cost: number; sub: number; projSum: number; projCost: number; projSub: number; tsSum: number; groups: number }> => {
    const sm = (await getJson(t.base, `/api/summary?range=all${qs}`)).body;
    const ts = (await getJson(t.base, `/api/timeseries?range=all&granularity=day${qs}`)).body;
    const pr = (await getJson(t.base, `/api/projects`)).body;
    const gs = (await getJson(t.base, `/api/timeseries?range=all&granularity=month&split=project${qs}`)).body;
    return {
      sum: sm.summary.total,
      req: sm.summary.requests,
      cost: sm.cost.apiUsd,
      sub: sm.cost.subUsd,
      projSum: pr.projects.reduce((a: number, p: any) => a + p.total, 0),
      projCost: pr.projects.reduce((a: number, p: any) => a + (p.cost.apiUsd ?? 0), 0),
      projSub: pr.projects.reduce((a: number, p: any) => a + (p.cost.subUsd ?? 0), 0),
      tsSum: ts.points.reduce((a: number, p: any) => a + p.total, 0),
      groups: gs.series.reduce((a: number, s: any) => a + s.total, 0),
    };
  };

  it('隐藏后：全部项目合计 / summary / 时间序列 / 项目分组 / 成本 全部一致地不含该项目（分组之和 = 合计）', async () => {
    const base = await totals();
    expect(base.projSum).toBe(base.sum);
    const pr0 = (await getJson(t.base, '/api/projects')).body;
    const alpha = pr0.projects.find((p: any) => p.id === 'D--Work-alpha');
    expect(alpha).toBeTruthy();
    const r = await putJson(t.base, '/api/project-overrides', { id: 'D--Work-alpha', hidden: true });
    expect(r.status).toBe(200);
    expect(r.body.hiddenCount).toBe(1);
    const after = await totals();
    expect(after.sum).toBe(base.sum - alpha.total);
    expect(after.req).toBe(base.req - alpha.requests);
    expect(after.projSum).toBe(after.sum);
    expect(after.tsSum).toBe(after.sum);
    expect(after.groups).toBe(after.sum);
    close(after.projCost, after.cost, 1e-5);
    close(after.projSub, after.sub, 1e-5);
    close(after.cost, base.cost - alpha.cost.apiUsd, 1e-5);
    const pr = (await getJson(t.base, '/api/projects')).body;
    expect(pr.projects.find((p: any) => p.id === 'D--Work-alpha')).toBeUndefined();
    expect(pr.hiddenCount).toBe(1);
    expect(pr.hidden[0]).toMatchObject({ id: 'D--Work-alpha', displayName: expect.any(String) });
    expect(pr.projectCount).toBe(pr0.projectCount - 1);
    // 直接查询被隐藏的项目：UNKNOWN_PROJECT 或空（不得泄漏其数据）
    const direct = await getJson(t.base, '/api/summary?range=all&project=D--Work-alpha');
    if (direct.status === 200) expect(direct.body.summary.total).toBe(0);
    else expect(direct.status).toBe(400);
    // 分析 / 会话类端点（批次 B）也不含隐藏项目（若已存在）
    const sess = await getJson(t.base, '/api/sessions?range=all');
    if (sess.status === 200 && Array.isArray(sess.body.sessions)) {
      expect(JSON.stringify(sess.body)).not.toContain('"projectId":"D--Work-alpha"');
    }
    // 导出同样不含
    const csv = await (await fetch(`${t.base}/api/export?kind=daily&format=csv&range=all&tz=Asia/Shanghai`)).text();
    const rows = csv.split('\r\n').filter((l) => l && !l.startsWith('#') && !l.startsWith('\uFEFF'));
    const hdr = rows[0]!.split(',');
    const iTotal = hdr.indexOf('total_tokens');
    expect(rows.slice(1).reduce((a, l) => a + Number(l.split(',')[iTotal]), 0)).toBe(after.sum);
    // 恢复
    expect((await putJson(t.base, '/api/project-overrides', { id: 'D--Work-alpha', hidden: false })).body.hiddenCount).toBe(0);
    const back = await totals();
    expect(back.sum).toBe(base.sum);
    expect(back.projSum).toBe(back.sum);
  });

  it('隐藏 Scratch 整组 / 其中一个子项；unhide-all', async () => {
    const base = await totals();
    const pr0 = (await getJson(t.base, '/api/projects')).body;
    const scratch = pr0.projects.find((p: any) => p.isScratchGroup);
    expect(scratch.children.length).toBe(3);
    const kid = scratch.children[0];
    expect((await putJson(t.base, '/api/project-overrides', { id: kid.id, hidden: true })).status).toBe(200);
    let a = await totals();
    expect(a.sum).toBe(base.sum - kid.total);
    expect(a.projSum).toBe(a.sum);
    expect((await getJson(t.base, '/api/projects')).body.projects.find((p: any) => p.isScratchGroup).children).toHaveLength(2);
    expect((await putJson(t.base, '/api/project-overrides', { id: 'scratch', hidden: true })).status).toBe(200);
    a = await totals();
    expect(a.sum).toBe(base.sum - scratch.total);
    expect(a.projSum).toBe(a.sum);
    const hid = (await getJson(t.base, '/api/project-overrides')).body;
    expect(hid.hidden.map((h: any) => h.id)).toEqual(['scratch']); // 子项随整组一起隐藏，不单独列出
expect(Object.keys(hid.overrides).sort()).toEqual([kid.id, 'scratch'].sort());
    const un = await fetch(`${t.base}/api/project-overrides/unhide-all`, { method: 'POST' });
    expect(un.status).toBe(200);
    const b = await totals();
    expect(b.sum).toBe(base.sum);
    expect(b.projSum).toBe(b.sum);
  });

  it('重命名 / 置顶 / 校验；覆盖规则只存应用数据目录且重启后保留；不改源数据', async () => {
    const r = await putJson(t.base, '/api/project-overrides', { id: 'D--Work-beta', name: '  我的项目 Beta  ', pinned: true });
    expect(r.status).toBe(200);
    expect(r.body.overrides['D--Work-beta']).toEqual({ name: '我的项目 Beta', pinned: true });
    let pr = (await getJson(t.base, '/api/projects?sort=name')).body;
    expect(pr.projects[0].id).toBe('D--Work-beta'); // 置顶永远在前，无论排序
    expect(pr.projects[0]).toMatchObject({ displayName: '我的项目 Beta', pinned: true, renamed: true });
    expect(pr.projects[0].defaultName).toBe('beta');
    pr = (await getJson(t.base, '/api/projects?sort=total')).body;
    expect(pr.projects[0].id).toBe('D--Work-beta');
    // 搜索按新名称
    expect((await getJson(t.base, '/api/projects?q=%E6%88%91%E7%9A%84')).body.projects.map((p: any) => p.id)).toEqual(['D--Work-beta']);
    // 分组名称跟随（项目维度拆分）
    const ts = (await getJson(t.base, '/api/timeseries?range=all&split=project&granularity=month')).body;
    expect(ts.series.some((s: any) => s.label === '我的项目 Beta')).toBe(true);
    // 校验
    for (const bad of [
      { id: 'nope', hidden: true },
      { id: 'D--Work-beta', name: 'x'.repeat(81) },
      { id: 'D--Work-beta', name: 'a\nb' },
      { id: 'D--Work-beta', hidden: 'yes' },
      { id: 'D--Work-beta', bogus: 1 },
      { id: 'scratch', name: '改名' },
      {},
    ]) {
      const x = await putJson(t.base, '/api/project-overrides', bad);
      expect(x.status, JSON.stringify(bad)).toBe(400);
    }
    expect(fs.existsSync(path.join(t.appData, 'project-overrides.json'))).toBe(true);
    // 重启：仍在
    const app2 = await startApp({ appDataDir: t.appData, keepAppData: true, settings: {} });
    try {
      const p2 = (await getJson(app2.base, '/api/projects')).body;
      expect(p2.projects[0]).toMatchObject({ id: 'D--Work-beta', displayName: '我的项目 Beta', pinned: true });
    } finally {
      await app2.close();
    }
    // 清除
    await putJson(t.base, '/api/project-overrides', { id: 'D--Work-beta', name: null, pinned: false });
    expect((await getJson(t.base, '/api/project-overrides')).body.overrides).toEqual({});
    expect((await getJson(t.base, '/api/projects')).body.projects.find((p: any) => p.id === 'D--Work-beta').displayName).toBe('beta');
    // 源数据（fixture）未被改动
    const after = snapshotDir(FIXTURE_ROOT);
    expect(after).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------
describe('导出 CSV / JSON', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp();
    await putJson(t.base, '/api/prices', { rules: [{ pattern: 'claude-*', match: 'glob', inputUsdPerM: 1, outputUsdPerM: 5, cacheWrite5mUsdPerM: 2, cacheWrite1hUsdPerM: 3, cacheReadUsdPerM: 0.1 }] });
    await putJson(t.base, '/api/settings', { subscription: { plan: 'custom', monthlyFeeUsd: 31 } });
  });
  afterAll(async () => {
    await t.close();
  });

  /** fetch().text() 会吞掉 BOM，所以按字节读取并保留 BOM */
  async function csvOf(url: string): Promise<string> {
    const r = await fetch(url);
    expect(r.status).toBe(200);
    const buf = new Uint8Array(await r.arrayBuffer());
    expect([...buf.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    return new TextDecoder('utf-8', { ignoreBOM: true }).decode(buf);
  }

  function parseCsv(text: string): { comment: string; header: string[]; rows: Record<string, string>[] } {
    expect(text.charCodeAt(0)).toBe(0xfeff);
    const lines = text.slice(1).split('\r\n').filter((l) => l.length > 0);
    const comment = lines[0]!;
    expect(comment.startsWith('# ')).toBe(true);
    const parseLine = (l: string): string[] => {
      const out: string[] = [];
      let cur = '';
      let q = false;
      for (let i = 0; i < l.length; i++) {
        const c = l[i]!;
        if (q) {
          if (c === '"' && l[i + 1] === '"') {
            cur += '"';
            i++;
          } else if (c === '"') q = false;
          else cur += c;
        } else if (c === '"') q = true;
        else if (c === ',') {
          out.push(cur);
          cur = '';
        } else cur += c;
      }
      out.push(cur);
      return out;
    };
    const header = parseLine(lines[1]!);
    return { comment, header, rows: lines.slice(2).map((l) => Object.fromEntries(parseLine(l).map((v, i) => [header[i]!, v]))) };
  }

  it('三种粒度：UTF-8 BOM、含 cost 列与"估算"说明、各行求和 = 界面累计、不含正文 / 标题', async () => {
    const sm = (await getJson(t.base, `/api/summary?range=all&tz=${TZ}`)).body;
    for (const kind of ['daily', 'model', 'session']) {
      const r = await fetch(`${t.base}/api/export?kind=${kind}&format=csv&range=all&tz=${TZ}`);
      expect(r.status).toBe(200);
      const text = await csvOf(`${t.base}/api/export?kind=${kind}&format=csv&range=all&tz=${TZ}`);
      expect(r.headers.get('content-type')).toContain('text/csv');
      expect(r.headers.get('content-disposition')).toMatch(/attachment; filename="token-usage-/);
      expect(text).not.toContain(MARKER);
      expect(text).not.toContain('Refactor the parser'); // 会话标题（首条用户消息派生）
      const { comment, header, rows } = parseCsv(text);
      expect(comment).toContain('估算');
      expect(header).toContain('cost_api_usd');
      expect(header).toContain('cost_sub_usd');
      expect(header).not.toContain('title');
      expect(rows.length).toBeGreaterThan(0);
      const sum = (k: string): number => rows.reduce((a, row) => a + Number(row[k] || 0), 0);
      expect(sum('total_tokens')).toBe(sm.summary.total);
      expect(sum('fresh_tokens')).toBe(sm.summary.fresh);
      expect(sum('requests')).toBe(sm.summary.requests);
      expect(sum('cache_read_tokens')).toBe(sm.summary.cacheRead);
      close(sum('cost_api_usd'), sm.cost.apiUsd, 1e-4);
      close(sum('cost_sub_usd'), sm.cost.subUsd, 1e-4);
    }
    // JSON 与 CSV 同口径
    const j = (await (await fetch(`${t.base}/api/export?kind=model&format=json&range=all&tz=${TZ}`)).json()) as any;
    expect(j.meta.currency).toBe('USD');
    expect(j.meta.note).toContain('估算');
    close(j.rows.reduce((a: number, r: any) => a + (r.cost_api_usd ?? 0), 0), sm.cost.apiUsd, 1e-4);
    const local = j.rows.filter((r: any) => r.is_local);
    expect(local.length).toBeGreaterThan(0);
    for (const l of local) expect(l.cost_api_usd).toBeNull(); // 本地模型：无法计价 → 空，不是 0
  });

  it('遵从筛选 / 口径 / 时区；无法计算的成本导出为空；非法参数 400', async () => {
    const q = `range=all&project=D--Work-alpha&basis=fresh&tz=UTC`;
    const sm = (await getJson(t.base, `/api/summary?${q}`)).body;
    const { rows } = parseCsv(await csvOf(`${t.base}/api/export?kind=daily&format=csv&${q}`));
    expect(rows.reduce((a, r) => a + Number(r.value_tokens), 0)).toBe(sm.summary.value);
    expect(rows.reduce((a, r) => a + Number(r.total_tokens), 0)).toBe(sm.summary.total);
    // 无价格 → cost_api_usd 为空
    await putJson(t.base, '/api/prices', { rules: [{ pattern: 'claude-*', match: 'glob', inputUsdPerM: null, outputUsdPerM: null, cacheWrite5mUsdPerM: null, cacheWrite1hUsdPerM: null, cacheReadUsdPerM: null }] });
    const csv2 = parseCsv(await csvOf(`${t.base}/api/export?kind=model&format=csv&range=all`));
    const claude = csv2.rows.filter((r) => r.model.startsWith('claude-'));
    expect(claude.length).toBeGreaterThan(0);
    for (const r of claude) {
      expect(r.cost_api_usd).toBe('');
      expect(r.unpriced).toBe('true');
    }
    for (const bad of ['kind=nope', 'format=xml', 'bogus=1', 'range=custom']) {
      expect((await fetch(`${t.base}/api/export?${bad}`)).status, bad).toBe(400);
    }
  });
});

// ---------------------------------------------------------------------------
// 设置：检测数据根
// ---------------------------------------------------------------------------
describe('设置端点', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(async () => {
    await t.close();
  });
  const post = async (p: string, body: unknown): Promise<{ status: number; body: any }> => {
    const r = await fetch(`${t.base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };

  it('validate-root：有效目录给出统计；非法路径中文报错且不改当前数据', async () => {
    const before = (await getJson(t.base, '/api/status')).body.dataRoot;
    const ok = await post('/api/settings/validate-root', { path: FIXTURE_ROOT });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, projectFolders: 9 });
    expect(ok.body.sessionFiles).toBeGreaterThan(5);
    const missing = await post('/api/settings/validate-root', { path: path.join(FIXTURE_ROOT, 'no-such-dir') });
    expect(missing.body.ok).toBe(false);
    expect(missing.body.message).toContain('不存在');
    const rel = await post('/api/settings/validate-root', { path: 'relative/dir' });
    expect(rel.body.ok).toBe(false);
    expect(rel.body.message).toContain('绝对路径');
    const file = await post('/api/settings/validate-root', { path: path.join(FIXTURE_ROOT, 'expected.json') });
    expect(file.body.ok).toBe(false);
    const inside = await post('/api/settings/validate-root', { path: path.dirname(t.appData) });
    expect(inside.body.ok).toBe(false); // 包含应用数据目录
    expect((await post('/api/settings/validate-root', { path: 5 })).status).toBe(400);
    expect((await post('/api/settings/validate-root', { path: 'C:\\x', extra: 1 })).status).toBe(400);
    expect((await getJson(t.base, '/api/status')).body.dataRoot).toBe(before);
    expect((await getJson(t.base, '/api/settings')).body.settings.dataRoot).toBeNull();
  });

  it('时区列表', async () => {
    const z = (await getJson(t.base, '/api/timezones')).body;
    expect(z.timezones).toContain('Asia/Shanghai');
    expect(typeof z.system).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// 接线：会话 / 分析条目的 cost；隐藏项目不计入 AI 运行时长
// ---------------------------------------------------------------------------
describe('接线：会话 / 分析成本与隐藏项目运行时长', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp();
    await putJson(t.base, '/api/prices', { rules: [{ pattern: 'claude-*', match: 'glob', inputUsdPerM: 1, outputUsdPerM: 5, cacheWrite5mUsdPerM: 2, cacheWrite1hUsdPerM: 3, cacheReadUsdPerM: 0.1 }] });
    await putJson(t.base, '/api/settings', { subscription: { plan: 'custom', monthlyFeeUsd: 31 } });
  });
  afterAll(async () => {
    await t.close();
  });

  it('/api/sessions 每行 cost 求和 = summary；详情 cost = 行 cost；sessions-top / models / projects 条目带 cost 且求和一致', async () => {
    const sm = (await getJson(t.base, `/api/summary?range=all&tz=${TZ}`)).body;
    const ss = (await getJson(t.base, `/api/sessions?range=all&pageSize=500&tz=${TZ}`)).body;
    expect(ss.rows.length).toBeGreaterThan(5);
    close(ss.rows.reduce((a: number, r: any) => a + (r.cost.apiUsd ?? 0), 0), sm.cost.apiUsd, 1e-5);
    close(ss.rows.reduce((a: number, r: any) => a + (r.cost.subUsd ?? 0), 0), sm.cost.subUsd, 1e-5);
    const row = ss.rows.find((r: any) => r.cost.apiUsd > 0);
    const det = (await getJson(t.base, `/api/sessions/${encodeURIComponent(row.id)}?tz=${TZ}`)).body;
    close(det.cost.apiUsd, row.cost.apiUsd, 1e-6);
    close(det.cost.subUsd, row.cost.subUsd, 1e-6);
    const top = (await getJson(t.base, `/api/analysis/sessions-top?range=all&limit=100&tz=${TZ}`)).body;
    for (const s of top.sessions) close(s.cost.apiUsd ?? 0, ss.rows.find((r: any) => r.id === s.id).cost.apiUsd ?? 0, 1e-6);
    const models = (await getJson(t.base, `/api/analysis/models?range=all&tz=${TZ}`)).body;
    close(models.models.reduce((a: number, m: any) => a + (m.cost.apiUsd ?? 0), 0), sm.cost.apiUsd, 1e-5);
    expect(models.models.filter((m: any) => m.isLocal).every((m: any) => m.cost.apiUsd === null)).toBe(true);
    const projs = (await getJson(t.base, `/api/analysis/projects?range=all&tz=${TZ}`)).body;
    close(projs.projects.reduce((a: number, p: any) => a + (p.cost.apiUsd ?? 0), 0), sm.cost.apiUsd, 1e-5);
    close(projs.projects.reduce((a: number, p: any) => a + (p.cost.subUsd ?? 0), 0), sm.cost.subUsd, 1e-5);
    // 家族合并：模型条目仍与合计一致
    const fam = (await getJson(t.base, `/api/analysis/models?range=all&mergeFamilies=true&tz=${TZ}`)).body;
    close(fam.models.reduce((a: number, m: any) => a + (m.cost.apiUsd ?? 0), 0), sm.cost.apiUsd, 1e-5);
  });

  it('隐藏项目后：summary.activeMs / activeMsSum 不含它（= 全部 − 该项目），会话列表不含它', async () => {
    const all0 = (await getJson(t.base, `/api/summary?range=all&tz=${TZ}`)).body.summary;
    const one = (await getJson(t.base, `/api/summary?range=all&project=D--Work-timeprobe&tz=${TZ}`)).body.summary;
    expect(one.activeMsSum).toBeGreaterThan(0);
    await putJson(t.base, '/api/project-overrides', { id: 'D--Work-timeprobe', hidden: true });
    const all1 = (await getJson(t.base, `/api/summary?range=all&tz=${TZ}`)).body.summary;
    expect(all1.activeMsSum).toBe(all0.activeMsSum - one.activeMsSum);
    expect(all1.activeMs).toBeLessThanOrEqual(all0.activeMs);
    const ts = (await getJson(t.base, `/api/timeseries?range=all&granularity=day&tz=${TZ}`)).body;
    expect(ts.points.reduce((a: number, p: any) => a + (p.activeMs ?? 0), 0)).toBe(all1.activeMs);
    const ss = (await getJson(t.base, `/api/sessions?range=all&pageSize=500&tz=${TZ}`)).body;
    expect(ss.rows.some((r: any) => r.projectKey === 'D--Work-timeprobe')).toBe(false);
    await putJson(t.base, '/api/project-overrides', { id: 'D--Work-timeprobe', hidden: false });
    expect((await getJson(t.base, `/api/summary?range=all&tz=${TZ}`)).body.summary.activeMsSum).toBe(all0.activeMsSum);
  });
});

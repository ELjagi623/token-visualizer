/**
 * 批次 B 的服务端端点：heatmap / day-detail / analysis/* / sessions / sessions/:id / activeMs。
 * 数值全部与 fixture 的 expected.json（声明式规格推出）对账；口径不变量：
 *   总量 = 曲线之和、Total − Fresh = 缓存读、分组之和 = 总量、会话之和 = 总量、热力图 168 格之和 = 总量。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getJson, startApp } from './apiHelpers.ts';
import type { TestApp } from './apiHelpers.ts';
import { loadExpected } from './helpers.ts';
import type { Expected } from './helpers.ts';

const expected: Expected = loadExpected();
let t: TestApp;
let b: string;

beforeAll(async () => {
  t = await startApp();
  b = t.base;
});
afterAll(async () => {
  await t.close();
});

const sum = (xs: number[]): number => xs.reduce((a, c) => a + c, 0);

describe('analysis：模型 / 构成 / 项目 / 工具 / 主线子代理 / 本地云端 / 时段 / 缓存 / 质量', () => {
  it('A1 模型：占比之和 = 1；<synthetic> 不出现；各模型 token = expected；家族合并后总量不变；本地模型带 isLocal', async () => {
    const r = (await getJson(b, '/api/analysis/models?range=all')).body;
    expect(r.models.length).toBe(Object.keys(expected.models).length);
    expect(Math.abs(sum(r.models.map((m: any) => m.share)) - 1)).toBeLessThan(1e-9);
    expect(r.models.some((m: any) => m.key === '<synthetic>')).toBe(false);
    for (const m of r.models) expect(m.total, m.key).toBe(expected.models[m.key].total);
    expect(r.total).toBe(expected.totals.total);
    expect(r.mostUsed).toBe(r.models[0].key);
    const locals = r.models.filter((m: any) => m.isLocal).map((m: any) => m.display);
    expect(locals).toContain('Qwen3-35B-A3B');
    expect(locals).toContain('qwen/qwen3-coder-next');
    const fam = (await getJson(b, '/api/analysis/models?range=all&mergeFamilies=true')).body;
    expect(fam.total).toBe(r.total);
    expect(fam.models.length).toBeLessThan(r.models.length);
    // Fresh：总量下降 = 缓存读
    const fresh = (await getJson(b, '/api/analysis/models?range=all&basis=fresh')).body;
    expect(r.total - fresh.total).toBe(expected.totals.cacheRead);
  });

  it('A2 构成：四类（含思考拆分）之和 = Total；Fresh 下缓存读不计入', async () => {
    const c = (await getJson(b, '/api/analysis/composition?range=all')).body;
    expect(c).toMatchObject({ input: expected.totals.input, cacheWrite: expected.totals.cacheWrite, cacheRead: expected.totals.cacheRead, output: expected.totals.output, thinking: expected.totals.thinking });
    expect(c.input + c.cacheWrite + c.cacheRead + c.output).toBe(c.total);
    expect(c.total).toBe(expected.totals.total);
    expect(c.thinking).toBeLessThanOrEqual(c.output);
    const f = (await getJson(b, '/api/analysis/composition?range=all&basis=fresh')).body;
    expect(c.total - f.value).toBe(c.cacheRead);
    expect(f.value).toBe(expected.totals.fresh);
  });

  it('A3 项目：各项目之和 = 总量，与 expected 各项目一致', async () => {
    const r = (await getJson(b, '/api/analysis/projects?range=all')).body;
    expect(sum(r.projects.map((p: any) => p.value))).toBe(expected.totals.total);
    const nonScratch = expected.projects.filter((p: any) => !p.isScratch && p.total > 0);
    for (const p of nonScratch) expect(r.projects.find((x: any) => x.id === p.projectKey).total, p.projectKey).toBe(p.total);
    const scratchTotal = sum(expected.projects.filter((p: any) => p.isScratch).map((p: any) => p.total));
    expect(r.projects.find((x: any) => x.id === 'scratch').total).toBe(scratchTotal);
  });

  it('A4 会话 Top N：严格按 token 降序；总量之和 ≤ 总量；limit 生效；标题规则（custom > 首条真人消息前 40 字）', async () => {
    const r = (await getJson(b, '/api/analysis/sessions-top?range=all&limit=5')).body;
    expect(r.sessions.length).toBe(5);
    for (let i = 1; i < r.sessions.length; i++) expect(r.sessions[i - 1].value).toBeGreaterThanOrEqual(r.sessions[i].value);
    expect(r.total).toBe(Object.keys(expected.sessions).length);
    const top = (await getJson(b, '/api/analysis/sessions-top?range=all&limit=100')).body;
    expect(sum(top.sessions.map((s: any) => s.value))).toBe(expected.totals.total);
    const withCustom = top.sessions.find((s: any) => s.id === 'a1a1a1a1-0000-4000-8000-000000000001');
    expect(withCustom.title).toBe('Refactor the parser');
    expect(withCustom.titleSource).toBe('custom');
  });

  it('A5 缓存：曲线各点缓存读之和 = 总缓存读；命中率 = 读 ÷ (输入 + 写 + 读)；写读比', async () => {
    const r = (await getJson(b, '/api/analysis/cache-efficiency?range=all')).body;
    expect(sum(r.points.map((p: any) => p.cacheRead))).toBe(expected.totals.cacheRead);
    const denom = expected.totals.input + expected.totals.cacheWrite + expected.totals.cacheRead;
    expect(r.hitRate).toBeCloseTo(expected.totals.cacheRead / denom, 12);
    expect(r.readPerWrite).toBeCloseTo(expected.totals.cacheRead / expected.totals.cacheWrite, 12);
    for (const p of r.points) if (p.hitRate !== null) expect(p.hitRate).toBeGreaterThanOrEqual(0), expect(p.hitRate).toBeLessThanOrEqual(1);
  });

  it('A7 活跃时段：7×24 = 168 个格子之和 = 总量；周日在前', async () => {
    const r = (await getJson(b, '/api/analysis/activity-grid?range=all')).body;
    expect(r.grid.length).toBe(7);
    expect(r.grid.every((row: number[]) => row.length === 24)).toBe(true);
    expect(sum(r.grid.flat())).toBe(expected.totals.total);
    expect(r.total).toBe(expected.totals.total);
    expect(r.max).toBe(Math.max(...r.grid.flat()));
  });

  it('A8 工具：次数与 expected 一致，只有工具名；MCP 工具按服务器前缀归并', async () => {
    const r = (await getJson(b, '/api/analysis/tools?range=all')).body;
    for (const [name, n] of Object.entries(expected.tools)) expect(r.tools.find((x: any) => x.name === name)?.count, name).toBe(n);
    expect(JSON.stringify(r)).not.toContain('SECRET_BODY_MARKER');
  });

  it('A9 主线 vs 子代理：之和 = 总量；子代理 = expected.sidechain；A19 本地 + 云端 = 总量', async () => {
    const s = (await getJson(b, '/api/analysis/sidechain?range=all')).body;
    expect(s.main.value + s.sidechain.value).toBe(expected.totals.total);
    expect(s.sidechain.value).toBe(expected.sidechain.total);
    expect(s.sidechain.requests).toBe(expected.sidechain.records);
    expect(s.main.share + s.sidechain.share).toBeCloseTo(1, 12);
    const l = (await getJson(b, '/api/analysis/local-vs-cloud?range=all')).body;
    expect(l.local.value + l.cloud.value).toBe(expected.totals.total);
    const localExpected = sum(Object.entries(expected.models).filter(([k]) => /gguf|qwen/i.test(k)).map(([, m]: any) => m.total));
    expect(l.local.value).toBe(localExpected);
  });

  it('A20 数据质量：与 expected.stats 精确相等', async () => {
    const q = (await getJson(b, '/api/analysis/quality')).body;
    const s = expected.stats;
    expect(q).toMatchObject({
      filesParsed: s.filesParsed,
      assistantRows: s.assistantRows,
      uniqueMessages: s.uniqueMessages,
      duplicatesDropped: s.duplicatesDropped,
      crossFileDuplicates: s.crossFileDuplicates,
      syntheticExcluded: s.syntheticExcluded,
      corruptLines: s.corruptLines,
      emptyFiles: s.emptyFiles,
      missingId: s.missingId,
      missingUsage: s.missingUsage,
      missingCacheBreakdown: s.missingCacheBreakdown,
      missingThinking: s.missingThinking,
    });
    expect(q.missingFieldRecords).toBe(s.missingUsage + s.missingCacheBreakdown);
  });

  it('筛选联动：改变范围 / 模型后，A1 / A2 / A3 / A9 的总量彼此一致', async () => {
    for (const qs of ['range=all', 'range=all&models=claude-haiku-4-5', 'range=all&basis=fresh&project=D--Work-alpha', 'range=30d&mergeFamilies=true&models=haiku,opus']) {
      const [m, c, p, s, l] = await Promise.all(['models', 'composition', 'projects', 'sidechain', 'local-vs-cloud'].map(async (k) => (await getJson(b, `/api/analysis/${k}?${qs}`)).body));
      const totals = [m.total, c.value, p.total, s.main.value + s.sidechain.value, l.local.value + l.cloud.value];
      expect(new Set(totals).size, `${qs} ${totals}`).toBe(1);
    }
  });
});

describe('热力图 / 当日明细', () => {
  it('heatmap：每格一天（零填充），连续、周对齐；格子之和 = 窗口内总量；weeks 参数', async () => {
    const r = (await getJson(b, '/api/heatmap?weeks=26')).body;
    // now = 2026-10-20（周二），周一起始 → 窗口从 25 周前的周一到今天：25*7 + 2 天
    expect(r.days.length).toBe(25 * 7 + 2);
    expect(r.days[0].date).toBe('2026-04-27');
    expect(r.days[r.days.length - 1].date).toBe('2026-10-20');
    const dates = r.days.map((d: any) => d.date);
    expect(new Set(dates).size).toBe(dates.length);
    const total = (await getJson(b, '/api/summary?range=custom&from=2026-04-27&to=2026-10-20')).body.summary.value;
    expect(sum(r.days.map((d: any) => d.value))).toBe(total);
    expect(r.max).toBe(Math.max(...r.days.map((d: any) => d.value)));
    const sun = (await getJson(b, '/api/heatmap?weeks=2&weekStart=sunday')).body;
    expect(sun.days.length).toBe(7 + 3);
    expect((await getJson(b, '/api/heatmap?weeks=0')).status).toBe(400);
  });

  it('day-detail：24 个小时桶之和 = 当天总量；会话之和 = 当天总量；会话数 = 当天有记录的会话数', async () => {
    // expected.phase2.nowCases[0]：上海 2026-10-20 今日 2 条 / 7330
    const today = expected.phase2.nowCases[0].today;
    const r = (await getJson(b, '/api/day-detail?date=2026-10-20')).body;
    expect(r.hours.length).toBe(24);
    expect(sum(r.hours.map((h: any) => h.value))).toBe(today.total);
    expect(r.summary.requests).toBe(today.requests);
    expect(sum(r.sessions.map((s: any) => s.value))).toBe(today.total);
    const day = (await getJson(b, '/api/summary?range=custom&from=2026-10-20&to=2026-10-20')).body.summary;
    expect(r.sessionCount).toBe(day.sessions);
    expect((await getJson(b, '/api/day-detail')).status).toBe(400);
    expect((await getJson(b, '/api/day-detail?date=2026-13-45x')).status).toBe(400);
    // 空的一天
    const e = (await getJson(b, '/api/day-detail?date=2020-01-01')).body;
    expect(e.sessionCount).toBe(0);
    expect(sum(e.hours.map((h: any) => h.value))).toBe(0);
    // DST：纽约 2026-03-08 只有 23 小时
    const ny = (await getJson(b, '/api/day-detail?date=2026-03-08&tz=America/New_York')).body;
    expect(ny.hours.length).toBe(23);
  });
});

describe('会话列表 / 详情', () => {
  it('列表：会话数与 token 之和 = 总览累计；按 tokens 降序；分页；搜索；排序方向；子代理并入父会话', async () => {
    const r = (await getJson(b, '/api/sessions?range=all&pageSize=500')).body;
    expect(r.total).toBe(Object.keys(expected.sessions).length);
    expect(sum(r.rows.map((x: any) => x.value))).toBe(expected.totals.total);
    expect(r.sumValue).toBe(expected.totals.total);
    for (let i = 1; i < r.rows.length; i++) expect(r.rows[i - 1].value).toBeGreaterThanOrEqual(r.rows[i].value);
    for (const row of r.rows) {
      const e = expected.sessions[row.id];
      expect(row.requests, row.id).toBe(e.records);
      expect(row.total, row.id).toBe(e.total);
      expect(row.sidechainRequests, row.id).toBe(e.sidechainRecords);
      expect(row.durationMs).toBe(row.lastTs - row.firstTs);
    }
    const p1 = (await getJson(b, '/api/sessions?range=all&pageSize=3&page=1')).body;
    const p2 = (await getJson(b, '/api/sessions?range=all&pageSize=3&page=2')).body;
    expect(p1.rows.length).toBe(3);
    expect(p1.rows.map((x: any) => x.id)).toEqual(r.rows.slice(0, 3).map((x: any) => x.id));
    expect(p2.rows.map((x: any) => x.id)).toEqual(r.rows.slice(3, 6).map((x: any) => x.id));
    const asc = (await getJson(b, '/api/sessions?range=all&sort=requests&dir=asc&pageSize=500')).body;
    for (let i = 1; i < asc.rows.length; i++) expect(asc.rows[i - 1].requests).toBeLessThanOrEqual(asc.rows[i].requests);
    for (const sort of ['start', 'duration']) expect((await getJson(b, `/api/sessions?range=all&sort=${sort}`)).status).toBe(200);
    // 搜索：标题 / 项目名 / id
    const byTitle = (await getJson(b, `/api/sessions?range=all&q=${encodeURIComponent('refactor the')}`)).body;
    expect(byTitle.total).toBeGreaterThanOrEqual(1);
    const byProject = (await getJson(b, '/api/sessions?range=all&q=demo')).body;
    expect(byProject.rows.every((x: any) => x.projectName === 'demo' || x.title?.toLowerCase().includes('demo') || x.id.includes('demo'))).toBe(true);
    const byId = (await getJson(b, '/api/sessions?range=all&q=a1a1a1a1-0000-4000-8000-000000000002')).body;
    expect(byId.total).toBe(1);
    // 项目筛选
    const alpha = (await getJson(b, '/api/sessions?range=all&project=D--Work-alpha&pageSize=500')).body;
    expect(alpha.rows.every((x: any) => x.projectId === 'D--Work-alpha')).toBe(true);
    expect((await getJson(b, '/api/sessions?sort=nope')).status).toBe(400);
    expect((await getJson(b, '/api/sessions?pageSize=0')).status).toBe(400);
  });

  it('隐私：响应里没有 SECRET_BODY_MARKER，也没有首条消息 40 字之后的内容；标题 ≤ 40 字', async () => {
    const all = JSON.stringify((await getJson(b, '/api/sessions?range=all&pageSize=500')).body) + JSON.stringify((await getJson(b, '/api/analysis/sessions-top?limit=100&range=all')).body) + JSON.stringify((await getJson(b, '/api/day-detail?date=2026-10-05')).body);
    expect(all).not.toContain('SECRET_BODY_MARKER');
    expect(all).not.toContain('this tail must never');
    expect(all).not.toContain('keep going');
    const r = (await getJson(b, '/api/sessions?range=all&pageSize=500')).body;
    for (const x of r.rows) if (x.title) expect(Array.from(x.title as string).length).toBeLessThanOrEqual(40);
  });

  it('详情：逐次请求之和 = 会话总量；请求数 = 唯一消息数；构成 / 模型 / 工具之和与总量一致；含子代理', async () => {
    for (const [id, e] of Object.entries<any>(expected.sessions)) {
      const r = (await getJson(b, `/api/sessions/${id}`)).body;
      expect(r.requestCount, id).toBe(e.records);
      expect(r.requests.length).toBe(e.records);
      expect(sum(r.requests.map((x: any) => x.total)), id).toBe(e.total);
      expect(r.composition.total).toBe(e.total);
      expect(r.composition.input + r.composition.cacheWrite + r.composition.cacheRead + r.composition.output).toBe(e.total);
      expect(sum(r.models.map((m: any) => m.total))).toBe(e.total);
      expect(sum(r.requests.map((x: any) => x.context))).toBe(e.input + e.cacheWrite + e.cacheRead);
      expect(r.sidechainRequests).toBe(e.sidechainRecords);
      for (let i = 1; i < r.requests.length; i++) expect(r.requests[i].ts).toBeGreaterThanOrEqual(r.requests[i - 1].ts);
    }
    const alpha = (await getJson(b, '/api/sessions/a1a1a1a1-0000-4000-8000-000000000001')).body;
    expect(alpha.title).toBe('Refactor the parser');
    expect(alpha.tools.length).toBeGreaterThan(0);
    const fresh = (await getJson(b, '/api/sessions/a1a1a1a1-0000-4000-8000-000000000001?basis=fresh')).body;
    expect(sum(fresh.requests.map((x: any) => x.value))).toBe(fresh.composition.fresh);
    expect((await getJson(b, '/api/sessions/does-not-exist')).status).toBe(404);
  });
});

describe('summary / timeseries 的 AI 运行时长（activeMs）', () => {
  it('summary.activeMs 与 timeseries 各点 activeMs 之和相等（四种粒度）；activeMs ≤ activeMsSum；≤ 窗口时长', async () => {
    for (const qs of ['range=all', 'range=custom&from=2026-10-01&to=2026-10-31', 'range=30d']) {
      const s = (await getJson(b, `/api/summary?${qs}`)).body;
      expect(typeof s.summary.activeMs).toBe('number');
      expect(s.summary.activeMs).toBeLessThanOrEqual(s.summary.activeMsSum);
      for (const g of ['hour', 'day', 'week', 'month']) {
        const ts = (await getJson(b, `/api/timeseries?${qs}&granularity=${g}`)).body;
        expect(sum(ts.points.map((p: any) => p.activeMs)), `${qs} ${g}`).toBe(s.summary.activeMs);
        expect(ts.summary.activeMs).toBe(s.summary.activeMs);
      }
      if (s.range.fromTs !== null) expect(s.summary.activeMs).toBeLessThanOrEqual(s.range.toTs - s.range.fromTs);
    }
    // 单个小时桶 ≤ 1 小时；单日桶 ≤ 24 小时
    const hourly = (await getJson(b, '/api/timeseries?range=all&granularity=hour')).body;
    for (const p of hourly.points) expect(p.activeMs).toBeLessThanOrEqual(3_600_000);
  });

  it('fixture 的手算对账：只有 user / assistant 行都带时间戳才产生区间；项目与子代理筛选单调', async () => {
    const all = (await getJson(b, '/api/summary?range=all')).body.summary;
    const noSide = (await getJson(b, '/api/summary?range=all&includeSidechain=false')).body.summary;
    expect(noSide.activeMs).toBeLessThanOrEqual(all.activeMs);
    const sumProjects = sum(await Promise.all(expected.projects.filter((p: any) => !p.isScratch).map(async (p: any) => (await getJson(b, `/api/summary?range=all&project=${encodeURIComponent(p.projectKey)}`)).body.summary.activeMsSum)));
    const scratch = (await getJson(b, '/api/summary?range=all&project=scratch')).body.summary.activeMsSum;
    // 各文件之和（activeMsSum）按项目可加：Σ 项目 = 全部
    expect(sumProjects + scratch).toBe(all.activeMsSum);
  });
});

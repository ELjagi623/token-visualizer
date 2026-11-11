import { describe, expect, it } from 'vitest';
import {
  aggregate,
  groupByModel,
  groupByProject,
  groupBySession,
  groupByTool,
  hourWeekGrid,
  periodCards,
  selectRecords,
  sidechainSplit,
  summarize,
} from '../src/server/core/aggregate.ts';
import type { AggregateContext } from '../src/server/core/aggregate.ts';
import { buildProjectIndex } from '../src/server/core/projects.ts';
import { QueryError } from '../src/server/core/time.ts';
import type { Granularity } from '../src/server/core/time.ts';
import type { UsageRecord } from '../src/shared/types.ts';
import { baseQuery, loadExpected, loadFixtureCtx } from './helpers.ts';
import type { Expected } from './helpers.ts';

const expected: Expected = loadExpected();
const GRANS: Granularity[] = ['hour', 'day', 'week', 'month'];
const sumBy = <T>(xs: T[], f: (x: T) => number): number => xs.reduce((a, x) => a + f(x), 0);

describe('aggregate：总量 = 曲线之和（验收 3）', () => {
  it('全部项目 / 每个项目 × 四种粒度 × 三个时区：summary.total = Σ timeline.total = expected', async () => {
    const { ctx, flatCtx } = await loadFixtureCtx();
    for (const tz of ['Asia/Shanghai', 'UTC', 'America/New_York']) {
      for (const g of GRANS) {
        const r = aggregate(ctx, baseQuery({ granularity: g, tz }));
        expect(r.summary.total, `all ${g} ${tz}`).toBe(expected.totals.total);
        expect(sumBy(r.timeline, (p) => p.total), `all ${g} ${tz}`).toBe(expected.totals.total);
        expect(sumBy(r.timeline, (p) => p.requests)).toBe(expected.stats.uniqueMessages);
        expect(r.summary.fresh).toBe(expected.totals.fresh);
        expect(sumBy(r.timeline, (p) => p.cacheRead)).toBe(expected.totals.cacheRead);
      }
    }
    for (const p of expected.projects as Expected[]) {
      for (const g of GRANS) {
        const r = aggregate(flatCtx, baseQuery({ projects: [p.projectKey], granularity: g }));
        expect(r.summary.total, `${p.projectKey} ${g}`).toBe(p.total);
        expect(sumBy(r.timeline, (x) => x.total), `${p.projectKey} ${g}`).toBe(p.total);
        expect(r.summary.requests).toBe(p.records);
      }
    }
  });

  it('Scratch 组 = 各 scratch 文件夹之和', async () => {
    const { ctx } = await loadFixtureCtx();
    const want = sumBy((expected.projects as Expected[]).filter((p) => p.isScratch), (p) => p.total);
    expect(aggregate(ctx, baseQuery({ projects: ['scratch'] })).summary.total).toBe(want);
  });

  it('汇总字段各自等于 expected.totals；比率 / 平均值按定义', async () => {
    const { ctx } = await loadFixtureCtx();
    const s = aggregate(ctx, baseQuery()).summary;
    const t = expected.totals;
    expect(s).toMatchObject({ input: t.input, cacheWrite: t.cacheWrite, cacheWrite5m: t.cacheWrite5m, cacheWrite1h: t.cacheWrite1h, cacheRead: t.cacheRead, output: t.output, thinking: t.thinking });
    expect(s.requests).toBe(expected.stats.uniqueMessages);
    expect(s.sessions).toBe(Object.keys(expected.sessions).length);
    expect(s.cacheHitRate).toBeCloseTo(t.cacheRead / (t.input + t.cacheWrite + t.cacheRead), 12);
    expect(s.outputInputRatio).toBeCloseTo(t.output / (t.input + t.cacheWrite + t.cacheRead), 12);
    expect(s.avgPerRequest).toBeCloseTo(t.total / s.requests, 9);
    expect(s.avgPerSession).toBeCloseTo(t.total / s.sessions, 9);
    expect(s.activeDays).toBe(Object.keys(expected.phase2.dailyTotals['Asia/Shanghai']).length);
    // Fresh 口径下 avg 用 fresh
    const f = aggregate(ctx, baseQuery({ basis: 'fresh' })).summary;
    expect(f.value).toBe(t.fresh);
    expect(f.avgPerRequest).toBeCloseTo(t.fresh / f.requests, 9);
  });

  it('空集合：除零得到 null 而不是 NaN / Infinity', async () => {
    const { ctx } = await loadFixtureCtx();
    const s = aggregate(ctx, baseQuery({ range: { kind: 'custom', from: '2030-01-01', to: '2030-01-03' } })).summary;
    expect(s).toMatchObject({ total: 0, requests: 0, sessions: 0, activeDays: 0, cacheHitRate: null, outputInputRatio: null, avgPerRequest: null, avgPerSession: null });
    const empty = aggregate({ records: [], projects: buildProjectIndex([]) }, baseQuery());
    expect(empty.timeline).toEqual([]);
    expect(empty.summary.total).toBe(0);
  });
});

describe('aggregate：日界与按日汇总与 expected 一致（验收 4）', () => {
  it('四个时区：日粒度时间线（有数据的日子）逐日等于 expected.dailyTotals', async () => {
    const { ctx } = await loadFixtureCtx();
    for (const tz of ['UTC', 'Asia/Shanghai', 'America/New_York', 'Asia/Kolkata']) {
      const r = aggregate(ctx, baseQuery({ granularity: 'day', tz }));
      const got = Object.fromEntries(r.timeline.filter((p) => p.requests > 0).map((p) => [p.key, { requests: p.requests, total: p.total, fresh: p.fresh }]));
      expect(got, tz).toEqual(expected.phase2.dailyTotals[tz]);
    }
  });

  it('Asia/Shanghai：UTC 15:59:59 与 16:00:00 的两条记录落在相邻两个本地日；换成 UTC 则同一天', async () => {
    const { ctx } = await loadFixtureCtx();
    const find = (id: string): UsageRecord => ctx.records.find((r) => r.messageId === id)!;
    const a = find('msg_tp_sh_day_a');
    const b = find('msg_tp_sh_day_b');
    const sh = aggregate(ctx, baseQuery({ granularity: 'day', tz: 'Asia/Shanghai' }));
    const byKey = new Map(sh.timeline.map((p) => [p.key, p]));
    // 2026-10-10 当天的总量包含 a、不含 b；2026-10-11 包含 b
    const d10 = byKey.get('2026-10-10')!;
    const d11 = byKey.get('2026-10-11')!;
    expect(d10.total).toBeGreaterThanOrEqual(a.input + a.cacheWrite + a.cacheRead + a.output);
    expect(d11.total).toBeGreaterThanOrEqual(b.input + b.cacheWrite + b.cacheRead + b.output);
    const only = (tz: string, from: string, to: string) => aggregate(ctx, baseQuery({ tz, range: { kind: 'custom', from, to }, projects: ['D--Work-timeprobe'] })).summary.requests;
    expect(only('Asia/Shanghai', '2026-10-10', '2026-10-10')).toBe(1); // 只有 sh_day_a
    expect(only('UTC', '2026-10-10', '2026-10-10')).toBe(4); // sh_day_a/b 与 ist_a/b 在 UTC 都是 10-10
  });

  it('timeprobe 项目：自定义范围按本地日裁剪，各时区的条数与手工本地日期表一致', async () => {
    const { ctx } = await loadFixtureCtx();
    for (const tz of ['UTC', 'Asia/Shanghai', 'America/New_York', 'Asia/Kolkata']) {
      const counts = new Map<string, number>();
      for (const p of expected.timeProbes as Expected[]) counts.set(p.localDate[tz], (counts.get(p.localDate[tz]) ?? 0) + 1);
      for (const [date, n] of counts) {
        const r = aggregate(ctx, baseQuery({ tz, projects: ['D--Work-timeprobe'], range: { kind: 'custom', from: date, to: date } }));
        expect(r.summary.requests, `${tz} ${date}`).toBe(n);
      }
    }
  });

  it('固定 now 下 今日 / 昨日 / 本周 / 本月（含上周 / 上月）与 expected.nowCases 一致；周起始日各自正确', async () => {
    const { ctx } = await loadFixtureCtx();
    for (const c of expected.phase2.nowCases as Expected[]) {
      const cards = periodCards(ctx, baseQuery({ tz: c.tz, weekStart: c.weekStart, now: Date.parse(c.nowIso) }));
      for (const k of ['today', 'yesterday', 'thisWeek', 'prevWeek', 'thisMonth', 'prevMonth'] as const) {
        expect({ requests: cards[k].summary.requests, total: cards[k].summary.total, fresh: cards[k].summary.fresh }, `${c.name} ${k}`).toEqual({ requests: c[k].requests, total: c[k].total, fresh: c[k].fresh });
      }
    }
    // 周一起始与周日起始在同一 now 下"本周"不同
    const mon = expected.phase2.nowCases.find((c: Expected) => c.name === 'shanghai-tue-monday-start');
    const sun = expected.phase2.nowCases.find((c: Expected) => c.name === 'shanghai-tue-sunday-start');
    expect(mon.thisWeek.total).not.toBe(sun.thisWeek.total);
  });

  it('各期汇总 = 对应区间的曲线之和；环比：昨日为 0 → pct 为 null', async () => {
    const { ctx } = await loadFixtureCtx();
    const q = baseQuery({ tz: 'Asia/Shanghai', now: Date.parse('2026-10-20T12:00:00Z') });
    const cards = periodCards(ctx, q);
    expect(cards.yesterday.summary.total).toBe(0);
    expect(cards.deltas.today.pct).toBeNull();
    expect(cards.deltas.today.diff).toBe(cards.today.summary.total);
    const today = aggregate(ctx, { ...q, range: { kind: 'today' }, granularity: 'hour' });
    expect(today.timeline).toHaveLength(24);
    expect(sumBy(today.timeline, (p) => p.total)).toBe(cards.today.summary.total);
    const month = aggregate(ctx, { ...q, range: { kind: 'thisMonth' }, granularity: 'day' });
    expect(month.timeline).toHaveLength(31);
    expect(sumBy(month.timeline, (p) => p.total)).toBe(cards.thisMonth.summary.total);
    // 有上期数据时 pct = (cur - prev) / prev
    const w = periodCards(ctx, { ...q, now: Date.parse('2026-10-26T12:00:00Z') }); // 下一周
    expect(w.deltas.week.pct).toBeCloseTo((w.thisWeek.summary.value - w.prevWeek.summary.value) / w.prevWeek.summary.value, 12);
  });

  it('范围 7d / 30d：桶数 = 天数；custom 的曲线 x 范围与区间吻合；all 的点数 = 数据跨度内的桶数', async () => {
    const { ctx } = await loadFixtureCtx();
    const q = baseQuery({ now: Date.parse('2026-10-20T12:00:00Z') });
    expect(aggregate(ctx, { ...q, range: { kind: '7d' } }).timeline).toHaveLength(7);
    expect(aggregate(ctx, { ...q, range: { kind: '30d' } }).timeline).toHaveLength(30);
    const c = aggregate(ctx, { ...q, range: { kind: 'custom', from: '2026-10-10', to: '2026-10-12' } });
    expect(c.timeline.map((p) => p.key)).toEqual(['2026-10-10', '2026-10-11', '2026-10-12']);
    const all = aggregate(ctx, q);
    const first = all.timeline[0]!.key;
    const last = all.timeline[all.timeline.length - 1]!.key;
    expect(first).toBe('2026-03-08'); // 最早的探针（上海：3 月 8 日）
    expect(last).toBe('2026-11-11'); // 最晚的常规消息
    const days = (Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / 86_400_000 + 1;
    expect(all.timeline).toHaveLength(days);
    // 空桶补零
    expect(all.timeline.filter((p) => p.requests === 0).length).toBeGreaterThan(100);
  });
});

describe('aggregate：口径（验收 5）与拆分一致性（验收 3）', () => {
  const queries = [
    {},
    { projects: ['D--Work-alpha'] },
    { projects: ['D--Work-alpha', 'scratch'] },
    { includeSidechain: false },
    { models: ['claude-sonnet-5-5'] },
    { models: ['opus', 'local'], mergeModelFamilies: true },
    { range: { kind: 'custom' as const, from: '2026-10-05', to: '2026-10-20' } },
    { granularity: 'week' as const, weekStart: 'sunday' as const },
    { granularity: 'hour' as const, tz: 'Asia/Kolkata', range: { kind: 'custom' as const, from: '2026-10-08', to: '2026-10-12' } },
  ];

  it('任意查询：Total − Fresh = cacheRead 之和（精确相等），汇总与曲线皆然', async () => {
    const { ctx } = await loadFixtureCtx();
    for (const over of queries) {
      const t = aggregate(ctx, baseQuery({ ...over, basis: 'total' }));
      const f = aggregate(ctx, baseQuery({ ...over, basis: 'fresh' }));
      expect(t.summary.total - t.summary.fresh, JSON.stringify(over)).toBe(t.summary.cacheRead);
      expect(t.summary.value - f.summary.value).toBe(t.summary.cacheRead);
      expect(sumBy(t.timeline, (p) => p.value) - sumBy(f.timeline, (p) => p.value)).toBe(t.summary.cacheRead);
      t.timeline.forEach((p, i) => expect(p.total - p.fresh).toBe(p.cacheRead + 0 * i));
    }
  });

  it('按 tokenType / model / project 拆分：各系列之和 = 总量（Total 与 Fresh 两种口径）', async () => {
    const { ctx } = await loadFixtureCtx();
    for (const over of queries) {
      for (const basis of ['total', 'fresh'] as const) {
        for (const split of ['none', 'tokenType', 'model', 'project'] as const) {
          const r = aggregate(ctx, baseQuery({ ...over, basis, split }));
          const label = `${JSON.stringify(over)} ${basis} ${split}`;
          expect(sumBy(r.series, (s) => s.total), label).toBe(r.summary.value);
          // 逐桶之和也等于曲线 value
          r.timeline.forEach((p, i) => expect(sumBy(r.series, (s) => s.values[i]!), label).toBe(p.value));
          for (const s of r.series) expect(s.values).toHaveLength(r.timeline.length);
        }
      }
    }
    // tokenType：Fresh 口径下没有 cacheRead 系列
    expect(aggregate(ctx, baseQuery({ split: 'tokenType', basis: 'fresh' })).series.map((s) => s.key)).toEqual(['input', 'cacheWrite', 'output']);
    expect(aggregate(ctx, baseQuery({ split: 'tokenType', basis: 'total' })).series.map((s) => s.key)).toEqual(['input', 'cacheWrite', 'cacheRead', 'output']);
  });

  it('按模型拆分：系列名是归一化显示名，本地模型有标记，<synthetic> 不出现', async () => {
    const { ctx } = await loadFixtureCtx();
    const r = aggregate(ctx, baseQuery({ split: 'model' }));
    const byKey = new Map(r.series.map((s) => [s.key, s]));
    expect(byKey.has('<synthetic>')).toBe(false);
    expect(byKey.get('C:\\Users\\x\\Models\\Qwen3-35B-A3B-Q4_K_M.gguf')).toMatchObject({ label: 'Qwen3-35B-A3B', isLocal: true, family: 'local' });
    expect(byKey.get('qwen/qwen3-coder-next')).toMatchObject({ label: 'qwen/qwen3-coder-next', isLocal: true });
    expect(byKey.get('claude-sonnet-5-5')).toMatchObject({ label: 'Sonnet 5.5', isLocal: false });
    expect(r.series.map((s) => s.total)).toEqual([...r.series.map((s) => s.total)].sort((a, b) => b - a));
    // 家族合并：系列变成家族，总量不变
    const m = aggregate(ctx, baseQuery({ split: 'model', mergeModelFamilies: true }));
    expect(m.series.map((s) => s.key).sort()).toEqual(['haiku', 'local', 'opus', 'sonnet']);
    expect(m.summary.total).toBe(r.summary.total);
    expect(sumBy(m.series, (s) => s.total)).toBe(sumBy(r.series, (s) => s.total));
  });

  it('按项目拆分：Scratch 归并为一个系列；不归并时各 scratch 独立', async () => {
    const { ctx, flatCtx } = await loadFixtureCtx();
    const g = aggregate(ctx, baseQuery({ split: 'project' }));
    expect(g.series.map((s) => s.key)).toContain('scratch');
    expect(g.series.filter((s) => s.key.includes('scratch-workspaces'))).toHaveLength(0);
    const f = aggregate(flatCtx, baseQuery({ split: 'project' }));
    expect(f.series.filter((s) => s.key.includes('scratch-workspaces'))).toHaveLength(3);
    expect(f.series.find((s) => s.key === 'C--Users-----Work-demo')!.label).toBe('demo');
  });

  it('includeSidechain=false 去掉的恰是子代理总量；模型过滤与家族合并', async () => {
    const { ctx } = await loadFixtureCtx();
    const all = aggregate(ctx, baseQuery()).summary;
    const main = aggregate(ctx, baseQuery({ includeSidechain: false })).summary;
    expect(all.total - main.total).toBe(expected.sidechain.total);
    expect(all.requests - main.requests).toBe(expected.sidechain.records);
    const sonnet55 = aggregate(ctx, baseQuery({ models: ['claude-sonnet-5-5'] })).summary;
    expect(sonnet55.total).toBe(expected.models['claude-sonnet-5-5'].total);
    const local = aggregate(ctx, baseQuery({ models: ['local'], mergeModelFamilies: true })).summary;
    const wantLocal = sumBy(Object.entries<Expected>(expected.models).filter(([k]) => k.includes('gguf') || k.includes('/')), ([, v]) => v.total);
    expect(local.total).toBe(wantLocal);
  });
});

describe('aggregate：分组聚合', () => {
  it('按模型：占比之和 = 1（容差 1e-9）；<synthetic> 不出现；与 expected.models 一致；家族合并总量不变', async () => {
    const { ctx } = await loadFixtureCtx();
    for (const merge of [false, true]) {
      for (const basis of ['total', 'fresh'] as const) {
        const rows = groupByModel(ctx, baseQuery({ mergeModelFamilies: merge, basis }));
        expect(Math.abs(sumBy(rows, (r) => r.share) - 1)).toBeLessThan(1e-9);
        expect(rows.some((r) => r.key === '<synthetic>' || r.rawIds.includes('<synthetic>'))).toBe(false);
        expect(sumBy(rows, (r) => r.total)).toBe(expected.totals.total);
        expect(sumBy(rows, (r) => r.requests)).toBe(expected.stats.uniqueMessages);
      }
    }
    const raw = groupByModel(ctx, baseQuery());
    for (const r of raw) expect({ total: r.total, requests: r.requests }, r.key).toEqual({ total: expected.models[r.key].total, requests: expected.models[r.key].records });
    expect(raw).toHaveLength(Object.keys(expected.models).length);
    const fam = groupByModel(ctx, baseQuery({ mergeModelFamilies: true }));
    expect(fam.find((r) => r.key === 'local')!.rawIds).toHaveLength(2);
    expect(fam.find((r) => r.key === 'sonnet')!.rawIds.sort()).toEqual(['claude-sonnet-5', 'claude-sonnet-5-5']);
    // 全零时占比不是 NaN
    const none = groupByModel(ctx, baseQuery({ models: ['nonexistent'] }));
    expect(none).toEqual([]);
  });

  it('按项目：与 expected.projects 一致，之和 = 总量', async () => {
    const { flatCtx, ctx } = await loadFixtureCtx();
    const rows = groupByProject(flatCtx, baseQuery());
    for (const r of rows) expect(r.total, r.id).toBe((expected.projects as Expected[]).find((p) => p.projectKey === r.id).total);
    expect(sumBy(rows, (r) => r.total)).toBe(expected.totals.total);
    expect(Math.abs(sumBy(rows, (r) => r.share) - 1)).toBeLessThan(1e-9);
    const g = groupByProject(ctx, baseQuery());
    expect(g.map((r) => r.id)).toContain('scratch');
    expect(g.find((r) => r.id === 'scratch')!.displayName).toBe('Scratch');
  });

  it('按会话：与 expected.sessions 一致（子代理计入父会话、跨文件重复只计一次）', async () => {
    const { ctx } = await loadFixtureCtx();
    const rows = groupBySession(ctx, baseQuery());
    expect(rows).toHaveLength(Object.keys(expected.sessions).length);
    for (const r of rows) {
      const e = expected.sessions[r.sessionId];
      expect({ total: r.total, requests: r.requests, sidechain: r.sidechainRequests }, r.sessionId).toEqual({ total: e.total, requests: e.records, sidechain: e.sidechainRecords });
    }
    expect(sumBy(rows, (r) => r.total)).toBe(expected.totals.total);
    for (let i = 1; i < rows.length; i++) expect(rows[i - 1]!.value).toBeGreaterThanOrEqual(rows[i]!.value);
    const a1 = rows.find((r) => r.sessionId === 'a1a1a1a1-0000-4000-8000-000000000001')!;
    expect(a1.sidechainRequests).toBe(2);
    expect(a1.projectKey).toBe('D--Work-alpha');
    expect(a1.firstTs).toBeLessThanOrEqual(a1.lastTs);
  });

  it('工具计数 = expected.tools；主线 / 子代理拆分 = expected.sidechain', async () => {
    const { ctx } = await loadFixtureCtx();
    expect(Object.fromEntries(groupByTool(ctx, baseQuery()).map((t) => [t.name, t.count]))).toEqual(expected.tools);
    const sp = sidechainSplit(ctx, baseQuery({ includeSidechain: false }));
    expect(sp.sidechain.total).toBe(expected.sidechain.total);
    expect(sp.sidechain.requests).toBe(expected.sidechain.records);
    expect(sp.main.total + sp.sidechain.total).toBe(expected.totals.total);
    expect(sp.main.share + sp.sidechain.share).toBeCloseTo(1, 12);
  });

  it('小时 × 星期 网格：总和 = 总量；每条记录落在手工推算的格子（上海 UTC+8）', async () => {
    const { ctx } = await loadFixtureCtx();
    const grid = hourWeekGrid(ctx, baseQuery({ tz: 'Asia/Shanghai' }));
    expect(grid).toHaveLength(7);
    expect(grid.every((row) => row.length === 24)).toBe(true);
    expect(sumBy(grid.flat(), (x) => x)).toBe(expected.totals.total);
    const want = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
    const msgs = [...Object.values<Expected>(expected.messages), ...(expected.noIdMessages as Expected[])];
    for (const m of msgs) {
      const d = new Date(m.ts + 8 * 3_600_000); // 纯算术：上海无 DST
      want[d.getUTCDay()]![d.getUTCHours()]! += m.total;
    }
    expect(grid).toEqual(want);
    // 已知记录：2026-10-10T16:00:00Z = 上海 周日 00:00
    expect(grid[0]![0]).toBeGreaterThan(0);
  });
});

describe('aggregate：非法参数与健壮性', () => {
  it('抛 QueryError（阶段 4 映射为 400），而不是随机异常', async () => {
    const { ctx } = await loadFixtureCtx();
    const bad: Array<[string, Parameters<typeof baseQuery>[0]]> = [
      ['INVALID_TZ', { tz: 'Mars/Base' }],
      ['INVALID_GRANULARITY', { granularity: 'minute' as 'day' }],
      ['INVALID_RANGE', { range: { kind: 'custom', from: '2026-10-02', to: '2026-10-01' } }],
      ['UNKNOWN_PROJECT', { projects: ['no-such-project'] }],
      ['INVALID_BASIS', { basis: 'x' as 'total' }],
      ['INVALID_SPLIT', { split: 'x' as 'none' }],
      ['INVALID_WEEKSTART', { weekStart: 'friday' as 'monday' }],
    ];
    for (const [code, over] of bad) {
      let err: unknown;
      try {
        aggregate(ctx, baseQuery(over));
      } catch (e) {
        err = e;
      }
      expect(err, code).toBeInstanceOf(QueryError);
      expect((err as QueryError).code).toBe(code);
    }
    expect(() => periodCards(ctx, baseQuery({ tz: 'Mars/Base' }))).toThrow(QueryError);
    expect(() => selectRecords(ctx, baseQuery({ tz: '' }))).toThrow(QueryError);
  });

  it('记录乱序也能正确聚合；性能：10 万条记录一次查询 < 2 s', () => {
    const base: UsageRecord = {
      messageId: 'x',
      ts: 0,
      model: 'claude-sonnet-5-5',
      sessionId: 's',
      projectKey: 'p',
      isSidechain: false,
      input: 1,
      cacheWrite: 2,
      cacheWrite5m: 1,
      cacheWrite1h: 1,
      cacheRead: 3,
      output: 4,
      thinking: 1,
      webSearch: 0,
      webFetch: 0,
      tools: {},
      sourceFile: 'p/s.jsonl',
    };
    const t0 = Date.UTC(2026, 0, 1);
    const records: UsageRecord[] = [];
    for (let i = 0; i < 100_000; i++) records.push({ ...base, messageId: `m${i}`, ts: t0 + ((i * 7919) % 100_000) * 60_000, sessionId: `s${i % 500}`, model: i % 3 === 0 ? 'claude-opus-5-5' : 'claude-sonnet-5-5' });
    const ctx: AggregateContext = { records, projects: buildProjectIndex(records) };
    const t = performance.now();
    const r = aggregate(ctx, baseQuery({ tz: 'America/New_York', granularity: 'hour', split: 'model', range: { kind: 'all' } }));
    const ms = performance.now() - t;
    expect(r.summary.requests).toBe(100_000);
    expect(r.summary.total).toBe(100_000 * 10);
    expect(sumBy(r.timeline, (p) => p.total)).toBe(1_000_000);
    expect(ms).toBeLessThan(2000);
    // 与乱序无关：summarize 同值
    expect(summarize(records, 'total', 'UTC').total).toBe(1_000_000);
  });
});

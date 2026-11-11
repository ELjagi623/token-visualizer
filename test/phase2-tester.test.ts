/**
 * 阶段 2 独立测试（测试工程师编写）。
 * 期望值全部来自：手工常量 / expected.json（声明式规格）/ 原始 fixture 文件的独立读取 / Intl，
 * 不使用 scripts/verify/naive.ts。
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { aggregate, filterBase, groupByModel, groupByProject, groupBySession, hourWeekGrid, periodCards, sidechainSplit } from '../src/server/core/aggregate.ts';
import type { AggregateContext, AggregateQuery } from '../src/server/core/aggregate.ts';
import { parseDataRoot } from '../src/server/core/loadRoot.ts';
import { modelGroupOf, normalizeModel } from '../src/server/core/models.ts';
import { buildProjectIndex } from '../src/server/core/projects.ts';
import { bucketOf, enumerateBuckets, localParts, MAX_BUCKETS, periodBounds, QueryError, resolveRange } from '../src/server/core/time.ts';
import type { UsageRecord } from '../src/shared/types.ts';
import { FIXTURE_ROOT, loadExpected } from './helpers.ts';

const NOW = Date.parse('2026-11-10T12:00:00Z');
const base: AggregateQuery = {
  projects: 'all',
  range: { kind: 'all' },
  granularity: 'day',
  tz: 'Asia/Shanghai',
  weekStart: 'monday',
  basis: 'total',
  split: 'none',
  includeSidechain: true,
  now: NOW,
};

let records: UsageRecord[];
let ctx: AggregateContext;
let ctxFlat: AggregateContext;
let folderKeys: string[];
beforeAll(async () => {
  const parsed = await parseDataRoot(FIXTURE_ROOT);
  records = parsed.records;
  folderKeys = [...new Set(parsed.files.map((f) => f.info.projectKey))];
  ctx = { records, projects: buildProjectIndex(records, { folderKeys }) };
  ctxFlat = { records, projects: buildProjectIndex(records, { groupScratch: false, folderKeys }) };
});

function rec(over: Partial<UsageRecord> & { ts: number }): UsageRecord {
  return {
    messageId: 'm' + Math.random().toString(36).slice(2),
    model: 'claude-sonnet-5',
    sessionId: 's',
    projectKey: 'P',
    isSidechain: false,
    input: 1,
    cacheWrite: 2,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheRead: 4,
    output: 8,
    thinking: 0,
    webSearch: 0,
    webFetch: 0,
    tools: {},
    sourceFile: 'P/s.jsonl',
    ...over,
  };
}
const mkCtx = (rs: UsageRecord[]): AggregateContext => ({ records: rs, projects: buildProjectIndex(rs) });

// ---------------------------------------------------------------------------
describe('模型归一化（PRD #5 / 阶段 2 验收 2）', () => {
  it('路径型 gguf：取文件名去扩展名；量化后缀默认去除，可保留；isLocal', () => {
    const n = normalizeModel('C:\\Users\\x\\Models\\Qwen3-35B-A3B-Q4_K_M.gguf');
    expect([n.display, n.isLocal, n.family]).toEqual(['Qwen3-35B-A3B', true, 'local']);
    expect(n.id).toBe('C:\\Users\\x\\Models\\Qwen3-35B-A3B-Q4_K_M.gguf');
    expect(n.variant).toBe('Qwen3-35B-A3B-Q4_K_M');
    expect(normalizeModel('C:\\Users\\x\\Models\\Qwen3-35B-A3B-Q4_K_M.gguf', { stripQuant: false }).display).toBe('Qwen3-35B-A3B-Q4_K_M');
    for (const raw of ['/home/u/models/llama-3.1-8b-instruct.Q8_0.gguf', 'plain-name.gguf', 'D:/models/x/y/mistral-7b.gguf']) {
      const m = normalizeModel(raw);
      expect(m.isLocal, raw).toBe(true);
      expect(m.display, raw).not.toMatch(/[\\/]|\.gguf$/i);
    }
  });

  it('org/name 形 -> 本地；claude 家族与别名；未知名 -> other 不崩溃', () => {
    expect(normalizeModel('qwen/qwen3-coder-next')).toMatchObject({ isLocal: true, family: 'local', display: 'qwen/qwen3-coder-next' });
    const fam: Array<[string, string]> = [
      ['claude-opus-5', 'opus'], ['claude-opus-5-5', 'opus'], ['claude-sonnet-5', 'sonnet'], ['claude-sonnet-5-5', 'sonnet'],
      ['claude-haiku-4-5', 'haiku'], ['claude-haiku-4-5-20251001', 'haiku'], ['claude-opus-4-1-20250805', 'opus'],
      ['claude-3-5-sonnet-20241022', 'sonnet'], ['claude-3-haiku-20240307', 'haiku'], ['Claude-Sonnet-4', 'sonnet'],
    ];
    for (const [raw, f] of fam) expect(normalizeModel(raw), raw).toMatchObject({ family: f, isLocal: false });
    for (const raw of ['gpt-4o', 'weird', '<synthetic>', '', '   ', 'claude', 'claude-instant-1', 'a/b/c/d', 'x'.repeat(5000), '\u0000']) {
      expect(() => normalizeModel(raw), JSON.stringify(raw).slice(0, 30)).not.toThrow();
    }
    expect(normalizeModel('gpt-4o')).toMatchObject({ family: 'local', isLocal: true, display: 'gpt-4o' });
    expect(normalizeModel('')).toMatchObject({ family: 'other' });
    // 非字符串输入也不崩溃
    expect(() => normalizeModel(undefined as unknown as string)).not.toThrow();
    expect(() => normalizeModel(null as unknown as string)).not.toThrow();
    expect(() => normalizeModel(42 as unknown as string)).not.toThrow();
  });

  it('modelGroupOf：默认按原始名；合并按家族键；家族合并只改分组不改总量', () => {
    expect(modelGroupOf('claude-sonnet-5-5', false).key).toBe('claude-sonnet-5-5');
    expect(modelGroupOf('claude-sonnet-5-5', true).key).toBe('sonnet');
    expect(modelGroupOf('qwen/qwen3-coder-next', true).key).toBe('local');
    expect(modelGroupOf('C:\\m\\a.gguf', true).key).toBe('local');
    expect(modelGroupOf('weird', true).key).toBe('local'); // 非 claude- 前缀一律本地 / 非 Anthropic
    expect(modelGroupOf('claude-mystery-9', true).key).toBe('other');
  });

  it('fixture：groupByModel 各原始名总量 = 对原始 jsonl 独立计算；占比和=1（Total/Fresh、合并/不合并）；无 <synthetic>', () => {
    const e = loadExpected();
    for (const basis of ['total', 'fresh'] as const) {
      for (const merge of [false, true]) {
        const rows = groupByModel(ctx, { ...base, basis, mergeModelFamilies: merge });
        expect(Math.abs(rows.reduce((a, r) => a + r.share, 0) - 1)).toBeLessThan(1e-9);
        expect(rows.reduce((a, r) => a + r.value, 0)).toBe(basis === 'total' ? e.totals.total : e.totals.fresh);
        expect(rows.some((r) => r.key.includes('synthetic') || r.display.includes('synthetic'))).toBe(false);
      }
    }
    const raw = groupByModel(ctx, base);
    expect(Object.fromEntries(raw.map((r) => [r.key, r.total]))).toEqual(Object.fromEntries(Object.entries(e.models).map(([k, v]: [string, any]) => [k, v.total])));
    const q = raw.find((r) => r.key === 'qwen/qwen3-coder-next')!;
    const g = raw.find((r) => r.key.endsWith('.gguf'))!;
    expect([q.isLocal, g.isLocal, g.display]).toEqual([true, true, 'Qwen3-35B-A3B']);
    const merged = groupByModel(ctx, { ...base, mergeModelFamilies: true });
    expect(merged.map((r) => r.key).sort()).toEqual(['haiku', 'local', 'opus', 'sonnet']);
    expect(merged.find((r) => r.key === 'local')!.total).toBe(q.total + g.total);
    // 防御：即使有人把 <synthetic> 记录塞进 records 也不会出现在分组/系列/总量里
    const poisoned = mkCtx([...records, rec({ ts: Date.parse('2026-10-10T00:00:00Z'), model: '<synthetic>', input: 999, output: 999 })]);
    expect(groupByModel(poisoned, base).some((r) => r.key === '<synthetic>')).toBe(false);
    expect(aggregate(poisoned, base).summary.total).toBe(e.totals.total);
    expect(filterBase(poisoned, base).length).toBe(records.length);
  });

  it('未知模型名进入聚合时不崩溃，归入 other', () => {
    const c = mkCtx([rec({ ts: Date.parse('2026-10-10T00:00:00Z'), model: 'totally/unknown/thing' }), rec({ ts: Date.parse('2026-10-10T00:00:00Z'), model: '' })]);
    expect(() => groupByModel(c, { ...base, mergeModelFamilies: true })).not.toThrow();
    expect(aggregate(c, { ...base, split: 'model' }).series.reduce((a, s) => a + s.total, 0)).toBe(30);
  });
});

// ---------------------------------------------------------------------------
describe('项目归组（阶段 2 验收 1）', () => {
  it('Scratch 归并：顶层数 = 非 scratch 文件夹数 + 1；children 数 = scratch 文件夹数；groupScratch=false 各自独立', () => {
    const folders = fs.readdirSync(FIXTURE_ROOT).filter((n) => fs.statSync(path.join(FIXTURE_ROOT, n)).isDirectory());
    const scratch = folders.filter((n) => n.includes('scratch-workspaces'));
    expect(scratch.length).toBeGreaterThanOrEqual(3);
    const withRecords = new Set(records.map((r) => r.projectKey));
    const nonScratchWithRecords = folders.filter((n) => !scratch.includes(n) && withRecords.has(n));
    expect(buildProjectIndex(records).list.length).toBe(nonScratchWithRecords.length + 1); // 仅按记录：空文件夹不出现
    expect(ctx.projects.list.length).toBe(folders.length - scratch.length + 1); // 带 folderKeys：文件夹数 = 项目数（scratch 归并为 1）
    expect(ctx.projects.byId.get('scratch')!.children!.length).toBe(scratch.length);
    expect(ctx.projects.byId.get('scratch')!.children!.map((c) => c.id).sort()).toEqual([...scratch].sort());
    // folderKeys 显式补入空文件夹后：顶层数 = 全部非 scratch 文件夹 + 1
    const full = buildProjectIndex(records, { folderKeys: folders });
    expect(full.list.length).toBe(folders.length - scratch.length + 1);
    const flat = buildProjectIndex(records, { groupScratch: false, folderKeys: folders });
    expect(flat.list.length).toBe(folders.length);
    expect(flat.byId.has('scratch')).toBe(false);
    for (const s of scratch) expect(flat.byId.get(s)!.isScratch).toBe(true);
  });

  it('中文用户名项目：显示名/路径取自 cwd（demo / C:\\Users\\王测试\\Work\\demo），不是有损文件夹名', () => {
    const info = ctx.projects.byId.get('C--Users-----Work-demo')!;
    expect(info.displayName).toBe('demo');
    expect(info.path).toBe('C:\\Users\\王测试\\Work\\demo');
    expect(info.pathUnknown).toBe(false);
    expect(info.displayName).not.toContain('--');
  });

  it('beta：同文件夹两个 cwd -> cwds[] 含两者，主 cwd = 记录数最多者；该对照直接读原始 jsonl 独立统计', () => {
    const dir = path.join(FIXTURE_ROOT, 'D--Work-beta');
    const owned = new Map<string, number>();
    for (const r of records.filter((x) => x.projectKey === 'D--Work-beta')) owned.set(r.cwd ?? '', (owned.get(r.cwd ?? '') ?? 0) + 1);
    expect(fs.readdirSync(dir).length).toBeGreaterThan(0);
    const info = ctx.projects.byId.get('D--Work-beta')!;
    expect(info.cwds.length).toBe(2);
    expect(new Set(info.cwds)).toEqual(new Set([...owned.keys()]));
    const top = [...owned].sort((a, b) => b[1] - a[1])[0]!;
    expect(info.path).toBe(top[0]);
    expect(info.displayName).toBe(top[0].split('\\').pop());
  });

  it('只有空文件的文件夹（无 cwd）：显示名退回文件夹名并标记 pathUnknown', () => {
    const idx = buildProjectIndex(records, { folderKeys: ['D--Work-empty'] });
    const e = idx.byId.get('D--Work-empty')!;
    expect([e.displayName, e.pathUnknown, e.path, e.records]).toEqual(['D--Work-empty', true, null, 0]);
  });

  it('各项目总量：全部 = Σ项目；scratch 组 = Σ子项；单独选子项 = 该文件夹；与 expected.projects 一致', () => {
    const e = loadExpected();
    const tot = aggregate(ctx, base).summary.total;
    expect(tot).toBe(e.totals.total);
    for (const p of e.projects) {
      const id = p.isScratch ? p.projectKey : p.projectKey;
      expect(aggregate(ctxFlat, { ...base, projects: [id] }).summary.total, id).toBe(p.total);
    }
    const scratchSum = e.projects.filter((p: any) => p.isScratch).reduce((a: number, p: any) => a + p.total, 0);
    expect(aggregate(ctx, { ...base, projects: ['scratch'] }).summary.total).toBe(scratchSum);
    expect(groupByProject(ctx, base).reduce((a, r) => a + r.total, 0)).toBe(tot);
    expect(groupByProject(ctx, base).find((r) => r.id === 'scratch')!.total).toBe(scratchSum);
  });

  it('overrides：重命名 / 隐藏标记 / 置顶标记 / 合并 / 链式合并 / 环 / 目标不存在', () => {
    const rs = [
      rec({ ts: 1, projectKey: 'A', cwd: 'C:\\w\\a', input: 1, cacheWrite: 0, cacheRead: 0, output: 0 }),
      rec({ ts: 2, projectKey: 'B', cwd: 'C:\\w\\b', input: 10, cacheWrite: 0, cacheRead: 0, output: 0 }),
      rec({ ts: 3, projectKey: 'C', cwd: 'C:\\w\\c', input: 100, cacheWrite: 0, cacheRead: 0, output: 0 }),
    ];
    const plain = buildProjectIndex(rs);
    expect(plain.list.map((p) => p.displayName)).toEqual(['a', 'b', 'c']);
    const ren = buildProjectIndex(rs, { overrides: { A: { name: '  My A  ', pinned: true, hidden: true } } });
    expect(ren.byId.get('A')).toMatchObject({ displayName: 'My A', renamed: true, pinned: true, hidden: true });
    const mg = buildProjectIndex(rs, { overrides: { A: { mergeInto: 'B' } } });
    expect(mg.byId.has('A')).toBe(false);
    expect(mg.byId.get('B')!.memberKeys.sort()).toEqual(['A', 'B']);
    expect(mg.byId.get('B')!.records).toBe(2);
    expect(mg.idOfKey('A')).toBe('B');
    const c1 = mkCtx(rs);
    const c2 = { records: rs, projects: mg };
    expect(aggregate(c1, { ...base, projects: ['B'] }).summary.total).toBe(10);
    expect(aggregate(c2, { ...base, projects: ['B'] }).summary.total).toBe(11); // 合并后 B = A + B
    expect(groupByProject(c2, base).map((r) => r.id).sort()).toEqual(['B', 'C']);
    // 链式 A->B->C
    const chain = buildProjectIndex(rs, { overrides: { A: { mergeInto: 'B' }, B: { mergeInto: 'C' } } });
    expect(chain.list.map((p) => p.id)).toEqual(['C']);
    expect(chain.byId.get('C')!.memberKeys.sort()).toEqual(['A', 'B', 'C']);
    // 环：不崩溃，两者都保留
    const cyc = buildProjectIndex(rs, { overrides: { A: { mergeInto: 'B' }, B: { mergeInto: 'A' } } });
    expect(cyc.list.map((p) => p.id).sort()).toEqual(['A', 'B', 'C']);
    // 合并到不存在的目标：忽略
    expect(buildProjectIndex(rs, { overrides: { A: { mergeInto: 'ZZZ' } } }).list.length).toBe(3);
    // 本阶段 filterBase 不看 hidden（隐藏项目不计入合计是阶段 9 的口径）
    const hid = { records: rs, projects: buildProjectIndex(rs, { overrides: { A: { hidden: true } } }) };
    expect(aggregate(hid, { ...base }).summary.total).toBe(111);
  });

  it('未知项目 id -> QueryError(UNKNOWN_PROJECT)', () => {
    expect(() => aggregate(ctx, { ...base, projects: ['nope'] })).toThrowError(expect.objectContaining({ code: 'UNKNOWN_PROJECT' }));
  });
});

// ---------------------------------------------------------------------------
describe('日界 / 时区 / DST（PRD #4）', () => {
  it('fixture 的 timeprobe：Asia/Shanghai 下 UTC 15:59:59 与 16:00:00 落相邻两个本地日；与 expected.timeProbes 一致', () => {
    const e = loadExpected();
    const a = e.timeProbes.find((p: any) => p.iso === '2026-09-30T15:59:59.000Z');
    const b = e.timeProbes.find((p: any) => p.iso === '2026-09-30T16:00:00.000Z');
    expect(a && b).toBeTruthy();
    expect(bucketOf(a.ts, 'day', 'Asia/Shanghai').key).toBe('2026-09-30');
    expect(bucketOf(b.ts, 'day', 'Asia/Shanghai').key).toBe('2026-10-01');
    expect(bucketOf(a.ts, 'day', 'UTC').key).toBe(bucketOf(b.ts, 'day', 'UTC').key);
    for (const p of e.timeProbes) for (const [tz, d] of Object.entries(p.localDate)) expect(localParts(p.ts, tz).date, `${p.id} ${tz}`).toBe(d);
  });

  it('日/周/月边界（上海）：周日 23:59:59 vs 周一 00:00:00 的周桶；月末/月初；周起始切换', () => {
    // 2026-11-01 是周日（上海）。2026-11-01T15:59:59Z = 11-01 23:59:59 周日；16:00:00Z = 11-02 周一 00:00
    const sun = Date.parse('2026-11-01T15:59:59Z');
    const mon = Date.parse('2026-11-01T16:00:00Z');
    expect(bucketOf(sun, 'week', 'Asia/Shanghai', 'monday').key).toBe('2026-10-26');
    expect(bucketOf(mon, 'week', 'Asia/Shanghai', 'monday').key).toBe('2026-11-02');
    expect(bucketOf(sun, 'week', 'Asia/Shanghai', 'sunday').key).toBe('2026-11-01');
    expect(bucketOf(mon, 'week', 'Asia/Shanghai', 'sunday').key).toBe('2026-11-01');
    // 月界
    expect(bucketOf(Date.parse('2026-10-31T15:59:59Z'), 'month', 'Asia/Shanghai').key).toBe('2026-10');
    expect(bucketOf(Date.parse('2026-10-31T16:00:00Z'), 'month', 'Asia/Shanghai').key).toBe('2026-11');
    // 年界周：2026-01-01 周四，周一起始 -> 2025-12-29
    expect(bucketOf(Date.parse('2026-01-01T04:00:00Z'), 'week', 'UTC', 'monday').key).toBe('2025-12-29');
    expect(bucketOf(Date.parse('2026-01-01T04:00:00Z'), 'week', 'UTC', 'sunday').key).toBe('2025-12-28');
    expect(bucketOf(Date.parse('2026-01-01T04:00:00Z'), 'month', 'UTC').key).toBe('2026-01');
    // 闰日
    expect(localParts(Date.parse('2028-02-29T23:59:59Z'), 'UTC').date).toBe('2028-02-29');
    expect(localParts(Date.parse('2028-03-01T00:00:00Z'), 'UTC').date).toBe('2028-03-01');
    expect(localParts(Date.parse('2027-02-28T23:59:59Z'), 'UTC').date).toBe('2027-02-28');
    expect(localParts(Date.parse('2027-03-01T00:00:00Z'), 'UTC').date).toBe('2027-03-01');
  });

  it('Asia/Kolkata（+5:30）与 Kathmandu（+5:45）：日界在 UTC 18:30 / 18:15；小时桶起点在 :30 / :45', () => {
    expect(bucketOf(Date.parse('2026-10-04T18:29:59Z'), 'day', 'Asia/Kolkata').key).toBe('2026-10-04');
    expect(bucketOf(Date.parse('2026-10-04T18:30:00Z'), 'day', 'Asia/Kolkata').key).toBe('2026-10-05');
    expect(bucketOf(Date.parse('2026-10-04T18:14:59Z'), 'day', 'Asia/Kathmandu').key).toBe('2026-10-04');
    expect(bucketOf(Date.parse('2026-10-04T18:15:00Z'), 'day', 'Asia/Kathmandu').key).toBe('2026-10-05');
    const h = bucketOf(Date.parse('2026-10-04T10:47:12Z'), 'hour', 'Asia/Kolkata');
    expect(new Date(h.start).toISOString()).toBe('2026-10-04T10:30:00.000Z');
    expect(h.key).toBe('2026-10-04T16');
    expect(new Date(bucketOf(Date.parse('2026-10-04T10:47:12Z'), 'hour', 'Asia/Kathmandu').start).toISOString()).toBe('2026-10-04T10:15:00.000Z');
  });

  it('America/New_York DST：回拨日 25 个小时桶（重复小时带 @ 偏移后缀、键唯一）、前拨日 23 个；日桶总和 = 总量', () => {
    const mk = (iso: string) => rec({ ts: Date.parse(iso) });
    const fall = mkCtx([mk('2026-11-01T03:00:00Z'), mk('2026-11-01T05:30:00Z'), mk('2026-11-01T06:30:00Z'), mk('2026-11-02T04:59:00Z')]);
    const r = aggregate(fall, { ...base, tz: 'America/New_York', granularity: 'hour' });
    const day = r.timeline.filter((p) => p.key.startsWith('2026-11-01'));
    expect(day.length).toBe(25);
    expect(new Set(r.timeline.map((p) => p.key)).size).toBe(r.timeline.length);
    expect(day.filter((p) => p.key.includes('@')).map((p) => p.key)).toEqual(['2026-11-01T01@-04:00', '2026-11-01T01@-05:00']);
    expect(r.timeline.reduce((a, p) => a + p.total, 0)).toBe(4 * 15);
    // 05:30Z = 01:30 EDT(-04)，06:30Z = 01:30 EST(-05)：两条各落一个重复小时桶
    expect(day.filter((p) => p.key.includes('@')).map((p) => p.requests)).toEqual([1, 1]);
    const spring = mkCtx([mk('2026-03-08T04:00:00Z'), mk('2026-03-09T03:59:00Z')]);
    const rs = aggregate(spring, { ...base, tz: 'America/New_York', granularity: 'hour' });
    expect(rs.timeline.filter((p) => p.key.startsWith('2026-03-08')).length).toBe(23);
    // 日桶：回拨日 start..next 之间 25h
    const days = enumerateBuckets(Date.parse('2026-10-31T12:00:00Z'), Date.parse('2026-11-03T12:00:00Z'), 'day', 'America/New_York');
    const spans = days.slice(0, -1).map((b, i) => (days[i + 1]!.start - b.start) / 3600000);
    expect(spans).toContain(25);
    expect(spans.filter((s) => s !== 25).every((s) => s === 24)).toBe(true);
  });

  it('periodBounds / 今日昨日本周本月（固定 now）：上海、周一/周日起始；与手算一致', () => {
    // now = 2026-11-10T12:00Z = 上海 11-10 20:00（周二）
    const nowTs = Date.parse('2026-11-10T12:00:00Z');
    const mon = periodBounds(nowTs, 'Asia/Shanghai', 'monday');
    const iso = (t: number) => new Date(t).toISOString();
    expect(mon.today.map(iso)).toEqual(['2026-11-09T16:00:00.000Z', '2026-11-10T16:00:00.000Z']);
    expect(mon.yesterday.map(iso)).toEqual(['2026-11-08T16:00:00.000Z', '2026-11-09T16:00:00.000Z']);
    expect(mon.thisWeek.map(iso)).toEqual(['2026-11-08T16:00:00.000Z', '2026-11-15T16:00:00.000Z']); // 周一 11-09 起
    expect(mon.prevWeek.map(iso)).toEqual(['2026-11-01T16:00:00.000Z', '2026-11-08T16:00:00.000Z']);
    expect(mon.thisMonth.map(iso)).toEqual(['2026-10-31T16:00:00.000Z', '2026-11-30T16:00:00.000Z']);
    expect(mon.prevMonth.map(iso)).toEqual(['2026-09-30T16:00:00.000Z', '2026-10-31T16:00:00.000Z']);
    const sun = periodBounds(nowTs, 'Asia/Shanghai', 'sunday');
    expect(sun.thisWeek.map(iso)).toEqual(['2026-11-07T16:00:00.000Z', '2026-11-14T16:00:00.000Z']); // 周日 11-08 起
    // 恰在午夜边界：本地 00:00:00 属于新的一天
    const mid = periodBounds(Date.parse('2026-11-09T16:00:00Z'), 'Asia/Shanghai', 'monday');
    expect(iso(mid.today[0])).toBe('2026-11-09T16:00:00.000Z');
    const beforeMid = periodBounds(Date.parse('2026-11-09T15:59:59Z'), 'Asia/Shanghai', 'monday');
    expect(iso(beforeMid.today[0])).toBe('2026-11-08T16:00:00.000Z');
    // 一月：上月是去年 12 月
    const jan = periodBounds(Date.parse('2027-01-15T12:00:00Z'), 'UTC', 'monday');
    expect(jan.prevMonth.map(iso)).toEqual(['2026-12-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z']);
    // 纽约回拨日：今日 25 小时
    const ny = periodBounds(Date.parse('2026-11-01T12:00:00Z'), 'America/New_York', 'monday');
    expect((ny.today[1] - ny.today[0]) / 3600000).toBe(25);
    const nyS = periodBounds(Date.parse('2026-03-08T12:00:00Z'), 'America/New_York', 'monday');
    expect((nyS.today[1] - nyS.today[0]) / 3600000).toBe(23);
  });

  it('expected.phase2.nowCases：逐项（含总量）与 periodCards 一致', () => {
    const e = loadExpected();
    for (const c of e.phase2.nowCases) {
      const pc = periodCards(ctx, { ...base, tz: c.tz, weekStart: c.weekStart, now: Date.parse(c.nowIso) });
      for (const k of ['today', 'yesterday', 'thisWeek', 'prevWeek', 'thisMonth', 'prevMonth'] as const) {
        expect(localParts(pc[k].from, c.tz).date, `${c.name} ${k} from`).toBe(c[k].from);
        expect(localParts(pc[k].to - 1, c.tz).date, `${c.name} ${k} to(含)`).toBe(c[k].to);
        expect(pc[k].summary.requests, `${c.name} ${k} requests`).toBe(c[k].requests);
        expect(pc[k].summary.fresh, `${c.name} ${k} fresh`).toBe(c[k].fresh);
        expect(pc[k].summary.total, `${c.name} ${k}`).toBe(c[k].total);
      }
    }
  });

  it('昨日为 0 时环比 pct=null（不是 NaN/Infinity）；有值时等于手算', () => {
    const c = mkCtx([rec({ ts: Date.parse('2026-11-10T01:00:00Z') })]); // 今日(UTC) 15，昨日 0
    const pc = periodCards(c, { ...base, tz: 'UTC', now: NOW });
    expect(pc.deltas.today.pct).toBeNull();
    expect(pc.deltas.today.diff).toBe(15);
    const c2 = mkCtx([rec({ ts: Date.parse('2026-11-10T01:00:00Z') }), rec({ ts: Date.parse('2026-11-09T01:00:00Z'), input: 5, cacheWrite: 0, cacheRead: 0, output: 0 })]);
    const p2 = periodCards(c2, { ...base, tz: 'UTC', now: NOW });
    expect(p2.deltas.today.pct).toBeCloseTo((15 - 5) / 5, 12);
  });

  it('resolveRange：7d/30d/90d = 含今天共 N 个本地日；today 一天；thisMonth；custom 含两端', () => {
    for (const [kind, n] of [['today', 1], ['7d', 7], ['30d', 30], ['90d', 90]] as const) {
      const r = aggregate(mkCtx([rec({ ts: NOW })]), { ...base, tz: 'Asia/Shanghai', range: { kind }, granularity: 'day' });
      expect(r.timeline.length, kind).toBe(n);
      expect(r.timeline[r.timeline.length - 1]!.key).toBe('2026-11-10');
    }
    const tm = aggregate(mkCtx([rec({ ts: NOW })]), { ...base, tz: 'Asia/Shanghai', range: { kind: 'thisMonth' }, granularity: 'day' });
    expect(tm.timeline.length).toBe(30);
    expect(tm.timeline[0]!.key).toBe('2026-11-01');
    const cu = aggregate(mkCtx([]), { ...base, range: { kind: 'custom', from: '2026-02-27', to: '2026-03-02' }, granularity: 'day', tz: 'UTC' });
    expect(cu.timeline.map((p) => p.key)).toEqual(['2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02']);
    expect(cu.summary.total).toBe(0);
  });

  it('非法参数 -> QueryError 且带稳定 code（阶段 4 映射 400）', () => {
    const code = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        return e instanceof QueryError ? e.code : 'NOT_QUERYERROR:' + String(e);
      }
      return 'NO_THROW';
    };
    const c = mkCtx([rec({ ts: NOW })]);
    expect(code(() => aggregate(c, { ...base, tz: 'Mars/Olympus' }))).toBe('INVALID_TZ');
    expect(code(() => aggregate(c, { ...base, tz: '' }))).toBe('INVALID_TZ');
    expect(code(() => aggregate(c, { ...base, granularity: 'minute' as never }))).toBe('INVALID_GRANULARITY');
    expect(code(() => aggregate(c, { ...base, basis: 'x' as never }))).toBe('INVALID_BASIS');
    expect(code(() => aggregate(c, { ...base, split: 'x' as never }))).toBe('INVALID_SPLIT');
    expect(code(() => aggregate(c, { ...base, weekStart: 'friday' as never }))).toBe('INVALID_WEEKSTART');
    expect(code(() => aggregate(c, { ...base, range: { kind: 'custom', from: '2026-12-01', to: '2026-11-01' } }))).toBe('INVALID_RANGE');
    expect(code(() => aggregate(c, { ...base, range: { kind: 'custom', from: '2026-02-30', to: '2026-03-01' } }))).toBe('INVALID_RANGE');
    expect(code(() => aggregate(c, { ...base, range: { kind: 'custom', from: 'yesterday', to: '2026-03-01' } }))).toBe('INVALID_RANGE');
    expect(code(() => aggregate(c, { ...base, range: { kind: 'custom' } }))).toBe('INVALID_RANGE');
    expect(code(() => aggregate(c, { ...base, range: { kind: 'forever' as never } }))).toBe('INVALID_RANGE');
    expect(code(() => resolveRange({ kind: 'custom', from: '2026-13-01', to: '2026-13-02' }, NOW, 'UTC'))).toBe('INVALID_RANGE');
    // 桶数上限
    const wide = mkCtx([rec({ ts: Date.parse('2010-01-01T00:00:00Z') }), rec({ ts: Date.parse('2026-01-01T00:00:00Z') })]);
    expect(code(() => aggregate(wide, { ...base, granularity: 'hour', tz: 'UTC' }))).toBe('TOO_MANY_BUCKETS');
    expect(MAX_BUCKETS).toBeGreaterThan(8000);
    expect(aggregate(wide, { ...base, granularity: 'month', tz: 'UTC' }).timeline.length).toBe(193);
  });
});

// ---------------------------------------------------------------------------
describe('一致性与口径（PRD #3 / #6）', () => {
  const projects = (): string[] => ['all', ...ctx.projects.list.map((p) => p.id)];
  it('每个项目 × 四种粒度 × 三个时区：summary.total = Σ曲线 = expected；四种粒度总和相同', () => {
    const e = loadExpected();
    for (const pid of projects()) {
      const ids = pid === 'all' ? ('all' as const) : [pid];
      for (const tz of ['UTC', 'Asia/Shanghai', 'America/New_York', 'Asia/Kolkata']) {
        const sums: number[] = [];
        for (const g of ['hour', 'day', 'week', 'month'] as const) {
          const r = aggregate(ctx, { ...base, projects: ids, tz, granularity: g });
          const s = r.timeline.reduce((a, p) => a + p.total, 0);
          expect(s, `${pid} ${tz} ${g}`).toBe(r.summary.total);
          sums.push(s);
        }
        expect(new Set(sums).size, `${pid} ${tz}`).toBe(1);
        if (pid === 'all') expect(sums[0]).toBe(e.totals.total);
      }
    }
  });

  it('Total − Fresh = cacheRead（精确）：汇总 / 曲线 / 周期卡 / 分组 / 各 split', () => {
    const e = loadExpected();
    for (const sc of [true, false]) {
      const t = aggregate(ctx, { ...base, includeSidechain: sc, basis: 'total' });
      const f = aggregate(ctx, { ...base, includeSidechain: sc, basis: 'fresh' });
      expect(t.summary.value - f.summary.value).toBe(t.summary.cacheRead);
      expect(t.summary.total - t.summary.fresh).toBe(t.summary.cacheRead);
      expect(t.timeline.reduce((a, p) => a + p.value - p.fresh, 0)).toBe(t.summary.cacheRead);
      if (sc) expect(t.summary.cacheRead).toBe(e.totals.cacheRead);
      else expect(t.summary.cacheRead).toBe(e.totals.cacheRead - e.sidechain.cacheRead);
    }
    const pcT = periodCards(ctx, { ...base, basis: 'total', tz: 'UTC', now: Date.parse('2026-10-31T00:00:00Z') });
    const pcF = periodCards(ctx, { ...base, basis: 'fresh', tz: 'UTC', now: Date.parse('2026-10-31T00:00:00Z') });
    for (const k of ['today', 'yesterday', 'thisWeek', 'thisMonth'] as const) expect(pcT[k].summary.value - pcF[k].summary.value).toBe(pcT[k].summary.cacheRead);
    for (const s of ['tokenType', 'model', 'project', 'none'] as const) {
      const t = aggregate(ctx, { ...base, split: s, basis: 'total' }).series.reduce((a, x) => a + x.total, 0);
      const f = aggregate(ctx, { ...base, split: s, basis: 'fresh' }).series.reduce((a, x) => a + x.total, 0);
      expect(t - f, s).toBe(e.totals.cacheRead);
    }
    // cacheHitRate / outputInputRatio（文档化口径）
    const sm = aggregate(ctx, base).summary;
    expect(sm.cacheHitRate).toBeCloseTo(e.totals.cacheRead / (e.totals.input + e.totals.cacheWrite + e.totals.cacheRead), 12);
    expect(sm.outputInputRatio).toBeCloseTo(e.totals.output / (e.totals.input + e.totals.cacheWrite + e.totals.cacheRead), 12);
  });

  it('拆分系列之和 = 总量（逐桶）：tokenType/model/project × Total/Fresh；model 系列名为原始名、本地标记', () => {
    for (const split of ['tokenType', 'model', 'project'] as const) {
      for (const basis of ['total', 'fresh'] as const) {
        const r = aggregate(ctx, { ...base, split, basis, granularity: 'week' });
        for (let i = 0; i < r.timeline.length; i++) expect(r.series.reduce((a, s) => a + s.values[i]!, 0)).toBe(r.timeline[i]!.value);
        if (split === 'tokenType') expect(r.series.map((s) => s.key)).toEqual(basis === 'total' ? ['input', 'cacheWrite', 'cacheRead', 'output'] : ['input', 'cacheWrite', 'output']);
      }
    }
    const m = aggregate(ctx, { ...base, split: 'model' }).series;
    expect(m.find((s) => s.key === 'qwen/qwen3-coder-next')).toMatchObject({ isLocal: true, family: 'local' });
    expect(m.find((s) => s.key.endsWith('.gguf'))).toMatchObject({ isLocal: true, label: 'Qwen3-35B-A3B' });
    const pr = aggregate(ctx, { ...base, split: 'project' }).series;
    expect(pr.find((s) => s.key === 'C--Users-----Work-demo')!.label).toBe('demo');
    expect(pr.some((s) => s.key === 'scratch')).toBe(true);
    expect(pr.filter((s) => s.key.includes('scratch-workspaces'))).toHaveLength(0);
  });

  it('子代理开关：includeSidechain=false 少的恰好是 expected.sidechain；主线+子代理 = 总量', () => {
    const e = loadExpected();
    const all = aggregate(ctx, base).summary.total;
    const noSide = aggregate(ctx, { ...base, includeSidechain: false }).summary.total;
    expect(all - noSide).toBe(e.sidechain.total);
    const sp = sidechainSplit(ctx, { ...base, includeSidechain: false });
    expect(sp.sidechain.total).toBe(e.sidechain.total);
    expect(sp.main.total + sp.sidechain.total).toBe(all);
    expect(sp.sidechain.requests).toBe(e.sidechain.records);
  });

  it('hourWeekGrid 168 格之和 = 总量，且 expected 中已知时刻落在正确格子（独立用 Intl 复算）', () => {
    for (const tz of ['Asia/Shanghai', 'America/New_York']) {
      const grid = hourWeekGrid(ctx, { ...base, tz });
      expect(grid.length).toBe(7);
      expect(grid.every((row) => row.length === 24)).toBe(true);
      expect(grid.flat().reduce((a, b) => a + b, 0)).toBe(loadExpected().totals.total);
      const want = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
      const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', hour: '2-digit', weekday: 'short' });
      for (const r of records) {
        const o: Record<string, string> = {};
        for (const p of f.formatToParts(new Date(r.ts))) o[p.type] = p.value;
        want[['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(o.weekday!)]![Number(o.hour) % 24]! += r.input + r.cacheWrite + r.cacheRead + r.output;
      }
      expect(grid).toEqual(want);
    }
  });

  it('会话分组之和 = 总量；聚合函数是纯函数：不修改输入记录、重复调用结果一致、不读系统时钟', () => {
    const frozen = JSON.stringify(records);
    const a = JSON.stringify(aggregate(ctx, { ...base, split: 'model', granularity: 'hour' }));
    const b = JSON.stringify(aggregate(ctx, { ...base, split: 'model', granularity: 'hour' }));
    expect(a).toBe(b);
    expect(JSON.stringify(records)).toBe(frozen);
    expect(groupBySession(ctx, base).reduce((x, r) => x + r.total, 0)).toBe(loadExpected().totals.total);
    const src = fs.readFileSync(path.join(path.dirname(FIXTURE_ROOT), '..', '..', 'src', 'server', 'core', 'aggregate.ts'), 'utf8') + fs.readFileSync(path.join(path.dirname(FIXTURE_ROOT), '..', '..', 'src', 'server', 'core', 'time.ts'), 'utf8');
    expect(src).not.toMatch(/Date\.now\(|new Date\(\)/);
  });

  it('空数据 / 全被过滤：不抛错，null 指标，空时间线', () => {
    const r = aggregate(mkCtx([]), base);
    expect(r.timeline).toEqual([]);
    expect(r.summary).toMatchObject({ total: 0, requests: 0, cacheHitRate: null, outputInputRatio: null, avgPerRequest: null, avgPerSession: null });
    expect(groupByModel(mkCtx([]), base)).toEqual([]);
    const z = mkCtx([rec({ ts: NOW, input: 0, cacheWrite: 0, cacheRead: 0, output: 0 })]);
    expect(groupByModel(z, base)[0]!.share).toBe(0); // 总量 0 时占比为 0，不是 NaN
    expect(aggregate(z, base).summary.cacheHitRate).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('verify 脚本的独立性', () => {
  it('naive.ts 的 import 只来自 node: 内置模块，且不含对 src/ 的任何引用', () => {
    const root = path.join(path.dirname(FIXTURE_ROOT), '..', '..');
    const text = fs.readFileSync(path.join(root, 'scripts', 'verify', 'naive.ts'), 'utf8');
    const imports = [...text.matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]!);
    expect(imports.length).toBeGreaterThan(0);
    for (const i of imports) expect(i.startsWith('node:'), i).toBe(true);
    expect(text).not.toMatch(/from\s+['"][^'"]*src\//);
    expect(text).not.toMatch(/require\(/);
    expect(text).not.toMatch(/import\(/);
  });
});

import { describe, expect, it } from 'vitest';
import {
  assertValidTimeZone,
  bucketKey,
  bucketOf,
  enumerateBuckets,
  localDateKey,
  localParts,
  periodBounds,
  QueryError,
  resolveRange,
  startOfMonth,
  startOfToday,
  startOfWeek,
  startOfYesterday,
  tzOffsetMs,
  zonedToUtc,
} from '../src/server/core/time.ts';
import { loadExpected } from './helpers.ts';
import type { Expected } from './helpers.ts';

const iso = (s: string): number => Date.parse(s);
const H = 3_600_000;

describe('time：与独立实现（Intl 逐字段）交叉核对', () => {
  const zones = ['UTC', 'Asia/Shanghai', 'America/New_York', 'Asia/Kolkata', 'Australia/Lord_Howe', 'Asia/Kathmandu', 'America/Sao_Paulo', 'Europe/London', 'Pacific/Auckland', 'America/St_Johns'];

  it('2020–2030 随机时刻：本地日期 / 小时 / 星期 与 Intl 完全一致（含 DST 与半小时 / 45 分偏移）', () => {
    let seed = 12345;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const lo = Date.UTC(2020, 0, 1);
    const hi = Date.UTC(2030, 0, 1);
    for (const tz of zones) {
      const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', weekday: 'short' });
      const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      for (let i = 0; i < 1500; i++) {
        const ts = Math.floor(lo + rnd() * (hi - lo));
        const parts = Object.fromEntries(f.formatToParts(new Date(ts)).map((p) => [p.type, p.value]));
        const p = localParts(ts, tz);
        const want = `${parts.year}-${parts.month}-${parts.day}`;
        expect(p.date, `${tz} ${new Date(ts).toISOString()}`).toBe(want);
        expect(p.h, `${tz} ${new Date(ts).toISOString()}`).toBe(Number(parts.hour) % 24);
        expect(wd[p.weekday], `${tz} ${new Date(ts).toISOString()}`).toBe(parts.weekday);
      }
    }
  });

  it('DST 切换瞬间前后 1 秒：本地日期正确（Intl 对照）', () => {
    const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
    for (const edge of ['2026-03-08T07:00:00Z', '2026-11-01T06:00:00Z', '2026-03-08T05:00:00Z', '2026-11-01T04:00:00Z']) {
      for (const d of [-1000, 0, 1000]) {
        const ts = iso(edge) + d;
        expect(localDateKey(ts, 'America/New_York')).toBe(f.format(new Date(ts)));
      }
    }
    expect(tzOffsetMs(iso('2026-03-08T06:59:59Z'), 'America/New_York')).toBe(-5 * H);
    expect(tzOffsetMs(iso('2026-03-08T07:00:00Z'), 'America/New_York')).toBe(-4 * H);
    expect(tzOffsetMs(iso('2026-11-01T05:59:59Z'), 'America/New_York')).toBe(-4 * H);
    expect(tzOffsetMs(iso('2026-11-01T06:00:00Z'), 'America/New_York')).toBe(-5 * H);
  });

  it('fixture 的 16 个时间探针在 UTC / 上海 / 纽约 / 加尔各答 下的本地日期等于手工推算值', () => {
    const e: Expected = loadExpected();
    for (const p of e.timeProbes as Expected[]) {
      for (const [tz, want] of Object.entries<string>(p.localDate)) expect(localDateKey(p.ts, tz), `${p.id} @ ${tz}`).toBe(want);
    }
  });
});

describe('time：桶', () => {
  it('Asia/Shanghai 日界：UTC 15:59:59 与 16:00:00 落在相邻两个本地日', () => {
    expect(bucketKey(iso('2026-10-10T15:59:59Z'), 'day', 'Asia/Shanghai')).toBe('2026-10-10');
    expect(bucketKey(iso('2026-10-10T16:00:00Z'), 'day', 'Asia/Shanghai')).toBe('2026-10-11');
    expect(bucketOf(iso('2026-10-10T16:00:00Z'), 'day', 'Asia/Shanghai').start).toBe(iso('2026-10-10T16:00:00Z'));
  });

  it('周界：周一起始 vs 周日起始（2026-10-11 是周日）', () => {
    const sunEnd = iso('2026-10-11T15:59:59Z'); // 上海周日 23:59:59
    const monStart = iso('2026-10-11T16:00:00Z'); // 上海周一 00:00:00
    expect(bucketKey(sunEnd, 'week', 'Asia/Shanghai', 'monday')).toBe('2026-10-05');
    expect(bucketKey(monStart, 'week', 'Asia/Shanghai', 'monday')).toBe('2026-10-12');
    expect(bucketKey(sunEnd, 'week', 'Asia/Shanghai', 'sunday')).toBe('2026-10-11');
    expect(bucketKey(monStart, 'week', 'Asia/Shanghai', 'sunday')).toBe('2026-10-11');
    expect(bucketKey(iso('2026-10-17T16:00:00Z'), 'week', 'Asia/Shanghai', 'sunday')).toBe('2026-10-18');
  });

  it('月界：上海 9/30 23:59:59 → 10/1 00:00:00；UTC 与上海的月份可以不同', () => {
    expect(bucketKey(iso('2026-09-30T15:59:59Z'), 'month', 'Asia/Shanghai')).toBe('2026-09');
    expect(bucketKey(iso('2026-09-30T16:00:00Z'), 'month', 'Asia/Shanghai')).toBe('2026-10');
    expect(bucketKey(iso('2026-09-30T16:00:00Z'), 'month', 'UTC')).toBe('2026-09');
    expect(bucketKey(iso('2026-10-31T23:59:59Z'), 'month', 'UTC')).toBe('2026-10');
    expect(bucketKey(iso('2026-11-01T00:00:00Z'), 'month', 'UTC')).toBe('2026-11');
  });

  it('非整小时偏移（Asia/Kolkata +5:30）：小时桶起点在 :30（UTC），本地日界在 18:30Z', () => {
    const b = bucketOf(iso('2026-10-10T18:29:59Z'), 'hour', 'Asia/Kolkata');
    expect(b.key).toBe('2026-10-10T23');
    expect(b.start).toBe(iso('2026-10-10T17:30:00Z'));
    expect(bucketKey(iso('2026-10-10T18:30:00Z'), 'hour', 'Asia/Kolkata')).toBe('2026-10-11T00');
    expect(bucketKey(iso('2026-10-10T18:29:59Z'), 'day', 'Asia/Kolkata')).toBe('2026-10-10');
    expect(bucketKey(iso('2026-10-10T18:30:00Z'), 'day', 'Asia/Kolkata')).toBe('2026-10-11');
  });

  it('美东 DST 回拨日（2026-11-01）：重复的 01 点是两个不同的小时桶，键不同；一天有 25 个小时桶', () => {
    const a = bucketOf(iso('2026-11-01T05:30:00Z'), 'hour', 'America/New_York'); // 01:30 EDT
    const b = bucketOf(iso('2026-11-01T06:30:00Z'), 'hour', 'America/New_York'); // 01:30 EST
    expect(a.start).not.toBe(b.start);
    expect(a.key).not.toBe(b.key);
    expect(a.key.startsWith('2026-11-01T01')).toBe(true);
    expect(b.key.startsWith('2026-11-01T01')).toBe(true);
    const dayStart = zonedToUtc(2026, 11, 1, 0, 0, 0, 'America/New_York');
    const dayEnd = zonedToUtc(2026, 11, 2, 0, 0, 0, 'America/New_York');
    expect((dayEnd - dayStart) / H).toBe(25);
    const hours = enumerateBuckets(dayStart, dayEnd, 'hour', 'America/New_York');
    expect(hours).toHaveLength(25);
    expect(new Set(hours.map((h) => h.key)).size).toBe(25);
    // 非重复小时不带偏移后缀
    expect(hours[0]!.key).toBe('2026-11-01T00');
  });

  it('美东 DST 前拨日（2026-03-08）：一天只有 23 个小时桶；日桶仍是连续的一天', () => {
    const dayStart = zonedToUtc(2026, 3, 8, 0, 0, 0, 'America/New_York');
    const dayEnd = zonedToUtc(2026, 3, 9, 0, 0, 0, 'America/New_York');
    expect((dayEnd - dayStart) / H).toBe(23);
    expect(enumerateBuckets(dayStart, dayEnd, 'hour', 'America/New_York')).toHaveLength(23);
    const days = enumerateBuckets(iso('2026-03-07T12:00:00Z'), iso('2026-03-10T12:00:00Z'), 'day', 'America/New_York');
    expect(days.map((d) => d.key)).toEqual(['2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10']);
  });

  it('enumerateBuckets：空桶补零（连续无缺口）、跨年、周 / 月起点', () => {
    const days = enumerateBuckets(iso('2026-12-30T00:00:00Z'), iso('2027-01-03T00:00:00Z'), 'day', 'UTC');
    expect(days.map((d) => d.key)).toEqual(['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02']);
    const months = enumerateBuckets(iso('2026-11-15T00:00:00Z'), iso('2027-02-02T00:00:00Z'), 'month', 'UTC');
    expect(months.map((d) => d.key)).toEqual(['2026-11', '2026-12', '2027-01', '2027-02']);
    const weeks = enumerateBuckets(iso('2026-10-14T00:00:00Z'), iso('2026-10-26T00:00:00Z'), 'week', 'UTC', 'monday');
    expect(weeks.map((d) => d.key)).toEqual(['2026-10-12', '2026-10-19']) // 10-26 00:00Z 恰为终点（不含）;
    const wk2 = enumerateBuckets(iso('2026-10-14T00:00:00Z'), iso('2026-10-26T00:00:00Z'), 'week', 'UTC', 'sunday');
    expect(wk2.map((d) => d.key)).toEqual(['2026-10-11', '2026-10-18', '2026-10-25']);
    // 起点严格递增且连续
    for (let i = 1; i < days.length; i++) expect(days[i]!.start - days[i - 1]!.start).toBe(86_400_000);
  });

  it('桶数量上限：超大范围的小时粒度抛 QueryError', () => {
    expect(() => enumerateBuckets(iso('2000-01-01T00:00:00Z'), iso('2026-01-01T00:00:00Z'), 'hour', 'UTC')).toThrow(QueryError);
  });
});

describe('time：今日 / 昨日 / 本周 / 本月 与范围', () => {
  const tz = 'Asia/Shanghai';
  const now = iso('2026-10-20T12:00:00Z'); // 上海周二 20:00

  it('start-of-*：固定 now 下', () => {
    expect(startOfToday(now, tz)).toBe(iso('2026-10-19T16:00:00Z'));
    expect(startOfYesterday(now, tz)).toBe(iso('2026-10-18T16:00:00Z'));
    expect(startOfWeek(now, tz, 'monday')).toBe(iso('2026-10-18T16:00:00Z')); // 周一 10-19
    expect(startOfWeek(now, tz, 'sunday')).toBe(iso('2026-10-17T16:00:00Z')); // 周日 10-18
    expect(startOfMonth(now, tz)).toBe(iso('2026-09-30T16:00:00Z'));
  });

  it('periodBounds：各期边界连续；周日 / 周一起始不同', () => {
    const m = periodBounds(now, tz, 'monday');
    expect(m.today[1]).toBe(m.today[0] + 86_400_000);
    expect(m.yesterday[1]).toBe(m.today[0]);
    expect(m.thisWeek[1] - m.thisWeek[0]).toBe(7 * 86_400_000);
    expect(m.prevWeek[1]).toBe(m.thisWeek[0]);
    expect(m.prevMonth[1]).toBe(m.thisMonth[0]);
    expect(m.thisMonth[1]).toBe(iso('2026-10-31T16:00:00Z'));
    const s = periodBounds(now, tz, 'sunday');
    expect(s.thisWeek[0]).toBe(m.thisWeek[0] - 86_400_000);
  });

  it('周日当天的 now：周一起始的"本周"从 6 天前开始', () => {
    const sunday = iso('2026-10-11T04:00:00Z'); // 上海周日 12:00
    expect(startOfWeek(sunday, tz, 'monday')).toBe(iso('2026-10-04T16:00:00Z')); // 10-05
    expect(startOfWeek(sunday, tz, 'sunday')).toBe(iso('2026-10-10T16:00:00Z')); // 10-11
  });

  it('跨 DST 的"本月"：美东 11 月起点是 EDT 的 11-01 00:00（04:00Z）', () => {
    const b = periodBounds(iso('2026-11-15T12:00:00Z'), 'America/New_York', 'sunday');
    expect(b.thisMonth[0]).toBe(iso('2026-11-01T04:00:00Z'));
    expect(b.prevMonth[0]).toBe(iso('2026-10-01T04:00:00Z'));
    expect(b.thisMonth[1]).toBe(iso('2026-12-01T05:00:00Z')); // 12 月已是 EST
  });

  it('resolveRange：today / 7d / 30d / 90d / thisMonth / all / custom', () => {
    const t0 = startOfToday(now, tz);
    const end = t0 + 86_400_000;
    expect(resolveRange({ kind: 'today' }, now, tz)).toEqual({ fromTs: t0, toTs: end });
    expect(resolveRange({ kind: '7d' }, now, tz)).toEqual({ fromTs: iso('2026-10-13T16:00:00Z'), toTs: end });
    expect(resolveRange({ kind: '30d' }, now, tz).fromTs).toBe(iso('2026-09-20T16:00:00Z'));
    expect(resolveRange({ kind: '90d' }, now, tz).fromTs).toBe(iso('2026-07-22T16:00:00Z'));
    expect(resolveRange({ kind: 'thisMonth' }, now, tz)).toEqual({ fromTs: iso('2026-09-30T16:00:00Z'), toTs: iso('2026-10-31T16:00:00Z') });
    expect(resolveRange({ kind: 'all' }, now, tz)).toEqual({ fromTs: null, toTs: null });
    expect(resolveRange({ kind: 'custom', from: '2026-10-10', to: '2026-10-11' }, now, tz)).toEqual({ fromTs: iso('2026-10-09T16:00:00Z'), toTs: iso('2026-10-11T16:00:00Z') });
    expect(resolveRange({ kind: 'custom', from: '2026-10-10', to: '2026-10-10' }, now, tz)).toEqual({ fromTs: iso('2026-10-09T16:00:00Z'), toTs: iso('2026-10-10T16:00:00Z') });
  });

  it('非法输入抛 QueryError（不是 TypeError / 500）', () => {
    expect(() => resolveRange({ kind: 'custom', from: '2026-10-12', to: '2026-10-11' }, now, tz)).toThrow(/不能晚于/);
    expect(() => resolveRange({ kind: 'custom', from: '2026-13-01', to: '2026-13-02' }, now, tz)).toThrow(QueryError);
    expect(() => resolveRange({ kind: 'custom', from: '2026-02-30', to: '2026-03-01' }, now, tz)).toThrow(QueryError);
    expect(() => resolveRange({ kind: 'custom', from: 'abc', to: '2026-03-01' }, now, tz)).toThrow(QueryError);
    expect(() => resolveRange({ kind: 'custom' }, now, tz)).toThrow(QueryError);
    expect(() => resolveRange({ kind: 'nope' as 'all' }, now, tz)).toThrow(QueryError);
    expect(() => assertValidTimeZone('Mars/Olympus')).toThrow(QueryError);
    expect(() => assertValidTimeZone('')).toThrow(QueryError);
    expect(() => bucketKey(0, 'minute' as 'day', 'UTC')).toThrow(QueryError);
    try {
      assertValidTimeZone('Mars/Olympus');
    } catch (e) {
      expect((e as QueryError).code).toBe('INVALID_TZ');
    }
  });
});

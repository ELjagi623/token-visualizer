import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { billingCycle, daysFromCivil, periodBounds, resolveRange } from '../src/server/core/time.ts';
import { startApp, getJson, putJson } from './apiHelpers.ts';
import type { TestApp } from './apiHelpers.ts';

const iso = (s: string): number => Date.parse(s);
const d = (y: number, m: number, day: number): number => daysFromCivil(y, m, day);

describe('订阅周期（续费日）：时间边界', () => {
  const tz = 'Asia/Shanghai';
  const now = iso('2026-10-20T12:00:00Z'); // 上海 10-20 20:00

  it('今天晚于续费日：周期 = 本月续费日 → 下月续费日；上一周期紧邻其前', () => {
    const b = periodBounds(now, tz, 'monday', 15);
    expect(b.thisMonth).toEqual([iso('2026-10-14T16:00:00Z'), iso('2026-11-14T16:00:00Z')]);
    expect(b.prevMonth).toEqual([iso('2026-09-14T16:00:00Z'), iso('2026-10-14T16:00:00Z')]);
    expect(resolveRange({ kind: 'thisMonth' }, now, tz, 15)).toEqual({ fromTs: iso('2026-10-14T16:00:00Z'), toTs: iso('2026-11-14T16:00:00Z') });
  });

  it('今天早于续费日：周期从上个月的续费日开始；恰好是续费日当天则当天起算', () => {
    expect(periodBounds(now, tz, 'monday', 25).thisMonth).toEqual([iso('2026-09-24T16:00:00Z'), iso('2026-10-24T16:00:00Z')]);
    expect(periodBounds(now, tz, 'monday', 20).thisMonth).toEqual([iso('2026-10-19T16:00:00Z'), iso('2026-11-19T16:00:00Z')]);
    expect(periodBounds(now, tz, 'monday', 21).thisMonth[0]).toBe(iso('2026-09-20T16:00:00Z'));
  });

  it('未设置（null / 缺省）与自然月完全一致', () => {
    expect(periodBounds(now, tz, 'monday', null)).toEqual(periodBounds(now, tz, 'monday'));
    expect(periodBounds(now, tz, 'monday').thisMonth).toEqual([iso('2026-09-30T16:00:00Z'), iso('2026-10-31T16:00:00Z')]);
    expect(resolveRange({ kind: 'thisMonth' }, now, tz)).toEqual(resolveRange({ kind: 'thisMonth' }, now, tz, null));
  });

  it('续费日 31：短月落在月底最后一天；闰年；跨年', () => {
    const c = billingCycle(d(2026, 3, 5), 31);
    expect(c).toEqual({ startDn: d(2026, 2, 28), endDn: d(2026, 3, 31) });
    expect(billingCycle(c.startDn - 1, 31)).toEqual({ startDn: d(2026, 1, 31), endDn: d(2026, 2, 28) });
    expect(billingCycle(d(2026, 4, 30), 31)).toEqual({ startDn: d(2026, 4, 30), endDn: d(2026, 5, 31) });
    expect(billingCycle(d(2028, 3, 1), 30)).toEqual({ startDn: d(2028, 2, 29), endDn: d(2028, 3, 30) });
    expect(billingCycle(d(2027, 1, 10), 15)).toEqual({ startDn: d(2026, 12, 15), endDn: d(2027, 1, 15) });
  });

  it('任意续费日：相邻周期首尾相接、长度 28–31 天', () => {
    for (let day = 1; day <= 31; day++) {
      let end = billingCycle(d(2026, 1, 1), day).endDn;
      for (let i = 0; i < 40; i++) {
        const next = billingCycle(end, day);
        expect(next.startDn).toBe(end);
        expect(next.endDn - next.startDn).toBeGreaterThanOrEqual(28);
        expect(next.endDn - next.startDn).toBeLessThanOrEqual(31);
        end = next.endDn;
      }
    }
  });
});

describe('订阅周期（续费日）：API', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp();
    await putJson(t.base, '/api/settings', { subscription: { plan: 'custom', monthlyFeeUsd: 31 } });
  });
  afterAll(async () => {
    await t.close();
  });

  it('设置校验：1–31 整数或 null；非法值整体不生效', async () => {
    for (const bad of [0, 32, 1.5, '15', -1]) {
      const r = await putJson(t.base, '/api/settings', { subscription: { billingDay: bad } });
      expect(r.status).toBe(400);
    }
    expect((await getJson(t.base, '/api/settings')).body.settings.subscription.billingDay).toBeNull();
    expect((await putJson(t.base, '/api/settings', { subscription: { billingDay: 15 } })).status).toBe(200);
    expect((await getJson(t.base, '/api/settings')).body.settings.subscription.billingDay).toBe(15);
    expect((await putJson(t.base, '/api/settings', { subscription: { billingDay: null } })).status).toBe(200);
    expect((await getJson(t.base, '/api/settings')).body.settings.subscription.billingDay).toBeNull();
  });

  it('回本：设置续费日后已过天数 / 周期天数 / 起止日期按订阅周期计算；清除后恢复自然月', async () => {
    const base = (await getJson(t.base, '/api/subscription/payback')).body;
    expect(base.billingDay).toBeNull();
    expect(base.cycleStart.endsWith('-01')).toBe(true);

    await putJson(t.base, '/api/settings', { subscription: { billingDay: 15 } });
    const pb = (await getJson(t.base, '/api/subscription/payback')).body;
    expect(pb.billingDay).toBe(15);
    expect(pb.cycleStart.endsWith('-15')).toBe(true);
    expect(pb.cycleEnd.endsWith('-14')).toBe(true);
    const days = (Date.parse(`${pb.cycleEnd}T00:00:00Z`) - Date.parse(`${pb.cycleStart}T00:00:00Z`)) / 86_400_000 + 1;
    expect(pb.daysInMonth).toBe(days);
    expect(pb.elapsedDays).toBeGreaterThanOrEqual(1);
    expect(pb.elapsedDays).toBeLessThanOrEqual(pb.daysInMonth);
    expect(pb.proratedFeeUsd).toBeCloseTo((31 * pb.elapsedDays) / pb.daysInMonth, 5);

    await putJson(t.base, '/api/settings', { subscription: { billingDay: null } });
    const back = (await getJson(t.base, '/api/subscription/payback')).body;
    expect(back.billingDay).toBeNull();
    expect(back.elapsedDays).toBe(base.elapsedDays);
    expect(back.daysInMonth).toBe(base.daysInMonth);
  });

  it('周期卡：设置续费日后 summary.periods.thisMonth 的起止是订阅周期；续费日不需要月费也生效', async () => {
    await putJson(t.base, '/api/settings', { subscription: { plan: null, monthlyFeeUsd: null, billingDay: 15 } });
    const body = (await getJson(t.base, '/api/summary')).body;
    const tm = body.periods.thisMonth;
    const pm = body.periods.prevMonth;
    expect(pm.to).toBe(tm.from); // 上一周期紧邻本周期
    const dayOf = (ts: number): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', day: '2-digit' }).format(ts); // 测试应用固定为上海时区
    expect(dayOf(tm.from)).toBe('15');
    expect(dayOf(tm.to)).toBe('15');
    expect(tm.to).toBeGreaterThan(tm.from);
  });
});

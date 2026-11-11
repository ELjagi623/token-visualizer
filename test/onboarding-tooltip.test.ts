import { describe, expect, it } from 'vitest';
import { applyPatch, defaultSettings, sanitizeStored, SettingsError } from '../src/server/settings.ts';
import { tooltipPosition } from '../web/src/charts/tooltip.ts';
import { hashFor, parseHash } from '../web/src/state/routeCore.ts';

describe('首次引导：onboarded 设置项', () => {
  it('默认 false；可置 true；非布尔值被拒绝；未知键仍被拒绝', () => {
    const d = defaultSettings();
    expect(d.onboarded).toBe(false);
    expect(applyPatch(d, { onboarded: true }).onboarded).toBe(true);
    expect(() => applyPatch(d, { onboarded: 'yes' })).toThrow(SettingsError);
    expect(() => applyPatch(d, { onboarding: true })).toThrow(SettingsError);
  });

  it('老设置文件（无 onboarded 字段）：已选档位或填过月费 → 视为已引导；全空 → 仍需引导', () => {
    const old = (subscription: object) => sanitizeStored({ schema: 1, settings: { theme: 'dark', subscription } }).settings.onboarded;
    expect(old({ plan: 'pro' })).toBe(true);
    expect(old({ monthlyFeeUsd: 20 })).toBe(true);
    expect(old({ billingDay: 5 })).toBe(false);
    expect(sanitizeStored({ schema: 1, settings: { theme: 'dark' } }).settings.onboarded).toBe(false);
  });

  it('已显式存了 onboarded:false 时不被兼容逻辑覆盖', () => {
    const r = sanitizeStored({ schema: 1, settings: { onboarded: false, subscription: { plan: 'pro' } } });
    expect(r.settings.onboarded).toBe(false);
  });
});

describe('图表悬浮提示位置', () => {
  const view: [number, number] = [600, 300];
  const size: [number, number] = [200, 120];

  it('光标在左半区 → 放右侧；在右半区 → 放左侧', () => {
    const [xl] = tooltipPosition([100, 150], size, view);
    expect(xl).toBeGreaterThan(100);
    const [xr] = tooltipPosition([500, 150], size, view);
    expect(xr + size[0]).toBeLessThan(500);
  });

  it('始终夹在图表内', () => {
    for (const p of [[0, 0], [600, 300], [300, 0], [300, 300], [590, 10]] as Array<[number, number]>) {
      const [x, y] = tooltipPosition(p, size, view);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x + size[0]).toBeLessThanOrEqual(view[0]);
      expect(y + size[1]).toBeLessThanOrEqual(view[1]);
    }
  });
});

describe('设置页点项目 → 总览', () => {
  it('hashFor 带 page 时换页并保留项目 / 筛选', () => {
    const route = parseHash('#/settings?project=foo&range=7d');
    const h = hashFor(route, { project: 'bar', rest: [], page: 'overview' });
    expect(h).toBe('#/overview?project=bar&range=7d');
  });
});

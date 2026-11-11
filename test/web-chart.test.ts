import { describe, expect, it } from 'vitest';
import { buildTimeChart, bucketLabel } from '../web/src/charts/timeChart.ts';
import type { TimeChartInput, TimePoint } from '../web/src/charts/timeChart.ts';
import { withAlpha } from '../web/src/charts/colors.ts';
import type { ChartColors } from '../web/src/charts/colors.ts';
import { durationParts, formatDuration, localDate, localHour, weekdayOfDate } from '../web/src/lib/format.ts';
import { filterQuery } from '../web/src/lib/query.ts';
import { buildHash, parseHash } from '../web/src/state/routeCore.ts';
import type { Route } from '../web/src/state/routeCore.ts';

const colors: ChartColors = {
  accent: '#10B981', accentText: '#047857', blue: '#3B82F6', amber: '#F59E0B', pink: '#EC4899', violet: '#8B5CF6', cyan: '#06B6D4',
  text: '#111', text2: '#555', muted: '#666', grid: '#ddd', card: '#fff', line: '#eee', track: '#eee', seg: '#eee',
  palette: ['#10B981', '#3B82F6', '#F59E0B', '#EC4899', '#8B5CF6', '#06B6D4'],
  type: { input: '#3B82F6', cacheWrite: '#F59E0B', cacheRead: '#10B981', output: '#8B5CF6' },
};

function pt(key: string, input: number, cw: number, cr: number, out: number, requests = 1): TimePoint {
  const total = input + cw + cr + out;
  return { key, start: Date.parse(key), value: total, total, fresh: total - cr, requests, input, cacheWrite: cw, cacheRead: cr, output: out };
}

const points = [pt('2026-10-01', 1, 2, 3, 4), pt('2026-10-02', 10, 20, 30, 40), pt('2026-10-03', 0, 0, 0, 0)];
const text = {
  total: '总', types: { input: '输入', cacheWrite: '写', cacheRead: '读', output: '出' }, weekday: (d: number) => `W${d}`, peak: (v: string, d: string) => `峰 ${v} ${d}`,
  requestsSum: (n: number) => `${n} 次`, localSuffix: '(本地)',
};
const base: TimeChartInput = { points, series: [{ key: 'total', label: 'Total', values: points.map((p) => p.value), total: 110 }], split: 'none', kind: 'area', gran: 'day', hidden: new Set(), basis: 'total', colors, text };

describe('时间曲线选项构造', () => {
  it('总量序列：各点之和 = 总量；峰值 = 最大点；标签 MM/DD', () => {
    const r = buildTimeChart(base);
    expect(r.totals).toEqual([10, 100, 0]);
    expect(r.peakIndex).toBe(1);
    expect(r.peakValue).toBe(100);
    expect(r.xLabels).toEqual(['10/01', '10/02', '10/03']);
    expect(r.peakLabel).toBe('峰 100 10/02');
  });

  it('堆叠：隐藏一个系列后其余系列照常，峰值按可见系列重算', () => {
    const series = [
      { key: 'input', label: 'in', values: [1, 10, 0], total: 11 },
      { key: 'cacheRead', label: 'cr', values: [3, 30, 0], total: 33 },
    ];
    const all = buildTimeChart({ ...base, split: 'tokenType', series });
    expect(all.totals).toEqual([4, 40, 0]);
    expect(all.legend.map((l) => l.color)).toEqual([colors.type.input, colors.type.cacheRead]);
    const hid = buildTimeChart({ ...base, split: 'tokenType', series, hidden: new Set(['cacheRead']) });
    expect(hid.totals).toEqual([1, 10, 0]);
    expect(hid.legend.find((l) => l.key === 'cacheRead')!.hidden).toBe(true);
    expect(((hid.option.series as unknown[]) ?? []).length).toBe(1);
    const none = buildTimeChart({ ...base, split: 'tokenType', series, hidden: new Set(['input', 'cacheRead']) });
    expect(none.peakIndex).toBe(-1);
  });

  it('模型拆分：本地模型标记；全零数据不产生峰值', () => {
    const r = buildTimeChart({ ...base, split: 'model', series: [{ key: 'm', label: 'Qwen', values: [1, 2, 3], total: 6, isLocal: true }] });
    expect(r.legend[0]!.label).toBe('Qwen(本地)');
    const z = buildTimeChart({ ...base, points: points.map((p) => ({ ...p, value: 0 })), series: [{ key: 'total', label: 'T', values: [0, 0, 0], total: 0 }] });
    expect(z.peakIndex).toBe(-1);
    expect(z.peakLabel).toBe('');
  });

  it('桶标签：小时 / 周 / 月', () => {
    expect(bucketLabel('2026-10-01T08', 'hour', false)).toBe('08:00');
    expect(bucketLabel('2026-10-01T08', 'hour', true)).toBe('10/01 08:00');
    expect(bucketLabel('2026-10-05', 'week')).toBe('10/05');
    expect(bucketLabel('2026-10', 'month')).toBe('2026-10');
  });

  it('withAlpha 处理 #hex 与 rgb()', () => {
    expect(withAlpha('#10B981', 0.5)).toBe('rgba(16,185,129,0.5)');
    expect(withAlpha('rgb(1, 2, 3)', 0.2)).toBe('rgba(1,2,3,0.2)');
  });
});

describe('时间 / 时长 / 路由 / 查询串', () => {
  it('本地日期 / 小时 / 星期（按指定时区）', () => {
    const ts = Date.parse('2026-10-01T16:30:00Z');
    expect(localDate(ts, 'Asia/Shanghai')).toBe('2026-10-02');
    expect(localHour(ts, 'Asia/Shanghai')).toBe(0);
    expect(localDate(ts, 'UTC')).toBe('2026-10-01');
    expect(weekdayOfDate('2026-10-20')).toBe(2);
  });

  it('时长格式', () => {
    expect(durationParts(3 * 3600_000 + 42 * 60_000)).toEqual([{ n: 3, unit: 'h' }, { n: 42, unit: 'm' }]);
    expect(formatDuration(35_000)).toBe('35s');
    expect(formatDuration(90 * 60_000)).toBe('1h 30m');
    expect(formatDuration(-1)).toBe('—');
  });

  it('hash 路由：全局筛选与页面私有参数往返；默认值省略', () => {
    const h = buildHash('sessions', 'p1', ['abc'], { filters: { range: '7d', models: ['a', 'b'], family: true, basis: 'fresh' }, params: { q: 'x y', sort: 'start' } });
    const r = parseHash(h);
    expect(r).toMatchObject({ page: 'sessions', project: 'p1', rest: ['abc'], filters: { range: '7d', models: ['a', 'b'], family: true, basis: 'fresh' }, params: { q: 'x y', sort: 'start' } });
    expect(buildHash('overview', 'all', [], { filters: { range: '30d', models: [], family: false, basis: null } })).toBe('#/overview');
    expect(parseHash('#/overview?range=bogus').filters.range).toBe('30d');
    expect(parseHash('').page).toBe('overview');
  });

  it('filterQuery：项目 / 范围 / 口径 / 模型；自定义起止；ignoreModels', () => {
    const route = { project: 'all', filters: { range: 'thisMonth', models: ['m1'], family: true, basis: null } } as Pick<Route, 'project' | 'filters'>;
    expect(filterQuery(route, 'fresh')).toBe('project=all&range=thisMonth&basis=fresh&models=m1&mergeFamilies=true');
    expect(filterQuery(route, 'total', { from: '2026-10-01', to: '2026-10-01', granularity: 'hour', ignoreModels: true })).toBe('project=all&range=custom&from=2026-10-01&to=2026-10-01&basis=total&granularity=hour');
  });
});

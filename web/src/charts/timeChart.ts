/**
 * Token 时间曲线的 ECharts 选项构造（纯函数，可单测）。
 * 视觉来自设计稿：平滑曲线 + 渐变面积、淡虚线水平参考线、小而浅的坐标轴、峰值实心点 + 文字标注、白卡圆角 16 的 tooltip。
 */
import type { EChartsOption } from 'echarts';
import { formatExact, formatTokens, weekdayOfDate } from '../lib/format.ts';
import { withAlpha } from './colors.ts';
import type { ChartColors } from './colors.ts';
import { chartTooltip } from './tooltip.ts';

export type SplitMode = 'none' | 'tokenType' | 'model' | 'project';
export type ChartKind = 'area' | 'bar';
export type Gran = 'hour' | 'day' | 'week' | 'month';

export interface TimePoint {
  key: string;
  start: number;
  value: number;
  total: number;
  fresh: number;
  requests: number;
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

export interface SeriesIn {
  key: string;
  label: string;
  values: number[];
  total: number;
  isLocal?: boolean;
}

export interface TimeChartText {
  total: string;
  types: { input: string; cacheWrite: string; cacheRead: string; output: string };
  weekday: (d: number) => string;
  peak: (v: string, d: string) => string;
  requestsSum: (n: number) => string;
  localSuffix: string;
}

export interface TimeChartInput {
  points: TimePoint[];
  series: SeriesIn[];
  split: SplitMode;
  kind: ChartKind;
  gran: Gran;
  /** 被图例隐藏的系列键 */
  hidden: ReadonlySet<string>;
  basis: 'total' | 'fresh';
  colors: ChartColors;
  text: TimeChartText;
  /** 成本模式（金额）：数值格式化函数；缺省 = token 数 */
  money?: { fmt: (v: number) => string; axis: (v: number) => string };
}

export interface LegendItem {
  key: string;
  label: string;
  color: string;
  hidden: boolean;
}

export interface TimeChartResult {
  option: EChartsOption;
  legend: LegendItem[];
  /** 每个点上"可见系列"的堆叠总和 */
  totals: number[];
  peakIndex: number;
  peakValue: number;
  peakLabel: string;
  xLabels: string[];
}

/** 桶键 → 横轴标签。 */
export function bucketLabel(key: string, gran: Gran, multiDayHour = true): string {
  if (gran === 'month') return key;
  if (gran === 'hour') {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})/.exec(key);
    if (!m) return key;
    return multiDayHour ? `${m[2]}/${m[3]} ${m[4]}:00` : `${m[4]}:00`;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(key);
  return m ? `${m[2]}/${m[3]}` : key;
}

function seriesColor(key: string, idx: number, split: SplitMode, c: ChartColors): string {
  if (split === 'none') return c.accent;
  if (split === 'tokenType') return (c.type as Record<string, string>)[key] ?? c.palette[idx % c.palette.length]!;
  return c.palette[idx % c.palette.length]!;
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

export function buildTimeChart(inp: TimeChartInput): TimeChartResult {
  const { points, split, kind, gran, colors: c, text } = inp;
  const multiDayHour = points.length > 24;
  const xLabels = points.map((p) => bucketLabel(p.key, gran, multiDayHour));

  // 可见系列
  const all = inp.series.map((s, i) => ({ ...s, color: seriesColor(s.key, i, split, c), label: split === 'model' && s.isLocal ? `${s.label}${text.localSuffix}` : s.label }));
  const visible = all.filter((s) => !inp.hidden.has(s.key));
  const n = points.length;
  const totals = new Array<number>(n).fill(0);
  for (const s of visible) for (let i = 0; i < n; i++) totals[i]! += s.values[i] ?? 0;

  let peakIndex = -1;
  let peakValue = 0;
  for (let i = 0; i < n; i++) {
    if (totals[i]! > peakValue) {
      peakValue = totals[i]!;
      peakIndex = i;
    }
  }
  const peakDate = peakIndex >= 0 ? xLabels[peakIndex]! : '';
  const peakLabel = peakIndex >= 0 ? text.peak(inp.money ? inp.money.axis(peakValue) : formatTokens(peakValue), peakDate) : '';

  const stacked = split !== 'none';
  const lastIdx = visible.length - 1;

  const series = visible.map((s, si) => {
    const isTop = si === lastIdx;
    const markPoint =
      isTop && peakIndex >= 0
        ? {
            symbol: 'circle',
            symbolSize: 9,
            animation: false,
            itemStyle: { color: c.accent, borderColor: c.card, borderWidth: 2 },
            label: { show: true, position: (peakIndex > n * 0.8 ? 'left' : peakIndex < n * 0.08 ? 'right' : 'top') as 'left' | 'right' | 'top', distance: peakIndex > n * 0.8 || peakIndex < n * 0.08 ? 10 : 8, formatter: peakLabel, color: c.text, fontWeight: 600, fontSize: 12.5, backgroundColor: c.card, borderColor: c.line, borderWidth: 1, borderRadius: 999, padding: [4, 10] },
            data: [{ coord: [peakIndex, peakValue] as [number, number] }],
          }
        : undefined;
    if (kind === 'bar') {
      return {
        id: s.key,
        name: s.label,
        type: 'bar' as const,
        stack: 'all',
        data: s.values,
        barMaxWidth: 26,
        itemStyle: { color: s.color, borderRadius: isTop ? [6, 6, 0, 0] : 0 },
        emphasis: { focus: 'none' as const, itemStyle: { color: s.color } },
        markPoint,
      };
    }
    return {
      id: s.key,
      name: s.label,
      type: 'line' as const,
      stack: stacked ? 'all' : undefined,
      data: s.values,
      smooth: 0.17,
      smoothMonotone: 'x' as const,
      symbol: 'circle',
      symbolSize: 10,
      showSymbol: false,
      lineStyle: { width: stacked ? 1.8 : 2.2, color: s.color, cap: 'round' as const, join: 'round' as const },
      itemStyle: { color: c.card, borderColor: s.color, borderWidth: 2.5 },
      areaStyle: {
        color: { type: 'linear' as const, x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: withAlpha(s.color, stacked ? 0.34 : 0.3) }, { offset: 1, color: withAlpha(s.color, stacked ? 0.05 : 0) }] },
      },
      emphasis: { focus: 'none' as const },
      markPoint,
    };
  });

  const tooltip = chartTooltip(c, {
    axisPointer: { type: 'line' as const, lineStyle: { color: c.muted, type: [3, 4] as unknown as 'dashed', width: 1 } },
    formatter: (params: unknown): string => {
      const arr = Array.isArray(params) ? (params as Array<{ dataIndex: number }>) : [params as { dataIndex: number }];
      const i = arr[0]?.dataIndex ?? 0;
      const p = points[i];
      if (!p) return '';
      const row = (color: string, name: string, v: number, pct: number | null): string =>
        `<div style="display:flex;justify-content:space-between;align-items:center;gap:16px;padding:1px 0"><span style="display:flex;align-items:center;gap:8px;color:${c.text2}"><span style="width:8px;height:8px;border-radius:2px;background:${color}"></span>${esc(name)}</span><span style="font-weight:600;font-variant-numeric:tabular-nums;color:${c.text}">${inp.money ? inp.money.fmt(v) : formatExact(v)}${pct === null ? '' : `<span style="color:${c.muted};font-weight:500;margin-left:8px">${pct.toFixed(1)}%</span>`}</span></div>`;
      let rows = '';
      if (split === 'none' && inp.money) {
        rows += row(c.accent, text.total, totals[i] ?? 0, null);
      } else if (split === 'none') {
        const types: Array<['input' | 'cacheWrite' | 'cacheRead' | 'output', string]> = [['input', c.type.input], ['cacheWrite', c.type.cacheWrite], ['cacheRead', c.type.cacheRead], ['output', c.type.output]];
        const denom = inp.basis === 'fresh' ? p.input + p.cacheWrite + p.output : p.input + p.cacheWrite + p.cacheRead + p.output;
        for (const [k, color] of types) {
          if (inp.basis === 'fresh' && k === 'cacheRead') continue;
          rows += row(color, text.types[k], p[k], denom > 0 ? (p[k] / denom) * 100 : null);
        }
      } else {
        const denom = totals[i] ?? 0;
        for (const s of [...visible].reverse()) rows += row(s.color, s.label, s.values[i] ?? 0, denom > 0 ? ((s.values[i] ?? 0) / denom) * 100 : null);
      }
      const dateStr = /^\d{4}-\d{2}-\d{2}/.test(p.key) && gran !== 'month' ? `${xLabels[i]!} ${gran === 'hour' ? '' : text.weekday(weekdayOfDate(p.key.slice(0, 10)))}`.trim() : xLabels[i]!;
      const shown = split === 'none' ? p.value : (totals[i] ?? 0);
      return `<div style="min-width:210px;padding:10px 14px;font-size:12.5px;font-family:inherit;background:${c.card};border-radius:14px"><div style="font-weight:600;font-size:13px;margin-bottom:5px;color:${c.text}">${esc(dateStr)}</div>${rows}<div style="display:flex;justify-content:space-between;gap:16px;margin-top:5px;padding-top:6px;border-top:1px solid ${c.line};font-weight:600;color:${c.text}"><span>${esc(text.requestsSum(p.requests))}</span><span style="font-variant-numeric:tabular-nums">${inp.money ? inp.money.fmt(shown) : formatExact(shown)}</span></div></div>`;
    },
  });

  const option: EChartsOption = {
    animationDuration: 600,
    animationDurationUpdate: 380,
    animationEasing: 'cubicOut',
    animationEasingUpdate: 'cubicOut',
    textStyle: { fontFamily: 'Outfit, "Noto Sans SC", "HarmonyOS Sans SC", "Microsoft YaHei", system-ui, sans-serif' },
    grid: { left: 4, right: 14, top: 44, bottom: 4, containLabel: true },
    tooltip,
    xAxis: {
      type: 'category',
      data: xLabels,
      boundaryGap: kind === 'bar',
      axisTick: { show: false },
      axisLine: { lineStyle: { color: c.grid } },
      axisLabel: { color: c.muted, fontSize: 12, hideOverlap: true, margin: 12 },
    },
    yAxis: {
      type: 'value',
      min: 0,
      splitNumber: 4,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: c.muted, fontSize: 12, formatter: (v: number) => (inp.money ? inp.money.axis(v) : formatTokens(v)) },
      splitLine: { lineStyle: { color: c.grid, type: [3, 5] as unknown as 'dashed', width: 1 } },
    },
    series: series as EChartsOption['series'],
  };

  const legend: LegendItem[] = all.map((s) => ({ key: s.key, label: s.label, color: s.color, hidden: inp.hidden.has(s.key) }));
  return { option, legend, totals, peakIndex, peakValue, peakLabel, xLabels };
}

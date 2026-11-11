import { useMemo } from 'react';
import type { EChartsOption } from 'echarts';
import type { TimeseriesPayload } from '../../api/types.ts';
import { useApi } from '../../api/useApi.ts';
import { withAlpha } from '../../charts/colors.ts';
import { readChartColors } from '../../charts/readColors.ts';
import { chartTooltip } from '../../charts/tooltip.ts';
import { EChart } from '../../charts/EChart.tsx';
import { Card } from '../../design/Card.tsx';
import { Skeleton } from '../../design/Skeleton.tsx';
import { cx } from '../../lib/cx.ts';
import { formatDelta, formatExact, formatTokens, localDate, localHour } from '../../lib/format.ts';
import { filterQuery } from '../../lib/query.ts';
import { useRoute } from '../../state/route.ts';
import { useBasis, useStore, useT } from '../../state/store.ts';
import s from './Sections.module.css';

const HOUR = 3_600_000;

function cumulative(values: number[]): number[] {
  const out: number[] = [];
  let a = 0;
  for (const v of values) {
    a += v;
    out.push(a);
  }
  return out;
}

interface Props {
  /** 今日 / 昨日的起点（UTC 毫秒；来自 /api/summary.periods） */
  todayFrom: number | null;
  yesterdayFrom: number | null;
}

/** 今日 vs 昨日：同一小时轴（0–23 时）上的累计曲线叠加；今日线截止到当前小时。 */
export function TodayVsYesterday({ todayFrom, yesterdayFrom }: Props) {
  const t = useT();
  const route = useRoute();
  const basis = useBasis();
  const theme = useStore((x) => x.resolvedTheme);
  const now = useStore((x) => x.status?.serverNow ?? null);
  const tz = useStore((x) => x.status?.today?.tz ?? null);

  const tDate = todayFrom !== null && tz ? localDate(todayFrom + 12 * HOUR, tz) : null;
  const yDate = yesterdayFrom !== null && tz ? localDate(yesterdayFrom + 12 * HOUR, tz) : null;
  const q = (d: string | null): string | null => (d ? `/api/timeseries?${filterQuery(route, basis, { from: d, to: d, granularity: 'hour' })}` : null);
  const today = useApi<TimeseriesPayload>(q(tDate));
  const yesterday = useApi<TimeseriesPayload>(q(yDate));
  const colors = useMemo(() => readChartColors(), [theme]);

  const model = useMemo(() => {
    if (!today.data || !yesterday.data || now === null || !tz) return null;
    const tv = today.data.points.map((p) => p.value);
    const yv = yesterday.data.points.map((p) => p.value);
    const tc = cumulative(tv);
    const yc = cumulative(yv);
    const nowIdx = Math.min(tv.length - 1, localHour(now, tz));
    const todayNow = tc[nowIdx] ?? 0;
    const yNow = yc[nowIdx] ?? 0;
    const yAll = yc[yc.length - 1] ?? 0;
    const hourLabel = (i: number): string => `${String(i).padStart(2, '0')}:00`;
    const labels = Array.from({ length: Math.max(tv.length, yv.length) }, (_, i) => hourLabel(i));
    const todaySeries = labels.map((_, i) => (i <= nowIdx ? (tc[i] ?? 0) : null));
    const option: EChartsOption = {
      animationDuration: 600,
      animationDurationUpdate: 380,
      animationEasing: 'cubicOut',
      textStyle: { fontFamily: 'Outfit, "Noto Sans SC", "HarmonyOS Sans SC", "Microsoft YaHei", system-ui, sans-serif' },
      grid: { left: 4, right: 14, top: 16, bottom: 4, containLabel: true },
      tooltip: chartTooltip(colors, {
        formatter: (params: unknown): string => {
          const arr = params as Array<{ dataIndex: number }>;
          const i = arr[0]?.dataIndex ?? 0;
          const row = (color: string, name: string, v: number | null): string =>
            v === null ? '' : `<div style="display:flex;justify-content:space-between;gap:16px;padding:2px 0"><span style="display:flex;align-items:center;gap:8px;color:${colors.text2}"><span style="width:8px;height:8px;border-radius:2px;background:${color}"></span>${name}</span><span style="font-weight:600;font-variant-numeric:tabular-nums;color:${colors.text}">${formatExact(v)}</span></div>`;
          return `<div style="min-width:190px;padding:10px 14px;font-size:12.5px;background:${colors.card};border-radius:14px"><div style="font-weight:600;font-size:13px;margin-bottom:5px;color:${colors.text}">${hourLabel(i)}</div>${row(colors.accent, t('tvy.seriesToday'), todaySeries[i] ?? null)}${row(colors.muted, t('tvy.seriesYesterday'), yc[i] ?? null)}</div>`;
        },
      }),
      xAxis: { type: 'category', data: labels, boundaryGap: false, axisTick: { show: false }, axisLine: { lineStyle: { color: colors.grid } }, axisLabel: { color: colors.muted, fontSize: 11.5, interval: 5 } },
      yAxis: { type: 'value', min: 0, splitNumber: 3, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: colors.muted, fontSize: 11.5, formatter: (v: number) => formatTokens(v) }, splitLine: { lineStyle: { color: colors.grid, type: [3, 5] as unknown as 'dashed' } } },
      series: [
        { id: 'yesterday', name: t('tvy.seriesYesterday'), type: 'line', data: yc, smooth: 0.17, symbol: 'none', lineStyle: { width: 2, color: colors.muted, type: [5, 5] as unknown as 'dashed' }, itemStyle: { color: colors.muted } },
        {
          id: 'today',
          name: t('tvy.seriesToday'),
          type: 'line',
          data: todaySeries,
          smooth: 0.17,
          symbol: 'circle',
          symbolSize: 10,
          showSymbol: false,
          lineStyle: { width: 2.4, color: colors.accent, cap: 'round' },
          itemStyle: { color: colors.card, borderColor: colors.accent, borderWidth: 2.5 },
          areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: withAlpha(colors.accent, 0.28) }, { offset: 1, color: withAlpha(colors.accent, 0) }] } },
          markPoint: { symbol: 'circle', symbolSize: 9, animation: false, itemStyle: { color: colors.accent, borderColor: colors.card, borderWidth: 2 }, label: { show: false }, data: [{ name: 'now', coord: [nowIdx, todayNow] as [number, number] }] },
        },
      ],
    };
    return { option, todayNow, yNow, yAll, nowIdx, nowLabel: hourLabel(nowIdx), delta: yNow > 0 ? (todayNow - yNow) / yNow : null, tc, yc };
  }, [today.data, yesterday.data, now, tz, colors, t]);

  const d = model ? formatDelta(model.delta) : null;
  return (
    <Card className={cx(s.card, s.half)} data-testid="tvy-card">
      <div className={s.head}>
        <div>
          <h2 className={s.h2}>{t('tvy.title')}</h2>
          <div className={s.sub}>{model ? t('tvy.subtitle', { time: model.nowLabel }) : ''}</div>
        </div>
        {d && d.dir !== 'none' && (
          <span className={cx(s.badge, d.dir === 'down' && s.badgeDown, 'num')} data-testid="tvy-delta" data-dir={d.dir}>
            {t('tvy.badge', { delta: d.text })}
          </span>
        )}
      </div>
      {!model ? (
        <Skeleton height={220} radius={16} />
      ) : (
        <>
          <EChart
            option={model.option}
            height={220}
            testId="tvy-chart"
            ariaLabel={t('tvy.ariaLabel', { time: model.nowLabel, today: formatTokens(model.todayNow), same: formatTokens(model.yNow) })}
            dataAttrs={{ 'today-cum': JSON.stringify(model.tc.slice(0, model.nowIdx + 1)), 'yesterday-cum': JSON.stringify(model.yc), 'now-index': model.nowIdx, today: model.todayNow, yesterday: model.yAll, 'yesterday-same': model.yNow }}
          />
          <div className={s.legend}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className={s.swatch} style={{ background: 'var(--accent)' }} />
              {t('tvy.today', { v: formatTokens(model.todayNow) })}
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 18, borderTop: '2px dashed var(--muted)' }} />
              {t('tvy.yesterday', { all: formatTokens(model.yAll), same: formatTokens(model.yNow) })}
            </span>
          </div>
        </>
      )}
    </Card>
  );
}

import { useEffect, useMemo, useState } from 'react';
import type { TimeseriesPayload } from '../../api/types.ts';
import { useApi } from '../../api/useApi.ts';
import { readChartColors } from '../../charts/readColors.ts';
import { EChart } from '../../charts/EChart.tsx';
import { buildTimeChart } from '../../charts/timeChart.ts';
import type { ChartKind, Gran, SplitMode } from '../../charts/timeChart.ts';
import { Card } from '../../design/Card.tsx';
import { costOf, useCostMode } from '../../features/cost/costMode.ts';
import { axisUsd, formatUsd } from '../../features/cost/format.ts';
import { Segmented } from '../../design/Segmented.tsx';
import { Skeleton } from '../../design/Skeleton.tsx';
import { formatTokens } from '../../lib/format.ts';
import { filterQuery } from '../../lib/query.ts';
import { useRoute } from '../../state/route.ts';
import { useRangeLabel } from '../../state/period.ts';
import { useBasis, useStore, useT } from '../../state/store.ts';
import s from './Sections.module.css';

/**
 * Token 时间曲线（5.3.3）：面积 / 堆叠柱状；小时 / 日 / 周 / 月；拆分 总量 / 类型 / 模型 / 项目（仅"全部项目"视图）；
 * tooltip 精确值 + 各类型分解 + 占比 + 请求数；图例点击显隐；峰值标注。
 */
export function TimeCurve() {
  const t = useT();
  const rangeName = useRangeLabel();
  const route = useRoute();
  const basis = useBasis();
  const theme = useStore((x) => x.resolvedTheme);
  const [gran, setGran] = useState<Gran>('day');
  const [split, setSplit] = useState<SplitMode>('none');
  const [kind, setKind] = useState<ChartKind>('area');
  const [unit, setUnit] = useState<'tokens' | 'cost'>('tokens');
  const costMode = useCostMode((x) => x.mode);
  const subConfigured = useStore((x) => (x.settings?.settings.subscription?.monthlyFeeUsd ?? 0) > 0);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());

  const range = route.filters.range;
  const effGran: Gran = range === 'today' ? 'hour' : gran;
  const effSplit: SplitMode = split === 'project' && route.project !== 'all' ? 'none' : split;

  useEffect(() => setHidden(new Set()), [effSplit]);

  const path = `/api/timeseries?${filterQuery(route, basis, { granularity: effGran, split: effSplit })}`;
  const ts = useApi<TimeseriesPayload>(path);
  const data = ts.data;

  const colors = useMemo(() => readChartColors(), [theme]);
  const isCost = unit === 'cost';
  const chart = useMemo(() => {
    if (!data) return null;
    // 成本模式：用服务端算好的 points[].cost / series[].costValues 替换 token 数值（随成本口径切换）
    const points = isCost ? data.points.map((p) => ({ ...p, value: costOf(p.cost, costMode) ?? 0 })) : data.points;
    const series = isCost
      ? data.series.map((x) => {
          const v = (costMode === 'api' ? x.costValues?.api : x.costValues?.sub) ?? new Array<number>(data.points.length).fill(0);
          return { ...x, values: v, total: v.reduce((a, b) => a + b, 0) };
        })
      : data.series;
    return buildTimeChart({
      points,
      series: series.map((x) => (effSplit === 'none' ? { ...x, label: t('curve.legendTotal') } : x)),
      split: effSplit,
      kind,
      gran: effGran,
      hidden,
      basis,
      colors,
      text: {
        total: t('curve.legendTotal'),
        types: { input: t('type.input'), cacheWrite: t('type.cacheWrite'), cacheRead: t('type.cacheRead'), output: t('type.output') },
        weekday: (d) => t(`weekday.${d as 0 | 1 | 2 | 3 | 4 | 5 | 6}`),
        peak: (v, d) => t('curve.peak', { v, d }),
        requestsSum: (n) => t('curve.requestsSum', { n }),
        localSuffix: t('model.localSuffix'),
      },
      money: isCost ? { fmt: (v) => formatUsd(v), axis: axisUsd } : undefined,
    });
  }, [data, effSplit, kind, effGran, hidden, basis, colors, t, isCost, costMode]);

  const rangeLabel = rangeName(range);
  const granLabel = t(`curve.granLabel.${effGran}`);
  const sum = chart ? chart.totals.reduce((a, b) => a + b, 0) : 0;
  const ready = ts.loadedKey === path && !ts.loading;
  const hasRequests = !!data && data.points.length > 0 && (data.summary.requests > 0 || sum > 0);
  // 成本模式下没有可计价的成本（价格未配置 / 未设置订阅方案）→ 给出引导而不是画一条 0 线
  const costEmpty = isCost && !!data && data.points.length > 0 && data.summary.requests > 0 && sum === 0;
  const hasData = hasRequests && !costEmpty;

  const toggle = (key: string): void =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <Card className={s.card} data-testid="time-curve" data-ready={ready ? 'true' : 'false'}>
      <div className={s.head}>
        <div>
          <h2 className={s.h2}>{t('curve.title')}</h2>
          <div className={s.sub} data-testid="curve-subtitle">
            {isCost
              ? t('cost.curve.subtitle', { range: rangeLabel, gran: granLabel, mode: t(costMode === 'api' ? 'cost.curve.modeApi' : 'cost.curve.modeSub') })
              : t('curve.subtitle', { range: rangeLabel, gran: granLabel, basis: basis === 'fresh' ? t('curve.basisFresh') : t('curve.basisTotal') })}
          </div>
        </div>
        <div className={s.controls}>
          <Segmented
            ariaLabel={t('cost.unit.aria')}
            size="sm"
            value={unit}
            testId="unit-toggle"
            onChange={setUnit}
            options={[
              { value: 'tokens', label: t('cost.unit.tokens') },
              { value: 'cost', label: t('cost.unit.cost') },
            ]}
          />
          <Segmented
            ariaLabel={t('curve.granAria')}
            size="sm"
            value={effGran}
            testId="gran-toggle"
            onChange={(g) => range !== 'today' && setGran(g)}
            options={(['hour', 'day', 'week', 'month'] as const).map((g) => ({ value: g, label: t(`curve.gran.${g}`) }))}
          />
          <Segmented
            ariaLabel={t('curve.splitAria')}
            size="sm"
            value={effSplit}
            testId="split-toggle"
            onChange={setSplit}
            options={(['none', 'tokenType', 'model', ...(route.project === 'all' ? (['project'] as const) : [])] as SplitMode[]).map((k) => ({ value: k, label: t(`curve.split.${k}`) }))}
          />
          <Segmented ariaLabel={t('curve.kindAria')} size="sm" value={kind} testId="kind-toggle" onChange={setKind} options={(['area', 'bar'] as const).map((k) => ({ value: k, label: t(`curve.kind.${k}`) }))} />
        </div>
      </div>

      {ts.error && !data && <div className={s.err}>{t('curve.error', { reason: ts.error.message })}</div>}
      {!data && !ts.error && <Skeleton height={300} radius={16} />}
      {data && !hasData && (
        <div className={s.empty} data-testid={costEmpty ? 'curve-cost-empty' : undefined}>
          {costEmpty ? t(costMode === 'sub' && !subConfigured ? 'cost.unit.noSub' : 'cost.unit.noPrices') : t('curve.empty')}
        </div>
      )}
      {chart && hasData && (
        <EChart
          option={chart.option}
          height={300}
          testId="time-chart"
          ariaLabel={t('curve.ariaLabel', { range: rangeLabel, gran: granLabel, d: chart.xLabels[chart.peakIndex] ?? '', v: isCost ? formatUsd(chart.peakValue) : formatTokens(chart.peakValue) })}
          dataAttrs={{
            sum,
            values: JSON.stringify(chart.totals),
            keys: JSON.stringify(data!.points.map((p) => p.key)),
            'peak-index': chart.peakIndex,
            'peak-value': chart.peakValue,
            gran: effGran,
            split: effSplit,
            kind,
            legend: chart.legend.map((l) => l.key).join(','),
            hidden: [...hidden].join(','),
            basis,
            unit,
          }}
        />
      )}

      <div className={s.legend} data-testid="curve-legend">
        {chart?.legend.map((l) => (
          <button key={l.key} type="button" className={s.legendBtn} aria-pressed={!l.hidden} data-legend-key={l.key} onClick={() => toggle(l.key)}>
            <span className={s.swatch} style={{ background: l.color }} />
            {l.label}
          </button>
        ))}
        <span className={s.hint}>{t('curve.legendHint')}</span>
      </div>
    </Card>
  );
}

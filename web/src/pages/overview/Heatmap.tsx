import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { DayDetailPayload, HeatmapPayload } from '../../api/types.ts';
import { useApi } from '../../api/useApi.ts';
import { readChartColors } from '../../charts/readColors.ts';
import { EChart } from '../../charts/EChart.tsx';
import { buildTimeChart } from '../../charts/timeChart.ts';
import type { TimePoint } from '../../charts/timeChart.ts';
import { RoundButton } from '../../design/Button.tsx';
import { Card } from '../../design/Card.tsx';
import { Icon } from '../../design/icons.tsx';
import { Skeleton } from '../../design/Skeleton.tsx';
import { cx } from '../../lib/cx.ts';
import { formatExact, formatTokens } from '../../lib/format.ts';
import { filterQuery } from '../../lib/query.ts';
import { hashFor, navigate, useRoute } from '../../state/route.ts';
import { useBasis, useStore, useT } from '../../state/store.ts';
import s from './Sections.module.css';

const WEEKS = 26;

function level(v: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (v <= 0 || max <= 0) return 0;
  const r = v / max;
  return r > 0.75 ? 4 : r > 0.5 ? 3 : r > 0.25 ? 2 : 1;
}

/** 日历热力图（5.3.4）：每格一天，颜色深浅 = 当日 token（遵从当前口径 / 项目 / 模型筛选）；点击某天，下方联动显示当天明细。 */
export function HeatmapCard() {
  const t = useT();
  const route = useRoute();
  const basis = useBasis();
  const path = `/api/heatmap?${filterQuery(route, basis, { extra: { weeks: WEEKS } })}`;
  const hm = useApi<HeatmapPayload>(path);
  const data = hm.data;
  const selected = route.params.day ?? '';
  const [focus, setFocus] = useState<number>(-1);
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const days = data?.days ?? [];
  const tabIdx = focus >= 0 ? focus : Math.max(0, days.findIndex((d) => d.date === selected) >= 0 ? days.findIndex((d) => d.date === selected) : days.length - 1);

  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const delta = e.key === 'ArrowRight' ? 7 : e.key === 'ArrowLeft' ? -7 : e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    e.stopPropagation();
    const next = Math.max(0, Math.min(days.length - 1, tabIdx + delta));
    setFocus(next);
    refs.current[next]?.focus();
  };

  return (
    <Card className={cx(s.card, s.half)} data-testid="heatmap-card" data-ready={hm.loadedKey === path && !hm.loading ? 'true' : 'false'}>
      <div>
        <h2 className={s.h2}>{t('heat.title')}</h2>
        <div className={s.sub}>{t('heat.subtitle', { weeks: WEEKS })}</div>
      </div>
      {!data ? (
        <Skeleton height={7 * 18} radius={12} />
      ) : (
        <div className={s.heatScroll}>
          <div className={s.heat} role="group" aria-label={t('heat.ariaLabel', { weeks: WEEKS })} data-testid="heatmap" data-cells={days.length} data-max={data.max} data-total={data.total} onKeyDown={onKey}>
            {days.map((d, i) => {
              const lv = level(d.value, data.max);
              const sel = d.date === selected;
              return (
                <button
                  key={d.date}
                  ref={(el) => {
                    refs.current[i] = el;
                  }}
                  type="button"
                  tabIndex={i === tabIdx ? 0 : -1}
                  className={cx(s.cell, lv > 0 && s[`l${lv}` as 'l1'])}
                  aria-pressed={sel}
                  aria-label={t(sel ? 'heat.cellTitleSelected' : 'heat.cellTitle', { date: d.date, value: formatTokens(d.value) })}
                  title={t('heat.cellTitle', { date: d.date, value: formatExact(d.value) })}
                  data-testid="heat-cell"
                  data-date={d.date}
                  data-value={d.value}
                  data-level={lv}
                  onClick={() => {
                    setFocus(i);
                    navigate({ params: { day: sel ? undefined : d.date } }, { replace: true });
                  }}
                />
              );
            })}
          </div>
        </div>
      )}
      <div className={s.heatLegend}>
        {t('heat.less')}
        <span className={s.cellSample} />
        <span className={cx(s.cellSample, s.l1)} />
        <span className={cx(s.cellSample, s.l2)} />
        <span className={cx(s.cellSample, s.l3)} />
        <span className={cx(s.cellSample, s.l4)} />
        {t('heat.more')}
      </div>
    </Card>
  );
}

/** 点击热力图某天后显示：当天按小时曲线 + 当天会话列表（点击跳转会话详情）。 */
export function DayDetailCard({ date }: { date: string }) {
  const t = useT();
  const route = useRoute();
  const basis = useBasis();
  const theme = useStore((x) => x.resolvedTheme);
  const path = `/api/day-detail?${filterQuery(route, basis, { extra: { date } })}`;
  const q = useApi<DayDetailPayload>(path);
  const data = q.data && q.data.date === date ? q.data : null;
  const colors = useMemo(() => readChartColors(), [theme]);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ block: 'nearest' });
  }, [date]);

  const chart = useMemo(() => {
    if (!data) return null;
    const points = data.hours as unknown as TimePoint[];
    return buildTimeChart({
      points,
      series: [{ key: 'total', label: t('curve.legendTotal'), values: points.map((p) => p.value), total: points.reduce((a, p) => a + p.value, 0) }],
      split: 'none',
      kind: 'area',
      gran: 'hour',
      hidden: new Set(),
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
    });
  }, [data, basis, colors, t]);

  return (
    <Card className={s.card} data-testid="day-detail" data-date={date} data-ready={data ? 'true' : 'false'}>
      <div ref={ref} className={s.head}>
        <div>
          <h2 className={s.h2}>{t('day.title', { date })}</h2>
          <div className={s.sub}>{data ? t('day.subtitle', { sessions: data.sessionCount, value: formatTokens(data.summary.value) }) : ''}</div>
        </div>
        <RoundButton small className={s.close} aria-label={t('day.close')} title={t('day.close')} data-testid="day-close" onClick={() => navigate({ params: { day: undefined } }, { replace: true })}>
          <Icon name="close" size={16} strokeWidth={2} />
        </RoundButton>
      </div>
      {!data ? (
        <Skeleton height={220} radius={16} />
      ) : (
        <>
          <div style={{ fontSize: 15, fontWeight: 500 }}>{t('day.hoursTitle')}</div>
          {chart && (
            <EChart
              option={chart.option}
              height={220}
              testId="day-chart"
              ariaLabel={t('day.hoursTitle')}
              dataAttrs={{ sum: chart.totals.reduce((a, b) => a + b, 0), values: JSON.stringify(chart.totals), hours: data.hours.length }}
            />
          )}
          <div style={{ fontSize: 15, fontWeight: 500 }}>{t('day.sessionsTitle')}</div>
          <div className={s.dayList} data-testid="day-sessions" data-count={data.sessionCount}>
            {data.sessions.length === 0 && <div className={s.empty}>{t('day.noSessions')}</div>}
            {data.sessions.map((x) => (
              <a key={x.id} className={s.dayRow} href={hashFor(route, { page: 'sessions', rest: [x.id], params: {} })} data-testid="day-session" data-session-id={x.id} title={t('day.openSession')}>
                <div style={{ minWidth: 0 }}>
                  <div className={s.dayTitle}>{x.title ?? t('day.untitled', { id: x.id.slice(0, 8) })}</div>
                  <div className={s.dayMeta}>{x.projectName}</div>
                </div>
                <span className={`num ${s.dayMeta}`}>{t('analysis.requestsN', { n: x.requests })}</span>
                <span className="num" data-value={x.value}>
                  {formatTokens(x.value)}
                </span>
              </a>
            ))}
          </div>
        </>
      )}
    </Card>
  );
}

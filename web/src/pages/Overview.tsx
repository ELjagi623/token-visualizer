import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useProjects } from '../api/hooks.ts';
import type { SummaryPayload, TimeseriesPayload } from '../api/types.ts';
import { useApi } from '../api/useApi.ts';
import { ChipLink } from '../design/Button.tsx';
import { StatePanel } from '../design/StatePanel.tsx';
import { Skeleton } from '../design/Skeleton.tsx';
import { StatTile } from '../design/StatTile.tsx';
import { ExportMenu } from '../features/export/ExportMenu.tsx';
import { FilterBar } from '../layout/FilterBar.tsx';
import { PageHeader } from '../layout/PageHeader.tsx';
import { formatTokens } from '../lib/format.ts';
import { markReady } from '../lib/perf.ts';
import { findProject } from '../lib/projects.ts';
import { filterQuery } from '../lib/query.ts';
import { hashFor, useRoute } from '../state/route.ts';
import { useBillingCycle, useRangeLabel } from '../state/period.ts';
import { useBasis, useStore, useT } from '../state/store.ts';
import { CostTile, PaybackCard } from './overview/CostSlots.tsx';
import { DayDetailCard, HeatmapCard } from './overview/Heatmap.tsx';
import { TimeCurve } from './overview/TimeCurve.tsx';
import { TodayVsYesterday } from './overview/TodayVsYesterday.tsx';
import { UsageCard } from './overview/UsageCard.tsx';
import { ScanProgress } from './ScanProgress.tsx';
import sec from './overview/Sections.module.css';
import s from './Overview.module.css';

const HOUR = 3_600_000;

/**
 * 总览页：页头 + 全局筛选条 → 使用状态卡 → 9 张指标卡（第 8 张成本卡 / 回本卡位置留给批次 C）→ Token 时间曲线 → 日历热力图 + 今日 vs 昨日 → 当日明细。
 * 所有数字来自 /api/summary、/api/timeseries、/api/heatmap、/api/day-detail，随全局筛选联动。
 */
export function OverviewPage() {
  const t = useT();
  const rangeName = useRangeLabel();
  const cycle = useBillingCycle();
  const route = useRoute();
  const project = route.project;
  const basis = useBasis();
  const weekStart = useStore((x) => x.settings?.settings.weekStart ?? 'monday');
  const budgetDaily = useStore((x) => x.settings?.settings.budget.daily ?? null);
  const budgetMonthly = useStore((x) => x.settings?.settings.budget.monthly ?? null);
  const budget = { daily: budgetDaily, monthly: budgetMonthly };
  const billingDay = useStore((x) => x.settings?.settings.subscription?.billingDay ?? null);
  const st = useStore(
    useShallow((x) => ({
      loaded: x.status !== null,
      state: x.status?.state ?? 'idle',
      phase: x.status?.phase ?? 'incremental',
      lastError: x.status?.lastError ?? null,
      connection: x.connection,
    })),
  );
  const scanningFull = st.state === 'scanning' && st.phase === 'full';
  const range = route.filters.range;

  const projects = useProjects();
  const summaryPath = `/api/summary?${filterQuery(route, basis)}`;
  const summary = useApi<SummaryPayload>(summaryPath);
  const series = useApi<TimeseriesPayload>(`/api/timeseries?${filterQuery(route, basis, { granularity: range === 'today' ? 'hour' : 'day' })}`);
  const last30 = useApi<TimeseriesPayload>(`/api/timeseries?${filterQuery(route, basis, { range: '30d', granularity: 'day' })}`);
  const hourly = useApi<TimeseriesPayload>(`/api/timeseries?${filterQuery(route, basis, { range: 'today', granularity: 'hour' })}`);

  const ready = summary.loadedKey === summaryPath && !summary.loading && !summary.placeholder;
  useEffect(() => {
    if (ready) markReady(project);
  }, [ready, project, summary.data]);

  const cur = project === 'all' ? undefined : findProject(projects.data?.projects, project);
  const sm = summary.data?.summary;
  const periods = summary.data?.periods;
  const hasData = sm !== undefined;
  const pts = series.data?.points;
  const rangeLabel = rangeName(range);

  const noRecords = st.loaded && !scanningFull && st.state !== 'error' && hasData && sm.requests === 0 && project === 'all' && (projects.data?.projectCount ?? 0) === 0;
  const bare = st.state === 'error' || noRecords;

  let title: ReactNode;
  let subtitle: string | undefined;
  if (scanningFull) {
    title = t('scan.title');
    subtitle = t('scan.desc');
  } else if (project === 'all') {
    title = t('sidebar.all');
    subtitle = hasData && projects.data ? t('overview.subtitleAll', { projects: projects.data.projectCount, sessions: sm.sessions, days: sm.activeDays }) : undefined;
  } else if (project === 'scratch' || cur?.isScratchGroup) {
    title = t('sidebar.scratch');
    subtitle = hasData ? t('overview.subtitleScratch', { projects: cur?.children?.length ?? 0, sessions: sm.sessions, days: sm.activeDays }) : undefined;
  } else {
    title = cur?.displayName ?? (projects.data ? project : <Skeleton width={220} height={30} />);
    subtitle = hasData ? t('overview.subtitleOne', { sessions: sm.sessions, days: sm.activeDays }) : undefined;
  }
  if (bare) subtitle = undefined;

  // 各卡片的迷你曲线
  const val = (xs: Array<{ value: number }> | undefined): number[] | undefined => xs?.map((p) => p.value);
  const hit = (xs: TimeseriesPayload['points'] | undefined): number[] | undefined =>
    xs?.map((p) => {
      const d = p.input + p.cacheWrite + p.cacheRead;
      return d > 0 ? (p.cacheRead / d) * 100 : 0;
    });
  const ratio = (xs: TimeseriesPayload['points'] | undefined): number[] | undefined => xs?.map((p) => (p.input > 0 ? p.output / p.input : 0));
  const l30 = last30.data?.points;
  const avg30 = last30.data ? last30.data.summary.value / 30 : null;

  const activeMs = sm?.activeMs ?? 0;
  const hours = activeMs / HOUR;
  const basisNote = basis === 'fresh' ? t('basis.noteFresh') : t('basis.noteTotal');
  const weekNoteFrom = weekStart === 'sunday' ? t('tile.weekNoteWeekdaySun') : t('tile.weekNoteWeekdayMon');
  const partial = scanningFull;
  const loading = !hasData;

  let body;
  if (st.state === 'error') {
    body = (
      <StatePanel
        role="alert"
        icon="server"
        tone="pink"
        testId="data-root-error"
        title={t('error.dataRoot.title')}
        desc={st.lastError ? t('error.dataRoot.reason', { reason: st.lastError }) : undefined}
        action={
          <ChipLink primary href={hashFor(route, { page: 'settings' })}>
            {t('error.dataRoot.goSettings')}
          </ChipLink>
        }
      />
    );
  } else if (st.connection === 'lost' && !hasData) {
    body = <StatePanel role="alert" icon="server" tone="amber" testId="api-error" title={t('error.api.title')} desc={t('error.api.desc')} />;
  } else if (noRecords) {
    body = <StatePanel icon="inbox" testId="empty-state" title={t('empty.title')} desc={t('empty.desc')} />;
  } else {
    body = (
      <>
        {scanningFull && <ScanProgress />}
        <UsageCard today={periods ? periods.today.summary.value : null} avg30={avg30} dailyBudget={budget.daily} monthlyBudget={budget.monthly} monthUsed={periods ? periods.thisMonth.summary.value : null} />
        <div className={s.grid} data-testid="tiles">
          <StatTile
            testId="tile-total"
            icon="layers"
            title={range === 'all' ? t('tile.totalAll') : t('tile.totalRange', { range: rangeLabel })}
            value={hasData ? sm.value : null}
            loading={loading}
            unit={t('unit.tokens')}
            note={hasData ? t('tile.totalNoteRange', { basis: basisNote, days: sm.activeDays }) : undefined}
            spark={val(pts)}
            partial={partial}
          />
          <StatTile
            testId="tile-today"
            icon="sun"
            title={t('tile.today')}
            value={periods ? periods.today.summary.value : null}
            loading={loading}
            unit={t('unit.tokens')}
            note={t('tile.todayNote')}
            deltaPct={periods ? periods.deltas.today.pct : undefined}
            spark={val(hourly.data?.points)}
            partial={partial}
          />
          <StatTile
            testId="tile-week"
            icon="cal"
            title={t('tile.week')}
            value={periods ? periods.thisWeek.summary.value : null}
            loading={loading}
            unit={t('unit.tokens')}
            note={t('tile.weekNote', { from: weekNoteFrom })}
            deltaPct={periods ? periods.deltas.week.pct : undefined}
            spark={val(l30?.slice(-7))}
            partial={partial}
          />
          <StatTile
            testId="tile-month"
            icon="cal"
            title={t(cycle ? 'tile.cycle' : 'tile.month')}
            value={periods ? periods.thisMonth.summary.value : null}
            loading={loading}
            unit={t('unit.tokens')}
            note={billingDay === null ? t('tile.monthNote') : t('tile.monthNoteCycle', { day: billingDay })}
            deltaPct={periods ? periods.deltas.month.pct : undefined}
            spark={val(l30)}
            partial={partial}
          />
          <StatTile
            testId="tile-requests"
            icon="act"
            title={t('tile.requests')}
            value={hasData ? sm.requests : null}
            loading={loading}
            formatParts={(n) => ({ num: Math.round(n).toLocaleString('en-US'), unit: '' })}
            unit={t('unit.times')}
            note={hasData ? t('tile.requestsNoteAvg', { sessions: sm.sessions, avg: sm.avgPerRequest === null ? '—' : formatTokens(sm.avgPerRequest) }) : undefined}
            hint={hasData && sm.avgPerSession !== null ? t('tile.avgPerSession', { avg: formatTokens(sm.avgPerSession) }) : undefined}
            spark={pts?.map((p) => p.requests)}
            partial={partial}
          />
          <StatTile
            testId="tile-hit"
            icon="pct"
            title={t('tile.hit')}
            value={hasData && sm.cacheHitRate !== null ? sm.cacheHitRate * 100 : null}
            loading={loading}
            formatParts={(n) => ({ num: n.toFixed(1), unit: '' })}
            exactText={hasData && sm.cacheHitRate !== null ? String(sm.cacheHitRate * 100) : undefined}
            unit="%"
            note={t('tile.hitNote')}
            spark={hit(pts)}
            partial={partial}
          />
          <StatTile
            testId="tile-ratio"
            icon="ratio"
            title={t('tile.ratio')}
            value={hasData && sm.input > 0 ? sm.output / sm.input : null}
            loading={loading}
            formatParts={(n) => ({ num: n.toFixed(1), unit: '' })}
            exactText={hasData && sm.input > 0 ? String(sm.output / sm.input) : undefined}
            unit="×"
            note={t('tile.ratioNote')}
            spark={ratio(pts)}
            partial={partial}
          />
          <CostTile />
          <StatTile
            testId="tile-runtime"
            icon="clock"
            title={t('tile.runtime')}
            value={hasData ? hours : null}
            loading={loading}
            formatParts={(n) => ({ num: n.toFixed(1), unit: '' })}
            exactText={hasData ? hours.toFixed(2) : undefined}
            unit={t('tile.runtimeUnit')}
            note={hasData ? t('tile.runtimeNote', { range: rangeLabel, days: sm.activeDays }) : undefined}
            hint={hasData ? t('tile.runtimeHint', { sum: ((sm.activeMsSum ?? 0) / HOUR).toFixed(1) }) : undefined}
            spark={pts?.map((p) => (p.activeMs ?? 0) / HOUR)}
            partial={partial}
          />
        </div>
        <PaybackCard />
        <TimeCurve />
        <div className={sec.pair}>
          <HeatmapCard />
          <TodayVsYesterday todayFrom={periods ? periods.today.from : null} yesterdayFrom={periods ? periods.yesterday.from : null} />
        </div>
        {route.params.day && /^\d{4}-\d{2}-\d{2}$/.test(route.params.day) && <DayDetailCard date={route.params.day} />}
      </>
    );
  }

  return (
    <div className={s.page} data-testid="content" data-page="overview" data-project={project} data-ready={ready ? 'true' : 'false'} data-basis={basis} data-range={range}>
      <PageHeader title={title} subtitle={subtitle} actions={bare ? undefined : <FilterBar after={<ExportMenu query={filterQuery(route, basis)} />} />} titleTestId="page-title" />
      {body}
    </div>
  );
}

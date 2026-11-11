import { useEffect, useMemo, useRef, useState } from 'react';
import type { EChartsOption } from 'echarts';
import { useProjects } from '../api/hooks.ts';
import type { SessionDetailPayload, SessionsPayload } from '../api/types.ts';
import { useApi } from '../api/useApi.ts';
import { withAlpha } from '../charts/colors.ts';
import { readChartColors } from '../charts/readColors.ts';
import { EChart } from '../charts/EChart.tsx';
import { Chip, RoundButton } from '../design/Button.tsx';
import { Card } from '../design/Card.tsx';
import { Icon } from '../design/icons.tsx';
import { Popover, popoverStyles as p } from '../design/Popover.tsx';
import { Skeleton } from '../design/Skeleton.tsx';
import { StatePanel } from '../design/StatePanel.tsx';
import { durationParts, formatDateTime, formatDuration, formatExact, formatTokens } from '../lib/format.ts';
import { markReady } from '../lib/perf.ts';
import { findProject } from '../lib/projects.ts';
import { filterQuery } from '../lib/query.ts';
import { FilterBar } from '../layout/FilterBar.tsx';
import { DataRootAlert } from '../layout/DataRootAlert.tsx';
import { PageHeader } from '../layout/PageHeader.tsx';
import { hashFor, navigate, useRoute } from '../state/route.ts';
import { useBasis, useStore, useT } from '../state/store.ts';
import { ExportMenu } from '../features/export/ExportMenu.tsx';
import { CostValue } from '../features/cost/CostValue.tsx';
import { SessionCostCell } from './overview/CostSlots.tsx';
import s from './Sessions.module.css';

const PAGE_SIZE = 10;
type SortKey = 'tokens' | 'requests' | 'start' | 'duration';
const SORT_KEYS: readonly SortKey[] = ['tokens', 'requests', 'start', 'duration'];

const FONT = 'Outfit, "Noto Sans SC", "HarmonyOS Sans SC", "Microsoft YaHei", system-ui, sans-serif';

// ---------------------------------------------------------------------------
// 会话详情
// ---------------------------------------------------------------------------
function SessionDetail({ id }: { id: string }) {
  const t = useT();
  const route = useRoute();
  const basis = useBasis();
  const theme = useStore((x) => x.resolvedTheme);
  const tz = useStore((x) => x.status?.today?.tz ?? 'UTC');
  const path = `/api/sessions/${encodeURIComponent(id)}?basis=${basis}`;
  const q = useApi<SessionDetailPayload>(path);
  const c = useMemo(() => readChartColors(), [theme]);
  const d = q.data && q.data.id === id ? q.data : null;
  const host = useRef<HTMLDivElement>(null);
  // 直达 #/sessions/<id> 或点击列表行后，把详情卡滚到可视区顶部（详情在列表下方，否则要手动下滑才看得到）；
  // 等详情数据到位后再滚，避免列表 / 详情加载引起的布局抖动把它顶走
  const ready = d !== null;
  useEffect(() => {
    if (!ready) return;
    const t = window.setTimeout(() => host.current?.scrollIntoView({ block: 'start' }), 60);
    return () => window.clearTimeout(t);
  }, [id, ready]);

  const charts = useMemo(() => {
    if (!d) return null;
    const n = d.requests.length;
    const labels = d.requests.map((_, i) => String(i + 1));
    const base = {
      animationDuration: 500,
      animationDurationUpdate: 300,
      textStyle: { fontFamily: FONT },
      grid: { left: 4, right: 14, top: 22, bottom: 4, containLabel: true },
    };
    const tooltipBase = { trigger: 'axis' as const, confine: true, backgroundColor: c.card, borderColor: c.line, borderWidth: 1, padding: 0, extraCssText: 'border-radius:16px;box-shadow:0 8px 28px rgba(0,0,0,.14);' };
    const yAxis = { type: 'value' as const, min: 0, splitNumber: 2, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: c.muted, fontSize: 11.5, formatter: (v: number) => formatTokens(v) }, splitLine: { lineStyle: { color: c.grid, type: [3, 5] as unknown as 'dashed' } } };
    const xAxis = (bar: boolean) => ({ type: 'category' as const, data: labels, boundaryGap: bar, axisTick: { show: false }, axisLine: { lineStyle: { color: c.grid } }, axisLabel: { color: c.muted, fontSize: 11.5, hideOverlap: true } });
    const row = (color: string, name: string, v: number): string => `<div style="display:flex;justify-content:space-between;gap:16px;padding:2px 0"><span style="display:flex;align-items:center;gap:8px;color:${c.text2}"><span style="width:8px;height:8px;border-radius:2px;background:${color}"></span>${name}</span><span style="font-weight:600;font-variant-numeric:tabular-nums;color:${c.text}">${formatExact(v)}</span></div>`;
    const bars: EChartsOption = {
      ...base,
      tooltip: {
        ...tooltipBase,
        formatter: (params: unknown): string => {
          const i = (params as Array<{ dataIndex: number }>)[0]?.dataIndex ?? 0;
          const r = d.requests[i];
          if (!r) return '';
          return `<div style="min-width:220px;padding:14px 16px;font-size:12.5px"><div style="font-weight:600;font-size:13px;margin-bottom:2px;color:${c.text}">${t('sessions.requestN', { n: i + 1 })}${r.isSidechain ? ` · ${t('sessions.sidechainTag')}` : ''}</div><div style="color:${c.muted};margin-bottom:8px">${formatDateTime(r.ts, tz)} · ${r.modelDisplay}</div>${row(c.type.input, t('type.input'), r.input)}${row(c.type.cacheWrite, t('type.cacheWrite'), r.cacheWrite)}${basis === 'fresh' ? '' : row(c.type.cacheRead, t('type.cacheRead'), r.cacheRead)}${row(c.type.output, t('type.output'), r.output)}<div style="display:flex;justify-content:space-between;margin-top:8px;padding-top:8px;border-top:1px solid ${c.line};font-weight:600;color:${c.text}"><span>${t('sessions.statTokens')}</span><span style="font-variant-numeric:tabular-nums">${formatExact(r.value)}</span></div></div>`;
        },
      },
      xAxis: xAxis(true),
      yAxis,
      series: [{ id: 'req', type: 'bar', data: d.requests.map((r) => ({ value: r.value, itemStyle: { color: r.isSidechain ? c.blue : c.accent, borderRadius: [2, 2, 0, 0] } })), barCategoryGap: n > 120 ? '10%' : '30%' }] as EChartsOption['series'],
    };
    const ctx: EChartsOption = {
      ...base,
      tooltip: {
        ...tooltipBase,
        formatter: (params: unknown): string => {
          const i = (params as Array<{ dataIndex: number }>)[0]?.dataIndex ?? 0;
          const r = d.requests[i];
          if (!r) return '';
          return `<div style="padding:12px 16px;font-size:12.5px"><div style="font-weight:600;margin-bottom:6px;color:${c.text}">${t('sessions.requestN', { n: i + 1 })}</div>${row(c.blue, t('sessions.context'), r.context)}${d.compactions.includes(i) ? `<div style="color:${c.muted};margin-top:4px">${t('sessions.compaction')}</div>` : ''}</div>`;
        },
      },
      xAxis: xAxis(false),
      yAxis,
      series: [
        {
          id: 'ctx',
          type: 'line',
          data: d.requests.map((r) => r.context),
          smooth: false,
          showSymbol: n <= 1,
          symbol: 'circle',
          symbolSize: 8,
          lineStyle: { width: 2.2, color: c.blue, join: 'round', cap: 'round' },
          itemStyle: { color: c.blue },
          areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: withAlpha(c.blue, 0.24) }, { offset: 1, color: withAlpha(c.blue, 0) }] } },
          markLine: {
            symbol: 'none',
            silent: true,
            animation: false,
            lineStyle: { color: c.muted, type: [3, 4] as unknown as 'dashed', width: 1 },
            label: { show: true, formatter: t('sessions.compaction'), color: c.muted, fontSize: 11.5, position: 'end' },
            data: d.compactions.map((i) => ({ xAxis: i })),
          },
        },
      ] as EChartsOption['series'],
    };
    return { bars, ctx };
  }, [d, c, basis, tz, t]);

  if (q.error && !d) {
    return (
      <StatePanel
        icon="list"
        tone="amber"
        testId="session-not-found"
        title={q.error.status === 404 ? t('sessions.notFound') : t('sessions.loadError', { reason: q.error.message })}
        action={
          <Chip primary onClick={() => navigate({ rest: [] })}>
            {t('sessions.notFoundBack')}
          </Chip>
        }
      />
    );
  }

  const comp = d?.composition;
  const compRows = comp
    ? [
        { key: 'cacheRead', name: t('type.cacheRead'), v: basis === 'fresh' ? 0 : comp.cacheRead, color: c.type.cacheRead },
        { key: 'output', name: t('type.output'), v: comp.output, color: c.type.output },
        { key: 'cacheWrite', name: t('type.cacheWrite'), v: comp.cacheWrite, color: c.type.cacheWrite },
        { key: 'input', name: t('type.input'), v: comp.input, color: c.type.input },
      ].filter((r) => !(basis === 'fresh' && r.key === 'cacheRead'))
    : [];
  const compTotal = compRows.reduce((a, r) => a + r.v, 0);
  const maxTool = Math.max(1, ...(d?.tools.map((x) => x.count) ?? [1]));
  const dur = d ? durationParts(d.durationMs) : [];

  return (
    <Card className={s.detail} data-testid="session-detail" data-session-id={id} data-ready={d ? 'true' : 'false'}>
      <div ref={host} className={s.dHead}>
        <div style={{ minWidth: 0 }}>
          <div className={s.kicker}>{t('sessions.detail')}</div>
          <h2 className={s.dTitle} data-testid="detail-title">
            {d ? (d.title ?? t('sessions.untitled', { id: id.slice(0, 8) })) : <Skeleton width={260} height={26} />}
          </h2>
          <div className={s.dMeta}>{d ? `${d.projectName} · ${formatDateTime(d.firstTs, tz)} – ${formatDateTime(d.lastTs, tz)}${d.sidechainRequests > 0 ? ` · ${t('sessions.sidechainCount', { n: d.sidechainRequests })}` : ''}` : ''}</div>
        </div>
        <div className={s.stats}>
          <div>
            <div className={s.statLabel}>{t('sessions.statRequests')}</div>
            <div className={`num ${s.statVal}`} data-testid="detail-requests" data-value={d?.requestCount ?? ''}>
              {d ? d.requestCount.toLocaleString('en-US') : '—'}
            </div>
          </div>
          <div>
            <div className={s.statLabel}>{t('sessions.statTokens')}</div>
            <div className={`num ${s.statVal}`} data-testid="detail-tokens" data-value={d?.composition.value ?? ''} title={d ? formatExact(d.composition.value) : undefined}>
              {d ? formatTokens(d.composition.value) : '—'}
            </div>
          </div>
          <div>
            <div className={s.statLabel}>{t('sessions.statCost')}</div>
            <div className={`num ${s.statVal}`} data-testid="detail-cost">
              {d ? <CostValue cost={d.cost} /> : '—'}
            </div>
          </div>
          <div>
            <div className={s.statLabel}>{t('sessions.statDuration')}</div>
            <div className={`num ${s.statVal}`} data-testid="detail-duration" data-value={d?.durationMs ?? ''}>
              {dur.length === 0 ? '—' : dur.map((x, i) => (
                <span key={i}>
                  {x.n}
                  <span className="unit" style={{ fontSize: 14, margin: '0 6px 0 3px' }}>
                    {x.unit}
                  </span>
                </span>
              ))}
            </div>
          </div>
        </div>
        <RoundButton small aria-label={t('sessions.detailBack')} title={t('sessions.detailBack')} data-testid="detail-close" onClick={() => navigate({ rest: [] })}>
          <Icon name="close" size={16} strokeWidth={2} />
        </RoundButton>
      </div>

      <div className={s.g2}>
        <div className={s.col}>
          <div className={s.colTitle}>
            {t('sessions.perRequest')}
            <span className={s.colSub}>{d ? t('sessions.perRequestSub', { n: d.requestCount }) : ''}</span>
          </div>
          {charts ? <EChart option={charts.bars} height={200} testId="session-bars" ariaLabel={t('sessions.perRequest')} dataAttrs={{ points: d!.requests.length, sum: d!.requests.reduce((a, r) => a + r.value, 0), values: JSON.stringify(d!.requests.map((r) => r.value)) }} /> : <Skeleton height={200} radius={16} />}
        </div>
        <div className={s.col}>
          <div className={s.colTitle}>
            {t('sessions.context')}
            <span className={s.colSub}>{t('sessions.contextSub')}</span>
          </div>
          {charts ? <EChart option={charts.ctx} height={200} testId="session-context" ariaLabel={t('sessions.context')} dataAttrs={{ points: d!.requests.length, compactions: d!.compactions.join(','), values: JSON.stringify(d!.requests.map((r) => r.context)) }} /> : <Skeleton height={200} radius={16} />}
        </div>
      </div>

      <div className={s.g2}>
        <div className={s.col}>
          <div className={s.colTitle}>{t('sessions.composition')}</div>
          <div className={s.compBar} role="img" aria-label={compRows.map((r) => `${r.name} ${compTotal > 0 ? Math.round((r.v / compTotal) * 100) : 0}%`).join(', ')} data-testid="session-composition" data-total={compTotal}>
            {compRows.map((r) => (
              <span key={r.key} style={{ width: `${compTotal > 0 ? (r.v / compTotal) * 100 : 0}%`, background: r.color }} data-type={r.key} data-value={r.v} />
            ))}
          </div>
          <div className={s.legendWrap}>
            {compRows.map((r) => (
              <span key={r.key} className={s.legendItem}>
                <span className={s.sw} style={{ background: r.color }} />
                {r.name} {formatTokens(r.v)}
              </span>
            ))}
          </div>
        </div>
        <div className={s.col}>
          <div className={s.colTitle}>{t('sessions.tools')}</div>
          {d && d.tools.length === 0 && <div style={{ color: 'var(--muted)', fontSize: 13 }}>{t('sessions.noTools')}</div>}
          <ul className={s.tools} data-testid="session-tools">
            {d?.tools.slice(0, 8).map((x) => (
              <li key={x.name} className={s.toolRow} data-tool={x.name} data-count={x.count}>
                <span className={s.toolName} title={x.name}>
                  {x.name}
                </span>
                <span className={s.track8}>
                  <span style={{ display: 'block', width: `${(x.count / maxTool) * 100}%`, height: '100%', borderRadius: 999, background: 'var(--accent)' }} />
                </span>
                <span className="num" style={{ textAlign: 'right' }}>
                  {x.count}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 会话页
// ---------------------------------------------------------------------------
/** 会话页：表格（排序 / 搜索 / 项目 / 模型 / 日期筛选 / 分页）+ 会话详情；URL 可直达 `#/sessions/<id>`, 筛选状态都在 URL 里。 */
export function SessionsPage() {
  const t = useT();
  const route = useRoute();
  const basis = useBasis();
  const tz = useStore((x) => x.status?.today?.tz ?? 'UTC');
  const projects = useProjects();
  const selectedId = route.rest[0] ?? '';

  const sortParam = route.params.sort;
  const sort: SortKey = (SORT_KEYS as readonly string[]).includes(sortParam ?? '') ? (sortParam as SortKey) : 'tokens';
  const dir = route.params.dir === 'asc' ? 'asc' : 'desc';
  const page = Math.max(1, Number(route.params.page ?? '1') || 1);
  const qText = route.params.q ?? '';

  const path = `/api/sessions?${filterQuery(route, basis, { extra: { q: qText || undefined, sort, dir, page, pageSize: PAGE_SIZE } })}`;
  const list = useApi<SessionsPayload>(path);
  const data = list.data;

  useEffect(() => {
    if (list.loadedKey === path && !list.loading) markReady(route.project);
  }, [list.loadedKey, list.loading, path, route.project]);

  // 搜索框：本地输入 + 防抖写入 URL
  const [text, setText] = useState(qText);
  useEffect(() => setText(qText), [qText]);
  useEffect(() => {
    if (text === qText) return;
    const id = setTimeout(() => navigate({ params: { q: text || undefined, page: undefined } }, { replace: true }), 250);
    return () => clearTimeout(id);
  }, [text, qText]);

  const cur = route.project === 'all' ? undefined : findProject(projects.data?.projects, route.project);
  const projectLabel = route.project === 'all' ? t('sidebar.all') : route.project === 'scratch' ? t('sidebar.scratch') : (cur?.displayName ?? route.project);

  const setSort = (k: SortKey): void => navigate({ params: { sort: k, dir: k === sort && dir === 'desc' ? 'asc' : 'desc', page: undefined } }, { replace: true });
  const colLabel: Record<SortKey, string> = { tokens: t('sessions.colTokens'), requests: t('sessions.colRequests'), start: t('sessions.colStart'), duration: t('sessions.colDuration') };
  const arrow = (k: SortKey): string => (k === sort ? (dir === 'desc' ? ' ↓' : ' ↑') : '');
  const th = (k: SortKey, right = false) => (
    <th scope="col" className={right ? s.r : undefined} aria-sort={k === sort ? (dir === 'desc' ? 'descending' : 'ascending') : 'none'}>
      <button type="button" className={s.sortBtn} aria-pressed={k === sort} aria-label={t('sessions.sortBy', { col: colLabel[k] })} data-testid={`sort-${k}`} onClick={() => setSort(k)}>
        {colLabel[k]}
        {arrow(k)}
      </button>
    </th>
  );

  const total = data?.total ?? 0;
  const from = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const to = Math.min(total, page * PAGE_SIZE);
  const hasPrev = page > 1;
  const hasNext = page * PAGE_SIZE < total;

  const searchBox = (
    <label className={s.search}>
      <Icon name="search" size={16} />
      <input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder={t('sessions.searchPlaceholder')} aria-label={t('sessions.searchAria')} data-testid="session-search" />
    </label>
  );
  const projectChip = (
    <Popover
      role="listbox"
      ariaLabel={t('sidebar.projects')}
      trigger={({ open, toggle }) => (
        <Chip aria-haspopup="listbox" aria-expanded={open} aria-label={t('sidebar.projects')} data-testid="session-project-button" onClick={toggle}>
          {t('sessions.projectPrefix', { v: projectLabel })}
          <Icon name="chevronDown" size={14} strokeWidth={2} />
        </Chip>
      )}
    >
      {({ close }) => (
        <div className={p.scroll}>
          {[{ id: 'all', name: t('sidebar.all') }, ...(projects.data?.projects ?? []).map((x) => ({ id: x.id, name: x.isScratchGroup ? t('sidebar.scratch') : x.displayName }))].map((x) => (
            <button
              key={x.id}
              type="button"
              role="option"
              aria-selected={x.id === route.project}
              className={p.item}
              data-project-id={x.id}
              onClick={() => {
                navigate({ project: x.id, rest: [], params: { page: undefined } });
                close();
              }}
            >
              <span className={p.grow}>{x.name}</span>
            </button>
          ))}
        </div>
      )}
    </Popover>
  );

  return (
    <div className={s.page} data-testid="content" data-page="sessions" data-project={route.project} data-ready={list.loadedKey === path && !list.loading ? 'true' : 'false'} data-range={route.filters.range} data-selected={selectedId}>
      <PageHeader title={t('sessions.title')} subtitle={t('sessions.subtitle', { sort: colLabel[sort], dir: dir === 'desc' ? t('sessions.dirDesc') : t('sessions.dirAsc') })} actions={<FilterBar before={<>{searchBox}{projectChip}</>} after={<ExportMenu query={filterQuery(route, basis)} defaultKind="session" />} />} titleTestId="page-title" />
      <DataRootAlert />

      <Card className={s.tableCard} padding="none" data-testid="sessions-card" data-total={total}>
        {list.error && !data ? (
          <div className={s.empty}>{t('sessions.loadError', { reason: list.error.message })}</div>
        ) : !data ? (
          <div style={{ padding: 14 }}>
            <Skeleton height={320} radius={16} />
          </div>
        ) : (
          <>
            <div className={s.scroll}>
              <table className={s.table} data-testid="sessions-table">
                <thead>
                  <tr>
                    <th scope="col">{t('sessions.colTitle')}</th>
                    <th scope="col">{t('sessions.colProject')}</th>
                    {th('start')}
                    {th('duration', true)}
                    {th('requests', true)}
                    {th('tokens', true)}
                    <th scope="col" className={s.r}>
                      {t('sessions.colCost')}
                    </th>
                    <th scope="col">{t('sessions.colModel')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={r.id} className={s.row} aria-selected={r.id === selectedId} data-testid="session-row" data-session-id={r.id} data-requests={r.requests} data-value={r.value} onClick={() => navigate({ rest: [r.id] })}>
                      <td>
                        <a className={s.titleLink} href={hashFor(route, { rest: [r.id] })} title={r.title ?? r.id} data-testid="session-title" onClick={(e) => e.stopPropagation()}>
                          {r.title ?? t('sessions.untitled', { id: r.id.slice(0, 8) })}
                        </a>
                      </td>
                      <td className={s.dim}>{r.projectId === 'scratch' ? t('sidebar.scratch') : r.projectName}</td>
                      <td className={`num ${s.dim} ${s.medium}`}>{formatDateTime(r.firstTs, tz)}</td>
                      <td className={`num ${s.r} ${s.medium}`}>{formatDuration(r.durationMs)}</td>
                      <td className={`num ${s.r} ${s.medium}`}>{r.requests.toLocaleString('en-US')}</td>
                      <td className={`num ${s.r}`} title={formatExact(r.value)}>
                        {formatTokens(r.value)}
                      </td>
                      <td className={`${s.r}`} style={{ color: 'var(--text2)' }}>
                        <SessionCostCell cost={r.cost} />
                      </td>
                      <td className={s.dim}>
                        {r.mainModel ? r.mainModel.display : '—'}
                        {r.mainModel?.isLocal && <span className={s.local}>{t('sessions.local')}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {data.rows.length === 0 && <div className={s.empty}>{qText ? t('sessions.showingNone') : t('sessions.empty')}</div>}
            </div>
            <div className={s.foot}>
              <span data-testid="sessions-footer">{total === 0 ? t('sessions.showingNone') : t('sessions.showing', { from, to, total })}</span>
              <span className={s.pager}>
                <Chip small disabled={!hasPrev} data-testid="page-prev" onClick={() => navigate({ params: { page: String(page - 1) } })}>
                  {t('sessions.prev')}
                </Chip>
                <Chip small disabled={!hasNext} data-testid="page-next" onClick={() => navigate({ params: { page: String(page + 1) } })}>
                  {t('sessions.next')}
                </Chip>
              </span>
            </div>
          </>
        )}
      </Card>

      {selectedId && <SessionDetail id={selectedId} />}
    </div>
  );
}

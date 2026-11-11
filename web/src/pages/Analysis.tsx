import { useEffect, useMemo } from 'react';
import type { ReactNode } from 'react';
import type { EChartsOption } from 'echarts';
import { useProjects } from '../api/hooks.ts';
import type { ModelRowApi, SessionBrief } from '../api/types.ts';
import { CostValue } from '../features/cost/CostValue.tsx';
import type { CostBlock } from '../features/cost/types.ts';
import { useApi } from '../api/useApi.ts';
import { withAlpha } from '../charts/colors.ts';
import { readChartColors } from '../charts/readColors.ts';
import { chartTooltip } from '../charts/tooltip.ts';
import { EChart } from '../charts/EChart.tsx';
import { Card } from '../design/Card.tsx';
import { Donut } from '../design/Donut.tsx';
import { Pill } from '../design/Pill.tsx';
import { Segmented } from '../design/Segmented.tsx';
import { Skeleton } from '../design/Skeleton.tsx';
import { formatClock, formatDateTime, formatDuration, formatExact, formatPercent, formatTokens } from '../lib/format.ts';
import { markReady } from '../lib/perf.ts';
import { findProject } from '../lib/projects.ts';
import { filterQuery } from '../lib/query.ts';
import { FilterBar } from '../layout/FilterBar.tsx';
import { DataRootAlert } from '../layout/DataRootAlert.tsx';
import { PageHeader } from '../layout/PageHeader.tsx';
import { hashFor, navigate, useRoute } from '../state/route.ts';
import { useRangeLabel } from '../state/period.ts';
import { useBasis, useStore, useT } from '../state/store.ts';
import s from './Analysis.module.css';

// ---- 各端点的响应类型（只声明用到的字段）----
interface ModelsRes {
  total: number;
  mostUsed: string | null;
  models: ModelRowApi[];
}
interface CompositionRes {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  thinking: number;
  total: number;
  fresh: number;
  value: number;
  requests: number;
}
interface ProjectsRes {
  total: number;
  projects: Array<{ id: string; displayName: string; value: number; share: number; requests: number; cost?: CostBlock }>;
}
interface TopRes {
  total: number;
  sessions: Array<SessionBrief & { durationMs: number; share: number; mainModel: { key: string; display: string } | null }>;
}
interface CacheRes {
  hitRate: number | null;
  readPerWrite: number | null;
  points: Array<{ key: string; hitRate: number | null }>;
}
interface GridRes {
  grid: number[][];
  max: number;
  total: number;
}
interface ToolsRes {
  total: number;
  tools: Array<{ name: string; count: number; mcp: boolean }>;
}
interface SideRes {
  main: { value: number; requests: number; share: number };
  sidechain: { value: number; requests: number; share: number };
}
interface LcRes {
  local: { value: number; requests: number; share: number };
  cloud: { value: number; requests: number; share: number };
}
interface QualityRes {
  filesParsed: number;
  assistantRows: number;
  uniqueMessages: number;
  duplicatesDropped: number;
  crossFileDuplicates: number;
  syntheticExcluded: number;
  corruptLines: number;
  emptyFiles: number;
  missingFieldRecords: number;
  missingId: number;
  lastScanMs: number | null;
  lastScanAt: number | null;
}

function useAnalysis<T>(kind: string, extra: Record<string, string | number | undefined> = {}, ignoreModels = false) {
  const route = useRoute();
  const basis = useBasis();
  return useApi<T>(`/api/analysis/${kind}?${filterQuery(route, basis, { extra, ignoreModels })}`);
}

function Head({ title, sub, small, right }: { title: string; sub?: string; small?: boolean; right?: ReactNode }) {
  return (
    <div className={s.head}>
      <div>
        <h2 className={`${s.h2} ${small ? s.h2s : ''}`}>{title}</h2>
        {sub && <div className={s.sub}>{sub}</div>}
      </div>
      {right}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className={s.empty}>{text}</div>;
}

// ---------------------------------------------------------------------------
// A2 构成
// ---------------------------------------------------------------------------
function CompositionCard() {
  const t = useT();
  const basis = useBasis();
  const q = useAnalysis<CompositionRes>('composition');
  const theme = useStore((x) => x.resolvedTheme);
  const c = useMemo(() => readChartColors(), [theme]);
  const d = q.data;
  const rows = d
    ? [
        { key: 'cacheRead', name: t('type.cacheRead'), v: basis === 'fresh' ? 0 : d.cacheRead, color: c.type.cacheRead },
        { key: 'output', name: t('type.output'), v: d.output, color: c.type.output },
        { key: 'cacheWrite', name: t('type.cacheWrite'), v: d.cacheWrite, color: c.type.cacheWrite },
        { key: 'input', name: t('type.input'), v: d.input, color: c.type.input },
      ].filter((r) => !(basis === 'fresh' && r.key === 'cacheRead'))
    : [];
  const total = d ? d.value : 0;
  return (
    <Card className={s.card} data-testid="a-composition" data-total={total}>
      <Head title={t('analysis.composition')} sub={t('analysis.compositionSub')} />
      {!d ? (
        <Skeleton height={196} radius={16} />
      ) : total === 0 ? (
        <Empty text={t('analysis.noActivity')} />
      ) : (
        <>
          <div className={s.donutRow}>
            <Donut size={196} segments={rows.map((r) => ({ key: r.key, color: r.color, value: r.v }))} center={{ main: formatTokens(total), sub: t('analysis.totalLabel') }} ariaLabel={rows.map((r) => `${r.name} ${formatPercent(total > 0 ? r.v / total : 0)}`).join(', ')} testId="donut-composition" />
            <ul className={s.list}>
              {rows.map((r) => (
                <li key={r.key} className={s.listRow} data-testid={`comp-${r.key}`} data-value={r.v}>
                  <span className={s.name}>
                    <span className={s.sw} style={{ background: r.color }} />
                    {r.name}
                  </span>
                  <span className={s.vals}>
                    <span className="num" style={{ fontSize: 14.5 }} title={formatExact(r.v)}>
                      {formatTokens(r.v)}
                    </span>
                    <span className={`num ${s.pct}`}>{formatPercent(total > 0 ? r.v / total : 0)}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div className={s.note} data-testid="comp-thinking" data-thinking={d.thinking} data-output={d.output}>
            <span>{t('analysis.thinking')}</span>
            <span>
              <span className="num" style={{ fontSize: 16 }}>
                {d.output > 0 ? ((d.thinking / d.output) * 100).toFixed(1) : '—'}
              </span>
              <span className="unit" style={{ marginLeft: 2, color: 'var(--text2)' }}>
                %
              </span>
              <span style={{ color: 'var(--text2)', marginLeft: 10 }}>
                {formatTokens(d.thinking)} / {formatTokens(d.output)}
              </span>
            </span>
          </div>
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// A1 模型
// ---------------------------------------------------------------------------
function ModelsCard() {
  const t = useT();
  const route = useRoute();
  const theme = useStore((x) => x.resolvedTheme);
  const q = useAnalysis<ModelsRes>('models');
  const c = useMemo(() => readChartColors(), [theme]);
  const d = q.data;
  const top = d?.models.find((m) => m.key === d.mostUsed);
  const maxV = d ? Math.max(1, ...d.models.map((m) => m.value)) : 1;
  return (
    <Card className={s.card} data-testid="a-models">
      <Head
        title={t('analysis.models')}
        sub={d && d.models.length > 0 ? t('analysis.modelsSub', { top: top?.display ?? '', n: d.models.length }) : t('analysis.modelsSubEmpty')}
        right={
          <Segmented
            ariaLabel={t('analysis.modelGroupAria')}
            size="sm"
            value={route.filters.family ? 'family' : 'raw'}
            testId="model-group-toggle"
            onChange={(v) => navigate({ filters: { family: v === 'family', models: [] } }, { replace: true })}
            options={[
              { value: 'raw', label: t('analysis.modelGroupRaw') },
              { value: 'family', label: t('analysis.modelGroupFamily') },
            ]}
          />
        }
      />
      {!d ? (
        <Skeleton height={220} radius={16} />
      ) : d.models.length === 0 ? (
        <Empty text={t('analysis.noActivity')} />
      ) : (
        <ul className={s.models} data-testid="model-list" data-total={d.total}>
          {d.models.map((m, i) => (
            <li key={m.key} data-testid="model-row" data-model-key={m.key} data-value={m.value} data-share={m.share}>
              <div className={s.modelHead}>
                <span className={s.modelName}>
                  <span className={s.ellipsis} title={m.rawIds.join('\n')}>
                    {route.filters.family ? t(`model.family.${m.key as 'opus' | 'sonnet' | 'haiku' | 'local' | 'other'}`) : m.display}
                  </span>
                  {m.isLocal && <span className={s.local}>{t('model.local')}</span>}
                </span>
                <span className={s.vals}>
                  <span className="num" title={formatExact(m.value)}>
                    {formatTokens(m.value)}
                  </span>
                  <span className={`num ${s.pct}`}>{formatPercent(m.share)}</span>
                </span>
              </div>
              <div className={s.bar}>
                <div className={s.fill} style={{ width: `${(m.value / maxV) * 100}%`, background: c.palette[i % c.palette.length] }} />
              </div>
              <div className={s.muted}>
                {t('analysis.requestsN', { n: m.requests })}
                {!m.isLocal && (
                  <>
                    {' · '}
                    <CostValue cost={m.cost} testId="model-cost" />
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// A5 缓存
// ---------------------------------------------------------------------------
function CacheCard() {
  const t = useT();
  const route = useRoute();
  const rangeName = useRangeLabel();
  const theme = useStore((x) => x.resolvedTheme);
  const q = useAnalysis<CacheRes>('cache-efficiency', { granularity: route.filters.range === 'today' ? 'hour' : 'day' });
  const c = useMemo(() => readChartColors(), [theme]);
  const d = q.data;
  const chart = useMemo(() => {
    if (!d) return null;
    const vals = d.points.map((p) => (p.hitRate === null ? null : p.hitRate * 100));
    const nums = vals.filter((v): v is number => v !== null);
    const min = nums.length > 0 ? Math.min(...nums) : 0;
    const lo = Math.max(0, Math.floor(min / 5) * 5 - (min % 5 === 0 ? 5 : 0));
    const labels = d.points.map((p) => (route.filters.range === 'today' ? `${p.key.slice(11, 13)}:00` : p.key.slice(5)));
    const option: EChartsOption = {
      animationDuration: 600,
      animationDurationUpdate: 380,
      textStyle: { fontFamily: 'Outfit, "Noto Sans SC", "HarmonyOS Sans SC", "Microsoft YaHei", system-ui, sans-serif' },
      grid: { left: 4, right: 14, top: 16, bottom: 4, containLabel: true },
      tooltip: chartTooltip(c, {
        formatter: (params: unknown): string => {
          const i = (params as Array<{ dataIndex: number }>)[0]?.dataIndex ?? 0;
          const v = vals[i];
          return `<div style="padding:10px 14px;font-size:12.5px;background:${c.card};border-radius:14px"><div style="font-weight:600;margin-bottom:4px;color:${c.text}">${labels[i]}</div><div style="color:${c.text2}">${t('analysis.hitRate')} <b style="color:${c.text};font-variant-numeric:tabular-nums">${v === null || v === undefined ? '—' : `${v.toFixed(1)}%`}</b></div></div>`;
        },
      }),
      xAxis: { type: 'category', data: labels, boundaryGap: false, axisTick: { show: false }, axisLine: { lineStyle: { color: c.grid } }, axisLabel: { color: c.muted, fontSize: 12, hideOverlap: true } },
      yAxis: { type: 'value', min: lo, max: 100, splitNumber: 3, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: c.muted, fontSize: 12, formatter: (v: number) => `${v}%` }, splitLine: { lineStyle: { color: c.grid, type: [3, 5] as unknown as 'dashed' } } },
      series: [
        {
          id: 'hit',
          type: 'line',
          data: vals,
          smooth: 0.17,
          connectNulls: true,
          symbol: 'circle',
          symbolSize: 10,
          showSymbol: false,
          lineStyle: { width: 2.2, color: c.accent, cap: 'round' },
          itemStyle: { color: c.card, borderColor: c.accent, borderWidth: 2.5 },
          areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: withAlpha(c.accent, 0.26) }, { offset: 1, color: withAlpha(c.accent, 0) }] } },
        },
      ],
    };
    return { option, vals, min, max: nums.length > 0 ? Math.max(...nums) : 0 };
  }, [d, c, route.filters.range, t]);
  return (
    <Card className={s.card} data-testid="a-cache">
      <Head
        title={t('analysis.cache')}
        sub={t('analysis.cacheSub', { range: rangeName(route.filters.range) })}
        right={
          <div className={s.stats}>
            <div>
              <div className={s.statLabel}>{t('analysis.hitRate')}</div>
              <div className={s.statVal} data-testid="cache-hit" data-value={d?.hitRate ?? ''}>
                <span className="num">{d?.hitRate == null ? '—' : (d.hitRate * 100).toFixed(1)}</span>
                <span className="unit" style={{ fontSize: 14, marginLeft: 4 }}>
                  %
                </span>
              </div>
            </div>
            <div>
              <div className={s.statLabel}>{t('analysis.writeRead')}</div>
              <div className={`num ${s.statVal}`} data-testid="cache-ratio" data-value={d?.readPerWrite ?? ''}>
                {d?.readPerWrite == null ? '—' : `1 : ${d.readPerWrite.toFixed(1)}`}
              </div>
            </div>
          </div>
        }
      />
      {!d ? (
        <Skeleton height={220} radius={16} />
      ) : chart && chart.vals.some((v) => v !== null) ? (
        <EChart option={chart.option} height={220} testId="cache-chart" ariaLabel={t('analysis.cacheAria', { min: `${chart.min.toFixed(0)}%`, max: `${chart.max.toFixed(0)}%` })} dataAttrs={{ values: JSON.stringify(chart.vals) }} />
      ) : (
        <Empty text={t('analysis.noActivity')} />
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// A7 活跃时段
// ---------------------------------------------------------------------------
function lvl(v: number, max: number): number {
  if (v <= 0 || max <= 0) return 0;
  const r = v / max;
  return r > 0.75 ? 4 : r > 0.5 ? 3 : r > 0.25 ? 2 : 1;
}

function ActivityCard() {
  const t = useT();
  const weekStart = useStore((x) => x.settings?.settings.weekStart ?? 'monday');
  const q = useAnalysis<GridRes>('activity-grid');
  const d = q.data;
  const order = weekStart === 'sunday' ? [0, 1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5, 6, 0];
  const busiest = useMemo(() => {
    if (!d || d.total <= 0) return null;
    let best = { day: 0, from: 0, v: -1 };
    for (let day = 0; day < 7; day++) {
      const row = d.grid[day]!;
      for (let h = 0; h + 3 <= 24; h++) {
        const v = row[h]! + row[h + 1]! + row[h + 2]!;
        if (v > best.v) best = { day, from: h, v };
      }
    }
    return best;
  }, [d]);
  const hh = (h: number): string => `${String(h).padStart(2, '0')}:00`;
  return (
    <Card className={`${s.card} ${s.cardTight}`} data-testid="a-activity" data-total={d?.total ?? 0}>
      <Head title={t('analysis.activity')} sub={t('analysis.activitySub')} />
      {!d ? (
        <Skeleton height={180} radius={16} />
      ) : d.total === 0 ? (
        <Empty text={t('analysis.noActivity')} />
      ) : (
        <>
          <div className={s.week} role="img" aria-label={t('analysis.activityAria')} data-testid="activity-grid" data-cells={d.grid.flat().length} data-max={d.max}>
            <div className={s.weekRow}>
              <span />
              {[0, 6, 12, 18].map((h) => (
                <span key={h} className={s.weekHead} style={{ gridColumn: 'span 6' }}>
                  {String(h).padStart(2, '0')}
                </span>
              ))}
            </div>
            {order.map((wd) => (
              <div key={wd} className={s.weekRow} data-weekday={wd}>
                <span className={s.weekLabel}>{t(`weekday.${wd as 0 | 1 | 2 | 3 | 4 | 5 | 6}`)}</span>
                {d.grid[wd]!.map((v, h) => {
                  const l = lvl(v, d.max);
                  return <div key={h} className={`${s.wcell} ${l > 0 ? s[`wl${l}` as 'wl1'] : ''}`} data-testid="activity-cell" data-weekday={wd} data-hour={h} data-value={v} title={`${t(`weekday.${wd as 0 | 1 | 2 | 3 | 4 | 5 | 6}`)} ${hh(h)} · ${formatExact(v)}`} />;
                })}
              </div>
            ))}
          </div>
          {busiest && <div style={{ color: 'var(--text2)', fontSize: 13.5 }}>{t('analysis.busiest', { day: t(`weekday.${busiest.day as 0 | 1 | 2 | 3 | 4 | 5 | 6}`), from: hh(busiest.from), to: hh(busiest.from + 3) })}</div>}
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// A8 工具
// ---------------------------------------------------------------------------
function ToolsCard() {
  const t = useT();
  const q = useAnalysis<ToolsRes>('tools');
  const d = q.data;
  const rows = d?.tools.slice(0, 8) ?? [];
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <Card className={s.card} data-testid="a-tools" data-total={d?.total ?? 0}>
      <Head title={t('analysis.tools')} sub={t('analysis.toolsSub')} />
      {!d ? (
        <Skeleton height={180} radius={16} />
      ) : rows.length === 0 ? (
        <Empty text={t('analysis.noTools')} />
      ) : (
        <ul className={s.simple} style={{ gap: 14 }}>
          {rows.map((r) => (
            <li key={r.name} className={s.toolRow} data-testid="tool-row" data-tool={r.name} data-count={r.count}>
              <span className={s.toolName} title={r.name}>
                {r.name}
              </span>
              <span className={s.track10}>
                <span className={s.fill} style={{ display: 'block', width: `${(r.count / max) * 100}%`, background: 'var(--accent)' }} />
              </span>
              <span className={`num ${s.right}`}>{r.count.toLocaleString('en-US')}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// A3 项目对比 / A9 / A19
// ---------------------------------------------------------------------------
function ProjectsCard() {
  const t = useT();
  const route = useRoute();
  const theme = useStore((x) => x.resolvedTheme);
  const q = useAnalysis<ProjectsRes>('projects');
  const c = useMemo(() => readChartColors(), [theme]);
  const d = q.data;
  const rows = d?.projects.slice(0, 8) ?? [];
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <Card className={`${s.card} ${s.cardTight}`} data-testid="a-projects" data-total={d?.total ?? 0}>
      <Head title={t('analysis.projects')} sub={t('analysis.projectsSub')} small />
      {!d ? (
        <Skeleton height={200} radius={16} />
      ) : rows.length === 0 ? (
        <Empty text={t('analysis.noActivity')} />
      ) : (
        <ul className={s.simple}>
          {rows.map((r, i) => (
            <li key={r.id} data-testid="project-bar" data-project-id={r.id} data-value={r.value}>
              <a className={s.projLink} href={hashFor(route, { project: r.id, rest: [] })}>
                <div className={s.between}>
                  <span className={s.ellipsis}>{r.id === 'scratch' ? t('sidebar.scratch') : r.displayName}</span>
                  <span className="num" title={formatExact(r.value)}>
                    {formatTokens(r.value)}
                    <span className={s.muted}>
                      {' · '}
                      <CostValue cost={r.cost} testId="project-cost" />
                    </span>
                  </span>
                </div>
                <div className={`${s.bar} ${s.barSm}`}>
                  <div className={s.fill} style={{ width: `${(r.value / max) * 100}%`, background: c.palette[i % c.palette.length] }} />
                </div>
              </a>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function SidechainCard() {
  const t = useT();
  const theme = useStore((x) => x.resolvedTheme);
  const q = useAnalysis<SideRes>('sidechain');
  const c = useMemo(() => readChartColors(), [theme]);
  const d = q.data;
  const total = d ? d.main.value + d.sidechain.value : 0;
  return (
    <Card className={`${s.card} ${s.cardTight}`} data-testid="a-sidechain" data-total={total}>
      <Head title={t('analysis.sidechain')} sub={t('analysis.sidechainSub')} small />
      {!d ? (
        <Skeleton height={190} radius={16} />
      ) : total === 0 ? (
        <Empty text={t('analysis.noActivity')} />
      ) : (
        <>
          <div className={s.center}>
            <Donut segments={[{ key: 'main', color: c.accent, value: d.main.value }, { key: 'sidechain', color: c.blue, value: d.sidechain.value }]} center={{ main: formatPercent(d.sidechain.share) }} ariaLabel={`${t('analysis.sub')} ${formatPercent(d.sidechain.share)}, ${t('analysis.main')} ${formatPercent(d.main.share)}`} testId="donut-sidechain" />
          </div>
          <div className={s.legendRows}>
            <div className={s.between} data-testid="side-main" data-value={d.main.value}>
              <span className={s.name}>
                <span className={s.sw} style={{ background: c.accent }} />
                {t('analysis.main')}
              </span>
              <span className="num" title={formatExact(d.main.value)}>
                {formatTokens(d.main.value)}
              </span>
            </div>
            <div className={s.between} data-testid="side-sub" data-value={d.sidechain.value}>
              <span className={s.name}>
                <span className={s.sw} style={{ background: c.blue }} />
                {t('analysis.sub')}
              </span>
              <span className="num" title={formatExact(d.sidechain.value)}>
                {formatTokens(d.sidechain.value)}
              </span>
            </div>
          </div>
        </>
      )}
    </Card>
  );
}

function LocalCloudCard() {
  const t = useT();
  const theme = useStore((x) => x.resolvedTheme);
  const q = useAnalysis<LcRes>('local-vs-cloud');
  const c = useMemo(() => readChartColors(), [theme]);
  const d = q.data;
  const total = d ? d.local.value + d.cloud.value : 0;
  return (
    <Card className={`${s.card} ${s.cardTight}`} data-testid="a-localcloud" data-total={total}>
      <Head title={t('analysis.localCloud')} sub={t('analysis.localCloudSub')} small />
      {!d ? (
        <Skeleton height={190} radius={16} />
      ) : total === 0 ? (
        <Empty text={t('analysis.noActivity')} />
      ) : (
        <>
          <div className={s.center}>
            <Donut segments={[{ key: 'cloud', color: c.accent, value: d.cloud.value }, { key: 'local', color: c.violet, value: d.local.value }]} center={{ main: formatPercent(d.local.share) }} ariaLabel={`${t('analysis.local')} ${formatPercent(d.local.share)}, ${t('analysis.cloud')} ${formatPercent(d.cloud.share)}`} testId="donut-localcloud" />
          </div>
          <div className={s.legendRows}>
            <div className={s.between} data-testid="lc-cloud" data-value={d.cloud.value}>
              <span className={s.name}>
                <span className={s.sw} style={{ background: c.accent }} />
                {t('analysis.cloud')}
              </span>
              <span className="num" title={formatExact(d.cloud.value)}>
                {formatTokens(d.cloud.value)}
              </span>
            </div>
            <div className={s.between} data-testid="lc-local" data-value={d.local.value}>
              <span className={s.name}>
                <span className={s.sw} style={{ background: c.violet }} />
                {t('analysis.local')}
              </span>
              <span className="num" title={formatExact(d.local.value)}>
                {formatTokens(d.local.value)}
              </span>
            </div>
          </div>
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// A4 会话排行
// ---------------------------------------------------------------------------
const TOP_N = 10;
function SessionsTopCard() {
  const t = useT();
  const route = useRoute();
  const tz = useStore((x) => x.status?.today?.tz ?? 'UTC');
  const q = useAnalysis<TopRes>('sessions-top', { limit: TOP_N });
  const d = q.data;
  return (
    <Card className={s.card} data-testid="a-sessions-top">
      <Head title={t('analysis.sessionsTop', { n: TOP_N })} sub={t('analysis.sessionsTopSub')} />
      {!d ? (
        <Skeleton height={240} radius={16} />
      ) : d.sessions.length === 0 ? (
        <Empty text={t('analysis.noSessions')} />
      ) : (
        <div role="list">
          {d.sessions.map((x, i) => (
            <a key={x.id} role="listitem" className={s.topRow} href={hashFor(route, { page: 'sessions', rest: [x.id], params: {} })} data-testid="top-session" data-session-id={x.id} data-value={x.value}>
              <span className={s.rank}>{i + 1}</span>
              <div style={{ minWidth: 0 }}>
                <div className={`${s.rowTitle} ${s.ellipsis}`}>{x.title ?? t('sessions.untitled', { id: x.id.slice(0, 8) })}</div>
                <div className={`${s.rowMeta} ${s.ellipsis}`}>
                  {x.projectName} · {formatDateTime(x.firstTs, tz)} · {formatDuration(x.durationMs)} · {t('analysis.requestsN', { n: x.requests })}
                </div>
              </div>
              <span className={`num ${s.pct}`} style={{ width: 'auto' }}>
                {formatPercent(x.share)}
              </span>
              <span className="num" title={formatExact(x.value)}>
                {formatTokens(x.value)}
              </span>
            </a>
          ))}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// A20 数据质量
// ---------------------------------------------------------------------------
function QualityCard() {
  const t = useT();
  const q = useApi<QualityRes>('/api/analysis/quality');
  const d = q.data;
  const ok = d ? d.corruptLines === 0 && d.emptyFiles === 0 && d.missingFieldRecords === 0 : true;
  const tiles: Array<{ key: string; label: string; value: number | null; unit: string }> = d
    ? [
        { key: 'files', label: t('quality.files'), value: d.filesParsed, unit: t('quality.unitFiles') },
        { key: 'assistantRows', label: t('quality.assistantRows'), value: d.assistantRows, unit: t('quality.unitRows') },
        { key: 'unique', label: t('quality.unique'), value: d.uniqueMessages, unit: t('quality.unitRows') },
        { key: 'dup', label: t('quality.dupDropped'), value: d.duplicatesDropped, unit: t('quality.unitRows') },
        { key: 'crossFile', label: t('quality.crossFile'), value: d.crossFileDuplicates, unit: t('quality.unitRows') },
        { key: 'synthetic', label: t('quality.synthetic'), value: d.syntheticExcluded, unit: t('quality.unitRows') },
        { key: 'corrupt', label: t('quality.corrupt'), value: d.corruptLines, unit: t('quality.unitLines') },
        { key: 'emptyFiles', label: t('quality.emptyFiles'), value: d.emptyFiles, unit: t('quality.unitFiles') },
        { key: 'missingFields', label: t('quality.missingFields'), value: d.missingFieldRecords, unit: t('quality.unitRows') },
      ]
    : [];
  return (
    <Card className={s.card} data-testid="a-quality">
      <Head
        title={t('analysis.quality')}
        sub={t('analysis.qualitySub')}
        right={
          <Pill tone={ok ? 'green' : 'amber'} data-testid="quality-pill">
            {ok ? t('analysis.qualityOk') : t('analysis.qualityWarn')}
          </Pill>
        }
      />
      {!d ? (
        <Skeleton height={200} radius={16} />
      ) : (
        <>
          <div className={s.qGrid}>
            {tiles.map((x) => (
              <div key={x.key} className={s.qTile} data-testid={`quality-${x.key}`} data-value={x.value ?? ''}>
                <div className={s.qLabel}>{x.label}</div>
                <div className={s.qVal}>
                  <span className="num">{x.value === null ? '—' : x.value.toLocaleString('en-US')}</span>
                  <span className={`unit ${s.qUnit}`}>{x.unit}</span>
                </div>
              </div>
            ))}
          </div>
          <div className={s.qFoot}>
            {t('quality.footer', { ms: d.lastScanMs === null ? '—' : `${(d.lastScanMs / 1000).toFixed(1)} ${t('quality.unitSec')}`, time: d.lastScanAt === null ? '—' : formatClock(d.lastScanAt), missing: d.missingId })}
          </div>
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 页面
// ---------------------------------------------------------------------------
/** 分析页：A1–A9、A19、A20（A4 会话排行）。全部随全局筛选联动；A20 是全局数据质量, 不随筛选变化。 */
export function AnalysisPage() {
  const t = useT();
  const route = useRoute();
  const projects = useProjects();
  const cur = route.project === 'all' ? undefined : findProject(projects.data?.projects, route.project);
  const name = route.project === 'all' ? t('sidebar.all') : route.project === 'scratch' ? t('sidebar.scratch') : (cur?.displayName ?? route.project);
  useEffect(() => {
    markReady(route.project);
  }, [route.project]);
  return (
    <div className={s.page} data-testid="content" data-page="analysis" data-project={route.project} data-ready="true" data-range={route.filters.range}>
      <PageHeader title={t('analysis.titleProject', { name })} subtitle={t('analysis.subtitle')} actions={<FilterBar />} titleTestId="page-title" />
      <DataRootAlert />
      <div className={s.g2}>
        <CompositionCard />
        <ModelsCard />
      </div>
      <CacheCard />
      <div className={s.g2}>
        <ActivityCard />
        <ToolsCard />
      </div>
      <div className={s.g3}>
        <ProjectsCard />
        <SidechainCard />
        <LocalCloudCard />
      </div>
      <SessionsTopCard />
      <QualityCard />
    </div>
  );
}

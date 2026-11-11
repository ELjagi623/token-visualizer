import { useEffect, useState } from 'react';
import { Card } from '../../design/Card.tsx';
import { ChipLink } from '../../design/Button.tsx';
import { Pill } from '../../design/Pill.tsx';
import { Segmented } from '../../design/Segmented.tsx';
import { Skeleton } from '../../design/Skeleton.tsx';
import { StatePanel } from '../../design/StatePanel.tsx';
import { DataRootAlert } from '../../layout/DataRootAlert.tsx';
import { PageHeader } from '../../layout/PageHeader.tsx';
import { formatTokens } from '../../lib/format.ts';
import { markReady } from '../../lib/perf.ts';
import { buildHash, useRoute } from '../../state/route.ts';
import { useRangeLabel } from '../../state/period.ts';
import { useBasis, useT } from '../../state/store.ts';
import { ExportMenu } from '../export/ExportMenu.tsx';
import { CostBasisToggle } from './CostBasisToggle.tsx';
import { useCostMode } from './costMode.ts';
import { DailyCostChart } from './DailyCostChart.tsx';
import { formatMultiple, formatUnitPrice, formatUsd } from './format.ts';
import { useCostSummary } from './hooks.ts';
import type { CostSummaryPayload } from './types.ts';
import s from './CostPage.module.css';

type RangeKey = '7d' | '30d' | 'thisMonth' | 'all';
const RANGES: readonly RangeKey[] = ['all', 'thisMonth', '30d', '7d'];

const TYPE_COLOR: Record<string, string> = { output: 'var(--violet)', cacheRead: 'var(--accent)', cacheWrite: 'var(--amber)', input: 'var(--blue)' };

function TypeBars({ data }: { data: CostSummaryPayload }) {
  const t = useT();
  const bt = data.api.byType;
  if (!bt) return null;
  const rows = (['output', 'cacheRead', 'cacheWrite', 'input'] as const).map((k) => ({ k, v: bt[k] }));
  const max = Math.max(...rows.map((r) => r.v), 0.0000001);
  return (
    <ul className={s.types} data-testid="cost-types">
      {rows.map((r) => (
        <li key={r.k} className={s.typeRow}>
          <span className={s.typeName}>{t(`cost.type.${r.k}`)}</span>
          <span className={s.typeTrack}>
            <span className={s.typeFill} style={{ width: `${Math.max(r.v > 0 ? 1.5 : 0, (r.v / max) * 100)}%`, background: TYPE_COLOR[r.k] }} />
          </span>
          <span className={`${s.typeValue} num`} data-testid={`cost-type-${r.k}`}>
            {formatUsd(r.v)}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** 成本模块（独立子视图 #/cost）：两种口径卡 + 每日成本 vs 订阅费 + 按项目两种成本 + 空状态 / 提示。 */
export function CostPage() {
  const t = useT();
  const rangeName = useRangeLabel();
  const route = useRoute();
  const project = route.project;
  const basis = useBasis();
  const mode = useCostMode((x) => x.mode);
  const [range, setRange] = useState<RangeKey>('30d');
  const filter = `project=${encodeURIComponent(project)}&basis=${basis}`;
  const query = `${filter}&range=${range}`;
  const { data, error, loading } = useCostSummary(query);

  useEffect(() => {
    if (data && !loading) markReady(project);
  }, [data, loading, project]);

  const settingsHref = buildHash('settings', project);
  const header = (
    <PageHeader
      title={t('cost.page.title')}
      titleTestId="page-title"
      back={{ label: t('cost.page.back'), href: buildHash('overview', project, [], { filters: route.filters }) }}
      subtitle={t('cost.page.subtitle')}
      actions={
        <>
          <Segmented
            size="sm"
            ariaLabel={t('cost.page.range')}
            testId="cost-range"
            value={range}
            onChange={setRange}
            options={RANGES.map((r) => ({ value: r, label: rangeName(r) }))}
          />
          <CostBasisToggle />
          <ExportMenu query={query} />
        </>
      }
    />
  );

  if (error && !data) {
    return (
      <div className={s.page} data-testid="content" data-page="cost" data-project={project} data-ready="true">
        {header}
        <DataRootAlert />
        <StatePanel icon="alert" tone="pink" title={t('cost.page.error')} desc={error.message} role="alert" testId="cost-error" />
      </div>
    );
  }
  if (!data) {
    return (
      <div className={s.page} data-testid="content" data-page="cost" data-project={project} data-ready="false">
        {header}
        <DataRootAlert />
        <div className={s.g2}>
          <Card>
            <Skeleton width={180} height={20} />
            <Skeleton width={220} height={44} style={{ marginTop: 18 }} />
          </Card>
          <Card>
            <Skeleton width={180} height={20} />
            <Skeleton width={220} height={44} style={{ marginTop: 18 }} />
          </Card>
        </div>
      </div>
    );
  }

  const api = data.api;
  const sub = data.subscription;
  const noPrices = api.totalUsd === null && api.unpricedModels.length > 0;
  const partial = api.totalUsd !== null && api.unpricedModels.length > 0;
  const daysSpan = data.daily.length;
  const lastFee = data.daily[daysSpan - 1]?.feeUsd ?? null;
  const dimDays = sub.monthlyFeeUsd !== null && lastFee !== null && lastFee > 0 ? Math.round(sub.monthlyFeeUsd / lastFee) : null;

  return (
    <div className={s.page} data-testid="content" data-page="cost" data-project={project} data-ready="true">
      {header}
      <DataRootAlert />

      {noPrices && (
        <div className={s.banner} role="status" data-testid="cost-banner-prices">
          <Pill tone="amber">{t('cost.empty.prices.pill')}</Pill>
          <span className={s.bannerText}>{t('cost.empty.prices.desc')}</span>
          <ChipLink href={settingsHref}>{t('cost.empty.prices.action')}</ChipLink>
        </div>
      )}
      {partial && (
        <div className={s.banner} role="status" data-testid="cost-banner-partial">
          <Pill tone="amber">{t('cost.empty.partial.pill')}</Pill>
          <span className={s.bannerText}>{t('cost.empty.partial.desc', { n: api.unpricedModels.length, tokens: formatTokens(api.unpricedTokens), models: api.unpricedModels.join(', ') })}</span>
          <ChipLink href={settingsHref}>{t('cost.empty.partial.action')}</ChipLink>
        </div>
      )}

      <div className={s.g2}>
        <Card as="article" className={`${s.cal} ${mode === 'api' ? s.calOn : ''}`} data-testid="cost-card-api">
          <div className={s.calHead}>
            <span className={s.calTitle}>{t('cost.page.cal1')}</span>
            <Pill tone="blue" size="sm" dot={false}>
              {t('cost.estimate')}
            </Pill>
          </div>
          <div>
            <span className={`${s.bigNum} num`} data-testid="cost-api-total">
              {formatUsd(api.totalUsd)}
            </span>
            <span className={s.unit}>USD</span>
          </div>
          <div className={s.calNote}>{t('cost.page.cal1Note', { range: rangeName(range) })}</div>
          <TypeBars data={data} />
          {(api.unpricedTokens > 0 || api.fastPremiumApplied) && (
            <div className={s.calFoot} data-testid="cost-api-foot">
              {[api.unpricedTokens > 0 ? t('cost.page.api.foot', { tokens: formatTokens(api.unpricedTokens) }) : null, api.fastPremiumApplied ? t('cost.page.api.fastApplied') : null].filter(Boolean).join(' · ')}
            </div>
          )}
        </Card>

        <Card as="article" className={`${s.cal} ${mode === 'sub' ? s.calOn : ''}`} data-testid="cost-card-sub">
          <div className={s.calHead}>
            <span className={s.calTitle}>{t('cost.page.cal2')}</span>
            {sub.configured ? (
              <Pill tone="blue" size="sm" dot={false}>
                {t('cost.estimate')}
              </Pill>
            ) : (
              <Pill tone="blue" size="sm" dot={false}>
                {t('cost.page.needPlan')}
              </Pill>
            )}
          </div>
          {sub.configured ? (
            <>
              <div>
                <span className={`${s.bigNum} num`} data-testid="cost-sub-total">
                  {formatUsd(sub.totalUsd)}
                </span>
                <span className={s.unit}>USD</span>
              </div>
              <div className={s.calNote}>{t('cost.page.cal2Note', { range: rangeName(range) })}</div>
              <div className={s.mini}>
                <div className={s.miniBox}>
                  <div className={s.miniLabel}>{t('cost.page.subPerM')}</div>
                  <div className={s.miniVal}>
                    <span className="num" data-testid="cost-sub-perm">
                      {formatUnitPrice(sub.perMillionTokensUsd)}
                    </span>
                    <span className={s.miniUnit}>{t('cost.page.perM')}</span>
                  </div>
                </div>
                <div className={s.miniBox}>
                  <div className={s.miniLabel}>{t('cost.page.apiPerM')}</div>
                  <div className={s.miniVal}>
                    <span className="num" data-testid="cost-api-perm">
                      {formatUnitPrice(sub.apiPerMillionTokensUsd)}
                    </span>
                    <span className={s.miniUnit}>{t('cost.page.perM')}</span>
                  </div>
                </div>
                <div className={`${s.miniBox} ${s.miniGood}`}>
                  <div className={s.miniLabelOn}>{t('cost.page.multiple')}</div>
                  <div className={s.miniVal}>
                    <span className="num" data-testid="cost-multiple">
                      {formatMultiple(sub.multiple)}
                    </span>
                  </div>
                </div>
                <div className={s.miniBox}>
                  <div className={s.miniLabel}>{t('cost.page.idle')}</div>
                  <div className={s.miniVal}>
                    <span className="num" data-testid="cost-idle">
                      {formatUsd(sub.idleUsd)}
                    </span>
                  </div>
                </div>
              </div>
              <div className={s.calFoot}>
                {dimDays !== null && lastFee !== null ? t('cost.page.sub.foot', { fee: formatUsd(sub.monthlyFeeUsd), days: dimDays, daily: formatUsd(lastFee) }) : t('cost.page.sub.footPlain', { fee: formatUsd(sub.monthlyFeeUsd) })}
              </div>
            </>
          ) : (
            <>
              <div>
                <span className={`${s.bigNum} num`} data-testid="cost-sub-total">
                  —
                </span>
              </div>
              <div className={s.calNote}>{t('cost.empty.sub.desc')}</div>
              <div>
                <ChipLink href={settingsHref} data-testid="cost-setup-sub">
                  {t('cost.empty.sub.action')}
                </ChipLink>
              </div>
            </>
          )}
        </Card>
      </div>

      <Card className={s.sec}>
        <div className={s.secHead}>
          <div>
            <h2 className={s.h2}>{t('cost.chart.title')}</h2>
            <div className={s.h2sub}>{sub.configured && lastFee !== null ? t('cost.chart.sub', { fee: formatUsd(lastFee) }) : t('cost.chart.subNoFee')}</div>
          </div>
        </div>
        {data.daily.length > 0 && api.totalUsd !== null ? <DailyCostChart days={data.daily} feeConfigured={sub.configured} /> : <div className={s.muted} data-testid="cost-chart-empty">{t(data.daily.length === 0 ? 'cost.chart.empty' : 'cost.chart.noPrices')}</div>}
      </Card>

      <Card padding="none" className={s.tableCard}>
        <div className={s.tableHead}>
          <h2 className={s.h2}>{t('cost.table.title')}</h2>
        </div>
        <div className={s.scroll}>
          <table className={s.table} data-testid="cost-project-table">
            <thead>
              <tr>
                <th scope="col">{t('cost.table.project')}</th>
                <th scope="col" className={s.r}>
                  {basis === 'fresh' ? t('cost.table.tokensFresh') : t('cost.table.tokens')}
                </th>
                <th scope="col" className={s.r}>
                  {t('cost.table.api')}
                </th>
                <th scope="col" className={s.r}>
                  {t('cost.table.sub')}
                </th>
                <th scope="col" className={s.r}>
                  {t('cost.table.share')}
                </th>
                <th scope="col" className={s.r}>
                  {t('cost.table.perM')}
                </th>
              </tr>
            </thead>
            <tbody>
              {data.byProject.map((p) => {
                const share = sub.totalUsd && p.cost.subUsd !== null ? p.cost.subUsd / sub.totalUsd : null;
                const perM = p.cost.subUsd !== null && p.tokens > 0 ? p.cost.subUsd / (p.tokens / 1e6) : null;
                return (
                  <tr key={p.id} data-testid="cost-project-row" data-id={p.id}>
                    <td className={s.name}>{p.label}</td>
                    <td className={`${s.r} num`}>{formatTokens(p.tokens)}</td>
                    <td className={`${s.r} num ${mode === 'api' ? s.emph : ''}`} data-testid="cost-row-api">
                      {formatUsd(p.cost.apiUsd)}
                      {p.cost.unpricedModels.length > 0 && (
                        <span className={s.unpriced} title={p.cost.unpricedModels.join(', ')}>
                          *
                        </span>
                      )}
                    </td>
                    <td className={`${s.r} num ${mode === 'sub' ? s.emph : ''}`} data-testid="cost-row-sub">
                      {formatUsd(p.cost.subUsd)}
                    </td>
                    <td className={`${s.r} num ${s.dim}`}>{share === null ? '—' : `${(share * 100).toFixed(1)}%`}</td>
                    <td className={`${s.r} num ${s.dim}`}>{formatUnitPrice(perM)}</td>
                  </tr>
                );
              })}
              <tr className={s.total}>
                <td>{t('cost.table.totalRow')}</td>
                <td className={`${s.r} num`}>{formatTokens(data.tokens)}</td>
                <td className={`${s.r} num`} data-testid="cost-total-api">
                  {formatUsd(api.totalUsd)}
                </td>
                <td className={`${s.r} num`} data-testid="cost-total-sub">
                  {formatUsd(sub.totalUsd)}
                </td>
                <td className={`${s.r} num ${s.dim}`}>{sub.totalUsd ? '100%' : '—'}</td>
                <td className={`${s.r} num ${s.dim}`}>{formatUnitPrice(sub.perMillionTokensUsd)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        {/* notes[0] 是常驻的"成本均为估算"声明，页面副标题已说明，这里只显示条件性提示 */}
        {data.notes.length > 1 && (
          <div className={s.tableFoot}>
            {data.notes.slice(1).map((n, i) => (
              <div key={i}>{n}</div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

import type { ReactNode } from 'react';
import type { PeriodCosts } from './periods.ts';
import { StatTile } from '../../design/StatTile.tsx';
import { useApi } from '../../api/useApi.ts';
import { useStore, useT } from '../../state/store.ts';
import { buildHash, useRoute } from '../../state/route.ts';
import { costOf, useCostMode } from './costMode.ts';
import { formatUsd, pctChange } from './format.ts';
import type { CostBlock } from './types.ts';

interface SummaryWithCost {
  cost: CostBlock;
  periods: PeriodCosts;
}
interface SeriesWithCost {
  points: Array<{ cost?: CostBlock }>;
}

interface CostTileProps {
  /** /api/summary 的查询串（含 range / basis / 筛选；周期卡与范围无关），不带前导 ? */
  summaryQuery: string;
  /** 近 30 天按日序列的查询串（迷你曲线用） */
  dailyQuery: string;
}

/** 指标网格第 8 张卡：本月至今的成本（口径随"成本口径"切换）+ 环比 + 近 30 天迷你曲线 + "估算"标注。 */
export function CostTile({ summaryQuery, dailyQuery }: CostTileProps) {
  const t = useT();
  const route = useRoute();
  const mode = useCostMode((s) => s.mode);
  const configured = useStore((s) => (s.settings?.settings.subscription?.monthlyFeeUsd ?? null) !== null);
  const cycle = useStore((s) => (s.settings?.settings.subscription?.billingDay ?? null) !== null);
  const summary = useApi<SummaryWithCost>(`/api/summary?${summaryQuery}`);
  const daily = useApi<SeriesWithCost>(`/api/timeseries?${dailyQuery}`);

  const periods = summary.data?.periods;
  const cur = periods?.thisMonth.cost;
  const prev = periods?.prevMonth.cost;
  const value = costOf(cur, mode);
  const spark = (daily.data?.points ?? []).map((p) => costOf(p.cost, mode) ?? 0);
  const delta = periods ? pctChange(costOf(cur, mode), costOf(prev, mode)) : undefined;
  const unpriced = (cur?.unpricedModels.length ?? 0) > 0;
  const settingsHref = buildHash('settings', route.project);

  let note: ReactNode;
  if (mode === 'sub' && !configured) {
    note = (
      <a href={settingsHref} data-testid="cost-tile-link">
        {t('cost.tile.noSubscription')}
      </a>
    );
  } else if (value === null && summary.data) {
    note = (
      <a href={settingsHref} data-testid="cost-tile-link">
        {t('cost.tile.noPrices')}
      </a>
    );
  } else if (unpriced) {
    note = (
      <a href={settingsHref} data-testid="cost-tile-link" title={cur?.unpricedModels.join(', ')}>
        {t('cost.tile.partial', { n: cur?.unpricedModels.length ?? 0 })}
      </a>
    );
  } else note = t(mode === 'api' ? (cycle ? 'cost.tile.noteApiCycle' : 'cost.tile.noteApi') : cycle ? 'cost.tile.noteSubCycle' : 'cost.tile.noteSub');

  return (
    <StatTile
      testId="tile-cost"
      icon="dollar"
      title={t(mode === 'api' ? 'cost.tile.titleApi' : 'cost.tile.titleSub')}
      value={mode === 'sub' && !configured ? null : value}
      formatParts={(n) => ({ num: formatUsd(n, { compact: true }), unit: '' })}
      formatNum={(n) => formatUsd(n, { compact: true })}
      exactText={value === null ? undefined : formatUsd(value)}
      deltaPct={delta}
      note={note}
      spark={spark.length > 1 ? spark : [0, 0, 0, 0, 0, 0]}
      loading={summary.data === null}
    />
  );
}

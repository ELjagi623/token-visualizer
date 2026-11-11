import { Card } from '../../design/Card.tsx';
import { ChipLink } from '../../design/Button.tsx';
import { Skeleton } from '../../design/Skeleton.tsx';
import { buildHash, useRoute } from '../../state/route.ts';
import { usePeriodWord } from '../../state/period.ts';
import { useStore, useT } from '../../state/store.ts';
import { formatMultiple, formatUsd } from './format.ts';
import { usePayback } from './hooks.ts';
import s from './PaybackCard.module.css';

const PLAN_LABEL: Record<string, string> = { pro: 'Pro', max5x: 'Max 5x', max20x: 'Max 20x' };

/** 总览"订阅回本"通栏卡：本月至今的等价 API 成本 vs 订阅月费（估算）；未设置订阅方案时给出引导。 */
export function PaybackCard() {
  const t = useT();
  const period = usePeriodWord();
  const route = useRoute();
  const plan = useStore((st) => st.settings?.settings.subscription?.plan ?? null);
  const { data, error } = usePayback();
  const settingsHref = buildHash('settings', route.project);
  const costHref = buildHash('cost', route.project, [], { filters: route.filters });

  if (error && !data) return null;
  if (!data) {
    return (
      <Card className={s.card} data-testid="payback-card" data-state="loading">
        <Skeleton width={160} height={22} />
        <Skeleton width="100%" height={92} />
      </Card>
    );
  }

  const cycle = data.billingDay !== null && data.billingDay !== undefined;
  const planText = plan === 'custom' || plan === null ? t('cost.payback.custom') : (PLAN_LABEL[plan] ?? plan);
  const head = (
    <div className={s.head}>
      <div>
        <h2 className={s.title}>{t('cost.payback.title')}</h2>
        <div className={s.sub}>{cycle ? t('cost.payback.subCycle', { from: data.cycleStart, to: data.cycleEnd }) : t('cost.payback.sub')}</div>
      </div>
      <div className={s.headActions}>
        <ChipLink href={costHref} data-testid="payback-cost-link">
          {t('cost.payback.detail')}
        </ChipLink>
        <ChipLink href={settingsHref} data-testid="payback-plan">
          {data.configured ? t('cost.payback.planChip', { plan: planText, fee: formatUsd(data.monthlyFeeUsd, { compact: true }) }) : t('cost.payback.noPlanChip')}
        </ChipLink>
      </div>
    </div>
  );

  if (!data.configured) {
    return (
      <Card className={s.card} data-testid="payback-card" data-state="unconfigured">
        {head}
        <div className={s.empty}>
          <div className={s.emptyText}>{t('cost.payback.unconfigured')}</div>
          <ChipLink href={settingsHref} primary data-testid="payback-setup">
            {t('cost.payback.setup')}
          </ChipLink>
        </div>
        <p className={s.foot}>{t('cost.payback.foot')}</p>
      </Card>
    );
  }

  const mult = data.multipleMtd;
  const proj = data.projected.multiple;
  const maxMult = Math.max(mult ?? 0, proj ?? 0, 1);
  const barNow = mult === null ? 0 : Math.max(2, Math.min(100, (mult / maxMult) * 100));
  const barProj = proj === null ? 0 : Math.max(2, Math.min(100, (proj / maxMult) * 100));
  const paidBack = data.paidBack;

  return (
    <Card className={s.card} data-testid="payback-card" data-state={paidBack ? 'paid' : 'unpaid'}>
      {head}
      <div className={s.blocks}>
        <div className={s.block}>
          <div className={s.label}>{t(cycle ? 'cost.payback.apiMtdCycle' : 'cost.payback.apiMtd')}</div>
          <div className={s.big} data-testid="payback-api">
            {formatUsd(data.apiUsdMtd)}
          </div>
          <div className={s.hint}>{data.partial ? t('cost.payback.partial', { n: data.unpricedModels.length }) : t('cost.payback.apiHint')}</div>
        </div>
        <div className={s.block}>
          <div className={s.label}>{t(cycle ? 'cost.payback.subMtdCycle' : 'cost.payback.subMtd', { done: data.elapsedDays, total: data.daysInMonth })}</div>
          <div className={s.big} data-testid="payback-prorated">
            {formatUsd(data.proratedFeeUsd)}
          </div>
          <div className={s.hint}>{t('cost.payback.subHint', { fee: formatUsd(data.monthlyFeeUsd) })}</div>
        </div>
        <div className={`${s.block} ${paidBack ? s.good : s.pending}`}>
          <div className={s.labelOn}>{t('cost.payback.multiple')}</div>
          <div className={s.big} data-testid="payback-multiple">
            {formatMultiple(mult)}
          </div>
          <div className={s.hintOn} data-testid="payback-savings">
            {data.apiUsdMtd === null ? t('cost.payback.noData', { period }) : paidBack ? t('cost.payback.saved', { amount: formatUsd(data.savingsUsd) }) : t('cost.payback.notYet')}
          </div>
        </div>
      </div>
      <div className={s.bars}>
        <div className={s.barRow}>
          <span className={s.barLabel}>{t(cycle ? 'cost.payback.barNowCycle' : 'cost.payback.barNow')}</span>
          <span className={s.track}>
            <span className={s.fill} style={{ width: `${barNow}%` }} />
          </span>
          <span className={`${s.barValue} num`}>{formatMultiple(mult)}</span>
        </div>
        <div className={s.barRow}>
          <span className={s.barLabel}>{t(cycle ? 'cost.payback.barProjectedCycle' : 'cost.payback.barProjected')}</span>
          <span className={s.track}>
            <span className={`${s.fill} ${s.fillProj}`} style={{ width: `${barProj}%` }} />
          </span>
          <span className={`${s.barValue} num`} data-testid="payback-projected">
            {formatMultiple(proj)}
          </span>
        </div>
      </div>
      <p className={s.foot}>{t('cost.payback.foot')}</p>
    </Card>
  );
}

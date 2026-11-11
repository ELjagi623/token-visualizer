import { useEffect, useState } from 'react';
import type { SettingsData } from '../../api/types.ts';
import { Segmented } from '../../design/Segmented.tsx';
import { Skeleton } from '../../design/Skeleton.tsx';
import { feeToText, formatUsd, parseFeeInput, parseFxInput } from '../../features/cost/format.ts';
import type { FeeCurrency } from '../../features/cost/format.ts';
import { usePlans } from '../../features/cost/hooks.ts';
import { saveSettings } from '../../features/settings/save.ts';
import { useT } from '../../state/store.ts';
import { Row, Section, Warn } from './parts.tsx';
import s from './Settings.module.css';

type Plan = 'pro' | 'max5x' | 'max20x' | 'custom';

/** 订阅方案：档位分段（预填月费，需核对官方定价页）+ 月费输入；未填月费时口径② 与回本卡不显示。 */
export function SubscriptionSection({ settings }: { settings: SettingsData }) {
  const t = useT();
  const plans = usePlans();
  const sub = { billingDay: null, feeCurrency: 'USD' as FeeCurrency, cnyPerUsd: 7.2, ...(settings.subscription ?? { plan: null, monthlyFeeUsd: null }) };
  const currency: FeeCurrency = sub.feeCurrency;
  const rate = sub.cnyPerUsd;
  const saveBillingDay = async (billingDay: number | null): Promise<void> => {
    const r = await saveSettings({ subscription: { billingDay } });
    setErr(r.ok ? null : r.message);
  };
  const [text, setText] = useState(feeToText(sub.monthlyFeeUsd, currency, rate));
  const [fxText, setFxText] = useState(String(rate));
  const [err, setErr] = useState<string | null>(null);
  const [fxErr, setFxErr] = useState<string | null>(null);
  // 月费 / 币种 / 汇率任一变化（含切换币种、改汇率）→ 输入框按当前币种重新显示（USD 存值不变）
  useEffect(() => setText(feeToText(sub.monthlyFeeUsd, currency, rate)), [sub.monthlyFeeUsd, currency, rate]);
  useEffect(() => setFxText(String(rate)), [rate]);

  const pick = async (plan: Plan): Promise<void> => {
    setErr(null);
    if (plan === 'custom') {
      const r = await saveSettings({ subscription: { plan: 'custom' } });
      if (!r.ok) setErr(r.message);
      return;
    }
    const def = plans.data?.plans.find((p) => p.id === plan);
    // 默认月费核对不到（null）时：只选档位，月费留空要求用户手填
    const r = await saveSettings({ subscription: { plan, monthlyFeeUsd: def?.monthlyFeeUsd ?? null } });
    if (!r.ok) setErr(r.message);
  };

  /** 手改月费（p 为换算后的 USD）：若与当前档位的预置月费不同，自动归为"自定义"。 */
  const feePatch = (p: number | null): { monthlyFeeUsd: number | null; plan: Plan | null } => {
    const def = plans.data?.plans.find((x) => x.id === sub.plan);
    const plan = sub.plan !== null && sub.plan !== 'custom' && def && def.monthlyFeeUsd !== p ? 'custom' : (sub.plan ?? (p === null ? null : 'custom'));
    return { monthlyFeeUsd: p, plan };
  };

  /** 框里的文字是否与已存月费（按当前币种显示）一致：一致就不写回（避免四舍五入把档位误改成"自定义"）。 */
  const unchanged = (txt: string): boolean => txt.trim() === feeToText(sub.monthlyFeeUsd, currency, rate);

  const commit = async (): Promise<void> => {
    if (unchanged(text)) {
      setErr(null);
      return;
    }
    const p = parseFeeInput(text, currency, rate);
    if (p === 'invalid') {
      setErr(t('settings.sub.invalid', { max: currency === 'CNY' ? Math.round(100_000 * rate).toLocaleString('en-US') : '100,000' }));
      return;
    }
    if (p === sub.monthlyFeeUsd) {
      setErr(null);
      return;
    }
    const r = await saveSettings({ subscription: feePatch(p) });
    setErr(r.ok ? null : r.message);
  };

  /** 切换币种：框里已有的数字按汇率换成另一种币种显示；若框里有尚未保存的合法修改，先按旧币种折成 USD 一并保存。 */
  const switchCurrency = async (next: FeeCurrency): Promise<void> => {
    if (next === currency) return;
    setErr(null);
    const patch: Record<string, unknown> = { feeCurrency: next };
    if (!unchanged(text)) {
      const p = parseFeeInput(text, currency, rate);
      if (p !== 'invalid' && p !== sub.monthlyFeeUsd) Object.assign(patch, feePatch(p));
    }
    const r = await saveSettings({ subscription: patch });
    if (!r.ok) setErr(r.message);
  };

  const commitFx = async (): Promise<void> => {
    const v = parseFxInput(fxText);
    if (v === 'invalid') {
      setFxErr(t('settings.sub.fxInvalid'));
      return;
    }
    setFxErr(null);
    if (v === rate) return;
    const r = await saveSettings({ subscription: { cnyPerUsd: v } });
    if (!r.ok) setFxErr(r.message);
  };

  const current = plans.data?.plans.find((p) => p.id === sub.plan);
  const configured = sub.monthlyFeeUsd !== null && sub.monthlyFeeUsd > 0;
  return (
    <Section title={t('settings.sub.title')} desc={t('settings.sub.desc')} testId="settings-subscription">
      <Row title={t('settings.sub.plan')} hint={t('settings.sub.planHint')}>
        {plans.data === null ? (
          <Skeleton width={320} height={40} />
        ) : (
          <Segmented<Plan | 'none'>
            size="sm"
            ariaLabel={t('settings.sub.plan')}
            testId="settings-plan"
            value={sub.plan ?? 'none'}
            onChange={(v) => {
              if (v !== 'none') void pick(v);
            }}
            options={[
              ...plans.data.plans.map((p) => ({ value: p.id as Plan | 'none', label: p.label, title: p.note ?? undefined })),
              { value: 'custom' as const, label: t('settings.sub.custom') },
            ]}
          />
        )}
      </Row>
      {current?.note && sub.plan !== 'custom' && (
        <div className={s.planNote} data-testid="settings-plan-note">
          {current.note}
          {current.checkedAt && ` ${t('settings.sub.checked', { date: current.checkedAt })}`}
        </div>
      )}
      <Row title={t('settings.sub.fee')} hint={t('settings.sub.feeHint')}>
        <div className={s.rowControlEnd}>
          <Segmented<FeeCurrency>
            size="sm"
            ariaLabel={t('settings.sub.currency')}
            testId="settings-fee-currency"
            value={currency}
            onChange={(v) => void switchCurrency(v)}
            options={[
              { value: 'USD', label: 'USD', title: t('settings.sub.currencyUsd') },
              { value: 'CNY', label: 'CNY', title: t('settings.sub.currencyCny') },
            ]}
          />
          <input
            className={`${s.field} ${s.fieldMd}`}
            type="text"
            inputMode="decimal"
            placeholder={t('settings.sub.feePh')}
            value={text}
            aria-label={t('settings.sub.fee')}
            aria-invalid={err !== null}
            data-testid="settings-fee"
            onChange={(e) => {
              setText(e.target.value);
              setErr(null);
            }}
            onBlur={() => void commit()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commit();
            }}
          />
          <span className={s.unit} data-testid="settings-fee-unit">
            {t(currency === 'CNY' ? 'settings.sub.perMonthCny' : 'settings.sub.perMonth')}
          </span>
          {err && <span className={`${s.msg} ${s.msgErr}`}>{err}</span>}
        </div>
      </Row>
      <Row title={t('settings.sub.fx')} hint={t('settings.sub.fxHint')}>
        <div className={s.rowControlEnd}>
          <span className={s.unit}>1 USD =</span>
          <input
            className={`${s.field} ${s.fieldSm}`}
            type="text"
            inputMode="decimal"
            value={fxText}
            aria-label={t('settings.sub.fx')}
            aria-invalid={fxErr !== null}
            data-testid="settings-fx"
            onChange={(e) => {
              setFxText(e.target.value);
              setFxErr(null);
            }}
            onBlur={() => void commitFx()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commitFx();
            }}
          />
          <span className={s.unit}>CNY</span>
          {fxErr && <span className={`${s.msg} ${s.msgErr}`}>{fxErr}</span>}
        </div>
      </Row>
      {currency === 'CNY' && sub.monthlyFeeUsd !== null && (
        <div className={s.planNote} data-testid="settings-fee-usd">
          {t('settings.sub.feeAsUsd', { usd: formatUsd(sub.monthlyFeeUsd) })}
        </div>
      )}
      <Row title={t('settings.sub.billingDay')} hint={t('settings.sub.billingDayHint')}>
        <select
          className={`${s.field} ${s.fieldMd}`}
          style={{ width: 'min(100%, 200px)' }}
          aria-label={t('settings.sub.billingDay')}
          data-testid="settings-billing-day"
          value={sub.billingDay ?? ''}
          onChange={(e) => void saveBillingDay(e.target.value === '' ? null : Number(e.target.value))}
        >
          <option value="">{t('settings.sub.billingDayNone')}</option>
          {Array.from({ length: 31 }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n}>
              {t('settings.sub.billingDayOption', { n })}
            </option>
          ))}
        </select>
      </Row>
      {sub.billingDay != null && sub.billingDay > 28 && <div className={s.planNote}>{t('settings.sub.billingDayShort', { n: sub.billingDay })}</div>}
      {!configured && <Warn testId="settings-sub-warn">{t('settings.sub.warn')}</Warn>}
      {sub.plan !== null && sub.plan !== 'custom' && sub.monthlyFeeUsd === null && <Warn testId="settings-sub-manual">{t('settings.sub.manual')}</Warn>}
    </Section>
  );
}

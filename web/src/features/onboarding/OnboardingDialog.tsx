import { useEffect, useRef, useState } from 'react';
import { Chip } from '../../design/Button.tsx';
import { Segmented } from '../../design/Segmented.tsx';
import { Skeleton } from '../../design/Skeleton.tsx';
import { useStore, useT } from '../../state/store.ts';
import { feeToText, parseFeeInput } from '../cost/format.ts';
import { usePlans } from '../cost/hooks.ts';
import { LanguageToggle } from '../settings/LanguageToggle.tsx';
import { saveSettings } from '../settings/save.ts';
import s from './OnboardingDialog.module.css';

type Plan = 'pro' | 'max5x' | 'max20x' | 'custom';

/**
 * 首次打开的引导：只问两件事——订阅档位与续费日。
 * 服务端 settings.onboarded 为 false 时弹出；"完成"或"稍后设置"都会把它置为 true（之后在设置页仍可修改）。
 */
export function OnboardingDialog() {
  const t = useT();
  const plans = usePlans();
  const settings = useStore((st) => st.settings?.settings ?? null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [fee, setFee] = useState('');
  const [day, setDay] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const card = useRef<HTMLDivElement>(null);
  const open = settings !== null && settings.onboarded === false;
  const rate = 7.2; // 引导里只用美元输入，汇率不参与换算（币种 / 汇率在设置页调整）

  const pick = (p: Plan): void => {
    setPlan(p);
    setErr(null);
    if (p === 'custom') return;
    const def = plans.data?.plans.find((x) => x.id === p);
    setFee(def?.monthlyFeeUsd != null ? feeToText(def.monthlyFeeUsd, 'USD', rate) : '');
  };

  const finish = async (skip: boolean): Promise<void> => {
    if (busy) return;
    const patch: Record<string, unknown> = { onboarded: true };
    if (!skip && plan !== null) {
      const parsed = parseFeeInput(fee, 'USD', rate);
      if (parsed === 'invalid') {
        setErr(t('onboarding.feeInvalid'));
        return;
      }
      patch.subscription = { plan, monthlyFeeUsd: parsed, billingDay: day === '' ? null : Number(day) };
    } else if (!skip && day !== '') {
      patch.subscription = { billingDay: Number(day) };
    }
    setBusy(true);
    const r = await saveSettings(patch);
    setBusy(false);
    if (!r.ok) setErr(r.message);
  };
  const finishRef = useRef(finish);
  finishRef.current = finish;

  // 打开后聚焦；Esc = 稍后设置；Tab 在弹窗内循环
  useEffect(() => {
    if (!open) return;
    const el = card.current;
    el?.querySelector<HTMLElement>('button, select, input')?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        void finishRef.current(true);
        return;
      }
      if (e.key !== 'Tab' || !el) return;
      const items = Array.from(el.querySelectorAll<HTMLElement>('button:not(:disabled), select, input'));
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open) return null;
  return (
    <div className={s.scrim} data-testid="onboarding">
      <div ref={card} className={s.card} role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
        <div className={s.langRow}>
          <LanguageToggle testId="onboarding-language" />
        </div>
        <h2 id="onboarding-title" className={s.title}>
          {t('onboarding.title')}
        </h2>
        <p className={s.sub}>{t('onboarding.sub')}</p>

        <div className={s.field}>
          <div className={s.label}>{t('settings.sub.plan')}</div>
          {plans.data === null ? (
            <Skeleton width={320} height={40} />
          ) : (
            <Segmented<Plan | 'none'>
              ariaLabel={t('settings.sub.plan')}
              testId="onboarding-plan"
              value={plan ?? 'none'}
              onChange={(v) => {
                if (v !== 'none') pick(v);
              }}
              options={[...plans.data.plans.map((p) => ({ value: p.id as Plan | 'none', label: p.label })), { value: 'custom' as const, label: t('settings.sub.custom') }]}
            />
          )}
        </div>

        {plan !== null && (
          <div className={s.field}>
            <label className={s.label} htmlFor="onboarding-fee">
              {t('settings.sub.fee')}
            </label>
            <div className={s.inline}>
              <input id="onboarding-fee" className={s.input} type="text" inputMode="decimal" placeholder={t('settings.sub.feePh')} value={fee} aria-invalid={err !== null} data-testid="onboarding-fee" onChange={(e) => (setFee(e.target.value), setErr(null))} />
              <span className={s.unit}>{t('settings.sub.perMonth')}</span>
            </div>
          </div>
        )}

        <div className={s.field}>
          <label className={s.label} htmlFor="onboarding-day">
            {t('settings.sub.billingDay')}
          </label>
          <select id="onboarding-day" className={s.input} value={day} data-testid="onboarding-day" onChange={(e) => setDay(e.target.value)}>
            <option value="">{t('onboarding.dayNone')}</option>
            {Array.from({ length: 31 }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {t('settings.sub.billingDayOption', { n })}
              </option>
            ))}
          </select>
        </div>

        {err && (
          <div className={s.err} role="alert">
            {err}
          </div>
        )}
        <div className={s.actions}>
          <Chip data-testid="onboarding-skip" disabled={busy} onClick={() => void finish(true)}>
            {t('onboarding.later')}
          </Chip>
          <Chip primary data-testid="onboarding-done" disabled={busy} onClick={() => void finish(false)}>
            {t('onboarding.done')}
          </Chip>
        </div>
      </div>
    </div>
  );
}

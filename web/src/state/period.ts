import type { RangeKind } from './routeCore.ts';
import { useStore, useT } from './store.ts';

/**
 * "本月"一词的口径：
 *   - 设置了续费日 → "本周期"（从续费日起的一个订阅周期）；
 *   - 未设置 → "本自然月"（每月 1 号到月底）。
 * 两者都不叫"本月"：避免被误解成"从今天往前推 30 天"（那是"近 30 天"）。
 */
export function useBillingCycle(): boolean {
  return useStore((s) => (s.settings?.settings.subscription?.billingDay ?? null) !== null);
}

/** 当前口径下的"本周期 / 本自然月"字样。 */
export function usePeriodWord(): string {
  const t = useT();
  return t(useBillingCycle() ? 'period.cycle' : 'period.calMonth');
}

/** 时间范围的显示名：thisMonth 随续费日设置显示为"本周期"或"本自然月"，其余沿用字典。 */
export function useRangeLabel(): (r: RangeKind) => string {
  const t = useT();
  const cycle = useBillingCycle();
  return (r) => (r === 'thisMonth' ? t(cycle ? 'range.thisCycle' : 'range.thisMonth') : t(`range.${r}`));
}

import { useApi } from '../../api/useApi.ts';
import type { PaybackPayload, PlansPayload, PricesPayload, CostSummaryPayload } from './types.ts';

/** 成本汇总：query 是共用的全局筛选参数（project / range / models / mergeFamilies / basis …），不带前导 ?。 */
export function useCostSummary(query: string) {
  return useApi<CostSummaryPayload>(`/api/cost/summary?${query}`);
}

/** 订阅回本（固定"本地时区当月"，无筛选）。 */
export function usePayback() {
  return useApi<PaybackPayload>('/api/subscription/payback');
}

export function usePrices() {
  return useApi<PricesPayload>('/api/prices');
}

export function usePlans() {
  return useApi<PlansPayload>('/api/subscription/plans');
}

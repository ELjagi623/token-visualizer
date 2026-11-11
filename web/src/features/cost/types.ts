/** 成本相关的 API 响应类型（与 src/server/cost/*.ts 的载荷一致）。金额单位 USD；null = 无法计算。 */

export interface CostBlock {
  apiUsd: number | null;
  subUsd: number | null;
  unpricedTokens: number;
  unpricedModels: string[];
}

/** 成本口径：api = 等价 API 成本；sub = 订阅摊销成本 */
export type CostMode = 'api' | 'sub';

export interface CostByType {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

export interface CostGroupRow {
  id: string;
  label: string;
  tokens: number;
  local?: boolean;
  cost: CostBlock;
}

export interface CostSummaryPayload {
  currency: 'USD';
  api: {
    totalUsd: number | null;
    byType: CostByType | null;
    unpricedTokens: number;
    unpricedModels: string[];
    fastPremiumApplied: boolean;
    fastUnconfiguredRecords: number;
    assumedCacheWrite5mTokens: number;
    localRecords: number;
  };
  subscription: {
    configured: boolean;
    plan: string | null;
    monthlyFeeUsd: number | null;
    totalUsd: number | null;
    idleUsd: number | null;
    feeSumUsd: number | null;
    perMillionTokensUsd: number | null;
    apiPerMillionTokensUsd: number | null;
    multiple: number | null;
  };
  tokens: number;
  daily: Array<{ date: string; apiUsd: number | null; feeUsd: number | null }>;
  byProject: CostGroupRow[];
  byModel: CostGroupRow[];
  notes: string[];
}

export interface PaybackPayload {
  configured: boolean;
  month: string;
  /** 续费日（1–31）；null = 按自然月。设置后 elapsedDays / daysInMonth 指订阅周期的已过天数 / 总天数 */
  billingDay: number | null;
  /** 当前周期的起止日期（YYYY-MM-DD，含两端） */
  cycleStart: string;
  cycleEnd: string;
  elapsedDays: number;
  daysInMonth: number;
  apiUsdMtd: number | null;
  monthlyFeeUsd: number | null;
  proratedFeeUsd: number | null;
  multipleMtd: number | null;
  savingsUsd: number | null;
  paidBack: boolean;
  projected: { apiUsd: number | null; multiple: number | null };
  partial: boolean;
  unpricedModels: string[];
}

export interface PriceRuleDto {
  id: string;
  pattern: string;
  match: 'exact' | 'prefix' | 'glob';
  inputUsdPerM: number | null;
  outputUsdPerM: number | null;
  cacheWrite5mUsdPerM: number | null;
  cacheWrite1hUsdPerM: number | null;
  cacheReadUsdPerM: number | null;
  fastMultiplier: number | null;
  sourceUrl: string | null;
  checkedAt: string | null;
  origin?: 'user' | 'builtin';
  complete?: boolean;
}

export interface PricesPayload {
  rules: PriceRuleDto[];
  effective: PriceRuleDto[];
  builtin: PriceRuleDto[];
  defaultsVersion: string;
  builtinCount: number;
  version: number;
  warnings: string[];
}

export interface PlansPayload {
  defaultsVersion: string;
  plans: Array<{ id: 'pro' | 'max5x' | 'max20x'; label: string; monthlyFeeUsd: number | null; sourceUrl: string | null; checkedAt: string | null; note: string | null }>;
}

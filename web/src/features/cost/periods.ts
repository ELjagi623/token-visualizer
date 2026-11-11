import type { CostBlock } from './types.ts';

/** /api/summary 的 periods：每个周期带 `cost`，另有 `costDeltas`（等价 API 成本环比）。 */
export interface PeriodCosts {
  today: { cost: CostBlock };
  yesterday: { cost: CostBlock };
  thisWeek: { cost: CostBlock };
  prevWeek: { cost: CostBlock };
  thisMonth: { cost: CostBlock };
  prevMonth: { cost: CostBlock };
  costDeltas: { today: number | null; week: number | null; month: number | null };
}

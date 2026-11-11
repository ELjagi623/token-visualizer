/**
 * 成本相关界面的接线位（批次 B 预留、批次 C 接线）：
 *   - CostBasisToggle：筛选条里的"成本口径"分段控件（等价 API / 订阅摊销）；
 *   - CostTile：指标网格第 8 张卡（本月至今成本 + 环比 + 近 30 天迷你曲线 + "估算"）；
 *   - PaybackCard：指标网格下方通栏"订阅回本"卡；
 *   - SessionCostCell：会话表"估算成本"列单元格。
 * 实现在 features/cost/，这里只负责把总览的全局筛选（项目 / 模型 / 家族合并 / 口径）喂给它们。
 */
import type { CostBlock } from '../../features/cost/types.ts';
import { CostBasisToggle } from '../../features/cost/CostBasisToggle.tsx';
import { CostTile as CostTileImpl } from '../../features/cost/CostTile.tsx';
import { CostValue } from '../../features/cost/CostValue.tsx';
import { PaybackCard } from '../../features/cost/PaybackCard.tsx';
import { filterQuery } from '../../lib/query.ts';
import { useRoute } from '../../state/route.ts';
import { useBasis } from '../../state/store.ts';

export { CostBasisToggle, PaybackCard };

export function CostTile() {
  const route = useRoute();
  const basis = useBasis();
  return <CostTileImpl summaryQuery={filterQuery(route, basis, { range: 'all' })} dailyQuery={filterQuery(route, basis, { range: '30d', granularity: 'day' })} />;
}

/** 会话表格"估算成本"列的单元格：按成本口径显示该会话的等价 API 成本 / 订阅摊销。 */
export function SessionCostCell({ cost }: { cost?: CostBlock | null }) {
  return <CostValue cost={cost} testId="session-cost" />;
}

import { useT } from '../../state/store.ts';
import { costOf, useCostMode } from './costMode.ts';
import { formatUsd } from './format.ts';
import type { CostBlock } from './types.ts';

/** 行内金额：按当前成本口径显示（等价 API / 订阅摊销）；无法计算 → "—"；含未计价模型时带 * 与说明。悬浮提示"估算"。 */
export function CostValue({ cost, testId }: { cost?: CostBlock | null; testId?: string }) {
  const t = useT();
  const mode = useCostMode((s) => s.mode);
  const unpriced = (cost?.unpricedModels.length ?? 0) > 0;
  // 整行都是未计价模型（等价 API 成本为 null）时，两种口径都显示 "—"（悬浮说明"未计价"），不让订阅摊销口径出现 $0.00*
  const v = unpriced && cost?.apiUsd === null ? null : costOf(cost, mode);
  const tip = [t(mode === 'api' ? 'cost.value.tipApi' : 'cost.value.tipSub'), unpriced ? t('cost.value.tipUnpriced', { models: cost!.unpricedModels.join(', ') }) : ''].filter(Boolean).join(' · ');
  return (
    <span className="num" title={tip} data-testid={testId} data-usd={v ?? ''}>
      {formatUsd(v)}
      {unpriced && v !== null && <span style={{ color: 'var(--pillAmberFg)', marginLeft: 2 }}>*</span>}
    </span>
  );
}

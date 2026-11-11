import { Segmented } from '../../design/Segmented.tsx';
import { useT } from '../../state/store.ts';
import { useCostMode } from './costMode.ts';

/** 筛选条里的"成本口径"分段控件：等价 API（默认）/ 订阅摊销。 */
export function CostBasisToggle({ size = 'sm' }: { size?: 'sm' | 'md' }) {
  const t = useT();
  const mode = useCostMode((s) => s.mode);
  const setMode = useCostMode((s) => s.setMode);
  return (
    <Segmented
      size={size}
      ariaLabel={t('cost.mode.aria')}
      testId="cost-mode"
      value={mode}
      onChange={setMode}
      options={[
        { value: 'api', label: t('cost.mode.api'), title: t('cost.mode.apiTip') },
        { value: 'sub', label: t('cost.mode.sub'), title: t('cost.mode.subTip') },
      ]}
    />
  );
}

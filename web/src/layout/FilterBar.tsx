import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { useApi } from '../api/useApi.ts';
import { Chip } from '../design/Button.tsx';
import { Icon } from '../design/icons.tsx';
import { Popover, popoverStyles as p } from '../design/Popover.tsx';
import { Segmented } from '../design/Segmented.tsx';
import { formatTokens } from '../lib/format.ts';
import { filterQuery } from '../lib/query.ts';
import { CostBasisToggle } from '../pages/overview/CostSlots.tsx';
import { navigate, RANGES, useRoute } from '../state/route.ts';
import { useRangeLabel } from '../state/period.ts';
import { useBasis, useT } from '../state/store.ts';
import s from './FilterBar.module.css';

interface ModelsPayload {
  models: Array<{ key: string; display: string; isLocal: boolean; value: number }>;
}

interface FilterBarProps {
  /** 隐藏时间范围 */
  hideRange?: boolean;
  /** 隐藏口径切换 */
  hideBasis?: boolean;
  /** 追加在最前面的控件（如会话页的搜索框） */
  before?: ReactNode;
  /** 追加在最后面的控件 */
  after?: ReactNode;
  /** 隐藏"成本口径"预留位 */
  hideCost?: boolean;
}

/**
 * 全局筛选条（总览 / 分析 / 会话共用）：时间范围、模型多选 + 家族合并、口径 Total ⇄ Fresh、（预留）成本口径。
 * 状态全部写进 URL（hash 查询串），刷新 / 后退 / 分享都能还原。
 */
export function FilterBar({ hideRange, hideBasis, before, after, hideCost }: FilterBarProps) {
  const t = useT();
  const rangeName = useRangeLabel();
  const route = useRoute();
  const basis = useBasis();
  const f = route.filters;

  // 模型候选：不受模型筛选自身影响（只用项目 + 家族合并 + 范围 all）
  const modelsPath = `/api/analysis/models?${filterQuery(route, basis, { range: 'all', ignoreModels: true, extra: { mergeFamilies: f.family ? 'true' : undefined } })}`;
  const models = useApi<ModelsPayload>(modelsPath);
  const options = useMemo(() => models.data?.models ?? [], [models.data]);
  const label = useMemo(() => {
    if (f.models.length === 0) return t('filter.modelsAll');
    if (f.models.length === 1) return options.find((m) => m.key === f.models[0])?.display ?? f.models[0]!;
    return t('filter.modelsN', { n: f.models.length });
  }, [f.models, options, t]);

  const toggleModel = (key: string): void => {
    const next = f.models.includes(key) ? f.models.filter((x) => x !== key) : [...f.models, key];
    navigate({ filters: { models: next } }, { replace: true });
  };

  return (
    <div className={s.bar} data-testid="filter-bar">
      {before}
      {!hideRange && (
        <Popover
          role="listbox"
          ariaLabel={t('filter.range')}
          trigger={({ open, toggle }) => (
            <Chip aria-haspopup="listbox" aria-expanded={open} aria-label={t('filter.range')} data-testid="range-button" data-range={f.range} onClick={toggle}>
              <Icon name="cal" size={16} />
              <span className={s.chipLabel}>{rangeName(f.range)}</span>
              <Icon name="chevronDown" size={14} strokeWidth={2} />
            </Chip>
          )}
        >
          {({ close }) => (
            <>
              {RANGES.map((r) => (
                <button
                  key={r}
                  type="button"
                  role="option"
                  aria-selected={f.range === r}
                  className={p.item}
                  data-testid={`range-option-${r}`}
                  onClick={() => {
                    navigate({ filters: { range: r } });
                    close();
                  }}
                >
                  {rangeName(r)}
                </button>
              ))}
            </>
          )}
        </Popover>
      )}
      <Popover
        role="dialog"
        ariaLabel={t('filter.models')}
        trigger={({ open, toggle }) => (
          <Chip aria-haspopup="dialog" aria-expanded={open} aria-label={t('filter.models')} data-testid="models-button" data-models={f.models.join(',')} onClick={toggle}>
            <span className={s.chipLabel}>{t('filter.modelsPrefix', { v: label })}</span>
            <Icon name="chevronDown" size={14} strokeWidth={2} />
          </Chip>
        )}
      >
        {() => (
          <>
            <div className={p.scroll} role="group" aria-label={t('filter.models')}>
              <button type="button" role="menuitemcheckbox" aria-checked={f.models.length === 0} className={p.item} data-testid="model-option-all" onClick={() => navigate({ filters: { models: [] } }, { replace: true })}>
                <span className={p.check}>{f.models.length === 0 && <Icon name="check" size={12} strokeWidth={3} />}</span>
                <span className={p.grow}>{t('filter.modelsAll')}</span>
              </button>
              {options.map((m) => (
                <button key={m.key} type="button" role="menuitemcheckbox" aria-checked={f.models.includes(m.key)} className={p.item} data-testid="model-option" data-model-key={m.key} onClick={() => toggleModel(m.key)}>
                  <span className={p.check}>{f.models.includes(m.key) && <Icon name="check" size={12} strokeWidth={3} />}</span>
                  <span className={p.grow} title={m.key}>
                    {m.display}
                  </span>
                  {m.isLocal && !f.family && <span className={p.tag}>{t('model.local')}</span>}
                  <span className={`${p.val} num`}>{formatTokens(m.value)}</span>
                </button>
              ))}
              {options.length === 0 && <div className={p.item}>{t('filter.noModels')}</div>}
            </div>
            <div className={p.sep} />
            <button type="button" role="menuitemcheckbox" aria-checked={f.family} className={p.item} data-testid="family-toggle" onClick={() => navigate({ filters: { family: !f.family, models: [] } }, { replace: true })}>
              <span className={p.check}>{f.family && <Icon name="check" size={12} strokeWidth={3} />}</span>
              <span className={p.grow}>{t('filter.family')}</span>
            </button>
          </>
        )}
      </Popover>
      {!hideBasis && (
        <Segmented
          ariaLabel={t('basis.aria')}
          size="sm"
          value={basis}
          testId="basis-toggle"
          onChange={(b) => navigate({ filters: { basis: b } })}
          options={[
            { value: 'total', label: t('basis.total'), title: t('basis.totalTip') },
            { value: 'fresh', label: t('basis.fresh'), title: t('basis.freshTip') },
          ]}
        />
      )}
      {!hideCost && <CostBasisToggle />}
      {after}
    </div>
  );
}

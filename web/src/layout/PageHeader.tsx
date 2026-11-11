import type { ReactNode } from 'react';
import { ChipLink, RoundButton } from '../design/Button.tsx';
import { Icon } from '../design/icons.tsx';
import { useMediaQuery } from '../lib/hooks.ts';
import { useStore, useT } from '../state/store.ts';
import { NARROW_QUERY } from './Sidebar.tsx';
import s from './PageHeader.module.css';

interface PageHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  titleTestId?: string;
  /** 返回入口（子视图用）：显示在标题左侧的“← 返回…”胶囊链接 */
  back?: { label: string; href: string };
}

/** 页头：（项目栏不可见时的）项目栏开关 + 大标题 + 说明 + 右侧操作区。 */
export function PageHeader({ title, subtitle, actions, titleTestId, back }: PageHeaderProps) {
  const t = useT();
  const narrow = useMediaQuery(NARROW_QUERY);
  const collapsed = useStore((st) => st.sidebarCollapsed);
  const setCollapsed = useStore((st) => st.setSidebarCollapsed);
  const setDrawerOpen = useStore((st) => st.setDrawerOpen);
  const sidebarHidden = narrow || collapsed;
  return (
    <div className={s.head}>
      <div className={s.left}>
        {sidebarHidden && (
          <RoundButton aria-label={t('sidebar.open')} title={t('sidebar.open')} data-testid="sidebar-open" onClick={() => (narrow ? setDrawerOpen(true) : setCollapsed(false))}>
            <Icon name="sidebar" size={19} />
          </RoundButton>
        )}
        {back && (
          <ChipLink href={back.href} data-testid="page-back" aria-label={back.label}>
            <Icon name="chevronLeft" size={16} strokeWidth={2} />
            {back.label}
          </ChipLink>
        )}
        <div className={s.titles}>
          <h1 className={s.title} data-testid={titleTestId}>
            {title}
          </h1>
          {subtitle && <div className={s.subtitle}>{subtitle}</div>}
        </div>
      </div>
      {actions && <div className={s.actions}>{actions}</div>}
    </div>
  );
}

import { useEffect } from 'react';
import type { IconName } from '../design/icons.tsx';
import { StatePanel } from '../design/StatePanel.tsx';
import { markReady } from '../lib/perf.ts';
import { PageHeader } from '../layout/PageHeader.tsx';
import { useRoute } from '../state/route.ts';
import { useT } from '../state/store.ts';

interface PlaceholderPageProps {
  page: 'analysis' | 'sessions' | 'settings';
  icon: IconName;
}

/** 分析 / 会话 / 设置：阶段 5 先放占位页（骨架与导航已到位，内容在后续阶段）。 */
export function PlaceholderPage({ page, icon }: PlaceholderPageProps) {
  const t = useT();
  const { project } = useRoute();
  useEffect(() => {
    markReady(project);
  }, [project]);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24, minWidth: 0 }} data-testid="content" data-page={page} data-project={project} data-ready="true">
      <PageHeader title={t(`page.${page}`)} titleTestId="page-title" />
      <StatePanel icon={icon} title={t('page.placeholderCard')} desc={t('page.placeholder')} testId="placeholder-page" />
    </div>
  );
}

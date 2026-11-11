import { useEffect } from 'react';
import { StatePanel } from '../../design/StatePanel.tsx';
import { Skeleton } from '../../design/Skeleton.tsx';
import { Card } from '../../design/Card.tsx';
import { LanguageToggle } from '../../features/settings/LanguageToggle.tsx';
import { useSaveStatus } from '../../features/settings/save.ts';
import { PageHeader } from '../../layout/PageHeader.tsx';
import { markReady } from '../../lib/perf.ts';
import { useRoute } from '../../state/route.ts';
import { useStore, useT } from '../../state/store.ts';
import { PricesSection } from './PricesSection.tsx';
import { ProjectsSection } from './ProjectsSection.tsx';
import { BudgetSection, DisplaySection, RefreshSection, SourceSection } from './SimpleSections.tsx';
import { Row, Section } from './parts.tsx';
import { SubscriptionSection } from './SubscriptionSection.tsx';
import s from './Settings.module.css';

function SaveStatus() {
  const t = useT();
  const kind = useSaveStatus((x) => x.kind);
  const message = useSaveStatus((x) => x.message);
  return (
    <div className={`${s.saveStatus} ${kind === 'error' ? s.msgErr : kind === 'saved' ? s.msgOk : ''}`} role="status" aria-live="polite" data-testid="save-status" data-kind={kind}>
      {kind === 'saving' ? t('settings.saving') : kind === 'saved' ? t('settings.saved') : kind === 'error' ? t('settings.saveFailed', { reason: message }) : ''}
    </div>
  );
}

/** 设置页：数据源 / 显示 / 刷新 / 价格表 / 订阅方案 / 预算 / 项目管理。修改即时保存（价格表除外：点"保存价格表"），只写应用数据目录。 */
export function SettingsPage() {
  const t = useT();
  const route = useRoute();
  const payload = useStore((st) => st.settings);

  useEffect(() => {
    if (payload) markReady(route.project);
  }, [payload, route.project]);

  const header = <PageHeader title={t('page.settings')} titleTestId="page-title" subtitle={t('settings.subtitle')} actions={<SaveStatus />} />;

  if (!payload) {
    return (
      <div className={s.page} data-testid="content" data-page="settings" data-project={route.project} data-ready="false">
        {header}
        <Card>
          <Skeleton width={200} height={24} />
          <Skeleton width="100%" height={120} style={{ marginTop: 16 }} />
        </Card>
      </div>
    );
  }
  const settings = payload.settings;
  return (
    <div className={s.page} data-testid="content" data-page="settings" data-project={route.project} data-ready="true">
      {header}
      {payload.warnings.length > 0 && <StatePanel icon="alert" tone="amber" title={t('warn.title')} desc={payload.warnings.join(' ')} testId="settings-warnings" />}
      <Section title={t('settings.lang.title')} testId="settings-language-section">
        <Row title={t('settings.lang.label')}>
          <LanguageToggle />
        </Row>
      </Section>
      <SourceSection settings={settings} effectiveRoot={payload.effective.dataRoot} />
      <DisplaySection settings={settings} systemTimezone={payload.systemTimezone} />
      <RefreshSection settings={settings} />
      <PricesSection />
      <SubscriptionSection settings={settings} />
      <BudgetSection settings={settings} />
      <ProjectsSection settings={settings} />
    </div>
  );
}

import { ChipLink } from '../design/Button.tsx';
import { StatePanel } from '../design/StatePanel.tsx';
import { hashFor, useRoute } from '../state/route.ts';
import { useStore, useT } from '../state/store.ts';

/**
 * 数据根目录不可读时，分析 / 会话 / 成本页顶部的醒目提示（总览页自己用整页的同款面板）。
 * 否则这些页面只会显示"这个范围内没有记录"，用户看不出真正原因。
 */
export function DataRootAlert() {
  const t = useT();
  const route = useRoute();
  const state = useStore((x) => x.status?.state);
  const lastError = useStore((x) => x.status?.lastError ?? null);
  if (state !== 'error') return null;
  return (
    <StatePanel
      role="alert"
      icon="server"
      tone="pink"
      testId="data-root-error"
      title={t('error.dataRoot.title')}
      desc={lastError ? t('error.dataRoot.reason', { reason: lastError }) : undefined}
      action={
        <ChipLink primary href={hashFor(route, { page: 'settings' })}>
          {t('error.dataRoot.goSettings')}
        </ChipLink>
      }
    />
  );
}

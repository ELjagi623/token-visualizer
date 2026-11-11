import { Segmented } from '../../design/Segmented.tsx';
import type { Lang } from '../../i18n/index.ts';
import { useStore, useT } from '../../state/store.ts';
import { saveSettings } from './save.ts';

/**
 * English | 中文 切换（设置页顶部与首次引导共用）。
 * 选项文字固定、不随当前语言变化；点击即保存，界面立刻切换（saveSettings 会同步 store.lang 与 <html lang>）。
 */
export function LanguageToggle({ testId = 'settings-language', size = 'sm' }: { testId?: string; size?: 'md' | 'sm' }) {
  const t = useT();
  const lang = useStore((st) => st.lang);
  return (
    <Segmented<Lang>
      size={size}
      ariaLabel={t('settings.lang.aria')}
      testId={testId}
      value={lang}
      onChange={(v) => {
        if (v !== lang) void saveSettings({ language: v });
      }}
      options={[
        { value: 'en', label: t('lang.en') },
        { value: 'zh', label: t('lang.zh') },
      ]}
    />
  );
}

import { useCallback, useRef, useState } from 'react';
import { Icon } from '../design/icons.tsx';
import type { IconName } from '../design/icons.tsx';
import { useDismiss } from '../lib/hooks.ts';
import { useStore, useT } from '../state/store.ts';
import type { ThemePref } from '../state/store.ts';
import s from './ThemeControl.module.css';

const OPTIONS: ReadonlyArray<{ value: ThemePref; icon: IconName; label: 'theme.light' | 'theme.dark' | 'theme.system' }> = [
  { value: 'light', icon: 'sun', label: 'theme.light' },
  { value: 'dark', icon: 'moon', label: 'theme.dark' },
  { value: 'system', icon: 'monitor', label: 'theme.system' },
];

/**
 * 主题切换：月亮 / 太阳按钮一键在浅色与深色之间切换（记住选择）；旁边的小箭头打开菜单，可选"跟随系统"。
 */
export function ThemeControl() {
  const t = useT();
  const resolved = useStore((st) => st.resolvedTheme);
  const pref = useStore((st) => st.themePref);
  const setThemePref = useStore((st) => st.setThemePref);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(ref, open, close);

  const dark = resolved === 'dark';
  return (
    <div className={s.wrap} ref={ref}>
      <button type="button" className={s.toggle} aria-label={dark ? t('theme.toLight') : t('theme.toDark')} title={dark ? t('theme.toLight') : t('theme.toDark')} data-testid="theme-toggle" data-theme-pref={pref} onClick={() => setThemePref(dark ? 'light' : 'dark')}>
        <Icon name={dark ? 'sun' : 'moon'} size={19} />
      </button>
      <button type="button" className={s.caret} aria-label={t('theme.menu')} aria-haspopup="menu" aria-expanded={open} data-testid="theme-menu-button" onClick={() => setOpen((v) => !v)}>
        <Icon name="chevronDown" size={14} strokeWidth={2} />
      </button>
      {open && (
        <div className={s.menu} role="menu" aria-label={t('theme.menu')}>
          {OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              role="menuitemradio"
              aria-checked={pref === o.value}
              className={s.item}
              data-testid={`theme-option-${o.value}`}
              onClick={() => {
                setThemePref(o.value);
                setOpen(false);
              }}
            >
              <Icon name={o.icon} size={17} />
              {t(o.label)}
              {pref === o.value && <Icon name="check" size={16} strokeWidth={2.2} className={s.check} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

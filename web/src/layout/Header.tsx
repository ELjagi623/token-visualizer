import { Icon, LogoMark } from '../design/icons.tsx';
import type { IconName } from '../design/icons.tsx';
import { SegmentedNav } from '../design/Segmented.tsx';
import { hashFor, useRoute } from '../state/route.ts';
import type { Page } from '../state/route.ts';
import { useT } from '../state/store.ts';
import { StatusPill } from './StatusPill.tsx';
import { ThemeControl } from './ThemeControl.tsx';
import s from './Header.module.css';

const NAV: ReadonlyArray<{ page: Page; icon: IconName; label: 'nav.overview' | 'nav.analysis' | 'nav.sessions' | 'nav.settings' }> = [
  { page: 'overview', icon: 'grid', label: 'nav.overview' },
  { page: 'analysis', icon: 'bars', label: 'nav.analysis' },
  { page: 'sessions', icon: 'list', label: 'nav.sessions' },
  { page: 'settings', icon: 'sliders', label: 'nav.settings' },
];

/** 顶栏：左 Logo、中间胶囊分段导航、右侧状态胶囊 + 主题切换。 */
export function Header() {
  const t = useT();
  const route = useRoute();
  return (
    <header className={s.header}>
      <a className={s.brand} href={hashFor(route, { page: 'overview' })} aria-label={t('app.name')}>
        <LogoMark />
        <span className={s.name}>{t('app.name')}</span>
      </a>
      <SegmentedNav
        ariaLabel={t('nav.aria')}
        items={NAV.map((n) => ({
          key: n.page,
          href: hashFor(route, { page: n.page }),
          current: route.page === n.page || (n.page === 'overview' && route.page === 'cost'),
          label: (
            <>
              <Icon name={n.icon} />
              {t(n.label)}
            </>
          ),
        }))}
      />
      <div className={s.right}>
        <StatusPill />
        <ThemeControl />
      </div>
    </header>
  );
}

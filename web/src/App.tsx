import { useEffect, useRef } from 'react';
import { OnboardingDialog } from './features/onboarding/OnboardingDialog.tsx';
import { Header } from './layout/Header.tsx';
import { Sidebar } from './layout/Sidebar.tsx';
import { WarningsBanner } from './layout/WarningsBanner.tsx';
import { AnalysisPage } from './pages/Analysis.tsx';
import { OverviewPage } from './pages/Overview.tsx';
import { CostPage } from './features/cost/CostPage.tsx';
import { SettingsPage } from './pages/settings/SettingsPage.tsx';
import { SessionsPage } from './pages/Sessions.tsx';
import { useRoute } from './state/route.ts';
import { bootstrap, useStore, useT } from './state/store.ts';
import s from './App.module.css';

/** 应用骨架：顶栏 + 项目栏 + 内容区。路由 / 布局保持不变，切换项目只更新内容区数据。 */
export function App() {
  const t = useT();
  const route = useRoute();
  const drawerOpen = useStore((st) => st.drawerOpen);
  const setDrawerOpen = useStore((st) => st.setDrawerOpen);

  useEffect(() => bootstrap(), []);

  // 内容区是唯一的滚动容器：切换页面时回到顶部
  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
  }, [route.page]);

  // 抽屉打开时按 Esc 关闭
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setDrawerOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawerOpen, setDrawerOpen]);

  let page;
  switch (route.page) {
    case 'analysis':
      page = <AnalysisPage />;
      break;
    case 'sessions':
      page = <SessionsPage />;
      break;
    case 'settings':
      page = <SettingsPage />;
      break;
    case 'cost':
      page = <CostPage />;
      break;
    default:
      page = <OverviewPage />;
  }

  return (
    <div className={s.shell}>
      <a className={s.skip} href="#main" onClick={(e) => { e.preventDefault(); document.getElementById('main')?.focus(); }}>
        {t('app.skip')}
      </a>
      <Header />
      <WarningsBanner />
      <OnboardingDialog />
      <div className={s.body}>
        <Sidebar />
        <main id="main" ref={mainRef} tabIndex={-1} className={s.main}>
          {page}
        </main>
      </div>
    </div>
  );
}

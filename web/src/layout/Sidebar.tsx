import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import { useProjects } from '../api/hooks.ts';
import type { ProjectItem, ProjectSort } from '../api/types.ts';
import { Chip, RoundButton } from '../design/Button.tsx';
import { Icon } from '../design/icons.tsx';
import { Skeleton } from '../design/Skeleton.tsx';
import { Sparkline } from '../design/Sparkline.tsx';
import { cx } from '../lib/cx.ts';
import { formatClock, formatRelative, formatTokens } from '../lib/format.ts';
import { useDismiss, useMediaQuery } from '../lib/hooks.ts';
import { markSwitch } from '../lib/perf.ts';
import { filterProjects, navigationOrder, projectTooltip } from '../lib/projects.ts';
import { hashFor, navigate, useRoute } from '../state/route.ts';
import { useStore, useT } from '../state/store.ts';
import { HiddenProjects } from './HiddenProjects.tsx';
import s from './Sidebar.module.css';

export const NARROW_QUERY = '(max-width: 899.98px)';

const SORT_OPTIONS: ReadonlyArray<{ value: ProjectSort; label: 'sidebar.sort.total' | 'sidebar.sort.recent' | 'sidebar.sort.name' | 'sidebar.sort.today' }> = [
  { value: 'total', label: 'sidebar.sort.total' },
  { value: 'recent', label: 'sidebar.sort.recent' },
  { value: 'name', label: 'sidebar.sort.name' },
  { value: 'today', label: 'sidebar.sort.today' },
];

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

/** 项目栏：搜索 / 排序 / 全部项目 / 各项目（sparkline、今日活动点、最近活跃）/ Scratch 分组 / 底部状态。 */
export function Sidebar() {
  const t = useT();
  const route = useRoute();
  const narrow = useMediaQuery(NARROW_QUERY);
  const sort = useStore((st) => st.sort);
  const setSort = useStore((st) => st.setSort);
  const collapsed = useStore((st) => st.sidebarCollapsed);
  const setCollapsed = useStore((st) => st.setSidebarCollapsed);
  const drawerOpen = useStore((st) => st.drawerOpen);
  const setDrawerOpen = useStore((st) => st.setDrawerOpen);
  const scratchExpanded = useStore((st) => st.scratchExpanded);
  const toggleScratch = useStore((st) => st.toggleScratch);
  const serverNow = useStore((st) => st.status?.serverNow ?? null);
  const lastScanAt = useStore((st) => st.status?.lastScanAt ?? null);
  const scanningFull = useStore((st) => st.status?.state === 'scanning' && st.status.phase === 'full');
  const refreshing = useStore((st) => st.refreshing);
  const refreshNow = useStore((st) => st.refreshNow);

  const asideRef = useRef<HTMLElement>(null);
  const hovering = useRef(false);
  const [q, setQ] = useState('');
  const [sortOpen, setSortOpen] = useState(false);
  const sortRef = useRef<HTMLDivElement>(null);
  const closeSort = useCallback(() => setSortOpen(false), []);
  useDismiss(sortRef, sortOpen, closeSort);

  // 项目栏吸顶 + 内部滚动：最大高度 = 视口高度 − 它在页面顶部时距视口顶的距离（顶栏 / 提示条高度会变），保证底部的刷新按钮首屏可见
  useLayoutEffect(() => {
    const el = asideRef.current;
    if (!el) return;
    const update = (): void => {
      const parent = el.parentElement;
      if (!parent) return;
      const top = parent.getBoundingClientRect().top + window.scrollY;
      el.style.setProperty('--sbMax', `${Math.round(top + 20)}px`);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(document.body);
    window.addEventListener('resize', update);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', update);
    };
  }, []);

  const projects = useProjects();
  const data = projects.data;
  const now = serverNow ?? Date.now();
  const filtered = useMemo(() => filterProjects(data?.projects ?? [], q), [data, q]);
  const expanded = scratchExpanded || q.trim() !== '';
  const selected = route.project;

  // 选中的项目已不存在（如换了数据根）→ 回到"全部项目"
  useEffect(() => {
    if (!data || projects.loading || projects.placeholder || selected === 'all') return;
    const known = new Set<string>();
    for (const p of data.projects) {
      known.add(p.id);
      p.children?.forEach((c) => known.add(c.id));
    }
    if (!known.has(selected)) navigate({ project: 'all' }, { replace: true });
  }, [data, projects.loading, projects.placeholder, selected]);

  // ↑/↓ 切换项目
  const order = useMemo(() => navigationOrder(filtered, expanded), [filtered, expanded]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.key !== 'ArrowDown' && e.key !== 'ArrowUp') || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.defaultPrevented) return;
      if (isTypingTarget(e.target)) return;
      // 只在项目栏聚焦或鼠标悬停在项目栏上时接管方向键；其它位置保留浏览器默认的滚动
      if (!hovering.current && !(asideRef.current && asideRef.current.contains(document.activeElement))) return;
      if (document.querySelector('[role="menu"], [role="listbox"]')) return;
      if (order.length === 0) return;
      const i = order.indexOf(selected);
      const next = e.key === 'ArrowDown' ? (i < 0 ? 0 : Math.min(order.length - 1, i + 1)) : i < 0 ? 0 : Math.max(0, i - 1);
      const id = order[next];
      if (id === undefined) return;
      e.preventDefault();
      if (id !== selected) {
        markSwitch(id);
        navigate({ project: id, rest: [] }, { replace: true });
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [order, selected]);

  // 选中项滚动到可见区域
  useEffect(() => {
    const el = document.querySelector<HTMLElement>('[data-testid="sidebar"] [data-selected="true"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [selected, data]);

  const onPick = (id: string) => (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey) markSwitch(id);
    if (narrow) setDrawerOpen(false);
  };

  const visibleInLayout = narrow ? drawerOpen : !collapsed;
  const linkFor = (id: string): string => hashFor(route, { project: id, rest: [] });

  const renderRow = (p: ProjectItem, child = false) => {
    const isSel = selected === p.id;
    const ago = formatRelative(p.lastActiveTs, now, t);
    const tooltip = projectTooltip(p, t('sidebar.noPath', { key: p.id }));
    return (
      <li key={p.id}>
        <div className={cx(s.row, child && s.child)} data-selected={isSel ? 'true' : 'false'} data-testid="project-row" data-project-id={p.id}>
          <a className={s.link} href={linkFor(p.id)} title={tooltip} aria-current={isSel ? 'true' : undefined} onClick={onPick(p.id)}>
            <div className={s.names}>
              <div className={s.name} data-testid="project-name">
                {p.pinned && (
                  <span className={s.pinMark} title={t('sidebar.pinned')} role="img" aria-label={t('sidebar.pinned')} data-testid="project-pin">
                    <Icon name="pin" size={12} strokeWidth={2} />
                  </span>
                )}
                {p.displayName}
              </div>
              <div className={s.sub}>
                {p.activeToday && <span className={s.dot} title={t('sidebar.activeToday')} aria-label={t('sidebar.activeToday')} role="img" data-testid="project-active-dot" />}
                <span>{p.lastActiveTs === null ? t('time.never') : ago}</span>
              </div>
            </div>
            <div className={s.right}>
              <div className={cx(s.total, 'num')} data-value={p.value} data-testid="project-total">
                {formatTokens(p.value)}
              </div>
              <Sparkline values={p.sparkline} width={84} height={22} pad={2} strokeWidth={1.5} fillOpacity={0.26} />
            </div>
          </a>
        </div>
      </li>
    );
  };

  const renderGroup = (g: ProjectItem) => {
    const isSel = selected === g.id;
    const kids = g.children ?? [];
    return (
      <li key={g.id}>
        <div className={s.row} data-selected={isSel ? 'true' : 'false'} data-testid="project-row" data-project-id={g.id} data-group="true">
          <a className={s.link} href={linkFor(g.id)} aria-current={isSel ? 'true' : undefined} onClick={onPick(g.id)}>
            <div className={s.groupLeft}>
              <Icon name="folder" className={s.groupIcon} />
              <div className={s.names}>
                <div className={s.name}>{t('sidebar.scratch')}</div>
                <div className={s.sub}>{t('sidebar.scratchSub', { n: g.children?.length ?? 0 })}</div>
              </div>
            </div>
            <div className={s.groupRight}>
              <span className={cx(s.total, 'num')} data-value={g.value} data-testid="project-total">
                {formatTokens(g.value)}
              </span>
            </div>
          </a>
          <button type="button" className={s.expand} aria-expanded={expanded} aria-label={expanded ? t('sidebar.scratchCollapse') : t('sidebar.scratchExpand')} data-testid="scratch-toggle" onClick={toggleScratch}>
            <Icon name="chevronRight" size={16} strokeWidth={2} />
          </button>
        </div>
        {expanded && kids.length > 0 && (
          <ul className={s.list} style={{ marginTop: 4 }} data-testid="scratch-children">
            {kids.map((c) => renderRow(c, true))}
          </ul>
        )}
      </li>
    );
  };

  const total = data?.projectCount ?? 0;
  const allSel = selected === 'all';
  const loadingFirst = data === null && projects.error === null;

  return (
    <>
      {narrow && drawerOpen && <div className={s.scrim} onClick={() => setDrawerOpen(false)} aria-hidden="true" />}
      <aside ref={asideRef} className={s.sidebar} aria-label={t('sidebar.aria')} onMouseEnter={() => (hovering.current = true)} onMouseLeave={() => (hovering.current = false)} data-testid="sidebar" data-collapsed={collapsed ? 'true' : 'false'} data-drawer-open={drawerOpen ? 'true' : 'false'} data-visible={visibleInLayout ? 'true' : 'false'}>
        <div className={s.top}>
          <label className={s.search}>
            <Icon name="search" />
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('sidebar.searchPlaceholder')} aria-label={t('sidebar.searchAria')} data-testid="project-search" />
          </label>
          <RoundButton small aria-label={t('sidebar.close')} title={t('sidebar.close')} data-testid="sidebar-close" onClick={() => (narrow ? setDrawerOpen(false) : setCollapsed(true))}>
            <Icon name="sidebar" size={17} />
          </RoundButton>
        </div>

        <div className={s.sortRow}>
          <span>{t('sidebar.projects')}</span>
          <div className={s.sortWrap} ref={sortRef}>
            <Chip small aria-haspopup="listbox" aria-expanded={sortOpen} aria-label={t('sidebar.sortAria')} data-testid="sort-button" data-sort={sort} onClick={() => setSortOpen((v) => !v)}>
              {t(SORT_OPTIONS.find((o) => o.value === sort)?.label ?? 'sidebar.sort.total')}
              <Icon name="chevronDown" size={14} strokeWidth={2} />
            </Chip>
            {sortOpen && (
              <div className={s.sortMenu} role="listbox" aria-label={t('sidebar.sortAria')}>
                {SORT_OPTIONS.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    role="option"
                    aria-selected={sort === o.value}
                    className={s.sortItem}
                    data-testid={`sort-option-${o.value}`}
                    onClick={() => {
                      setSort(o.value);
                      setSortOpen(false);
                    }}
                  >
                    {t(o.label)}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className={s.listWrap}>
          <ul className={s.list} data-testid="project-list">
            <li>
              <div className={cx(s.row, s.all)} data-selected={allSel ? 'true' : 'false'} data-testid="project-row-all" data-project-id="all">
                <a className={s.link} href={linkFor('all')} aria-current={allSel ? 'true' : undefined} onClick={onPick('all')}>
                  <div className={s.names}>
                    <div className={cx(s.name, s.allName)}>{t('sidebar.all')}</div>
                    <div className={s.sub}>{data ? t('sidebar.allSub', { n: total }) : <Skeleton width={70} height={10} />}</div>
                  </div>
                  <div className={s.right}>
                    <div className={cx(s.total, s.allTotal, 'num')} data-value={data?.all.value ?? ''} data-testid="project-total-all">
                      {data ? formatTokens(data.all.value) : '—'}
                    </div>
                    {data && <Sparkline values={data.all.sparkline} width={84} height={22} pad={2} strokeWidth={1.6} fillOpacity={0.3} />}
                  </div>
                </a>
              </div>
            </li>
            {loadingFirst &&
              [62, 48, 70, 54].map((w, i) => (
                <li key={`sk${i}`} className={s.skRow} aria-hidden="true">
                  <div style={{ flex: 1 }}>
                    <Skeleton width={`${w}%`} height={14} />
                    <Skeleton width="46%" height={10} style={{ marginTop: 8 }} />
                  </div>
                  <Skeleton width={44} height={14} />
                </li>
              ))}
            {filtered.map((p) => (p.isScratchGroup ? renderGroup(p) : renderRow(p)))}
          </ul>
          {data && filtered.length === 0 && <div className={s.empty}>{q.trim() !== '' ? t('sidebar.noMatch') : t('sidebar.empty')}</div>}
        </div>

        <HiddenProjects items={data?.hidden ?? []} />

        <div className={s.footer}>
          <span data-testid="sidebar-footer">{scanningFull ? t('sidebar.footerScanning', { n: total }) : t('sidebar.footer', { n: total, time: formatClock(lastScanAt) })}</span>
          <RoundButton small aria-label={t('sidebar.refresh')} title={t('sidebar.refresh')} spinning={refreshing} data-testid="refresh-button" onClick={() => void refreshNow()}>
            <Icon name="refresh" size={16} strokeWidth={1.9} />
          </RoundButton>
        </div>
      </aside>
    </>
  );
}

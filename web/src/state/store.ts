/**
 * 全局状态（zustand）：状态 / 设置 / 主题 / 语言 / 项目栏偏好 / 口径。
 *
 * 数据流：SSE（/api/events）推送 status → setStatus；dataVersion 变化时各页面的 useApi 自动重取；
 * 另有 10 秒一次的 /api/status 轮询作为 SSE 的兜底（也保证"最近记录多久前"的状态会过期）。
 */
import { create } from 'zustand';
import { api } from '../api/client.ts';
import { startEvents } from '../api/events.ts';
import type { Basis, Connection, ProjectSort, SettingsPayload, StatusPayload } from '../api/types.ts';
import { makeT } from '../i18n/index.ts';
import type { Lang, TFn } from '../i18n/index.ts';
import { lsGet, lsSet, ssGet, ssSet } from '../lib/storage.ts';
import { useRoute } from './route.ts';

export type ThemePref = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const KEY_THEME = 'tv.theme';
const KEY_SORT = 'tv.projectSort';
const KEY_SIDEBAR = 'tv.sidebarCollapsed';
const KEY_SCRATCH = 'tv.scratchExpanded';
const KEY_DISMISSED = 'tv.dismissedWarnings';

const SORTS: readonly ProjectSort[] = ['total', 'recent', 'name', 'today'];

function systemDark(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function resolveTheme(pref: ThemePref, sysDark: boolean): ResolvedTheme {
  return pref === 'dark' || (pref === 'system' && sysDark) ? 'dark' : 'light';
}

function applyTheme(resolved: ResolvedTheme): void {
  const root = document.documentElement;
  root.setAttribute('data-theme', resolved);
  root.style.colorScheme = resolved;
}

function readThemePref(): ThemePref {
  const v = lsGet(KEY_THEME);
  return v === 'light' || v === 'dark' ? v : 'system';
}

function readSort(): ProjectSort {
  const v = lsGet(KEY_SORT);
  return SORTS.includes(v as ProjectSort) ? (v as ProjectSort) : 'total';
}

function readDismissed(): string[] {
  try {
    const v = JSON.parse(ssGet(KEY_DISMISSED) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export interface AppState {
  lang: Lang;
  status: StatusPayload | null;
  connection: Connection;
  settings: SettingsPayload | null;
  settingsVersion: number;
  themePref: ThemePref;
  resolvedTheme: ResolvedTheme;
  sort: ProjectSort;
  sidebarCollapsed: boolean;
  drawerOpen: boolean;
  scratchExpanded: boolean;
  basisOverride: Basis | null;
  dismissed: string[];
  refreshing: boolean;

  setStatus: (s: StatusPayload) => void;
  setThemePref: (p: ThemePref) => void;
  setSort: (s: ProjectSort) => void;
  setSidebarCollapsed: (v: boolean) => void;
  setDrawerOpen: (v: boolean) => void;
  toggleScratch: () => void;
  setBasis: (b: Basis) => void;
  dismissWarnings: (items: string[]) => void;
  refreshNow: () => Promise<void>;
}

let putInFlight = 0;

export const useStore = create<AppState>((set, get) => ({
  lang: 'zh',
  status: null,
  connection: 'connecting',
  settings: null,
  settingsVersion: 0,
  themePref: readThemePref(),
  resolvedTheme: resolveTheme(readThemePref(), systemDark()),
  sort: readSort(),
  sidebarCollapsed: lsGet(KEY_SIDEBAR) === '1',
  drawerOpen: false,
  scratchExpanded: lsGet(KEY_SCRATCH) === '1',
  basisOverride: null,
  dismissed: readDismissed(),
  refreshing: false,

  setStatus: (s) => set({ status: s }),

  setThemePref: (p) => {
    lsSet(KEY_THEME, p);
    const resolved = resolveTheme(p, systemDark());
    applyTheme(resolved);
    set({ themePref: p, resolvedTheme: resolved });
    putInFlight++;
    api
      .putSettings({ theme: p })
      .catch(() => undefined)
      .finally(() => {
        putInFlight--;
      });
  },

  setSort: (s) => {
    lsSet(KEY_SORT, s);
    set({ sort: s });
  },

  setSidebarCollapsed: (v) => {
    lsSet(KEY_SIDEBAR, v ? '1' : '0');
    set({ sidebarCollapsed: v });
  },

  setDrawerOpen: (v) => set({ drawerOpen: v }),

  toggleScratch: () => {
    const v = !get().scratchExpanded;
    lsSet(KEY_SCRATCH, v ? '1' : '0');
    set({ scratchExpanded: v });
  },

  setBasis: (b) => set({ basisOverride: b }),

  dismissWarnings: (items) => {
    const next = [...new Set([...get().dismissed, ...items])].slice(-50);
    ssSet(KEY_DISMISSED, JSON.stringify(next));
    set({ dismissed: next });
  },

  refreshNow: async () => {
    if (get().refreshing) return;
    set({ refreshing: true });
    try {
      const st = await api.refresh();
      set({ status: st });
    } catch {
      // 失败时由状态胶囊 / 连接状态反映
    } finally {
      set({ refreshing: false });
    }
  },
}));

// ---------------------------------------------------------------------------
// 派生：当前语言的 t() / 当前口径
// ---------------------------------------------------------------------------

export function useT(): TFn {
  const lang = useStore((s) => s.lang);
  return makeT(lang);
}

/** 当前口径：URL 里的 basis 优先，否则取设置里的默认口径。 */
export function useBasis(): Basis {
  const fromUrl = useRoute().filters.basis;
  const dflt = useStore((s) => s.settings?.settings.defaultBasis ?? 'total');
  return fromUrl ?? dflt;
}

// ---------------------------------------------------------------------------
// 启动：设置 / 状态 / SSE / 系统主题监听
// ---------------------------------------------------------------------------

function applySettings(payload: SettingsPayload, adoptTheme: boolean): void {
  document.documentElement.removeAttribute('data-theme-pending');
  const st = useStore.getState();
  const patch: Partial<AppState> = { settings: payload, settingsVersion: payload.version, lang: payload.settings.language };
  document.documentElement.lang = payload.settings.language === 'en' ? 'en' : 'zh-CN';
  if (adoptTheme && putInFlight === 0 && payload.settings.theme !== st.themePref) {
    lsSet(KEY_THEME, payload.settings.theme);
    const resolved = resolveTheme(payload.settings.theme, systemDark());
    applyTheme(resolved);
    patch.themePref = payload.settings.theme;
    patch.resolvedTheme = resolved;
  }
  useStore.setState(patch);
}

export function bootstrap(): () => void {
  const store = useStore;
  let stopped = false;
  applyTheme(store.getState().resolvedTheme);

  const loadSettings = (adoptTheme: boolean): void => {
    api
      .settings()
      .then((p) => {
        if (!stopped) applySettings(p, adoptTheme);
      })
      .catch(() => undefined);
  };
  const pollStatus = (): void => {
    api
      .status()
      .then((s) => {
        if (!stopped) store.setState({ status: s, connection: 'open' });
      })
      .catch(() => {
        if (!stopped) store.setState({ connection: 'lost' });
      });
  };

  loadSettings(true);
  pollStatus();

  const stopEvents = startEvents({
    onStatus: (s) => store.setState({ status: s, connection: 'open' }),
    onSettings: (v) => {
      if (v !== store.getState().settingsVersion) loadSettings(true);
    },
    onOpen: () => {
      store.setState({ connection: 'open' });
      loadSettings(false);
    },
    // SSE 出错不等于服务掉线（代理 / 网络抖动也会触发）：立即用一次状态请求核实，失败才标记为断开
    onLost: pollStatus,
  });
  const poll = setInterval(pollStatus, 10_000);

  // 跟随系统主题
  const mq = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  const onScheme = (): void => {
    const st = store.getState();
    if (st.themePref !== 'system') return;
    const resolved = resolveTheme('system', systemDark());
    applyTheme(resolved);
    store.setState({ resolvedTheme: resolved });
  };
  mq?.addEventListener('change', onScheme);

  return () => {
    stopped = true;
    stopEvents();
    clearInterval(poll);
    mq?.removeEventListener('change', onScheme);
  };
}

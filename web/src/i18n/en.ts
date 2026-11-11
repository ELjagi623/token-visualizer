import type { Dict } from './zh.ts';

/**
 * 英文字典：阶段 5 先放最基础的一部分，缺失的键自动回退到中文；阶段 9 补全。
 */
export const en: Partial<Dict> = {
  'app.skip': 'Skip to main content',
  'nav.aria': 'Main navigation',
  'nav.overview': 'Overview',
  'nav.analysis': 'Analysis',
  'nav.sessions': 'Sessions',
  'nav.settings': 'Settings',
  'theme.toLight': 'Switch to light theme',
  'theme.toDark': 'Switch to dark theme',
  'theme.menu': 'Theme settings',
  'theme.light': 'Light',
  'theme.dark': 'Dark',
  'theme.system': 'Follow system',
  'pill.today': 'Today',
  'time.justNow': 'just now',
  'time.minutesAgo': '{n} min ago',
  'time.hoursAgo': '{n} h ago',
  'time.yesterday': 'yesterday',
  'time.daysAgo': '{n} d ago',
  'sidebar.searchPlaceholder': 'Search projects or paths',
  'sidebar.projects': 'Projects',
  'sidebar.all': 'All projects',
  'sidebar.sort.total': 'Sort by total',
  'sidebar.sort.recent': 'Sort by recent',
  'sidebar.sort.name': 'Sort by name',
  'sidebar.sort.today': 'Sort by today',
};

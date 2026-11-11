/**
 * 后端 API 响应类型（与 src/server/app.ts 的载荷一致；这里只声明前端用到的字段）。
 */

import type { CostBlock } from '../features/cost/types.ts';

export type Basis = 'total' | 'fresh';
/** 与本地服务的连接状态 */
export type Connection = 'connecting' | 'open' | 'lost';
export type ScanState = 'idle' | 'scanning' | 'error';
export type Activity = 'idle' | 'active' | 'generating';
export type UsageState = Activity | 'scanning' | 'error';

export interface TodayPart {
  value: number;
  total: number;
  fresh: number;
  requests: number;
  basis: Basis;
  tz: string;
}

export interface StatusPayload {
  state: ScanState;
  phase: 'full' | 'incremental';
  filesDone: number;
  filesTotal: number;
  bytesDone: number;
  bytesTotal: number;
  startedAt: number | null;
  lastScanAt: number | null;
  lastError?: string;
  dataVersion: number;
  lastRecordTs: number | null;
  warnings: string[];
  usageState: UsageState;
  /** 纯按最近记录时间判定（不受 scanning / error 覆盖）；状态胶囊用它避免每 5 秒闪烁 */
  activity: Activity;
  recordAgeMs: number | null;
  serverNow: number;
  dataRoot: string;
  today: TodayPart | null;
}

export interface ProjectItem {
  id: string;
  displayName: string;
  path: string | null;
  cwds: string[];
  pathUnknown: boolean;
  isScratchGroup: boolean;
  isScratch: boolean;
  requests: number;
  total: number;
  fresh: number;
  value: number;
  sparkline: number[];
  todayRequests: number;
  todayValue: number;
  activeToday: boolean;
  lastActiveTs: number | null;
  firstTs: number | null;
  /** 项目管理（批次 C）：置顶 / 已重命名 / 自动识别的原始名称 */
  pinned?: boolean;
  renamed?: boolean;
  defaultName?: string | null;
  /** 全部时间的成本（两种口径） */
  cost?: { apiUsd: number | null; subUsd: number | null; unpricedTokens: number; unpricedModels: string[] };
  children?: ProjectItem[];
}

/** 被隐藏的项目（不计入"全部项目"合计，可恢复） */
export interface HiddenProject {
  id: string;
  displayName: string;
  path: string | null;
  isScratchGroup: boolean;
  requests: number;
  lastTs: number | null;
}

export interface ProjectsAll {
  requests: number;
  total: number;
  fresh: number;
  value: number;
  sparkline: number[];
  todayRequests: number;
  todayValue: number;
  activeToday: boolean;
  lastActiveTs: number | null;
}

export type ProjectSort = 'total' | 'recent' | 'name' | 'today';

export interface ProjectsPayload {
  basis: Basis;
  tz: string;
  sort: ProjectSort;
  all: ProjectsAll;
  projects: ProjectItem[];
  projectCount: number;
  folderCount: number;
  hidden?: HiddenProject[];
  hiddenCount?: number;
}

export interface Summary {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  thinking: number;
  total: number;
  fresh: number;
  value: number;
  requests: number;
  sessions: number;
  activeDays: number;
  cacheHitRate: number | null;
  outputInputRatio: number | null;
  avgPerRequest: number | null;
  avgPerSession: number | null;
  /** AI 运行时长（估算）：范围内所有会话 / 子代理区间的并集，毫秒 */
  activeMs?: number;
  /** 各会话 / 子代理时长之和（并行重复计入），毫秒 */
  activeMsSum?: number;
}

export interface PeriodDelta {
  pct: number | null;
  diff: number;
}

export interface PeriodStat {
  from: number;
  to: number;
  summary: Summary;
}

export interface PeriodCards {
  today: PeriodStat;
  yesterday: PeriodStat;
  thisWeek: PeriodStat;
  prevWeek: PeriodStat;
  thisMonth: PeriodStat;
  prevMonth: PeriodStat;
  deltas: { today: PeriodDelta; week: PeriodDelta; month: PeriodDelta };
}

export interface SummaryPayload {
  summary: Summary;
  periods: PeriodCards;
}

export interface TimelinePoint {
  key: string;
  start: number;
  total: number;
  fresh: number;
  value: number;
  requests: number;
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  thinking: number;
  /** 该桶内的 AI 运行时长（毫秒） */
  activeMs?: number;
  /** 该桶的成本（批次 C） */
  cost?: CostBlock;
}

export interface TimeSeriesItem {
  key: string;
  label: string;
  values: number[];
  total: number;
  isLocal?: boolean;
  /** 该系列的成本（合计）与按桶的成本值（与 points 对齐；sub = null 表示未设置订阅方案） */
  cost?: CostBlock;
  costValues?: { api: number[]; sub: number[] | null };
}

export interface TimeseriesPayload {
  summary: Summary;
  points: TimelinePoint[];
  series: TimeSeriesItem[];
  query?: { tz?: string };
}

export interface SettingsData {
  dataRoot: string | null;
  timezone: string;
  weekStart: 'monday' | 'sunday';
  defaultBasis: Basis;
  autoRefresh: { enabled: boolean; intervalSec: number };
  theme: 'light' | 'dark' | 'system';
  language: 'zh' | 'en';
  groupScratch: boolean;
  budget: { daily: number | null; monthly: number | null };
  /** 订阅方案（批次 C）：monthlyFeeUsd 为 null = 未设置 */
  subscription?: { plan: 'pro' | 'max5x' | 'max20x' | 'custom' | null; monthlyFeeUsd: number | null; billingDay?: number | null };
}

export interface SettingsPayload {
  settings: SettingsData;
  effective: { dataRoot: string; timezone: string };
  systemTimezone: string;
  version: number;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// 批次 B：热力图 / 当日明细 / 分析 / 会话
// ---------------------------------------------------------------------------

export interface HeatmapPayload {
  from: string;
  to: string;
  weeks: number;
  weekStart: 'monday' | 'sunday';
  tz: string;
  max: number;
  total: number;
  days: Array<{ date: string; value: number; total: number; fresh: number; requests: number }>;
}

export interface SessionBrief {
  id: string;
  title: string | null;
  titleSource: 'custom' | 'auto' | 'none';
  projectId: string;
  projectName: string;
  firstTs: number;
  lastTs: number;
  requests: number;
  value: number;
  total: number;
}

export interface DayDetailPayload {
  date: string;
  tz: string;
  summary: Summary;
  hours: Array<{ key: string; start: number; value: number; total: number; requests: number }>;
  sessions: SessionBrief[];
  sessionCount: number;
}

export interface ModelRowApi {
  key: string;
  display: string;
  family: string;
  isLocal: boolean;
  requests: number;
  value: number;
  total: number;
  share: number;
  rawIds: string[];
  cost?: CostBlock;
}

export interface SessionRowApi extends SessionBrief {
  projectKey: string;
  durationMs: number;
  sidechainRequests: number;
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  fresh: number;
  mainModel: { key: string; display: string; isLocal: boolean } | null;
  cost?: CostBlock;
}

export interface SessionsPayload {
  basis: Basis;
  tz: string;
  sort: 'tokens' | 'requests' | 'start' | 'duration';
  dir: 'asc' | 'desc';
  page: number;
  pageSize: number;
  total: number;
  sumValue: number;
  rows: SessionRowApi[];
}

export interface SessionDetailPayload {
  id: string;
  title: string | null;
  titleSource: 'custom' | 'auto' | 'none';
  basis: Basis;
  tz: string;
  projectId: string;
  projectName: string;
  firstTs: number;
  lastTs: number;
  durationMs: number;
  requestCount: number;
  cost?: CostBlock;
  sidechainRequests: number;
  composition: { input: number; cacheWrite: number; cacheRead: number; output: number; thinking: number; total: number; fresh: number; value: number };
  models: Array<{ key: string; display: string; isLocal: boolean; requests: number; value: number; total: number }>;
  tools: Array<{ name: string; count: number }>;
  requests: Array<{ ts: number; input: number; cacheWrite: number; cacheRead: number; output: number; total: number; fresh: number; value: number; model: string; modelDisplay: string; isSidechain: boolean; context: number }>;
  compactions: number[];
}

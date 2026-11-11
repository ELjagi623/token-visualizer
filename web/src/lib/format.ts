/**
 * 数字 / 时间格式化（纯函数，无 DOM 依赖，可在 Node 下单测）。
 */

export interface TokenParts {
  /** 数字部分，如 "1.42" / "38.6" / "412" / "8,420" */
  num: string;
  /** 缩写单位：'' | K | M | B | T */
  unit: string;
}

const UNITS = ['', 'K', 'M', 'B', 'T'] as const;
const DASH = '—';

function roundTo(v: number, d: number): number {
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

/** 三位有效数字：1.42 / 14.2 / 142（进位后重新判定，避免出现 "10.00"、"100.0"）。 */
function sig3(v: number): string {
  let d = v < 10 ? 2 : v < 100 ? 1 : 0;
  let r = roundTo(v, d);
  if (d === 2 && r >= 10) {
    d = 1;
    r = roundTo(v, 1);
  }
  if (d === 1 && r >= 100) {
    d = 0;
    r = roundTo(v, 0);
  }
  return r.toFixed(d);
}

/**
 * 缩写：< 10,000 用千分位精确值；≥ 10,000 缩写为 K / M / B / T 并保留 3 位有效数字。
 * 无值（null / NaN / ∞）→ "—"。
 */
export function formatTokenParts(n: number | null | undefined): TokenParts {
  if (n === null || n === undefined || !Number.isFinite(n)) return { num: DASH, unit: '' };
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs < 10_000) return { num: sign + Math.round(abs).toLocaleString('en-US'), unit: '' };
  let i = 0;
  let v = abs;
  while (v >= 1000 && i < UNITS.length - 1) {
    v /= 1000;
    i++;
  }
  let text = sig3(v);
  if (parseFloat(text) >= 1000 && i < UNITS.length - 1) {
    v /= 1000;
    i++;
    text = sig3(v);
  }
  return { num: sign + text, unit: UNITS[i] ?? '' };
}

/** "1.42 M" / "8,420" / "—" */
export function formatTokens(n: number | null | undefined): string {
  const p = formatTokenParts(n);
  return p.unit ? `${p.num} ${p.unit}` : p.num;
}

/** 精确值（千分位）："1,284,300"；无值 → "—"。 */
export function formatExact(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return DASH;
  return Math.round(n).toLocaleString('en-US');
}

/** 比例（0–1）→ "94.3%"；null → "—"。 */
export function formatPercent(ratio: number | null | undefined, digits = 1): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return DASH;
  return `${(ratio * 100).toFixed(digits)}%`;
}

export interface DeltaView {
  /** "▲ 12%" / "▼ 8%" / "—" */
  text: string;
  dir: 'up' | 'down' | 'flat' | 'none';
}

/** 环比（pct 为小数，如 0.12）；上期为 0（pct = null）→ "—"，绝不出现 NaN / ∞。 */
export function formatDelta(pct: number | null | undefined): DeltaView {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return { text: DASH, dir: 'none' };
  const v = Math.round(Math.abs(pct) * 100);
  if (v === 0) return { text: '0%', dir: 'flat' };
  // 基数极小时（如月初对上月零头）环比会大到没有意义：封顶显示 999%+，避免 ▲475609% 这类数字
  const shown = v > 999 ? '999%+' : `${v}%`;
  return pct > 0 ? { text: `▲ ${shown}`, dir: 'up' } : { text: `▼ ${shown}`, dir: 'down' };
}

export type TimeKey = 'time.justNow' | 'time.secondsAgo' | 'time.minutesAgo' | 'time.hoursAgo' | 'time.yesterday' | 'time.daysAgo' | 'time.weeksAgo' | 'time.monthsAgo';
export type Translate = (key: TimeKey, params?: Record<string, string | number>) => string;

/** 相对时间（基于经过的时间）："刚刚" / "5 分钟前" / "3 小时前" / "昨天" / "3 天前" / "2 周前" / "3 个月前"。 */
export function formatRelative(ts: number | null | undefined, now: number, t: Translate): string {
  if (ts === null || ts === undefined || !Number.isFinite(ts)) return DASH;
  const sec = Math.max(0, Math.floor((now - ts) / 1000));
  if (sec < 10) return t('time.justNow');
  if (sec < 60) return t('time.secondsAgo', { n: sec });
  const min = Math.floor(sec / 60);
  if (min < 60) return t('time.minutesAgo', { n: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return t('time.hoursAgo', { n: hr });
  const day = Math.floor(hr / 24);
  if (day < 2) return t('time.yesterday');
  if (day < 14) return t('time.daysAgo', { n: day });
  if (day < 60) return t('time.weeksAgo', { n: Math.floor(day / 7) });
  return t('time.monthsAgo', { n: Math.floor(day / 30) });
}

/** 秒级时钟 "12:04:31"（本地时间，24 小时制）。 */
export function formatClock(ts: number | null | undefined): string {
  if (ts === null || ts === undefined || !Number.isFinite(ts)) return DASH;
  const d = new Date(ts);
  const p = (x: number): string => String(x).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 字节数 → "296 MB" / "1.2 GB"。 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return DASH;
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)} ${units[i]}`;
}

/** 毫秒 → 小时（保留 1 位小数的数字）。 */
export function msToHours(ms: number): number {
  return ms / 3_600_000;
}

/** 毫秒 → "3 h 42 m" / "42 m" / "35 s" 的 [数值, 单位] 片段（会话时长）。 */
export function durationParts(ms: number): Array<{ n: number; unit: 'h' | 'm' | 's' }> {
  if (!Number.isFinite(ms) || ms < 0) return [];
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return [{ n: h, unit: 'h' }, { n: m, unit: 'm' }];
  if (m > 0) return [{ n: m, unit: 'm' }];
  return [{ n: s, unit: 's' }];
}

/** "3h 42m" 纯文本。 */
export function formatDuration(ms: number): string {
  const parts = durationParts(ms);
  return parts.length === 0 ? DASH : parts.map((p) => `${p.n}${p.unit}`).join(' ');
}

/** 在指定 IANA 时区下格式化时间 "MM/DD HH:mm"。 */
export function formatDateTime(ts: number, tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(ts);
    const g = (t: string): string => parts.find((x) => x.type === t)?.value ?? '';
    return `${g('month')}/${g('day')} ${g('hour') === '24' ? '00' : g('hour')}:${g('minute')}`;
  } catch {
    return DASH;
  }
}

/** 在指定时区下取本地日期 YYYY-MM-DD。 */
export function localDate(ts: number, tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(ts);
    const g = (t: string): string => parts.find((x) => x.type === t)?.value ?? '';
    return `${g('year')}-${g('month')}-${g('day')}`;
  } catch {
    return '';
  }
}

/** 在指定时区下取本地小时 0–23。 */
export function localHour(ts: number, tz: string): number {
  try {
    const h = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }).formatToParts(ts).find((x) => x.type === 'hour')?.value ?? '0';
    return Number(h) % 24;
  } catch {
    return 0;
  }
}

/** YYYY-MM-DD → 星期几（0 = 周日），与时区无关（纯日历运算）。 */
export function weekdayOfDate(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)).getUTCDay();
}

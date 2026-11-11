/**
 * 时区感知的日界 / 桶 / 范围计算。
 *
 * 做法：用 `Intl.DateTimeFormat`（按时区缓存）只求"UTC 偏移"，偏移再按 15 分钟桶缓存
 * （现行所有时区的偏移切换点都落在 15 分钟边界上）；之后的年月日、星期、小时全部用
 * 纯算术（civil-from-days）从"本地毫秒数"得到。因此：
 *   - DST 切换日（23 / 25 小时的日）与非整小时偏移（如 Asia/Kolkata +5:30）都正确；
 *   - 热路径（对每条记录取本地日期）不再调用 Intl。
 */

export type Granularity = 'hour' | 'day' | 'week' | 'month';
export type WeekStart = 'monday' | 'sunday';
export type RangeKind = 'today' | '7d' | '30d' | 'thisMonth' | '90d' | 'all' | 'custom';

export interface RangeSpec {
  kind: RangeKind;
  /** 仅 custom：本地日期 `YYYY-MM-DD`（含）。 */
  from?: string;
  /** 仅 custom：本地日期 `YYYY-MM-DD`（含）。 */
  to?: string;
}

/** 查询参数不合法（阶段 4 的 API 层把它映射为 400）。 */
export class QueryError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'QueryError';
    this.code = code;
  }
}

const HOUR = 3_600_000;
const DAY = 86_400_000;
const QUARTER = 900_000;

// ---------------------------------------------------------------------------
// 时区偏移
// ---------------------------------------------------------------------------

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function getDtf(tz: string): Intl.DateTimeFormat {
  let f = dtfCache.get(tz);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
      });
    } catch {
      throw new QueryError('INVALID_TZ', `无效的时区：${tz}`);
    }
    dtfCache.set(tz, f);
  }
  return f;
}

/** 校验 IANA 时区名，非法则抛 QueryError。 */
export function assertValidTimeZone(tz: string): void {
  if (typeof tz !== 'string' || tz.length === 0) throw new QueryError('INVALID_TZ', '时区不能为空');
  getDtf(tz);
}

const offsetCache = new Map<string, Map<number, number>>();

/** 时刻 ts 处该时区相对 UTC 的偏移（毫秒，东为正）。 */
export function tzOffsetMs(ts: number, tz: string): number {
  if (tz === 'UTC' || tz === 'Etc/UTC') return 0;
  const bucket = Math.floor(ts / QUARTER);
  let m = offsetCache.get(tz);
  if (!m) {
    m = new Map();
    offsetCache.set(tz, m);
  }
  const hit = m.get(bucket);
  if (hit !== undefined) return hit;
  const t = bucket * QUARTER;
  const parts = getDtf(tz).formatToParts(new Date(t));
  let y = 0;
  let mo = 0;
  let d = 0;
  let h = 0;
  let mi = 0;
  let s = 0;
  for (const p of parts) {
    switch (p.type) {
      case 'year':
        y = Number(p.value);
        break;
      case 'month':
        mo = Number(p.value);
        break;
      case 'day':
        d = Number(p.value);
        break;
      case 'hour':
        h = Number(p.value) % 24;
        break;
      case 'minute':
        mi = Number(p.value);
        break;
      case 'second':
        s = Number(p.value);
        break;
      default:
        break;
    }
  }
  const off = Date.UTC(y, mo - 1, d, h, mi, s) - t;
  if (m.size > 100_000) m.clear();
  m.set(bucket, off);
  return off;
}

// ---------------------------------------------------------------------------
// 公历算术（Howard Hinnant 的 days_from_civil / civil_from_days）
// ---------------------------------------------------------------------------

export function daysFromCivil(y: number, m: number, d: number): number {
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

export function civilFromDays(z: number): { y: number; m: number; d: number } {
  z += 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return { y: y + (m <= 2 ? 1 : 0), m, d };
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function dateStr(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${pad2(m)}-${pad2(d)}`;
}

export interface LocalParts {
  y: number;
  m: number;
  d: number;
  h: number;
  /** 0 = 周日 … 6 = 周六 */
  weekday: number;
  /** `YYYY-MM-DD` */
  date: string;
  /** 距 1970-01-01 的本地日序号 */
  dayNumber: number;
}

/** 时刻 ts 在 tz 下的本地年月日 / 小时 / 星期。 */
export function localParts(ts: number, tz: string): LocalParts {
  const local = ts + tzOffsetMs(ts, tz);
  const dayNumber = Math.floor(local / DAY);
  const { y, m, d } = civilFromDays(dayNumber);
  const h = Math.floor((local - dayNumber * DAY) / HOUR);
  const weekday = (((dayNumber + 4) % 7) + 7) % 7; // 1970-01-01 是周四
  return { y, m, d, h, weekday, date: dateStr(y, m, d), dayNumber };
}

/** 本地日期 `YYYY-MM-DD`。 */
export function localDateKey(ts: number, tz: string): string {
  return localParts(ts, tz).date;
}

/** 本地 (y,m,d,h,mi,s) → UTC 毫秒。落在 DST 空洞时向后推；落在重复小时取先出现的那个。 */
export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  let t = guess - tzOffsetMs(guess, tz);
  const o2 = tzOffsetMs(t, tz);
  if (guess - o2 !== t) t = guess - o2;
  return t;
}

function startOfLocalDay(dayNumber: number, tz: string): number {
  const { y, m, d } = civilFromDays(dayNumber);
  return zonedToUtc(y, m, d, 0, 0, 0, tz);
}

// ---------------------------------------------------------------------------
// 桶
// ---------------------------------------------------------------------------

function weekOffsetDays(weekday: number, weekStart: WeekStart): number {
  return weekStart === 'monday' ? (weekday + 6) % 7 : weekday;
}

function offsetLabel(offMs: number): string {
  const sign = offMs < 0 ? '-' : '+';
  const abs = Math.abs(offMs) / 60_000;
  return `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

export interface Bucket {
  /** 桶键：day `YYYY-MM-DD`；week 为该周起始日 `YYYY-MM-DD`；month `YYYY-MM`；hour `YYYY-MM-DDTHH`（DST 回拨产生的重复小时追加 `@±HH:MM`）。 */
  key: string;
  /** 桶起点（UTC 毫秒）。 */
  start: number;
}

function hourLabel(startLocal: number): string {
  const dayNumber = Math.floor(startLocal / DAY);
  const { y, m, d } = civilFromDays(dayNumber);
  const h = Math.floor((startLocal - dayNumber * DAY) / HOUR);
  return `${dateStr(y, m, d)}T${pad2(h)}`;
}

export function bucketOf(ts: number, granularity: Granularity, tz: string, weekStart: WeekStart = 'monday'): Bucket {
  switch (granularity) {
    case 'hour': {
      const off = tzOffsetMs(ts, tz);
      const startLocal = Math.floor((ts + off) / HOUR) * HOUR;
      const start = startLocal - off;
      let key = hourLabel(startLocal);
      // 回拨日：同一个本地小时出现两次 → 用偏移区分
      const prev = hourLabel(start - HOUR + tzOffsetMs(start - HOUR, tz));
      const next = hourLabel(start + HOUR + tzOffsetMs(start + HOUR, tz));
      if (prev === key || next === key) key = `${key}@${offsetLabel(off)}`;
      return { key, start };
    }
    case 'day': {
      const p = localParts(ts, tz);
      return { key: p.date, start: startOfLocalDay(p.dayNumber, tz) };
    }
    case 'week': {
      const p = localParts(ts, tz);
      const first = p.dayNumber - weekOffsetDays(p.weekday, weekStart);
      const c = civilFromDays(first);
      return { key: dateStr(c.y, c.m, c.d), start: startOfLocalDay(first, tz) };
    }
    case 'month': {
      const p = localParts(ts, tz);
      return { key: `${String(p.y).padStart(4, '0')}-${pad2(p.m)}`, start: zonedToUtc(p.y, p.m, 1, 0, 0, 0, tz) };
    }
    default:
      throw new QueryError('INVALID_GRANULARITY', `未知的时间粒度：${String(granularity)}`);
  }
}

export function bucketKey(ts: number, granularity: Granularity, tz: string, weekStart: WeekStart = 'monday'): string {
  return bucketOf(ts, granularity, tz, weekStart).key;
}

export function nextBucketStart(start: number, granularity: Granularity, tz: string): number {
  switch (granularity) {
    case 'hour':
      return start + HOUR;
    case 'day': {
      const p = localParts(start + 2 * HOUR, tz); // +2h：即使起点因 DST 空洞被推迟，也仍落在同一本地日
      return startOfLocalDay(p.dayNumber + 1, tz);
    }
    case 'week': {
      const p = localParts(start + 2 * HOUR, tz);
      return startOfLocalDay(p.dayNumber + 7, tz);
    }
    case 'month': {
      const p = localParts(start + 2 * HOUR, tz);
      const y = p.m === 12 ? p.y + 1 : p.y;
      const m = p.m === 12 ? 1 : p.m + 1;
      return zonedToUtc(y, m, 1, 0, 0, 0, tz);
    }
    default:
      throw new QueryError('INVALID_GRANULARITY', `未知的时间粒度：${String(granularity)}`);
  }
}

export const MAX_BUCKETS = 50_000;

/** 枚举覆盖 [fromTs, toTs) 的全部桶（起点升序，空桶也在内）。 */
export function enumerateBuckets(fromTs: number, toTs: number, granularity: Granularity, tz: string, weekStart: WeekStart = 'monday'): Bucket[] {
  const out: Bucket[] = [];
  if (!(toTs > fromTs)) return out;
  let start = bucketOf(fromTs, granularity, tz, weekStart).start;
  while (start < toTs) {
    out.push(bucketOf(start, granularity, tz, weekStart));
    if (out.length > MAX_BUCKETS) throw new QueryError('TOO_MANY_BUCKETS', `时间桶过多（>${MAX_BUCKETS}），请缩小范围或换更粗的粒度`);
    const next = nextBucketStart(start, granularity, tz);
    start = next > start ? next : start + HOUR;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 今日 / 昨日 / 本周 / 本月 与范围解析
// ---------------------------------------------------------------------------

export function startOfToday(nowTs: number, tz: string): number {
  return startOfLocalDay(localParts(nowTs, tz).dayNumber, tz);
}

export function startOfYesterday(nowTs: number, tz: string): number {
  return startOfLocalDay(localParts(nowTs, tz).dayNumber - 1, tz);
}

export function startOfWeek(nowTs: number, tz: string, weekStart: WeekStart): number {
  const p = localParts(nowTs, tz);
  return startOfLocalDay(p.dayNumber - weekOffsetDays(p.weekday, weekStart), tz);
}

export function startOfMonth(nowTs: number, tz: string): number {
  const p = localParts(nowTs, tz);
  return zonedToUtc(p.y, p.m, 1, 0, 0, 0, tz);
}

export interface PeriodBounds {
  today: [number, number];
  yesterday: [number, number];
  thisWeek: [number, number];
  prevWeek: [number, number];
  thisMonth: [number, number];
  prevMonth: [number, number];
}

/** 订阅续费日（1–31 号）；null = 未设置，"本月"按自然月。 */
export type BillingDay = number | null;

function monthLength(y: number, m: number): number {
  return daysFromCivil(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1, 1) - daysFromCivil(y, m, 1);
}

/** y 年 m 月的续费日锚点（本地日序号）：续费日 > 当月天数时落在当月最后一天（如 31 号遇 2 月 → 28 / 29 号）。 */
function billingAnchor(y: number, m: number, billingDay: number): number {
  return daysFromCivil(y, m, Math.min(billingDay, monthLength(y, m)));
}

/**
 * 包含 dayNumber 的订阅周期：[startDn, endDn)（endDn = 下一个续费日，不含）。
 * 起点 = 最近一个 ≤ 当天的续费日；周期长度 = endDn − startDn（28–31 天不等）。
 */
export function billingCycle(dayNumber: number, billingDay: number): { startDn: number; endDn: number } {
  const c = civilFromDays(dayNumber);
  const prev = (y: number, m: number): { y: number; m: number } => (m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 });
  const next = (y: number, m: number): { y: number; m: number } => (m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 });
  let ym = { y: c.y, m: c.m };
  if (dayNumber < billingAnchor(ym.y, ym.m, billingDay)) ym = prev(ym.y, ym.m);
  const n = next(ym.y, ym.m);
  return { startDn: billingAnchor(ym.y, ym.m, billingDay), endDn: billingAnchor(n.y, n.m, billingDay) };
}

/** 各"期"的 [起, 止) 边界；止为下一期起点（不是 now）。billingDay 非 null 时，本月 / 上月 = 当前 / 上一个订阅周期。 */
export function periodBounds(nowTs: number, tz: string, weekStart: WeekStart, billingDay: BillingDay = null): PeriodBounds {
  const p = localParts(nowTs, tz);
  const day = (n: number): number => startOfLocalDay(n, tz);
  const wk = p.dayNumber - weekOffsetDays(p.weekday, weekStart);
  const month = (y: number, m: number): number => zonedToUtc(y, m, 1, 0, 0, 0, tz);
  const nextM = p.m === 12 ? { y: p.y + 1, m: 1 } : { y: p.y, m: p.m + 1 };
  const prevM = p.m === 1 ? { y: p.y - 1, m: 12 } : { y: p.y, m: p.m - 1 };
  let thisMonth: [number, number] = [month(p.y, p.m), month(nextM.y, nextM.m)];
  let prevMonth: [number, number] = [month(prevM.y, prevM.m), month(p.y, p.m)];
  if (billingDay !== null) {
    const cur = billingCycle(p.dayNumber, billingDay);
    const prev = billingCycle(cur.startDn - 1, billingDay);
    thisMonth = [day(cur.startDn), day(cur.endDn)];
    prevMonth = [day(prev.startDn), day(prev.endDn)];
  }
  return {
    today: [day(p.dayNumber), day(p.dayNumber + 1)],
    yesterday: [day(p.dayNumber - 1), day(p.dayNumber)],
    thisWeek: [day(wk), day(wk + 7)],
    prevWeek: [day(wk - 7), day(wk)],
    thisMonth,
    prevMonth,
  };
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseLocalDate(s: string | undefined, label: string): number {
  const m = typeof s === 'string' ? DATE_RE.exec(s) : null;
  if (!m) throw new QueryError('INVALID_RANGE', `${label} 必须是 YYYY-MM-DD 格式`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dn = daysFromCivil(y, mo, d);
  const back = civilFromDays(dn);
  if (back.y !== y || back.m !== mo || back.d !== d) throw new QueryError('INVALID_RANGE', `${label} 不是有效日期：${s}`);
  return dn;
}

export interface ResolvedRange {
  /** 起点（含）；null = 不设下限（all） */
  fromTs: number | null;
  /** 终点（不含）；null = 不设上限（all） */
  toTs: number | null;
}

/**
 * 解析范围。today / 7d / 30d / 90d 都以"今天"结尾（含今天，共 N 个本地日）；
 * thisMonth = 本月 1 日 0 点 至 下月 1 日 0 点（设置了续费日时 = 当前订阅周期）；custom 的 from/to 是含两端的本地日期。
 */
export function resolveRange(spec: RangeSpec, nowTs: number, tz: string, billingDay: BillingDay = null): ResolvedRange {
  const today = localParts(nowTs, tz).dayNumber;
  switch (spec.kind) {
    case 'today':
      return { fromTs: startOfLocalDay(today, tz), toTs: startOfLocalDay(today + 1, tz) };
    case '7d':
      return { fromTs: startOfLocalDay(today - 6, tz), toTs: startOfLocalDay(today + 1, tz) };
    case '30d':
      return { fromTs: startOfLocalDay(today - 29, tz), toTs: startOfLocalDay(today + 1, tz) };
    case '90d':
      return { fromTs: startOfLocalDay(today - 89, tz), toTs: startOfLocalDay(today + 1, tz) };
    case 'thisMonth': {
      const b = periodBounds(nowTs, tz, 'monday', billingDay).thisMonth;
      return { fromTs: b[0], toTs: b[1] };
    }
    case 'all':
      return { fromTs: null, toTs: null };
    case 'custom': {
      const f = parseLocalDate(spec.from, 'from');
      const t = parseLocalDate(spec.to, 'to');
      if (f > t) throw new QueryError('INVALID_RANGE', 'from 不能晚于 to');
      return { fromTs: startOfLocalDay(f, tz), toTs: startOfLocalDay(t + 1, tz) };
    }
    default:
      throw new QueryError('INVALID_RANGE', `未知的时间范围：${String((spec as RangeSpec).kind)}`);
  }
}

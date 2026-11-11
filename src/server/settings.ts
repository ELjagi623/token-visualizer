/**
 * 设置：默认值、校验、持久化（应用数据目录下的 settings.json，原子写；绝不写数据根）。
 *
 * - 读取时容错：文件不存在 → 默认值；损坏 / 含非法字段 → 对应字段回退默认值并给出警告，不崩溃；
 * - PUT 语义：部分更新（只给要改的字段，嵌套对象也可只给部分字段）；未知字段 / 非法值 → 400 级错误，整次更新不生效。
 */
import type { Basis } from '../shared/metrics.ts';
import { assertValidTimeZone, QueryError } from './core/time.ts';
import { systemTimeZone } from './systemTz.ts';
import { isInside, resolveReal } from './core/safeFs.ts';
import type { WeekStart } from './core/time.ts';
import type { AppDataWriter, SafeFs } from './core/safeFs.ts';
import path from 'node:path';

export interface Settings {
  /** 数据根目录；null = 自动（TV_DATA_ROOT 或 ~/.claude/projects） */
  dataRoot: string | null;
  /** IANA 时区名，或 "system"（跟随系统） */
  timezone: string;
  weekStart: WeekStart;
  defaultBasis: Basis;
  autoRefresh: { enabled: boolean; intervalSec: number };
  theme: 'light' | 'dark' | 'system';
  language: 'zh' | 'en';
  groupScratch: boolean;
  /** 每日 / 每月预算（token 数；null = 不设置） */
  budget: { daily: number | null; monthly: number | null };
  /**
   * 订阅方案：plan 只是预设标签，真正参与计算的是 monthlyFeeUsd（null = 未设置，口径②与回本卡不显示）。
   * billingDay = 每月续费日（1–31）：设置后"本月"= 当前订阅周期（续费日 → 下个续费日前一天）；null = 自然月。与月费无关。
   * feeCurrency / cnyPerUsd：月费输入框的币种与汇率（1 USD = ? CNY，手填，软件不联网）。只是输入 / 显示的换算层，
   * 存储与全部计算仍以 monthlyFeeUsd 为准。
   */
  subscription: { plan: SubscriptionPlan | null; monthlyFeeUsd: number | null; billingDay: number | null; feeCurrency: FeeCurrency; cnyPerUsd: number };
}

export type FeeCurrency = 'USD' | 'CNY';
export const DEFAULT_CNY_PER_USD = 7.2;
export const MAX_CNY_PER_USD = 100;

export type SubscriptionPlan = 'pro' | 'max5x' | 'max20x' | 'custom';
export const SUBSCRIPTION_PLANS: readonly SubscriptionPlan[] = ['pro', 'max5x', 'max20x', 'custom'];
export const MAX_MONTHLY_FEE = 100_000;

export const SETTINGS_FILE = 'settings.json';
export const SETTINGS_SCHEMA = 1;

export function defaultSettings(): Settings {
  return {
    dataRoot: null,
    timezone: 'system',
    weekStart: 'monday',
    defaultBasis: 'total',
    autoRefresh: { enabled: true, intervalSec: 5 },
    theme: 'system',
    language: 'zh',
    groupScratch: true,
    budget: { daily: null, monthly: null },
    subscription: { plan: null, monthlyFeeUsd: null, billingDay: null, feeCurrency: 'USD', cnyPerUsd: DEFAULT_CNY_PER_USD },
  };
}

/** 设置校验失败（API 层映射为 400）。 */
export class SettingsError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = 'SettingsError';
    this.field = field;
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function checkKeys(obj: Record<string, unknown>, allowed: string[], where: string): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) throw new SettingsError(where ? `${where}.${k}` : k, `未知的设置项：${where ? `${where}.` : ''}${k}`);
  }
}

function budgetValue(v: unknown, field: string): number | null {
  if (v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1e15) throw new SettingsError(field, `${field} 必须是 ≥ 0 的数字或 null`);
  return v;
}

/**
 * 把一个"补丁"应用到当前设置上，返回新设置。逐字段校验，任何问题抛 SettingsError。
 * 注意：dataRoot 的"目录是否存在"由调用方（异步）另行校验；这里只校验格式。
 */
export function applyPatch(current: Settings, patch: unknown): Settings {
  if (!isObj(patch)) throw new SettingsError('', '请求体必须是 JSON 对象');
  checkKeys(patch, ['dataRoot', 'timezone', 'weekStart', 'defaultBasis', 'autoRefresh', 'theme', 'language', 'groupScratch', 'budget', 'subscription'], '');
  const next: Settings = structuredClone(current);

  if ('dataRoot' in patch) {
    const v = patch.dataRoot;
    if (v === null || v === '') next.dataRoot = null;
    else if (typeof v !== 'string' || v.length > 1000 || v.includes('\0')) throw new SettingsError('dataRoot', 'dataRoot 必须是路径字符串或 null');
    else if (!path.isAbsolute(v)) throw new SettingsError('dataRoot', 'dataRoot 必须是绝对路径');
    else next.dataRoot = path.resolve(v);
  }
  if ('timezone' in patch) {
    const v = patch.timezone;
    if (typeof v !== 'string') throw new SettingsError('timezone', 'timezone 必须是字符串（IANA 时区名或 "system"）');
    if (v !== 'system') {
      try {
        assertValidTimeZone(v);
      } catch (e) {
        throw new SettingsError('timezone', e instanceof QueryError ? e.message : '无效的时区');
      }
    }
    next.timezone = v;
  }
  if ('weekStart' in patch) {
    if (patch.weekStart !== 'monday' && patch.weekStart !== 'sunday') throw new SettingsError('weekStart', 'weekStart 只能是 monday 或 sunday');
    next.weekStart = patch.weekStart;
  }
  if ('defaultBasis' in patch) {
    if (patch.defaultBasis !== 'total' && patch.defaultBasis !== 'fresh') throw new SettingsError('defaultBasis', 'defaultBasis 只能是 total 或 fresh');
    next.defaultBasis = patch.defaultBasis;
  }
  if ('autoRefresh' in patch) {
    const a = patch.autoRefresh;
    if (!isObj(a)) throw new SettingsError('autoRefresh', 'autoRefresh 必须是对象');
    checkKeys(a, ['enabled', 'intervalSec'], 'autoRefresh');
    if ('enabled' in a) {
      if (typeof a.enabled !== 'boolean') throw new SettingsError('autoRefresh.enabled', 'autoRefresh.enabled 必须是布尔值');
      next.autoRefresh.enabled = a.enabled;
    }
    if ('intervalSec' in a) {
      const s = a.intervalSec;
      if (typeof s !== 'number' || !Number.isInteger(s) || s < 2 || s > 60) throw new SettingsError('autoRefresh.intervalSec', 'autoRefresh.intervalSec 必须是 2–60 之间的整数（秒）');
      next.autoRefresh.intervalSec = s;
    }
  }
  if ('theme' in patch) {
    if (patch.theme !== 'light' && patch.theme !== 'dark' && patch.theme !== 'system') throw new SettingsError('theme', 'theme 只能是 light、dark 或 system');
    next.theme = patch.theme;
  }
  if ('language' in patch) {
    if (patch.language !== 'zh' && patch.language !== 'en') throw new SettingsError('language', 'language 只能是 zh 或 en');
    next.language = patch.language;
  }
  if ('groupScratch' in patch) {
    if (typeof patch.groupScratch !== 'boolean') throw new SettingsError('groupScratch', 'groupScratch 必须是布尔值');
    next.groupScratch = patch.groupScratch;
  }
  if ('budget' in patch) {
    const b = patch.budget;
    if (!isObj(b)) throw new SettingsError('budget', 'budget 必须是对象');
    checkKeys(b, ['daily', 'monthly'], 'budget');
    if ('daily' in b) next.budget.daily = budgetValue(b.daily, 'budget.daily');
    if ('monthly' in b) next.budget.monthly = budgetValue(b.monthly, 'budget.monthly');
  }
  if ('subscription' in patch) {
    const sub = patch.subscription;
    if (!isObj(sub)) throw new SettingsError('subscription', 'subscription 必须是对象');
    checkKeys(sub, ['plan', 'monthlyFeeUsd', 'billingDay', 'feeCurrency', 'cnyPerUsd'], 'subscription');
    if ('feeCurrency' in sub) {
      if (sub.feeCurrency !== 'USD' && sub.feeCurrency !== 'CNY') throw new SettingsError('subscription.feeCurrency', 'subscription.feeCurrency 只能是 USD 或 CNY');
      next.subscription.feeCurrency = sub.feeCurrency;
    }
    if ('cnyPerUsd' in sub) {
      const r = sub.cnyPerUsd;
      if (typeof r !== 'number' || !Number.isFinite(r) || r <= 0 || r > MAX_CNY_PER_USD) throw new SettingsError('subscription.cnyPerUsd', `汇率（1 USD 兑多少 CNY）必须是 0–${MAX_CNY_PER_USD} 之间的正数`);
      next.subscription.cnyPerUsd = r;
    }
    if ('billingDay' in sub) {
      const d = sub.billingDay;
      if (d !== null && (typeof d !== 'number' || !Number.isInteger(d) || d < 1 || d > 31)) throw new SettingsError('subscription.billingDay', '续费日必须是 1–31 之间的整数或 null');
      next.subscription.billingDay = d as number | null;
    }
    if ('plan' in sub) {
      const p = sub.plan;
      if (p !== null && !(SUBSCRIPTION_PLANS as readonly unknown[]).includes(p)) throw new SettingsError('subscription.plan', 'subscription.plan 只能是 pro / max5x / max20x / custom 或 null');
      next.subscription.plan = p as SubscriptionPlan | null;
    }
    if ('monthlyFeeUsd' in sub) {
      const f = sub.monthlyFeeUsd;
      if (f !== null && (typeof f !== 'number' || !Number.isFinite(f) || f < 0 || f > MAX_MONTHLY_FEE)) throw new SettingsError('subscription.monthlyFeeUsd', `订阅月费必须是 0–${MAX_MONTHLY_FEE} 之间的数字（USD）或 null`);
      next.subscription.monthlyFeeUsd = f as number | null;
    }
  }
  return next;
}

export interface LoadResult {
  settings: Settings;
  warnings: string[];
}

/** 把磁盘内容（可能损坏 / 部分非法）合并进默认值：逐字段尝试，非法字段回退默认并警告。 */
export function sanitizeStored(raw: unknown): LoadResult {
  const warnings: string[] = [];
  let settings = defaultSettings();
  if (!isObj(raw) || !isObj(raw.settings)) {
    warnings.push('设置文件格式不正确，已使用默认设置');
    return { settings, warnings };
  }
  const stored = raw.settings;
  // 逐个顶层字段单独应用，一个坏字段不影响其它字段
  for (const key of Object.keys(stored)) {
    try {
      settings = applyPatch(settings, { [key]: stored[key] });
    } catch (e) {
      warnings.push(`设置项 ${key} 无效，已使用默认值：${(e as Error).message}`);
    }
  }
  return { settings, warnings };
}

export class SettingsStore {
  private current: Settings = defaultSettings();
  /** 每次修改 +1，用于响应缓存失效 */
  version = 0;
  warnings: string[] = [];
  private readonly writer: AppDataWriter;

  constructor(writer: AppDataWriter) {
    this.writer = writer;
  }

  get(): Settings {
    return structuredClone(this.current);
  }

  /** 价格表 / 项目覆盖规则等"设置类"数据变化时 +1：响应缓存与前端 useApi 的重取令牌都跟随 version。 */
  touch(): void {
    this.version++;
  }

  async load(): Promise<void> {
    let buf: Buffer | null = null;
    try {
      buf = await this.writer.readFile(SETTINGS_FILE);
    } catch (e) {
      this.warnings.push(`读取设置失败，已使用默认设置：${(e as Error).message}`);
      return;
    }
    if (buf === null) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(buf.toString('utf8'));
    } catch {
      this.warnings.push('设置文件已损坏，已使用默认设置（下次保存时会覆盖）');
      return;
    }
    const r = sanitizeStored(parsed);
    this.current = r.settings;
    this.warnings.push(...r.warnings);
  }

  /** 应用补丁并持久化；失败时（校验 / 写入）当前设置不变。 */
  async update(patch: unknown, extraCheck?: (next: Settings) => Promise<void>): Promise<Settings> {
    const next = applyPatch(this.current, patch);
    if (extraCheck) await extraCheck(next);
    await this.writer.atomicWriteFile(SETTINGS_FILE, `${JSON.stringify({ schema: SETTINGS_SCHEMA, settings: next }, null, 2)}\n`);
    this.current = next;
    this.version++;
    return structuredClone(next);
  }

  /**
   * 启动时自检：已保存的 dataRoot 若包含应用数据目录（旧版本 / 手工编辑 / 目录结构变化造成），
   * 在内存中回退为"自动"，记一条警告并尽力把修正写回文件；不会因此锁死设置。
   */
  async repairDataRoot(appDataDir: string): Promise<boolean> {
    const root = this.current.dataRoot;
    if (root === null || !dataRootContainsAppData(root, appDataDir)) return false;
    this.warnings.push(`已保存的数据根目录包含应用数据目录，已自动回退为默认数据根（请在设置中重新选择）`);
    this.current = { ...this.current, dataRoot: null };
    this.version++;
    try {
      await this.writer.atomicWriteFile(SETTINGS_FILE, `${JSON.stringify({ schema: SETTINGS_SCHEMA, settings: this.current }, null, 2)}
`);
    } catch {
      // 写不回去也不要紧：每次启动都会重新修正
    }
    return true;
  }

  /** 解析"生效时区"。 */
  effectiveTimezone(): string {
    return this.current.timezone === 'system' ? systemTimeZone() : this.current.timezone;
  }
}

/** 校验数据根：存在且是目录。返回规范化后的路径；否则抛 SettingsError（中文说明）。 */
export async function validateDataRoot(fs: SafeFs, root: string): Promise<string> {
  const abs = path.resolve(root);
  try {
    const st = await fs.stat(abs);
    if (!st.isDirectory) throw new SettingsError('dataRoot', `不是目录：${abs}`);
    await fs.readdir(abs);
  } catch (e) {
    if (e instanceof SettingsError) throw e;
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new SettingsError('dataRoot', `目录不存在：${abs}`);
    if (code === 'EACCES' || code === 'EPERM') throw new SettingsError('dataRoot', `没有权限读取该目录：${abs}`);
    throw new SettingsError('dataRoot', `无法读取该目录：${(e as Error).message}`);
  }
  return abs;
}

export const DATA_ROOT_CONTAINS_APPDATA = '数据根不能包含应用数据目录（缓存与设置的存放处），请选择其它目录';

/** 数据根是否等于或包含应用数据目录（这种配置会让缓存 / 设置的写入被只读保护拒绝）。 */
export function dataRootContainsAppData(root: string, appDataDir: string): boolean {
  return isInside(resolveReal(appDataDir), resolveReal(root));
}

/** 校验数据根与应用数据目录不冲突；冲突抛 SettingsError（不含绝对路径）。 */
export function assertDataRootCompatible(root: string, appDataDir: string): void {
  if (dataRootContainsAppData(root, appDataDir)) throw new SettingsError('dataRoot', DATA_ROOT_CONTAINS_APPDATA);
}

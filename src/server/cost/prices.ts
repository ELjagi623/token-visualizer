/**
 * 价格表：内置默认规则（src/server/data/prices.default.json，开发时联网核对官方页）+ 用户规则（应用数据目录 prices.json）。
 *
 * - 单位 USD / 百万 token；任一价格为 null = 未配置（该模型视为"未计价"，绝不当 0）；
 * - 匹配优先级：先用户规则，后内置；同一组内 exact > 最长 prefix > glob（`*` / `?`，按字面字符数多者优先）；
 * - exact 额外尝试"去掉日期 / [1m] 后缀"的模型名（claude-opus-4-5-20251101 → claude-opus-4-5）；
 * - 本地 / 非 Anthropic 模型（路径型、org/name、以及一切非 claude- 前缀的名字，见 normalizeModel）成本不适用并标记 local，不进入"未计价"；
 *   其中无路径的非 claude- 名字允许被用户规则覆盖成云端计价；
 * - 运行时绝不联网。
 */
import { normalizeModel } from '../core/models.ts';
import type { AppDataWriter } from '../core/safeFs.ts';
import builtinPrices from '../data/prices.default.json' with { type: 'json' };

export type MatchKind = 'exact' | 'prefix' | 'glob';

export interface PriceRule {
  id: string;
  pattern: string;
  match: MatchKind;
  inputUsdPerM: number | null;
  outputUsdPerM: number | null;
  cacheWrite5mUsdPerM: number | null;
  cacheWrite1hUsdPerM: number | null;
  cacheReadUsdPerM: number | null;
  /** fast 速度模式倍率（对整条记录的全部成本分量生效）；null = 未配置，不计溢价。 */
  fastMultiplier: number | null;
  sourceUrl: string | null;
  checkedAt: string | null;
}

export const PRICE_FIELDS = ['inputUsdPerM', 'outputUsdPerM', 'cacheWrite5mUsdPerM', 'cacheWrite1hUsdPerM', 'cacheReadUsdPerM'] as const;
export type PriceField = (typeof PRICE_FIELDS)[number];

export const PRICES_FILE = 'prices.json';
export const MAX_USER_RULES = 200;
const MAX_PRICE = 100_000;

export class PriceError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = 'PriceError';
    this.field = field;
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function priceValue(v: unknown, field: string): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > MAX_PRICE) throw new PriceError(field, `${field} 必须是 0–${MAX_PRICE} 之间的数字或 null`);
  return v;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 校验并规范化一条规则（用户提交 / 内置文件都走这里）。 */
export function normalizeRule(raw: unknown, where: string): PriceRule {
  if (!isObj(raw)) throw new PriceError(where, `${where} 必须是对象`);
  const allowed = ['id', 'pattern', 'match', ...PRICE_FIELDS, 'fastMultiplier', 'sourceUrl', 'checkedAt', 'origin', 'complete', 'note'];
  for (const k of Object.keys(raw)) if (!allowed.includes(k)) throw new PriceError(`${where}.${k}`, `未知的字段：${where}.${k}`);
  const pattern = raw.pattern;
  if (typeof pattern !== 'string' || pattern.trim().length === 0 || pattern.length > 200 || /[\0\r\n]/.test(pattern)) throw new PriceError(`${where}.pattern`, '匹配规则必须是 1–200 个字符的非空文本');
  const match = raw.match;
  if (match !== 'exact' && match !== 'prefix' && match !== 'glob') throw new PriceError(`${where}.match`, 'match 只能是 exact / prefix / glob');
  const id = typeof raw.id === 'string' && raw.id.length > 0 && raw.id.length <= 200 ? raw.id : `${match}:${pattern.trim()}`;
  let fast: number | null = null;
  if (raw.fastMultiplier !== null && raw.fastMultiplier !== undefined && raw.fastMultiplier !== '') {
    const f = raw.fastMultiplier;
    if (typeof f !== 'number' || !Number.isFinite(f) || f < 1 || f > 20) throw new PriceError(`${where}.fastMultiplier`, 'fastMultiplier 必须是 1–20 之间的数字或 null');
    fast = f;
  }
  let sourceUrl: string | null = null;
  if (raw.sourceUrl !== null && raw.sourceUrl !== undefined && raw.sourceUrl !== '') {
    if (typeof raw.sourceUrl !== 'string' || raw.sourceUrl.length > 500) throw new PriceError(`${where}.sourceUrl`, 'sourceUrl 必须是不超过 500 字符的文本');
    sourceUrl = raw.sourceUrl;
  }
  let checkedAt: string | null = null;
  if (raw.checkedAt !== null && raw.checkedAt !== undefined && raw.checkedAt !== '') {
    if (typeof raw.checkedAt !== 'string' || !DATE_RE.test(raw.checkedAt)) throw new PriceError(`${where}.checkedAt`, 'checkedAt 必须是 YYYY-MM-DD');
    checkedAt = raw.checkedAt;
  }
  return {
    id,
    pattern: pattern.trim(),
    match,
    inputUsdPerM: priceValue(raw.inputUsdPerM, `${where}.inputUsdPerM`),
    outputUsdPerM: priceValue(raw.outputUsdPerM, `${where}.outputUsdPerM`),
    cacheWrite5mUsdPerM: priceValue(raw.cacheWrite5mUsdPerM, `${where}.cacheWrite5mUsdPerM`),
    cacheWrite1hUsdPerM: priceValue(raw.cacheWrite1hUsdPerM, `${where}.cacheWrite1hUsdPerM`),
    cacheReadUsdPerM: priceValue(raw.cacheReadUsdPerM, `${where}.cacheReadUsdPerM`),
    fastMultiplier: fast,
    sourceUrl,
    checkedAt,
  };
}

/** 校验整组用户规则（PUT /api/prices 的请求体：`{ rules: [...] }`）。id 必须唯一。 */
export function validateUserRules(body: unknown): PriceRule[] {
  if (!isObj(body)) throw new PriceError('', '请求体必须是 JSON 对象');
  for (const k of Object.keys(body)) if (k !== 'rules') throw new PriceError(k, `未知的字段：${k}`);
  const list = body.rules;
  if (!Array.isArray(list)) throw new PriceError('rules', 'rules 必须是数组');
  if (list.length > MAX_USER_RULES) throw new PriceError('rules', `规则最多 ${MAX_USER_RULES} 条`);
  const out = list.map((r, i) => normalizeRule(r, `rules[${i}]`));
  const seen = new Set<string>();
  for (const r of out) {
    if (seen.has(r.id)) throw new PriceError('rules', `规则 id 重复：${r.id}`);
    seen.add(r.id);
  }
  return out;
}

export function isComplete(r: PriceRule): boolean {
  return PRICE_FIELDS.every((f) => r[f] !== null);
}

// ---------------------------------------------------------------------------
// 内置默认
// ---------------------------------------------------------------------------

export interface BuiltinInfo {
  rules: PriceRule[];
  defaultsVersion: string;
}

let builtinMemo: BuiltinInfo | null = null;

export function builtinDefaults(): BuiltinInfo {
  if (builtinMemo) return builtinMemo;
  const raw = builtinPrices as unknown as { defaultsVersion: string; rules: unknown[] };
  builtinMemo = { rules: raw.rules.map((r, i) => normalizeRule(r, `builtin[${i}]`)), defaultsVersion: raw.defaultsVersion };
  return builtinMemo;
}

// ---------------------------------------------------------------------------
// 匹配
// ---------------------------------------------------------------------------

const DATE_SUFFIX = /(?:-\d{8})?(?:\[[^\]]*\])?$/;

/** exact 比较时使用的候选名：原名、去 `[..]` 与 `-YYYYMMDD` 后缀的名字（小写）。 */
function exactCandidates(model: string): string[] {
  const lower = model.trim().toLowerCase();
  const stripped = lower.replace(DATE_SUFFIX, '');
  return stripped === lower ? [lower] : [lower, stripped];
}

function globToRegExp(p: string): RegExp {
  const esc = p
    .toLowerCase()
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${esc}$`, 's');
}

function literalLen(p: string): number {
  return p.replace(/[*?]/g, '').length;
}

interface Matcher {
  rule: PriceRule;
  re?: RegExp;
  pat: string;
}

function compile(rules: readonly PriceRule[]): Matcher[] {
  return rules.map((rule) => ({ rule, pat: rule.pattern.trim().toLowerCase(), ...(rule.match === 'glob' ? { re: globToRegExp(rule.pattern) } : {}) }));
}

/** 在一组规则里选最佳匹配：exact > 最长 prefix > glob（字面字符多者优先）；同级取靠前者。 */
function bestMatch(ms: readonly Matcher[], model: string): PriceRule | null {
  const cands = exactCandidates(model);
  const lower = model.trim().toLowerCase();
  let best: { rule: PriceRule; rank: number; len: number } | null = null;
  for (const m of ms) {
    let rank = -1;
    let len = 0;
    if (m.rule.match === 'exact') {
      if (cands.includes(m.pat)) {
        rank = 3;
        len = m.pat.length;
      }
    } else if (m.rule.match === 'prefix') {
      if (lower.startsWith(m.pat)) {
        rank = 2;
        len = m.pat.length;
      }
    } else if (m.re && (m.re.test(lower) || cands.some((c) => m.re!.test(c)))) {
      rank = 1;
      len = literalLen(m.pat);
    }
    if (rank < 0) continue;
    if (!best || rank > best.rank || (rank === best.rank && len > best.len)) best = { rule: m.rule, rank, len };
  }
  return best ? best.rule : null;
}

export interface ResolvedPrice {
  /** 本地模型：成本恒为 0，不进入未计价 */
  local: boolean;
  /** 命中的规则（本地模型 / 无匹配为 null） */
  rule: PriceRule | null;
  origin: 'user' | 'builtin' | null;
  /** 云端模型且规则完整（五个价格都已配置） */
  priced: boolean;
}

export class PriceBook {
  readonly user: readonly PriceRule[];
  private readonly userM: Matcher[];
  private readonly builtinM: Matcher[];
  private readonly memo = new Map<string, ResolvedPrice>();

  constructor(userRules: readonly PriceRule[], builtin: readonly PriceRule[] = builtinDefaults().rules) {
    this.user = userRules;
    this.userM = compile(userRules);
    this.builtinM = compile(builtin);
  }

  resolve(model: string): ResolvedPrice {
    let r = this.memo.get(model);
    if (r) return r;
    if (normalizeModel(model).isLocal) {
      // 路径型 / org/name 恒为本地；仅"无路径的非 claude- 名字"（grok-4.7、别名等）允许用户用自己的价格规则覆盖成云端计价
      const nameOnly = !/[\\/]/.test(model) && !model.toLowerCase().endsWith('.gguf');
      const u = nameOnly ? bestMatch(this.userM, model) : null;
      r = u ? { local: false, rule: u, origin: 'user', priced: isComplete(u) } : { local: true, rule: null, origin: null, priced: false };
    } else {
      const u = bestMatch(this.userM, model);
      if (u) r = { local: false, rule: u, origin: 'user', priced: isComplete(u) };
      else {
        const b = bestMatch(this.builtinM, model);
        r = b ? { local: false, rule: b, origin: 'builtin', priced: isComplete(b) } : { local: false, rule: null, origin: null, priced: false };
      }
    }
    this.memo.set(model, r);
    return r;
  }
}

// ---------------------------------------------------------------------------
// 用户规则持久化（只写应用数据目录）
// ---------------------------------------------------------------------------

export class PriceStore {
  private rules: PriceRule[] = [];
  /** 每次修改 +1，用于响应缓存失效 */
  version = 0;
  warnings: string[] = [];
  private book: PriceBook | null = null;
  private readonly writer: AppDataWriter;

  constructor(writer: AppDataWriter) {
    this.writer = writer;
  }

  async load(): Promise<void> {
    let buf: Buffer | null = null;
    try {
      buf = await this.writer.readFile(PRICES_FILE);
    } catch (e) {
      this.warnings.push(`读取价格表失败，已使用内置默认价格：${(e as Error).message}`);
      return;
    }
    if (buf === null) return;
    try {
      const parsed = JSON.parse(buf.toString('utf8')) as unknown;
      this.rules = validateUserRules({ rules: isObj(parsed) ? parsed.rules : undefined });
    } catch (e) {
      this.warnings.push(`价格表文件无效，已使用内置默认价格（下次保存时会覆盖）：${(e as Error).message}`);
      this.rules = [];
    }
    this.book = null;
  }

  get(): PriceRule[] {
    return structuredClone(this.rules);
  }

  getBook(): PriceBook {
    this.book ??= new PriceBook(this.rules);
    return this.book;
  }

  /** 整体替换用户规则（先校验，再原子写盘；失败时不变）。 */
  async replace(body: unknown): Promise<PriceRule[]> {
    const next = validateUserRules(body);
    await this.persist(next);
    return this.get();
  }

  /** 清空用户规则，恢复内置默认。 */
  async reset(): Promise<void> {
    await this.persist([]);
  }

  private async persist(next: PriceRule[]): Promise<void> {
    await this.writer.atomicWriteFile(PRICES_FILE, `${JSON.stringify({ schema: 1, rules: next }, null, 2)}\n`);
    this.rules = next;
    this.book = null;
    this.version++;
  }
}

export interface EffectiveRule extends PriceRule {
  origin: 'user' | 'builtin';
  /** 内置规则被同 id 的用户规则覆盖时为 true（此时只展示用户那条） */
  complete: boolean;
}

/** 供设置页展示：用户规则 + 未被同 id 用户规则覆盖的内置规则（用户规则在前）。 */
export function effectiveRules(user: readonly PriceRule[], builtin: readonly PriceRule[] = builtinDefaults().rules): EffectiveRule[] {
  const ids = new Set(user.map((r) => r.id));
  return [
    ...user.map((r) => ({ ...r, origin: 'user' as const, complete: isComplete(r) })),
    ...builtin.filter((r) => !ids.has(r.id)).map((r) => ({ ...r, origin: 'builtin' as const, complete: isComplete(r) })),
  ];
}

/**
 * 成本引擎：两种口径（规格见 docs/design/COST-SPEC.md）。
 *
 * 口径 ① 等价 API 成本：Σ（input×输入价 + output×输出价 + cacheWrite5m×5m 写价 + cacheWrite1h×1h 写价 + cacheRead×读价）/ 1e6。
 *   - 内部以整数纳美元（nano-USD）累加：token × 单价（USD / 百万 token）= 微美元，再 ×1000；同一批记录无论怎么分组，求和都精确相等。
 *   - cacheWrite 缺 5m / 1h 细分的部分按 5m 价；本地模型 = 0；云端模型价格不完整 → 记入 unpricedTokens / unpricedModels，绝不当 0。
 *   - speed === 'fast' 的记录：仅当规则配置了 fastMultiplier 才整条 ×倍率，否则不计溢价（并计数，界面注明"不含 fast 溢价"）。
 * 口径 ② 订阅摊销：本地日 d（不晚于今天）的日订阅费 = 月费 ÷ 当月天数，按当天各条目等价 API 成本占比分摊；
 *   当天等价 API 成本为 0 → 计入 idleUsd，不分配给任何条目。占比的分母是"当天全部（可见）记录"的成本，与筛选无关，
 *   所以各项目 / 会话 / 模型的分摊额之和 = 总分摊额。
 */
import type { UsageRecord } from '../../shared/types.ts';
import { billingCycle, civilFromDays, daysFromCivil, localParts } from '../core/time.ts';
import type { PriceBook, ResolvedPrice } from './prices.ts';

export interface CostBlock {
  /** 等价 API 成本（USD）；null = 该范围内没有任何已计价的云端模型 */
  apiUsd: number | null;
  /** 订阅摊销成本（USD，占比分摊）；null = 未设置订阅方案 */
  subUsd: number | null;
  /** 未计价的云端模型的 token 数（Total 口径：input + cacheWrite + cacheRead + output） */
  unpricedTokens: number;
  unpricedModels: string[];
}

export type CostType = 'input' | 'cacheWrite' | 'cacheRead' | 'output';
export const COST_TYPES: readonly CostType[] = ['input', 'cacheWrite', 'cacheRead', 'output'];

/** 一条记录的成本（纳美元，整数）。 */
export interface RecCost {
  kind: 'priced' | 'local' | 'unpriced';
  /** 各分量（顺序同 COST_TYPES） */
  comps: [number, number, number, number];
  nano: number;
  /** Total 口径 token 数 */
  tokens: number;
  /** 按 5m 价计的"缺细分"cacheWrite token 数 */
  assumed5m: number;
  fast: 'applied' | 'unconfigured' | 'none';
}

const ZERO4: [number, number, number, number] = [0, 0, 0, 0];

export function recordCost(r: UsageRecord, p: ResolvedPrice): RecCost {
  const tokens = r.input + r.cacheWrite + r.cacheRead + r.output;
  if (p.local) return { kind: 'local', comps: ZERO4, nano: 0, tokens, assumed5m: 0, fast: 'none' };
  const rule = p.rule;
  if (!p.priced || !rule) return { kind: 'unpriced', comps: ZERO4, nano: 0, tokens, assumed5m: 0, fast: 'none' };
  const inP = rule.inputUsdPerM!;
  const outP = rule.outputUsdPerM!;
  const w5 = rule.cacheWrite5mUsdPerM!;
  const w1 = rule.cacheWrite1hUsdPerM!;
  const rdP = rule.cacheReadUsdPerM!;
  const known = r.cacheWrite5m + r.cacheWrite1h;
  const unknown = Math.max(0, r.cacheWrite - known);
  const w5Tokens = r.cacheWrite5m + unknown;
  let fast: RecCost['fast'] = 'none';
  let mult = 1;
  if (r.speed === 'fast') {
    if (rule.fastMultiplier !== null) {
      mult = rule.fastMultiplier;
      fast = 'applied';
    } else fast = 'unconfigured';
  }
  // 1 token × 1 USD/M = 1e-6 USD = 1000 nano-USD
  const nanoOf = (x: number): number => Math.round(x * 1000 * mult);
  const comps: [number, number, number, number] = [nanoOf(r.input * inP), nanoOf(w5Tokens * w5 + r.cacheWrite1h * w1), nanoOf(r.cacheRead * rdP), nanoOf(r.output * outP)];
  return { kind: 'priced', comps, nano: comps[0] + comps[1] + comps[2] + comps[3], tokens, assumed5m: unknown, fast };
}

export function roundUsd(nano: number): number {
  return Math.round(nano / 1000) / 1e6;
}

function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

export interface CostAcc {
  nano: number;
  comps: [number, number, number, number];
  /** 订阅分摊（USD，浮点） */
  sub: number;
  subComps: [number, number, number, number];
  pricedRecords: number;
  localRecords: number;
  unpricedTokens: number;
  unpricedModels: Set<string>;
  assumed5m: number;
  fastApplied: number;
  fastUnconfigured: number;
}

export function newAcc(): CostAcc {
  return { nano: 0, comps: [0, 0, 0, 0], sub: 0, subComps: [0, 0, 0, 0], pricedRecords: 0, localRecords: 0, unpricedTokens: 0, unpricedModels: new Set(), assumed5m: 0, fastApplied: 0, fastUnconfigured: 0 };
}

export function mergeAcc(into: CostAcc, from: CostAcc): void {
  into.nano += from.nano;
  into.sub += from.sub;
  for (let i = 0; i < 4; i++) {
    into.comps[i]! += from.comps[i]!;
    into.subComps[i]! += from.subComps[i]!;
  }
  into.pricedRecords += from.pricedRecords;
  into.localRecords += from.localRecords;
  into.unpricedTokens += from.unpricedTokens;
  for (const m of from.unpricedModels) into.unpricedModels.add(m);
  into.assumed5m += from.assumed5m;
  into.fastApplied += from.fastApplied;
  into.fastUnconfigured += from.fastUnconfigured;
}

export interface EngineOptions {
  book: PriceBook;
  /** 订阅月费（USD）；null / ≤ 0 = 未设置 */
  monthlyFeeUsd: number | null;
  /** 订阅续费日（1–31）；设置后日订阅费 = 月费 ÷ 所在订阅周期天数（每个周期摊销之和 = 月费）；null = 按自然月 */
  billingDay?: number | null;
  tz: string;
  /** 当前时间（epoch ms）：不晚于今天的日子才分摊订阅费 */
  nowTs: number;
  /** 当天（本地日序号 → 纳美元）全部记录的成本；由 CostService 缓存后传入 */
  dayNano: Map<number, number>;
}

export function monthDays(dayNumber: number): number {
  const { y, m } = civilFromDays(dayNumber);
  return daysFromCivil(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1, 1) - daysFromCivil(y, m, 1);
}

/** 各本地日的全部记录成本（纳美元）。 */
export function computeDayNano(records: readonly UsageRecord[], book: PriceBook, tz: string): Map<number, number> {
  const m = new Map<number, number>();
  for (const r of records) {
    const c = recordCost(r, book.resolve(r.model));
    if (c.nano === 0) continue;
    const dn = localParts(r.ts, tz).dayNumber;
    m.set(dn, (m.get(dn) ?? 0) + c.nano);
  }
  return m;
}

export class CostEngine {
  readonly book: PriceBook;
  readonly tz: string;
  readonly fee: number | null;
  readonly billingDay: number | null;
  readonly todayDn: number;
  private readonly dayNano: Map<number, number>;
  private readonly feeMemo = new Map<number, number>();

  constructor(o: EngineOptions) {
    this.book = o.book;
    this.tz = o.tz;
    this.fee = o.monthlyFeeUsd !== null && o.monthlyFeeUsd > 0 ? o.monthlyFeeUsd : null;
    this.billingDay = o.billingDay ?? null;
    this.todayDn = localParts(o.nowTs, o.tz).dayNumber;
    this.dayNano = o.dayNano;
  }

  get subscriptionConfigured(): boolean {
    return this.fee !== null;
  }

  /** 某本地日的日订阅费（月费 ÷ 当月天数；设了续费日则 ÷ 所在订阅周期天数）；未设置订阅方案为 0。 */
  dailyFee(dn: number): number {
    if (this.fee === null) return 0;
    let v = this.feeMemo.get(dn);
    if (v === undefined) {
      if (this.billingDay !== null) {
        const c = billingCycle(dn, this.billingDay);
        v = this.fee / (c.endDn - c.startDn);
      } else v = this.fee / monthDays(dn);
      this.feeMemo.set(dn, v);
    }
    return v;
  }

  dayTotalNano(dn: number): number {
    return this.dayNano.get(dn) ?? 0;
  }

  /** 把一条记录累加进 acc（含订阅分摊）。 */
  add(acc: CostAcc, r: UsageRecord, dn?: number): RecCost {
    const c = recordCost(r, this.book.resolve(r.model));
    if (c.kind === 'priced') {
      acc.pricedRecords++;
      acc.nano += c.nano;
      for (let i = 0; i < 4; i++) acc.comps[i]! += c.comps[i]!;
      acc.assumed5m += c.assumed5m;
      if (c.fast === 'applied') acc.fastApplied++;
      else if (c.fast === 'unconfigured') acc.fastUnconfigured++;
      if (this.fee !== null && c.nano > 0) {
        const day = dn ?? localParts(r.ts, this.tz).dayNumber;
        const total = this.dayNano.get(day) ?? 0;
        if (day <= this.todayDn && total > 0) {
          const f = this.dailyFee(day);
          acc.sub += (f * c.nano) / total;
          for (let i = 0; i < 4; i++) acc.subComps[i]! += (f * c.comps[i]!) / total;
        }
      }
    } else if (c.kind === 'local') acc.localRecords++;
    else {
      acc.unpricedTokens += c.tokens;
      acc.unpricedModels.add(r.model);
    }
    return c;
  }

  block(acc: CostAcc): CostBlock {
    return {
      apiUsd: acc.pricedRecords > 0 ? roundUsd(acc.nano) : null,
      subUsd: this.fee !== null ? round6(acc.sub) : null,
      unpricedTokens: acc.unpricedTokens,
      unpricedModels: [...acc.unpricedModels].sort(),
    };
  }

  /** 一组记录的合计成本。 */
  total(records: readonly UsageRecord[]): { acc: CostAcc; block: CostBlock } {
    const acc = newAcc();
    for (const r of records) this.add(acc, r);
    return { acc, block: this.block(acc) };
  }

  /** 按键分组。 */
  group<K>(records: readonly UsageRecord[], keyOf: (r: UsageRecord) => K): Map<K, CostAcc> {
    const m = new Map<K, CostAcc>();
    for (const r of records) {
      const k = keyOf(r);
      let a = m.get(k);
      if (!a) {
        a = newAcc();
        m.set(k, a);
      }
      this.add(a, r);
    }
    return m;
  }

  /** [fromDn, toDn]（含，且不晚于今天）内"当天等价 API 成本为 0"的日订阅费之和（闲置摊销）。 */
  idleUsd(fromDn: number, toDn: number): number | null {
    if (this.fee === null) return null;
    let s = 0;
    const end = Math.min(toDn, this.todayDn);
    for (let d = fromDn; d <= end; d++) if (this.dayTotalNano(d) === 0) s += this.dailyFee(d);
    return round6(s);
  }

  /** [fromDn, toDn]（含，且不晚于今天）内日订阅费之和。 */
  feeSum(fromDn: number, toDn: number): number | null {
    if (this.fee === null) return null;
    let s = 0;
    const end = Math.min(toDn, this.todayDn);
    for (let d = fromDn; d <= end; d++) s += this.dailyFee(d);
    return round6(s);
  }
}

/** 把 CostAcc 按 token 类型拆成 { input, cacheWrite, cacheRead, output }（USD）。 */
export function byTypeUsd(acc: CostAcc): Record<CostType, number> {
  return { input: roundUsd(acc.comps[0]), cacheWrite: roundUsd(acc.comps[1]), cacheRead: roundUsd(acc.comps[2]), output: roundUsd(acc.comps[3]) };
}

export function bySubTypeUsd(acc: CostAcc): Record<CostType, number> {
  return { input: round6(acc.subComps[0]), cacheWrite: round6(acc.subComps[1]), cacheRead: round6(acc.subComps[2]), output: round6(acc.subComps[3]) };
}

/**
 * 缓存 dayNano：同一份记录 + 价格表 + 时区只算一次。
 * （records 数组对象在 dataVersion / 隐藏项目变化时才会换，所以用对象引用作键。）
 */
export class DayNanoCache {
  private recs: readonly UsageRecord[] | null = null;
  private book: PriceBook | null = null;
  private byTz = new Map<string, Map<number, number>>();

  get(records: readonly UsageRecord[], book: PriceBook, tz: string): Map<number, number> {
    if (this.recs !== records || this.book !== book) {
      this.recs = records;
      this.book = book;
      this.byTz.clear();
    }
    let m = this.byTz.get(tz);
    if (!m) {
      m = computeDayNano(records, book, tz);
      this.byTz.set(tz, m);
    }
    return m;
  }
}

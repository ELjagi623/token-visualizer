/**
 * 指标口径（PRD 第 4 节）。前后端共用。
 *
 *   Total = input + cacheWrite + cacheRead + output
 *   Fresh = input + cacheWrite + output          （Total - Fresh = cacheRead，精确相等）
 *   cacheHitRate = cacheRead / (input + cacheWrite + cacheRead)，分母为 0 → null
 *   thinking 包含在 output 内（正文输出 = output - thinking）
 */

export type Basis = 'total' | 'fresh';

export interface UsageNumbers {
  input: number;
  cacheWrite: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
  thinking: number;
}

export function zeroUsage(): UsageNumbers {
  return { input: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, thinking: 0 };
}

export function addUsage(target: UsageNumbers, r: UsageNumbers): void {
  target.input += r.input;
  target.cacheWrite += r.cacheWrite;
  target.cacheWrite5m += r.cacheWrite5m;
  target.cacheWrite1h += r.cacheWrite1h;
  target.cacheRead += r.cacheRead;
  target.output += r.output;
  target.thinking += r.thinking;
}

export function totalOf(u: Pick<UsageNumbers, 'input' | 'cacheWrite' | 'cacheRead' | 'output'>): number {
  return u.input + u.cacheWrite + u.cacheRead + u.output;
}

export function freshOf(u: Pick<UsageNumbers, 'input' | 'cacheWrite' | 'output'>): number {
  return u.input + u.cacheWrite + u.output;
}

export function valueOf(u: UsageNumbers, basis: Basis): number {
  return basis === 'fresh' ? freshOf(u) : totalOf(u);
}

/** 缓存命中率；分母（所有"输入侧"token）为 0 时返回 null。 */
export function cacheHitRate(u: Pick<UsageNumbers, 'input' | 'cacheWrite' | 'cacheRead'>): number | null {
  const denom = u.input + u.cacheWrite + u.cacheRead;
  return denom > 0 ? u.cacheRead / denom : null;
}

/** 输出 ÷ 输入侧（input + cacheWrite + cacheRead，与缓存命中率同分母）；分母为 0 → null。 */
export function outputInputRatio(u: Pick<UsageNumbers, 'input' | 'cacheWrite' | 'cacheRead' | 'output'>): number | null {
  const denom = u.input + u.cacheWrite + u.cacheRead;
  return denom > 0 ? u.output / denom : null;
}

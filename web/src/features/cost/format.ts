/** 金额 / 倍数格式化（纯函数，无 DOM 依赖）。金额在服务端算好，这里只负责显示。 */

const DASH = '—';

/** "$1,234.56"；null / NaN → "—"。compact：≥ $1,000 省略小数。 */
export function formatUsd(n: number | null | undefined, opts: { compact?: boolean } = {}): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return DASH;
  const big = opts.compact === true && Math.abs(n) >= 1000;
  const v = big ? Math.round(n) : Math.round(n * 100) / 100;
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: big ? 0 : 2, maximumFractionDigits: big ? 0 : 2 });
  return `${v < 0 ? '-' : ''}$${s}`;
}

/** 单价（USD / 百万 token）：保留至少 2 位、最多 4 位小数。 */
export function formatUnitPrice(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return DASH;
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
}

/** "4.2 ×"；null → "—"。 */
export function formatMultiple(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return DASH;
  // 0 < n < 0.005 四舍五入会显示成 "0.00 ×"，像是没算出来：改为 "<0.01 ×"
  if (n > 0 && n < 0.005) return '<0.01 ×';
  return `${n >= 100 ? Math.round(n) : n < 1 ? n.toFixed(2) : n.toFixed(1)} ×`;
}

/** 坐标轴刻度用的金额："$0" / "$5.5" / "$120" / "$1.2k"。 */
export function axisUsd(v: number): string {
  if (!Number.isFinite(v)) return DASH;
  if (v === 0) return '$0';
  if (Math.abs(v) >= 1000) return `$${Math.round(v / 100) / 10}k`;
  if (Math.abs(v) >= 10) return `$${Math.round(v)}`;
  return `$${Math.round(v * 100) / 100}`;
}

/** 价格输入框文本 → 数字 | null | 'invalid'。空串 = 未配置。 */
export function parsePriceInput(text: string, max = 100_000): number | null | 'invalid' {
  const t = text.trim().replace(/^\$/, '');
  if (t === '') return null;
  if (!/^\d+(\.\d+)?$/.test(t)) return 'invalid';
  const v = Number(t);
  return Number.isFinite(v) && v <= max ? v : 'invalid';
}

/** 数字 → 输入框文本（null → 空串）。 */
export function priceToText(v: number | null | undefined): string {
  return v === null || v === undefined ? '' : String(v);
}

// ---------------------------------------------------------------------------
// 月费的币种换算（只是输入 / 显示层：存储与全部计算仍以 USD 为准）
// ---------------------------------------------------------------------------

export type FeeCurrency = 'USD' | 'CNY';

const roundTo = (x: number, digits: number): number => {
  const k = 10 ** digits;
  return Math.round(x * k) / k;
};

/** USD → CNY（显示用，保留最多 2 位小数）。 */
export function usdToCny(usd: number, cnyPerUsd: number): number {
  return roundTo(usd * cnyPerUsd, 2);
}

/** CNY → USD（存储用，保留 4 位小数；140 元 ÷ 7.2 = 19.4444，再乘回 7.2 显示仍是 140）。 */
export function cnyToUsd(cny: number, cnyPerUsd: number): number {
  return roundTo(cny / cnyPerUsd, 4);
}

/** 月费输入框文本：USD 值按币种换算后显示（null → 空串）。 */
export function feeToText(usd: number | null | undefined, currency: FeeCurrency, cnyPerUsd: number): string {
  if (usd === null || usd === undefined) return '';
  return currency === 'CNY' ? String(usdToCny(usd, cnyPerUsd)) : String(roundTo(usd, 4));
}

/** 月费输入框文本（按所选币种）→ USD 数字 | null（空串 = 未设置）| 'invalid'。换算后的 USD 超过 maxUsd 也算非法。 */
export function parseFeeInput(text: string, currency: FeeCurrency, cnyPerUsd: number, maxUsd = 100_000): number | null | 'invalid' {
  // 允许前缀 ¥（U+00A5 半角 / U+FFE5 全角）；用 RegExp 构造避免源码里出现全角字符
  const p = parsePriceInput(text.trim().replace(new RegExp('^[\\u00A5\\uFFE5]'), ''), Number.MAX_SAFE_INTEGER);
  if (p === null || p === 'invalid') return p;
  const usd = currency === 'CNY' ? cnyToUsd(p, cnyPerUsd) : p;
  return Number.isFinite(usd) && usd <= maxUsd ? usd : 'invalid';
}

/** 汇率输入框文本 → 正数 | 'invalid'（必须 > 0 且 ≤ max）。 */
export function parseFxInput(text: string, max = 100): number | 'invalid' {
  const p = parsePriceInput(text, max);
  return p === null || p === 'invalid' || p <= 0 ? 'invalid' : p;
}

/** 环比（小数）；任一为 null 或上期 ≤ 0 → null。 */
export function pctChange(cur: number | null | undefined, prev: number | null | undefined): number | null {
  if (cur === null || cur === undefined || prev === null || prev === undefined || prev <= 0) return null;
  return (cur - prev) / prev;
}

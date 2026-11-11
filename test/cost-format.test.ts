import { describe, expect, it } from 'vitest';
import { formatMultiple, formatUnitPrice, formatUsd, parsePriceInput, pctChange, priceToText } from '../web/src/features/cost/format.ts';

describe('成本格式化（前端纯函数）', () => {
  it('formatUsd：$ + 千分位 + 2 位小数；null / NaN → —；compact 省略大数小数', () => {
    expect(formatUsd(1234.5)).toBe('$1,234.50');
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(0.004)).toBe('$0.00');
    expect(formatUsd(912.4)).toBe('$912.40');
    expect(formatUsd(null)).toBe('—');
    expect(formatUsd(Number.NaN)).toBe('—');
    expect(formatUsd(undefined)).toBe('—');
    expect(formatUsd(2640, { compact: true })).toBe('$2,640');
    expect(formatUsd(912.4, { compact: true })).toBe('$912.40');
  });

  it('formatMultiple / formatUnitPrice', () => {
    expect(formatMultiple(4.56)).toBe('4.6 ×');
    expect(formatMultiple(0)).toBe('0.00 ×');
    expect(formatMultiple(0.0044)).toBe('<0.01 ×');
    expect(formatMultiple(0.005)).toBe('0.01 ×');
    expect(formatMultiple(0.034)).toBe('0.03 ×');
    expect(formatMultiple(null)).toBe('—');
    expect(formatUnitPrice(0.275)).toBe('$0.275');
    expect(formatUnitPrice(14.7999)).toBe('$14.7999');
    expect(formatUnitPrice(null)).toBe('—');
  });

  it('parsePriceInput：空 = 未配置（null）；非法 = invalid；不接受负数 / 科学计数 / 千分位', () => {
    expect(parsePriceInput('')).toBeNull();
    expect(parsePriceInput('  ')).toBeNull();
    expect(parsePriceInput('3.75')).toBe(3.75);
    expect(parsePriceInput('$5')).toBe(5);
    expect(parsePriceInput('0')).toBe(0);
    for (const bad of ['-1', '1e3', '1,000', 'abc', '1.', '.5', '100001']) expect(parsePriceInput(bad), bad).toBe('invalid');
    expect(priceToText(null)).toBe('');
    expect(priceToText(6.25)).toBe('6.25');
  });

  it('pctChange：上期为 0 / 无法计算 → null（界面显示 —）', () => {
    expect(pctChange(110, 100)).toBeCloseTo(0.1);
    expect(pctChange(50, 100)).toBeCloseTo(-0.5);
    expect(pctChange(5, 0)).toBeNull();
    expect(pctChange(null, 5)).toBeNull();
    expect(pctChange(5, null)).toBeNull();
  });
});

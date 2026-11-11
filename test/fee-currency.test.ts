import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cnyToUsd, feeToText, parseFeeInput, parseFxInput, usdToCny } from '../web/src/features/cost/format.ts';
import { startApp, getJson, putJson } from './apiHelpers.ts';
import type { TestApp } from './apiHelpers.ts';

describe('月费币种换算', () => {
  it('100 USD ⇄ 720 CNY（汇率 7.2）', () => {
    expect(usdToCny(100, 7.2)).toBe(720);
    expect(cnyToUsd(720, 7.2)).toBe(100);
    expect(feeToText(100, 'CNY', 7.2)).toBe('720');
    expect(feeToText(100, 'USD', 7.2)).toBe('100');
    expect(feeToText(null, 'CNY', 7.2)).toBe('');
  });

  it('140 元存成 19.4444 USD，切回人民币仍显示 140（不会变成 139.97）', () => {
    const usd = parseFeeInput('140', 'CNY', 7.2);
    expect(usd).toBe(19.4444);
    expect(feeToText(usd as number, 'CNY', 7.2)).toBe('140');
  });

  it('parseFeeInput：空串 = 未设置；$ / ¥ 前缀；非法输入；超限', () => {
    expect(parseFeeInput('', 'USD', 7.2)).toBeNull();
    expect(parseFeeInput('  ', 'CNY', 7.2)).toBeNull();
    expect(parseFeeInput('$20', 'USD', 7.2)).toBe(20);
    expect(parseFeeInput('¥144', 'CNY', 7.2)).toBe(20); // 半角 ¥
    expect(parseFeeInput('￥144', 'CNY', 7.2)).toBe(20); // 全角 ￥
    expect(parseFeeInput('abc', 'USD', 7.2)).toBe('invalid');
    expect(parseFeeInput('-5', 'CNY', 7.2)).toBe('invalid');
    expect(parseFeeInput('100001', 'USD', 7.2)).toBe('invalid');
    expect(parseFeeInput('100000', 'USD', 7.2)).toBe(100000);
    // 人民币的上限 = 100000 USD × 汇率
    expect(parseFeeInput('720000', 'CNY', 7.2)).toBe(100000);
    expect(parseFeeInput('720001', 'CNY', 7.2)).toBe('invalid');
  });

  it('parseFxInput：必须是 (0, 100] 的正数', () => {
    expect(parseFxInput('7.2')).toBe(7.2);
    expect(parseFxInput('100')).toBe(100);
    for (const bad of ['0', '-1', '101', '', 'x', '7,2']) expect(parseFxInput(bad)).toBe('invalid');
  });
});

describe('月费币种 / 汇率：设置校验', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(async () => {
    await t.close();
  });

  it('默认值 USD / 7.2；非法值整体不生效；合法值可保存', async () => {
    const sub = async () => (await getJson(t.base, '/api/settings')).body.settings.subscription;
    expect(await sub()).toMatchObject({ feeCurrency: 'USD', cnyPerUsd: 7.2 });
    for (const bad of [{ feeCurrency: 'EUR' }, { feeCurrency: 1 }, { cnyPerUsd: 0 }, { cnyPerUsd: -7 }, { cnyPerUsd: 101 }, { cnyPerUsd: '7.2' }, { cnyPerUsd: null }]) {
      expect((await putJson(t.base, '/api/settings', { subscription: bad })).status).toBe(400);
    }
    expect(await sub()).toMatchObject({ feeCurrency: 'USD', cnyPerUsd: 7.2 });
    expect((await putJson(t.base, '/api/settings', { subscription: { feeCurrency: 'CNY', cnyPerUsd: 7.05, monthlyFeeUsd: 19.4444 } })).status).toBe(200);
    expect(await sub()).toMatchObject({ feeCurrency: 'CNY', cnyPerUsd: 7.05, monthlyFeeUsd: 19.4444 });
  });
});

import { describe, expect, it } from 'vitest';
import { decideSystemTz, systemTimeZone, WINDOWS_TO_IANA, windowsToIana } from '../src/server/systemTz.ts';
import { assertValidTimeZone } from '../src/server/core/time.ts';

describe('系统时区解析', () => {
  it('Intl 给出名字时直接使用（不调用 Windows 查询）', () => {
    let called = false;
    const r = decideSystemTz('Asia/Shanghai', () => {
      called = true;
      return 'China Standard Time';
    });
    expect(r).toEqual({ name: 'Asia/Shanghai', source: 'intl' });
    expect(called).toBe(false);
  });

  it('Intl 读不出（undefined）时用 Windows 时区名映射：Alberta → America/Edmonton', () => {
    expect(decideSystemTz(undefined, () => 'Alberta Standard Time')).toEqual({ name: 'America/Edmonton', source: 'windows' });
    expect(decideSystemTz(undefined, () => 'China Standard Time\r\n')).toEqual({ name: 'Asia/Shanghai', source: 'windows' });
  });

  it('都识别不了 → UTC + fallback 标记（由设置页提示手动选择）', () => {
    expect(decideSystemTz(undefined, () => 'Some Future Standard Time')).toEqual({ name: 'UTC', source: 'fallback' });
    expect(decideSystemTz(undefined, () => null)).toEqual({ name: 'UTC', source: 'fallback' });
    expect(decideSystemTz(undefined, null)).toEqual({ name: 'UTC', source: 'fallback' });
  });

  it('映射表里的每个 IANA 名都能被运行环境识别', () => {
    for (const [win, iana] of Object.entries(WINDOWS_TO_IANA)) {
      expect(() => assertValidTimeZone(iana), `${win} → ${iana}`).not.toThrow();
      expect(windowsToIana(win)).toBe(iana);
    }
  });

  it('systemTimeZone() 返回一个有效的时区名', () => {
    expect(() => assertValidTimeZone(systemTimeZone())).not.toThrow();
  });
});

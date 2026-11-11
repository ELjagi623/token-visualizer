import { afterEach, describe, expect, it } from 'vitest';
import { en } from '../web/src/i18n/en.ts';
import { translate } from '../web/src/i18n/index.ts';
import { zh } from '../web/src/i18n/zh.ts';
import { L, setServerLang } from '../src/server/i18n.ts';
import { applyPatch, defaultSettings, sanitizeStored } from '../src/server/settings.ts';

const placeholders = (s: string): string => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
const ALLOWED_CJK = new Set(['lang.zh', 'settings.lang.title']);

describe('英文字典', () => {
  it('与中文字典的键完全一致', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
  });

  it('占位符与中文一致（复数的每个分支都带同样的占位符）；除语言名外不含中文', () => {
    const bad: string[] = [];
    for (const k of Object.keys(zh) as Array<keyof typeof zh>) {
      const e = en[k];
      if (typeof e !== 'string' || e.trim() === '') {
        bad.push(`empty: ${k}`);
        continue;
      }
      for (const variant of e.split('|')) {
        const p = placeholders(variant);
        if (p !== placeholders(zh[k]) && !(e.includes('|') && p === '')) bad.push(`placeholder: ${k}`);
      }
      if (e.split('|').length > 2) bad.push(`pipes: ${k}`);
      if (/[㐀-鿿＀-￯　-〿]/.test(e) && !ALLOWED_CJK.has(k)) bad.push(`cjk: ${k}`);
    }
    expect(bad).toEqual([]);
  });

  it('复数：n === 1 取单数，其余取复数；中文不受影响', () => {
    expect(translate('en', 'sidebar.allSub', { n: 1 })).toBe('1 project');
    expect(translate('en', 'sidebar.allSub', { n: 0 })).toBe('0 projects');
    expect(translate('en', 'sidebar.allSub', { n: 12 })).toBe('12 projects');
    expect(translate('zh', 'sidebar.allSub', { n: 1 })).toBe('1 个项目');
  });

  it('语言选项的文字固定，不随语言变化', () => {
    for (const lang of ['en', 'zh'] as const) {
      expect(translate(lang, 'lang.en')).toBe('English');
      expect(translate(lang, 'lang.zh')).toBe('中文');
      expect(translate(lang, 'settings.lang.title')).toBe('Language · 语言');
    }
  });
});

describe('默认语言与服务端文案', () => {
  const saved = process.env.TV_LANG;
  afterEach(() => {
    if (saved === undefined) delete process.env.TV_LANG;
    else process.env.TV_LANG = saved;
    setServerLang(saved === 'zh' ? 'zh' : 'en');
  });

  it('默认英文；TV_LANG=zh 可改默认；设置里显式存了 zh 的老用户保持中文', () => {
    delete process.env.TV_LANG;
    expect(defaultSettings().language).toBe('en');
    process.env.TV_LANG = 'zh';
    expect(defaultSettings().language).toBe('zh');
    delete process.env.TV_LANG;
    expect(sanitizeStored({ schema: 1, settings: { language: 'zh' } }).settings.language).toBe('zh');
    expect(sanitizeStored({ schema: 1, settings: { theme: 'dark' } }).settings.language).toBe('en');
  });

  it('L() 按当前服务端语言取文案；校验错误与警告随语言变化', () => {
    setServerLang('en');
    expect(L('中', 'en')).toBe('en');
    expect(() => applyPatch(defaultSettings(), { budget: { daily: -1 } })).toThrow(/must be a number/);
        setServerLang('zh');
    expect(L('中', 'en')).toBe('中');
    expect(() => applyPatch(defaultSettings(), { budget: { daily: -1 } })).toThrow(/必须是/);
  });

  it('损坏的设置文件：按设置里的语言给警告（读取时先确定语言）', () => {
    const r = sanitizeStored({ schema: 1, settings: { language: 'zh', theme: 'nope' } });
    expect(r.warnings.join('')).toContain('无效');
    const r2 = sanitizeStored({ schema: 1, settings: { language: 'en', theme: 'nope' } });
    expect(r2.warnings.join('')).toMatch(/invalid/i);
  });
});

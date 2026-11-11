/**
 * i18n：界面文案一律走 t('key')。当前语言存在 zustand 里（state/store.ts），组件用 useT() 订阅，
 * 非组件代码（如纯函数）用 translate(lang, key, params)。
 */
import { en } from './en.ts';
import { zh } from './zh.ts';
import type { DictKey } from './zh.ts';

export type Lang = 'zh' | 'en';
export type { DictKey };
export type TParams = Record<string, string | number>;
export type TFn = (key: DictKey, params?: TParams) => string;

function interpolate(s: string, params?: TParams): string {
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
}

export function translate(lang: Lang, key: DictKey, params?: TParams): string {
  const s = (lang === 'en' ? en[key] : undefined) ?? zh[key];
  return interpolate(s, params);
}

export function makeT(lang: Lang): TFn {
  return (key, params) => translate(lang, key, params);
}

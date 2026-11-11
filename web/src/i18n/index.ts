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

/**
 * 极简复数：值里写 "{n} project|{n} projects"，params.n 为数字时 n === 1 取前者，否则取后者。
 * 没有 "|" 的值不受影响；中文字典不使用。
 */
function pickPlural(s: string, params?: TParams): string {
  if (!s.includes('|')) return s;
  const [one, other] = s.split('|');
  return Number(params?.n) === 1 ? one! : (other ?? one!);
}

function interpolate(s: string, params?: TParams): string {
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
}

export function translate(lang: Lang, key: DictKey, params?: TParams): string {
  const s = lang === 'en' ? en[key] : zh[key];
  return interpolate(pickPlural(s, params), params);
}

export function makeT(lang: Lang): TFn {
  return (key, params) => translate(lang, key, params);
}

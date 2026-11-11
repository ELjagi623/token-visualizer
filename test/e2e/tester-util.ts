/**
 * 阶段 5 测试者（独立于开发者 phase5.spec.ts）的公共工具：设计令牌表、对比度算法、样式读取。
 * 令牌值逐字取自 docs/design/DESIGN.md 与 Main.dc.html 的 THEMES 对象。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';

export const ROOT = path.resolve(import.meta.dirname, '..', '..');
export const SHOTS = path.join(ROOT, 'test', 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });
export const shot = (name: string): string => path.join(SHOTS, `phase5-tester-${name}.png`);

export const THEMES: Record<'light' | 'dark', Record<string, string>> = {
  light: {
    bg: '#F6F6F3', card: '#FFFFFF', line: 'rgba(17,22,19,0.07)', text: '#111613', text2: '#555C56', muted: '#6B726C', track: '#ECEEEA', seg: '#EDEEEA', segOn: '#FFFFFF',
    accent: '#10B981', accentText: '#047857', blue: '#3B82F6', amber: '#F59E0B', pink: '#EC4899', violet: '#8B5CF6', grid: 'rgba(17,22,19,0.09)',
    shadow: '0 1px 2px rgba(17,22,19,0.04), 0 14px 36px rgba(17,22,19,0.05)',
    pillIdleBg: '#ECEEEA', pillIdleFg: '#555C56', pillBlueBg: '#E3EEFF', pillBlueFg: '#1D4ED8', pillGreenBg: '#D9F5E6', pillGreenFg: '#047857', pillAmberBg: '#FEF0CF', pillAmberFg: '#92580A', pillPinkBg: '#FDE3EE', pillPinkFg: '#BE185D',
    h1: 'rgba(16,185,129,0.24)', h2: 'rgba(16,185,129,0.45)', h3: 'rgba(16,185,129,0.72)', h4: 'rgba(16,185,129,1)',
  },
  dark: {
    bg: '#0E1210', card: '#171C19', line: 'rgba(255,255,255,0.08)', text: '#ECF1ED', text2: '#B2BAB4', muted: '#9AA39C', track: '#252C28', seg: '#1F2522', segOn: '#2C3430',
    accent: '#34D399', accentText: '#6EE7B7', blue: '#60A5FA', amber: '#FBBF24', pink: '#F472B6', violet: '#A78BFA', grid: 'rgba(255,255,255,0.09)',
    shadow: '0 1px 2px rgba(0,0,0,0.3), 0 14px 36px rgba(0,0,0,0.28)',
    pillIdleBg: '#252C28', pillIdleFg: '#B2BAB4', pillBlueBg: 'rgba(96,165,250,0.16)', pillBlueFg: '#93C5FD', pillGreenBg: 'rgba(52,211,153,0.16)', pillGreenFg: '#6EE7B7', pillAmberBg: 'rgba(251,191,36,0.16)', pillAmberFg: '#FCD34D', pillPinkBg: 'rgba(244,114,182,0.16)', pillPinkFg: '#F9A8D4',
    h1: 'rgba(52,211,153,0.25)', h2: 'rgba(52,211,153,0.45)', h3: 'rgba(52,211,153,0.72)', h4: 'rgba(52,211,153,1)',
  },
};

/**
 * 规范化颜色 / 阴影字符串以便比较：所有颜色写法（#rgb / #rrggbb / #rrggbbaa / rgb() / rgba()）统一成 rgba(r,g,b,a)，alpha 取两位小数。
 * 注意：Vite 构建会把 rgba(17,22,19,.07) 压缩成 #11161312（8 位十六进制，alpha=18/255≈.0706），语义相同，所以不能做字符串全等比较。
 */
export function normColor(v: string): string {
  const f = (n: number): string => String(Math.round(n * 100) / 100);
  return v
    .trim()
    .toLowerCase()
    .replace(/#([0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3})(?![0-9a-f])/g, (_m, h: string) => {
      const x = h.length === 3 ? h.replace(/./g, (c: string) => c + c) : h;
      const n = parseInt(x.slice(0, 6), 16);
      const a = x.length === 8 ? parseInt(x.slice(6), 16) / 255 : 1;
      return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${f(a)})`;
    })
    .replace(/rgba?\(([^)]+)\)/g, (_m, inner: string) => {
      const p = inner.split(/[ ,/]+/).filter(Boolean).map(Number);
      return `rgba(${p[0]},${p[1]},${p[2]},${f(p[3] ?? 1)})`;
    })
    .replace(/\s+/g, '');
}

export type RGBA = [number, number, number, number];
export function parseColor(c: string): RGBA {
  const s = c.trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(s);
  if (hex) {
    const n = parseInt(hex[1]!, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const m = /rgba?\(([^)]+)\)/.exec(s);
  const p = (m?.[1] ?? '0,0,0').split(/[ ,/]+/).filter(Boolean).map(Number);
  return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0, p[3] ?? 1];
}
export function over(fg: RGBA, bg: RGBA): RGBA {
  const a = fg[3];
  return [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a), 1];
}
export function luminance(c: RGBA): number {
  const f = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
}
/** WCAG 对比度；fg 带透明度时先叠到 bg 上。 */
export function contrast(fg: string, bg: string, under = '#FFFFFF'): number {
  const b = over(parseColor(bg), parseColor(under));
  const f = over(parseColor(fg), b);
  const [a, d] = [luminance(f), luminance(b)];
  return (Math.max(a, d) + 0.05) / (Math.min(a, d) + 0.05);
}

/** 读取元素计算样式（一次 evaluate）。 */
export async function css(page: Page, selector: string, props: string[], nth = 0): Promise<Record<string, string>> {
  return page.evaluate(
    ({ selector, props, nth }) => {
      const el = document.querySelectorAll(selector)[nth];
      if (!el) return { __missing: selector };
      const cs = getComputedStyle(el);
      const out: Record<string, string> = {};
      for (const p of props) out[p] = cs.getPropertyValue(p);
      const r = el.getBoundingClientRect();
      out.__w = String(Math.round(r.width * 100) / 100);
      out.__h = String(Math.round(r.height * 100) / 100);
      return out;
    },
    { selector, props, nth },
  );
}

export async function open(page: Page, url: string, hash = ''): Promise<void> {
  // 批次 B 起默认时间范围是近 30 天；这些用例按"全部"范围对账，所以补上 range=all；鼠标放到项目栏上（方向键只在项目栏聚焦 / 悬停时生效）
  if (hash === '' || (hash.startsWith('#/overview') && !hash.includes('range='))) hash = `${hash === '' ? '#/overview' : hash}${hash.includes('?') ? '&' : '?'}range=all`;
  await page.goto(`${url}${hash}`);
  await page.waitForSelector('[data-testid="content"][data-ready="true"]');
  await page.hover('[data-testid="sidebar"]', { timeout: 800 }).catch(() => undefined);
  await page.evaluate(() => document.fonts.ready);
}

export async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  // 服务端设置是主题的真相（localStorage 只是首帧缓存），所以同时写两处
  const origin = new URL(page.url()).origin;
  await page.request.put(origin + '/api/settings', { data: { theme }, headers: { Origin: origin } });
  await page.evaluate((t) => localStorage.setItem('tv.theme', t), theme);
  await page.reload();
  await page.waitForSelector('[data-testid="content"][data-ready="true"]');
  await page.evaluate(() => document.fonts.ready);
}

export interface Collected {
  console: string[];
  origins: Set<string>;
  urls: string[];
  csp: string[];
}
/** 收集控制台 error/warning、pageerror、所有请求（含 websocket）、CSP 违规。 */
export function collect(page: Page): Collected {
  const c: Collected = { console: [], origins: new Set(), urls: [], csp: [] };
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') c.console.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => c.console.push(`pageerror: ${e.message}`));
  page.on('request', (r) => {
    c.urls.push(r.url());
    try {
      c.origins.add(new URL(r.url()).host.replace(/:\d+$/, ''));
    } catch {
      c.origins.add(r.url());
    }
  });
  page.on('websocket', (w) => c.urls.push(`ws:${w.url()}`));
  return c;
}
export const CSP_INIT = `window.__csp=[];document.addEventListener('securitypolicyviolation',e=>window.__csp.push(e.violatedDirective+' '+e.blockedURI));`;

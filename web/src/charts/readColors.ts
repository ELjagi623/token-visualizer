/** 从 CSS 变量读取当前主题的图表配色（需要 DOM；纯类型与工具见 colors.ts）。 */
import type { ChartColors } from './colors.ts';

function v(cs: CSSStyleDeclaration, name: string, fallback: string): string {
  const x = cs.getPropertyValue(name).trim();
  return x.length > 0 ? x : fallback;
}

export function readChartColors(): ChartColors {
  const cs = getComputedStyle(document.documentElement);
  const c = {
    accent: v(cs, '--accent', '#10B981'),
    accentText: v(cs, '--accentText', '#047857'),
    blue: v(cs, '--blue', '#3B82F6'),
    amber: v(cs, '--amber', '#F59E0B'),
    pink: v(cs, '--pink', '#EC4899'),
    violet: v(cs, '--violet', '#8B5CF6'),
    cyan: v(cs, '--cyan', '#06B6D4'),
    text: v(cs, '--text', '#111613'),
    text2: v(cs, '--text2', '#555C56'),
    muted: v(cs, '--muted', '#6B726C'),
    grid: v(cs, '--grid', 'rgba(17,22,19,0.09)'),
    card: v(cs, '--card', '#FFFFFF'),
    line: v(cs, '--line', 'rgba(17,22,19,0.07)'),
    track: v(cs, '--track', '#ECEEEA'),
    seg: v(cs, '--seg', '#EDEEEA'),
  };
  return {
    ...c,
    palette: [c.accent, c.blue, c.amber, c.pink, c.violet, c.cyan],
    type: { input: c.blue, cacheWrite: c.amber, cacheRead: c.accent, output: c.violet },
  };
}

/**
 * 图表配色：运行时从 CSS 变量读取（浅 / 深色令牌），所以主题切换后只需重新取色重绘。
 * Token 类型固定配色（全站一致）：输入 = blue，缓存写 = amber，缓存读 = accent，输出 = violet。
 */
export interface ChartColors {
  accent: string;
  accentText: string;
  blue: string;
  amber: string;
  pink: string;
  violet: string;
  cyan: string;
  text: string;
  text2: string;
  muted: string;
  grid: string;
  card: string;
  line: string;
  track: string;
  seg: string;
  /** 多系列色板：绿、蓝、琥珀、粉、紫、青 */
  palette: string[];
  type: { input: string; cacheWrite: string; cacheRead: string; output: string };
}

/** 把 #RRGGBB / rgb() 颜色加上透明度（用于渐变面积）。无法解析时原样返回。 */
export function withAlpha(color: string, alpha: number): string {
  const hex = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (hex) {
    const n = parseInt(hex[1]!, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
  }
  const rgb = /^rgba?\(([^)]+)\)$/.exec(color.trim());
  if (rgb) {
    const p = rgb[1]!.split(',').map((x) => x.trim());
    return `rgba(${p[0]},${p[1]},${p[2]},${alpha})`;
  }
  return color;
}

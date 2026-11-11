/**
 * 平滑曲线路径（Catmull-Rom，张力 0.17 ≈ monotone，来自设计稿）。
 */

export type Pt = readonly [number, number];

const f = (n: number): string => n.toFixed(1);

export function smoothPath(pts: readonly Pt[], tension = 0.17): string {
  if (pts.length === 0) return '';
  const first = pts[0]!;
  if (pts.length === 1) return `M${f(first[0])} ${f(first[1])}`;
  let d = `M${f(first[0])} ${f(first[1])}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p3 = pts[i + 2] ?? p2;
    d += ` C${f(p1[0] + (p2[0] - p0[0]) * tension)} ${f(p1[1] + (p2[1] - p0[1]) * tension)} ${f(p2[0] - (p3[0] - p1[0]) * tension)} ${f(p2[1] - (p3[1] - p1[1]) * tension)} ${f(p2[0])} ${f(p2[1])}`;
  }
  return d;
}

export interface SparkPaths {
  line: string;
  area: string;
}

/** 把数值序列映射到 w×h 的盒子（min–max 归一化，上下留 pad），返回曲线与面积路径。 */
export function sparkPaths(values: readonly number[], w: number, h: number, pad: number): SparkPaths {
  if (values.length === 0) return { line: '', area: '' };
  let mx = -Infinity;
  let mn = Infinity;
  for (const v of values) {
    if (v > mx) mx = v;
    if (v < mn) mn = v;
  }
  const rg = mx - mn || 1;
  const n = values.length;
  const pts: Pt[] = values.map((v, i) => [n === 1 ? w / 2 : (i * w) / (n - 1), pad + (h - 2 * pad) * (1 - (v - mn) / rg)]);
  const line = smoothPath(pts);
  if (n === 1) {
    // 单点：画一条水平线
    const y = f(pts[0]![1]);
    return { line: `M0 ${y} L${w} ${y}`, area: `M0 ${y} L${w} ${y} L${w} ${h} L0 ${h} Z` };
  }
  return { line, area: `${line} L${w} ${h} L0 ${h} Z` };
}

/**
 * 图表悬浮提示的统一配置：不透明、无渐隐 / 滑动动画、紧凑，并在光标另一侧避让（不盖住光标下的数据点）。
 * 纯函数，可单测。
 */
import type { ChartColors } from './colors.ts';

/** 提示卡与光标的水平间距 */
const GAP = 18;
/** 提示卡与图表边缘的最小距离 */
const EDGE = 4;

/**
 * 计算提示卡左上角：光标在图表右半区时放左侧，否则放右侧；垂直方向以光标为中心，并夹在图表内。
 * 参数与 ECharts `tooltip.position` 回调一致（只取需要的部分）。
 */
export function tooltipPosition(point: readonly [number, number], contentSize: readonly [number, number], viewSize: readonly [number, number]): [number, number] {
  const [px, py] = point;
  const [w, h] = contentSize;
  const [vw, vh] = viewSize;
  let x = px > vw / 2 ? px - w - GAP : px + GAP;
  x = Math.max(EDGE, Math.min(x, vw - w - EDGE));
  let y = py - h / 2;
  y = Math.max(EDGE, Math.min(y, vh - h - EDGE));
  return [x, y];
}

/** 所有 ECharts 图共用的 tooltip 外壳；调用方提供 formatter（以及可选的 axisPointer）。 */
export function chartTooltip(c: ChartColors, extra: Record<string, unknown> = {}) {
  return {
    trigger: 'axis' as const,
    confine: true,
    // 瞬间出现 / 消失：避免渐隐与滑动过程中的半透明和拖影
    transitionDuration: 0,
    displayTransition: false,
    backgroundColor: c.card,
    borderColor: c.line,
    borderWidth: 1,
    padding: 0,
    extraCssText: 'border-radius:14px;box-shadow:0 6px 20px rgba(0,0,0,.18);opacity:1;',
    position: (point: number[], _params: unknown, _dom: unknown, _rect: unknown, size: { contentSize: number[]; viewSize: number[] }) =>
      tooltipPosition([point[0] ?? 0, point[1] ?? 0], [size.contentSize[0] ?? 0, size.contentSize[1] ?? 0], [size.viewSize[0] ?? 0, size.viewSize[1] ?? 0]),
    ...extra,
  };
}

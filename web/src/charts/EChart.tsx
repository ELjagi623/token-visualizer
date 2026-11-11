import { useEffect, useRef } from 'react';
import type { EChartsOption } from 'echarts';
import { prefersReducedMotion } from '../lib/hooks.ts';
import { init } from './echarts.ts';
import type { EChartsType } from './echarts.ts';

interface EChartProps {
  option: EChartsOption;
  height: number;
  /** 图表的文字描述（无障碍；canvas 本身读不出） */
  ariaLabel: string;
  testId?: string;
  /** 额外的 data-* 属性：E2E 从这里读图表的数据（canvas 内的点不可读） */
  dataAttrs?: Record<string, string | number | undefined>;
  /** 点击数据点（category 轴的下标） */
  onIndexClick?: (index: number) => void;
}

/**
 * ECharts 封装：init / resize / dispose；option 变化时合并更新（系列按 id 替换，所以数据变化有平滑过渡）。
 * 减少动效偏好下关闭动画。
 */
export function EChart({ option, height, ariaLabel, testId, dataAttrs, onIndexClick }: EChartProps) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<EChartsType | null>(null);
  const clickRef = useRef(onIndexClick);
  clickRef.current = onIndexClick;
  const optionRef = useRef(option);
  optionRef.current = option;
  const labelsHidden = useRef(false);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const c = init(el, undefined, { renderer: 'canvas' });
    chart.current = c;
    c.on('click', (p) => {
      const i = (p as { dataIndex?: number }).dataIndex;
      if (typeof i === 'number') clickRef.current?.(i);
    });
    // 悬浮提示出现时临时隐藏图内的标注（如峰值标签）：提示卡已给出同一数值，且 DOM 提示卡会盖住画布里的文字
    const setMarkLabels = (show: boolean): void => {
      if (labelsHidden.current === !show) return;
      labelsHidden.current = !show;
      const series = (Array.isArray(optionRef.current.series) ? optionRef.current.series : []) as Array<{ id?: string; markPoint?: { label?: { show?: boolean } } }>;
      // 只动原本显示标注的系列（"现在"标记点的标注本来就是关的）
      const patch = series.filter((s) => s.id !== undefined && s.markPoint?.label?.show === true).map((s) => ({ id: s.id, markPoint: { label: { show } } }));
      if (patch.length > 0) c.setOption({ series: patch });
    };
    c.on('showTip', () => setMarkLabels(false));
    c.on('hideTip', () => setMarkLabels(true));
    c.on('globalout', () => setMarkLabels(true));
    const ro = new ResizeObserver(() => c.resize());
    ro.observe(el);
    return () => {
      ro.disconnect();
      c.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    labelsHidden.current = false;
    c.setOption({ ...option, animation: !prefersReducedMotion() && option.animation !== false }, { replaceMerge: ['series'] });
  }, [option]);

  const data: Record<string, string> = {};
  for (const [k, val] of Object.entries(dataAttrs ?? {})) if (val !== undefined) data[`data-${k}`] = String(val);
  return <div ref={host} role="img" aria-label={ariaLabel} data-testid={testId} style={{ width: '100%', height }} {...data} />;
}

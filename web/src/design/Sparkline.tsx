import { useId } from 'react';
import type { CSSProperties } from 'react';
import { sparkPaths } from '../lib/curve.ts';
import { useTweenArray } from '../lib/hooks.ts';

interface SparklineProps {
  values: readonly number[];
  /** viewBox 宽高 */
  width: number;
  height: number;
  /** 上下留白 */
  pad?: number;
  strokeWidth?: number;
  /** 通栏：宽度铺满卡片并抵消卡片左右内边距（指标卡底部迷你曲线），线宽不随缩放变化 */
  bleed?: number;
  /** 渐变不透明度（顶部）；设计稿 0.26–0.3 */
  fillOpacity?: number;
  /** 虚线（占位 / 无数据） */
  dashed?: boolean;
  /** 关闭补间动画 */
  still?: boolean;
  testId?: string;
}

/** 迷你曲线：平滑曲线 + 渐变面积，无坐标轴。数据变化时曲线平滑过渡（减少动效时直接切换）。 */
export function Sparkline({ values, width, height, pad = 2, strokeWidth = 1.6, bleed, fillOpacity = 0.26, dashed = false, still = false, testId }: SparklineProps) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const tweened = useTweenArray(values, still ? 0 : 350);
  const vals = tweened.length === values.length ? tweened : [...values];
  const { line, area } = sparkPaths(vals, width, height, pad);
  const style: CSSProperties | undefined = bleed !== undefined ? { display: 'block', width: `calc(100% + ${bleed * 2}px)`, margin: `0 -${bleed}px`, height } : undefined;
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={bleed !== undefined ? undefined : width}
      height={height}
      preserveAspectRatio={bleed !== undefined ? 'none' : undefined}
      style={style}
      aria-hidden="true"
      focusable="false"
      data-testid={testId}
    >
      <defs>
        <linearGradient id={`sg${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--accent)" stopOpacity={fillOpacity} />
          <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {!dashed && area && <path d={area} fill={`url(#sg${uid})`} />}
      {line && (
        <path
          d={line}
          fill="none"
          stroke="var(--accent)"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray={dashed ? '4 6' : undefined}
          vectorEffect={bleed !== undefined ? 'non-scaling-stroke' : undefined}
        />
      )}
    </svg>
  );
}

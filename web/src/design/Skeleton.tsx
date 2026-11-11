import type { CSSProperties } from 'react';
import { cx } from '../lib/cx.ts';
import s from './Skeleton.module.css';

interface SkeletonProps {
  width?: number | string;
  height?: number | string;
  radius?: number | string;
  className?: string;
  style?: CSSProperties;
}

/** 骨架屏：shimmer 流光（沿用 FirstRun 设计稿）。 */
export function Skeleton({ width = '100%', height = 14, radius, className, style }: SkeletonProps) {
  return <div aria-hidden="true" className={cx(s.sk, className)} style={{ width, height, borderRadius: radius, ...style }} />;
}

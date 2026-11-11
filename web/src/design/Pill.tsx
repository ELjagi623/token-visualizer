import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from '../lib/cx.ts';
import s from './Pill.module.css';

export type PillTone = 'idle' | 'blue' | 'green' | 'amber' | 'pink';

interface PillProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  tone?: PillTone;
  /** 前置圆点 */
  dot?: boolean;
  /** 圆点呼吸动画（prefers-reduced-motion 下自动关闭） */
  pulse?: boolean;
  /** 非当前态整体变淡（opacity .5） */
  dim?: boolean;
  size?: 'md' | 'sm';
  children?: ReactNode;
}

/** 状态胶囊：Idle 灰 / Active 蓝 / Live·Generating 绿 / 警告琥珀 / 错误粉。 */
export function Pill({ tone = 'idle', dot = true, pulse = false, dim = false, size = 'md', className, children, ...rest }: PillProps) {
  return (
    <span className={cx(s.pill, s[tone], size === 'sm' && s.sm, dim && s.dim, className)} {...rest}>
      {dot && <span className={cx(s.dot, pulse && 'tv-pulse')} aria-hidden="true" />}
      {children}
    </span>
  );
}

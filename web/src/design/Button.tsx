import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react';
import { cx } from '../lib/cx.ts';
import s from './Button.module.css';

interface ChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  small?: boolean;
  primary?: boolean;
  children?: ReactNode;
}

/** 胶囊按钮（筛选 / 排序 chip）。 */
export function Chip({ small, primary, className, children, type = 'button', ...rest }: ChipProps) {
  return (
    <button type={type} className={cx(s.chip, small && s.chipSm, primary && s.primary, className)} {...rest}>
      {children}
    </button>
  );
}

/** 链接样式的胶囊按钮。 */
export function ChipLink({ primary, className, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { primary?: boolean }) {
  return (
    <a className={cx(s.chip, primary && s.primary, className)} {...rest}>
      {children}
    </a>
  );
}

interface RoundButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  small?: boolean;
  spinning?: boolean;
  children?: ReactNode;
}

/** 圆形图标按钮（主题切换 / 手动刷新 / 关闭）。必须带 aria-label。 */
export function RoundButton({ small, spinning, className, children, type = 'button', ...rest }: RoundButtonProps) {
  return (
    <button type={type} className={cx(s.round, small && s.roundSm, spinning && s.spin, className)} {...rest}>
      {children}
    </button>
  );
}

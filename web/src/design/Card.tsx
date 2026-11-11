import type { CSSProperties, HTMLAttributes, ReactNode } from 'react';
import { cx } from '../lib/cx.ts';
import s from './Card.module.css';

type Pad = 'lg' | 'md' | 'none';

interface CardProps extends Omit<HTMLAttributes<HTMLElement>, 'children'> {
  as?: 'section' | 'article' | 'div' | 'aside';
  padding?: Pad;
  children?: ReactNode;
  style?: CSSProperties;
}

/** 卡片：圆角 24、1px 极淡描边、柔和阴影。 */
export function Card({ as: Tag = 'section', padding = 'lg', className, children, ...rest }: CardProps) {
  return (
    <Tag className={cx(s.card, padding === 'lg' && s.lg, padding === 'md' && s.md, padding === 'none' && s.flush, className)} {...rest}>
      {children}
    </Tag>
  );
}

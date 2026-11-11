import type { MouseEvent, ReactNode } from 'react';
import { cx } from '../lib/cx.ts';
import s from './Segmented.module.css';

export interface SegOption<V extends string> {
  value: V;
  label: ReactNode;
  title?: string;
}

interface SegmentedProps<V extends string> {
  value: V;
  options: ReadonlyArray<SegOption<V>>;
  onChange: (v: V) => void;
  ariaLabel: string;
  size?: 'md' | 'sm';
  className?: string;
  testId?: string;
}

/** 胶囊分段控件（浅灰底 + 选中白色凸起）。按钮组语义：每项 aria-pressed。 */
export function Segmented<V extends string>({ value, options, onChange, ariaLabel, size = 'md', className, testId }: SegmentedProps<V>) {
  return (
    <div className={cx(s.seg, size === 'sm' && s.sm, className)} role="group" aria-label={ariaLabel} data-testid={testId}>
      {options.map((o) => (
        <button key={o.value} type="button" className={o.value === value ? s.on : undefined} aria-pressed={o.value === value} title={o.title} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export interface NavItem {
  key: string;
  href: string;
  label: ReactNode;
  current: boolean;
  onClick?: (e: MouseEvent<HTMLAnchorElement>) => void;
}

/** 导航版分段控件：<nav> 内是链接，当前页 aria-current="page"。 */
export function SegmentedNav({ items, ariaLabel }: { items: NavItem[]; ariaLabel: string }) {
  return (
    <nav className={cx(s.seg, s.nav)} aria-label={ariaLabel}>
      {items.map((it) => (
        <a key={it.key} href={it.href} className={it.current ? s.on : undefined} aria-current={it.current ? 'page' : undefined} onClick={it.onClick}>
          {it.label}
        </a>
      ))}
    </nav>
  );
}

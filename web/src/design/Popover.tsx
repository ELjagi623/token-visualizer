import { useCallback, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { cx } from '../lib/cx.ts';
import { useDismiss } from '../lib/hooks.ts';
import s from './Popover.module.css';

interface PopoverProps {
  /** 触发器（通常是 Chip）；接收 toggle 与 open 状态 */
  trigger: (p: { open: boolean; toggle: () => void }) => ReactNode;
  children: (p: { close: () => void }) => ReactNode;
  /** 面板对齐到触发器左边（默认右对齐） */
  alignLeft?: boolean;
  role?: 'listbox' | 'menu' | 'dialog';
  ariaLabel?: string;
  testId?: string;
}

/** 点击外部 / Esc 关闭的弹层。 */
export function Popover({ trigger, children, alignLeft, role = 'dialog', ariaLabel, testId }: PopoverProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(ref, open, close);
  return (
    <div className={s.wrap} ref={ref}>
      {trigger({ open, toggle: () => setOpen((v) => !v) })}
      {open && (
        <div className={cx(s.panel, alignLeft && s.left)} role={role} aria-label={ariaLabel} data-testid={testId}>
          {children({ close })}
        </div>
      )}
    </div>
  );
}

export const popoverStyles = s;

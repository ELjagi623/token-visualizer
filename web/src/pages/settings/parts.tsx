import type { ReactNode } from 'react';
import { Card } from '../../design/Card.tsx';
import { Icon } from '../../design/icons.tsx';
import { cx } from '../../lib/cx.ts';
import s from './Settings.module.css';

export function Section({ title, desc, aside, children, testId }: { title: string; desc?: ReactNode; aside?: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <Card as="section" className={s.section} data-testid={testId} aria-label={title}>
      <div className={s.sectionHead}>
        <div>
          <h2 className={s.h2}>{title}</h2>
          {desc && <div className={s.desc}>{desc}</div>}
        </div>
        {aside}
      </div>
      {children}
    </Card>
  );
}

export function Row({ title, hint, children, testId }: { title: ReactNode; hint?: ReactNode; children?: ReactNode; testId?: string }) {
  return (
    <div className={s.row} data-testid={testId}>
      <div className={s.rowLabel}>
        <div className={s.rowTitle}>{title}</div>
        {hint && <div className={s.rowHint}>{hint}</div>}
      </div>
      {children}
    </div>
  );
}

export function Switch({ checked, onChange, label, testId, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; testId?: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className={cx(s.switch, checked && s.switchOn)} data-testid={testId} disabled={disabled} onClick={() => onChange(!checked)}>
      <i />
    </button>
  );
}

export function Warn({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div className={s.warn} role="status" data-testid={testId}>
      <Icon name="alert" size={18} strokeWidth={1.9} />
      <span>{children}</span>
    </div>
  );
}

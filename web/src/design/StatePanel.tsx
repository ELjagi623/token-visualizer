import type { ReactNode } from 'react';
import { cx } from '../lib/cx.ts';
import { Card } from './Card.tsx';
import { Icon } from './icons.tsx';
import type { IconName } from './icons.tsx';
import s from './StatePanel.module.css';

interface StatePanelProps {
  icon: IconName;
  tone?: 'neutral' | 'amber' | 'pink';
  title: ReactNode;
  desc?: ReactNode;
  action?: ReactNode;
  testId?: string;
  role?: 'status' | 'alert';
}

/** 空状态 / 错误引导：卡片内居中的图标 + 标题 + 说明 + 可选操作。 */
export function StatePanel({ icon, tone = 'neutral', title, desc, action, testId, role }: StatePanelProps) {
  return (
    <Card className={s.panel} data-testid={testId} role={role}>
      <div className={cx(s.icon, tone === 'amber' && s.iconAmber, tone === 'pink' && s.iconPink)}>
        <Icon name={icon} size={28} />
      </div>
      <h2 className={s.title}>{title}</h2>
      {desc && <p className={s.desc}>{desc}</p>}
      {action && <div className={s.action}>{action}</div>}
    </Card>
  );
}

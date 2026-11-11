import { useCallback, useRef, useState } from 'react';
import { apiSend } from '../api/clientC.ts';
import type { HiddenProject } from '../api/types.ts';
import { Chip } from '../design/Button.tsx';
import { Icon } from '../design/icons.tsx';
import { reloadSettings, runAction } from '../features/settings/save.ts';
import { useDismiss } from '../lib/hooks.ts';
import { useT } from '../state/store.ts';
import s from './HiddenProjects.module.css';

/** 项目栏底部"已隐藏 N 个"：点开列出被隐藏的项目并可恢复（隐藏的项目不计入"全部项目"合计）。没有隐藏项目时不渲染。 */
export function HiddenProjects({ items }: { items: HiddenProject[] }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(ref, open, close);
  if (items.length === 0) return null;

  const restore = async (id: string): Promise<void> => {
    const r = await runAction(() => apiSend<unknown>('PUT', '/api/project-overrides', { id, hidden: false }));
    if (r.ok) await reloadSettings().catch(() => undefined);
  };

  return (
    <div className={s.wrap} ref={ref}>
      <button type="button" className={s.toggle} aria-expanded={open} data-testid="hidden-toggle" onClick={() => setOpen((v) => !v)}>
        <Icon name="eyeOff" size={14} />
        <span>{t('sidebar.hiddenCount', { n: items.length })}</span>
        <Icon name="chevronDown" size={13} strokeWidth={2} />
      </button>
      {open && (
        <div className={s.pop} role="dialog" aria-label={t('sidebar.hiddenAria')} data-testid="hidden-pop">
          <ul className={s.list}>
            {items.map((h) => (
              <li key={h.id} className={s.item} data-testid="hidden-item" data-id={h.id}>
                <span className={s.name} title={h.path ?? undefined}>
                  {h.isScratchGroup ? t('sidebar.scratch') : h.displayName}
                </span>
                <Chip small data-testid="hidden-restore" onClick={() => void restore(h.id)}>
                  {t('sidebar.hiddenRestore')}
                </Chip>
              </li>
            ))}
          </ul>
          <div className={s.note}>{t('sidebar.hiddenNote')}</div>
        </div>
      )}
    </div>
  );
}

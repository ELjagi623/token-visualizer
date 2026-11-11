import { useCallback, useRef, useState } from 'react';
import { Chip } from '../../design/Button.tsx';
import { Icon } from '../../design/icons.tsx';
import { Segmented } from '../../design/Segmented.tsx';
import { useDismiss } from '../../lib/hooks.ts';
import { useT } from '../../state/store.ts';
import s from './ExportMenu.module.css';

type Kind = 'daily' | 'model' | 'session';
type Format = 'csv' | 'json';

interface ExportMenuProps {
  /** 当前的全局筛选参数（project / range / from / to / models / mergeFamilies / basis / includeSidechain / tz …），不含 kind / format，不带前导 ? */
  query: string;
  defaultKind?: Kind;
}

/** 导出下拉：粒度（日 / 模型 / 会话）× 格式（CSV / JSON）。下载由服务端生成（遵从当前筛选 / 口径 / 时区；不含对话正文）。 */
export function ExportMenu({ query, defaultKind = 'daily' }: ExportMenuProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Kind>(defaultKind);
  const [format, setFormat] = useState<Format>('csv');
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(ref, open, close);
  const href = `/api/export?${query ? `${query}&` : ''}kind=${kind}&format=${format}`;
  return (
    <div className={s.wrap} ref={ref}>
      <Chip aria-haspopup="dialog" aria-expanded={open} data-testid="export-button" onClick={() => setOpen((v) => !v)}>
        <Icon name="download" size={16} />
        {t('export.button')}
      </Chip>
      {open && (
        <div className={s.pop} role="dialog" aria-label={t('export.title')} data-testid="export-pop">
          <div className={s.row}>
            <div className={s.label}>{t('export.kind')}</div>
            <Segmented
              size="sm"
              ariaLabel={t('export.kind')}
              testId="export-kind"
              value={kind}
              onChange={setKind}
              options={[
                { value: 'daily', label: t('export.kind.daily') },
                { value: 'model', label: t('export.kind.model') },
                { value: 'session', label: t('export.kind.session') },
              ]}
            />
          </div>
          <div className={s.row}>
            <div className={s.label}>{t('export.format')}</div>
            <Segmented
              size="sm"
              ariaLabel={t('export.format')}
              testId="export-format"
              value={format}
              onChange={setFormat}
              options={[
                { value: 'csv', label: 'CSV' },
                { value: 'json', label: 'JSON' },
              ]}
            />
          </div>
          <a className={s.go} href={href} download data-testid="export-download" onClick={() => setTimeout(close, 200)}>
            <Icon name="download" size={16} />
            {t('export.download')}
          </a>
          <p className={s.note}>{t('export.note')}</p>
        </div>
      )}
    </div>
  );
}

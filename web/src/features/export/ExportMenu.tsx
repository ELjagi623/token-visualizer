import { useCallback, useRef, useState } from 'react';
import { Chip } from '../../design/Button.tsx';
import { Icon } from '../../design/icons.tsx';
import { Segmented } from '../../design/Segmented.tsx';
import { useFloatingPanel } from '../../lib/floating.ts';
import { useDismiss } from '../../lib/hooks.ts';
import { useT } from '../../state/store.ts';
import { downloadDataUrl, exportFileName, renderPageJpg } from './pageImage.ts';
import s from './ExportMenu.module.css';

type Kind = 'daily' | 'model' | 'session';
type Format = 'csv' | 'json' | 'jpg';

interface ExportMenuProps {
  /** 当前的全局筛选参数（project / range / from / to / models / mergeFamilies / basis / includeSidechain / tz …），不含 kind / format，不带前导 ? */
  query: string;
  defaultKind?: Kind;
}

/**
 * 导出下拉：粒度（日 / 模型 / 会话）× 格式（CSV / JSON / JPG）。
 * CSV / JSON 由服务端生成（遵从当前筛选 / 口径 / 时区；不含对话正文）；
 * JPG 在浏览器里把当前页面的内容区（不含顶栏和项目栏）整页渲染成一张长图，与粒度无关。
 */
export function ExportMenu({ query, defaultKind = 'daily' }: ExportMenuProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Kind>(defaultKind);
  const [format, setFormat] = useState<Format>('csv');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(ref, open, close);
  useFloatingPanel(ref, panelRef, open);
  const isImage = format === 'jpg';
  const exportImage = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    // 先关掉面板，等一帧让它从页面上消失，再截图
    setOpen(false);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    try {
      const { dataUrl, page } = await renderPageJpg();
      downloadDataUrl(dataUrl, exportFileName(page));
    } catch (e) {
      setErr((e as Error).message || 'error');
      setOpen(true);
    } finally {
      setBusy(false);
    }
  };
  const href = `/api/export?${query ? `${query}&` : ''}kind=${kind}&format=${format}`;
  return (
    <div className={s.wrap} ref={ref} data-export-skip="">
      <Chip aria-haspopup="dialog" aria-expanded={open} data-testid="export-button" onClick={() => setOpen((v) => !v)}>
        <Icon name="download" size={16} />
        {t('export.button')}
      </Chip>
      {open && (
        <div ref={panelRef} className={s.pop} role="dialog" aria-label={t('export.title')} data-testid="export-pop">
          {!isImage && (
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
          )}
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
                { value: 'jpg', label: 'JPG' },
              ]}
            />
          </div>
          {isImage ? (
            <button type="button" className={s.go} disabled={busy} data-testid="export-download" data-format="jpg" onClick={() => void exportImage()}>
              <Icon name="download" size={16} />
              {busy ? t('export.rendering') : t('export.download')}
            </button>
          ) : (
            <a className={s.go} href={href} download data-testid="export-download" onClick={() => setTimeout(close, 200)}>
              <Icon name="download" size={16} />
              {t('export.download')}
            </a>
          )}
          {err && (
            <p className={s.err} role="alert" data-testid="export-error">
              {t('export.imageFailed', { reason: err })}
            </p>
          )}
          <p className={s.note}>{isImage ? t('export.noteImage') : t('export.note')}</p>
        </div>
      )}
    </div>
  );
}

import { Icon } from '../design/icons.tsx';
import { useStore, useT } from '../state/store.ts';
import s from './WarningsBanner.module.css';

const MAX_SHOWN = 3;

/**
 * 醒目的琥珀色提示条：展示 /api/status.warnings（含设置回退警告，如"已保存的数据根目录无效，已自动回退"）。
 * 可关闭（本次会话内记住，同一条文案不再弹出；服务端重启后警告通常已消失）。
 */
export function WarningsBanner() {
  const t = useT();
  const warnings = useStore((st) => st.status?.warnings);
  const dismissed = useStore((st) => st.dismissed);
  const dismiss = useStore((st) => st.dismissWarnings);
  const visible = (warnings ?? []).filter((w) => !dismissed.includes(w));
  if (visible.length === 0) return null;
  const shown = visible.slice(0, MAX_SHOWN);
  return (
    <div className={s.banner} role="status" aria-live="polite" data-testid="warnings-banner">
      <Icon name="alert" size={20} className={s.icon} />
      <div className={s.body}>
        <strong className={s.title}>{t('warn.title')}</strong>
        <ul className={s.list}>
          {shown.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
        {visible.length > shown.length && <div className={s.more}>{t('warn.more', { n: visible.length - shown.length })}</div>}
      </div>
      <button type="button" className={s.close} aria-label={t('warn.dismiss')} onClick={() => dismiss(visible)}>
        <Icon name="close" size={16} strokeWidth={2} />
      </button>
    </div>
  );
}

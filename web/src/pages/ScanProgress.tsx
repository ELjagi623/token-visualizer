import { Card } from '../design/Card.tsx';
import { Pill } from '../design/Pill.tsx';
import { formatBytes, formatExact } from '../lib/format.ts';
import { scanPercent } from '../lib/statusPill.ts';
import { useStore, useT } from '../state/store.ts';
import { useShallow } from 'zustand/react/shallow';
import s from './ScanProgress.module.css';

/** 首次全量扫描的进度卡（FirstRun 设计稿）：解析进度、已处理文件、字节、只读声明。 */
export function ScanProgress() {
  const t = useT();
  const p = useStore(
    useShallow((st) => ({
      filesDone: st.status?.filesDone ?? 0,
      filesTotal: st.status?.filesTotal ?? 0,
      bytesDone: st.status?.bytesDone ?? 0,
      bytesTotal: st.status?.bytesTotal ?? 0,
    })),
  );
  const percent = scanPercent(p);
  return (
    <Card className={s.card} data-testid="scan-progress">
      <div className={s.row}>
        <h2 className={s.h2}>{t('scan.progress')}</h2>
        <Pill tone="blue" pulse>
          {t('scan.state')}
        </Pill>
      </div>
      <div className={s.row} style={{ alignItems: 'baseline' }}>
        <div className={s.label}>{t('scan.files')}</div>
        <div>
          <span className={`${s.big} num`}>{formatExact(p.filesDone)}</span>
          <span className={`unit ${s.slash}`}>/ {formatExact(p.filesTotal)}</span>
          <span className={`unit ${s.unitSm}`}>{t('scan.filesUnit')}</span>
        </div>
      </div>
      <div>
        <div className={s.track} role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-label={t('scan.progressAria')}>
          <div className={s.fill} style={{ width: `${percent}%` }} />
        </div>
        <div className={s.meta}>
          <span>{t('scan.bytes', { done: formatBytes(p.bytesDone), total: formatBytes(p.bytesTotal) })}</span>
          <span className={`num ${s.pct}`}>{percent}%</span>
        </div>
      </div>
      <div className={s.note}>{t('scan.readOnly')}</div>
    </Card>
  );
}

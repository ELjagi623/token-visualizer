import { useShallow } from 'zustand/react/shallow';
import { CountUp } from '../design/CountUp.tsx';
import { Pill } from '../design/Pill.tsx';
import { Skeleton } from '../design/Skeleton.tsx';
import { formatRelative, formatTokens } from '../lib/format.ts';
import { derivePill } from '../lib/statusPill.ts';
import type { PillInput, PillKind } from '../lib/statusPill.ts';
import { useStore, useT } from '../state/store.ts';

const LABEL = {
  scanning: 'pill.scanning',
  error: 'pill.error',
  offline: 'pill.offline',
  generating: 'pill.live',
  active: 'pill.active',
  idle: 'pill.idle',
} as const satisfies Record<PillKind, string>;

/** 顶栏右侧状态胶囊：● Live · 今日 1.2 M tokens / ● Idle / ● Scanning x% / ● Error。悬浮看原因。 */
export function StatusPill() {
  const t = useT();
  const sel = useStore(
    useShallow((st) => ({
      has: st.status !== null,
      state: st.status?.state ?? 'idle',
      phase: st.status?.phase ?? 'incremental',
      activity: st.status?.activity ?? 'idle',
      bytesDone: st.status?.bytesDone ?? 0,
      bytesTotal: st.status?.bytesTotal ?? 0,
      filesDone: st.status?.filesDone ?? 0,
      filesTotal: st.status?.filesTotal ?? 0,
      today: st.status?.today ? st.status.today.value : null,
      lastError: st.status?.lastError ?? null,
      lastRecordTs: st.status?.lastRecordTs ?? null,
      serverNow: st.status?.serverNow ?? null,
      connection: st.connection,
    })),
  );
  const input: PillInput | null = sel.has
    ? { state: sel.state, phase: sel.phase, activity: sel.activity, bytesDone: sel.bytesDone, bytesTotal: sel.bytesTotal, filesDone: sel.filesDone, filesTotal: sel.filesTotal, today: sel.today }
    : null;
  const view = derivePill(input, sel.connection);
  if (!view) return <Skeleton width={176} height={34} radius={999} />;

  const ago = formatRelative(sel.lastRecordTs, sel.serverNow ?? Date.now(), t);
  let tip: string;
  switch (view.kind) {
    case 'scanning':
      tip = t('pill.tip.scanning', { done: sel.filesDone, total: sel.filesTotal });
      break;
    case 'error':
      tip = sel.lastError ? t('pill.tip.error', { reason: sel.lastError }) : t('pill.tip.errorUnknown');
      break;
    case 'offline':
      tip = t('pill.tip.offline');
      break;
    case 'generating':
      tip = t('pill.tip.generating', { ago });
      break;
    case 'active':
      tip = t('pill.tip.active', { ago });
      break;
    default:
      tip = sel.lastRecordTs === null ? t('pill.tip.idleNone') : t('pill.tip.idle', { ago });
  }

  return (
    <Pill tone={view.tone} pulse={view.pulse} title={tip} role="status" aria-live="off" data-testid="status-pill" data-state={view.kind}>
      <span>
        {t(LABEL[view.kind])}
        {view.kind === 'scanning' && view.percent !== null && <> · {view.percent}%</>}
        {view.today !== null && (
          <>
            {' · '}
            {t('pill.today')}{' '}
            <b className="num" data-testid="status-today">
              <CountUp value={view.today} format={formatTokens} />
            </b>{' '}
            {t('unit.tokens')}
          </>
        )}
      </span>
    </Pill>
  );
}

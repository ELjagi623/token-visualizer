import type { Activity, Connection, ScanState, StatusPayload } from '../api/types.ts';

export type PillKind = 'scanning' | 'error' | 'offline' | 'generating' | 'active' | 'idle';

/** 状态胶囊只依赖这些字段（便于单测与 useShallow 选择）。 */
export interface PillInput {
  state: ScanState;
  phase: 'full' | 'incremental';
  activity: Activity;
  bytesDone: number;
  bytesTotal: number;
  filesDone: number;
  filesTotal: number;
  /** 今日用量（默认口径）；未知为 null */
  today: number | null;
}

export function toPillInput(s: StatusPayload): PillInput {
  return { state: s.state, phase: s.phase, activity: s.activity, bytesDone: s.bytesDone, bytesTotal: s.bytesTotal, filesDone: s.filesDone, filesTotal: s.filesTotal, today: s.today ? s.today.value : null };
}

export interface PillView {
  kind: PillKind;
  tone: 'idle' | 'blue' | 'green' | 'amber' | 'pink';
  pulse: boolean;
  /** Scanning 的百分比（0–100） */
  percent: number | null;
  /** 今日用量（按设置里的默认口径）；scanning / error / offline 时不显示 */
  today: number | null;
}

/** 扫描进度百分比：优先按字节，其次按文件数；未知为 0。 */
export function scanPercent(s: Pick<PillInput, 'bytesDone' | 'bytesTotal' | 'filesDone' | 'filesTotal'>): number {
  const ratio = s.bytesTotal > 0 ? s.bytesDone / s.bytesTotal : s.filesTotal > 0 ? s.filesDone / s.filesTotal : 0;
  return Math.max(0, Math.min(100, Math.floor(ratio * 100)));
}

/**
 * 状态胶囊的状态机：
 *  - 首次全量扫描（phase = full 且 state = scanning）→ Scanning x%；
 *  - state = error → Error；连接断开 → Offline（琥珀）；
 *  - 其余一律用 `activity`（纯按最近记录时间）→ Live / Active / Idle。
 *    注意：不用 usageState，因为每次 5 秒轮询的增量扫描都会让它短暂变成 scanning，造成闪烁。
 */
export function derivePill(status: PillInput | null, connection: Connection): PillView | null {
  if (connection === 'lost') return { kind: 'offline', tone: 'amber', pulse: false, percent: null, today: null };
  if (!status) return null;
  if (status.state === 'error') return { kind: 'error', tone: 'pink', pulse: false, percent: null, today: null };
  if (status.state === 'scanning' && status.phase === 'full') {
    return { kind: 'scanning', tone: 'blue', pulse: true, percent: scanPercent(status), today: null };
  }
  const today = status.today;
  switch (status.activity) {
    case 'generating':
      return { kind: 'generating', tone: 'green', pulse: true, percent: null, today };
    case 'active':
      return { kind: 'active', tone: 'blue', pulse: false, percent: null, today };
    default:
      return { kind: 'idle', tone: 'idle', pulse: false, percent: null, today };
  }
}

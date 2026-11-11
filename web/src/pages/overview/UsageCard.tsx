import { useShallow } from 'zustand/react/shallow';
import { Card } from '../../design/Card.tsx';
import { CountUp } from '../../design/CountUp.tsx';
import { Pill } from '../../design/Pill.tsx';
import { formatExact, formatRelative, formatTokens } from '../../lib/format.ts';
import { usePeriodWord } from '../../state/period.ts';
import { useStore, useT } from '../../state/store.ts';
import s from './UsageCard.module.css';

interface UsageCardProps {
  /** 今日用量（当前口径）；null = 尚未取得 */
  today: number | null;
  /** 近 30 天日均（当前口径）；null / 0 = 不足以计算 */
  avg30: number | null;
  /** 每日预算（tokens；设置页）；null = 未设置 */
  dailyBudget?: number | null;
  /** 每月预算（tokens）与本月已用（当前口径）；只在没有每日预算时作为进度条的依据 */
  monthlyBudget?: number | null;
  monthUsed?: number | null;
}

const STATES = ['idle', 'active', 'generating'] as const;

/** 使用状态卡（5.3.1）：三个状态胶囊（当前态高亮，其余淡化）+ 今日数字 + 细长圆角进度条（今日 ÷ 近 30 天日均）。 */
export function UsageCard({ today, avg30, dailyBudget = null, monthlyBudget = null, monthUsed = null }: UsageCardProps) {
  const period = usePeriodWord();
  const t = useT();
  const st = useStore(
    useShallow((x) => ({
      activity: x.status?.activity ?? 'idle',
      lastRecordTs: x.status?.lastRecordTs ?? null,
      serverNow: x.status?.serverNow ?? null,
    })),
  );
  // 进度条依据：每日预算 > 每月预算 > 近 30 天日均
  const mode: 'daily' | 'monthly' | 'avg' = dailyBudget !== null && dailyBudget > 0 ? 'daily' : monthlyBudget !== null && monthlyBudget > 0 ? 'monthly' : 'avg';
  const used = mode === 'monthly' ? monthUsed : today;
  const base = mode === 'daily' ? dailyBudget : mode === 'monthly' ? monthlyBudget : avg30;
  const pct = used !== null && base !== null && base > 0 ? (used / base) * 100 : null;
  const over = mode !== 'avg' && pct !== null && pct > 100;
  const label = { idle: t('usage.idle'), active: t('usage.active'), generating: t('usage.generating') };
  const tone = { idle: 'idle', active: 'blue', generating: 'green' } as const;
  return (
    <Card className={s.card} data-testid="usage-card" data-state={st.activity}>
      <div className={s.head}>
        <h2 className={s.h2}>{t('usage.title')}</h2>
        <div role="group" aria-label={t('usage.groupAria', { state: label[st.activity] })} className={s.pills}>
          {STATES.map((k) => (
            <Pill key={k} tone={tone[k]} dim={k !== st.activity} pulse={k === 'generating' && st.activity === 'generating'} aria-current={k === st.activity ? 'true' : undefined} data-state={k} style={k === st.activity ? { fontWeight: 600 } : undefined}>
              {label[k]}
            </Pill>
          ))}
        </div>
      </div>
      <div className={s.row}>
        <div className={s.sub}>{st.lastRecordTs === null ? t('usage.todayUsedNone') : t('usage.todayUsed', { ago: formatRelative(st.lastRecordTs, st.serverNow ?? Date.now(), t) })}</div>
        <div>
          <span className={`${s.big} num`} data-testid="usage-today" data-value={today ?? ''} title={today === null ? undefined : formatExact(today)}>
            {today === null ? '—' : <CountUp value={today} format={(n) => Math.round(n).toLocaleString('en-US')} />}
          </span>
          <span className={`unit ${s.unitText}`}>{t('usage.unitToday')}</span>
        </div>
      </div>
      <div>
        <div className={s.track} role="progressbar" aria-valuenow={pct === null ? 0 : Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label={t(mode === 'daily' ? 'usage.progressAriaDaily' : mode === 'monthly' ? 'usage.progressAriaMonthly' : 'usage.progressAria', { period })} data-testid="usage-progress" data-mode={mode} data-over={over ? 'true' : 'false'}>
          <div className={s.fill} style={{ width: `${pct === null ? 0 : Math.min(100, pct)}%`, ...(over ? { background: 'var(--pink)' } : {}) }} />
        </div>
        <div className={s.meta}>
          <span data-testid="usage-progress-note">{mode === 'daily' ? t('usage.budgetNoteDaily', { budget: formatTokens(dailyBudget ?? 0) }) : mode === 'monthly' ? t('usage.budgetNoteMonthly', { period, used: formatTokens(monthUsed ?? 0), budget: formatTokens(monthlyBudget ?? 0) }) : avg30 !== null && avg30 > 0 ? t('usage.progressNote', { avg: formatTokens(avg30) }) : t('usage.noAvg')}</span>
          <span className={`num ${s.pct}`} data-testid="usage-pct" style={over ? { color: 'var(--pillPinkFg)' } : undefined}>
            {pct === null ? '—' : `${Math.round(pct)}%`}
          </span>
        </div>
      </div>
    </Card>
  );
}

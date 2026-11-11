import { useMemo, useState } from 'react';
import { useT } from '../../state/store.ts';
import { formatUsd } from './format.ts';

interface Day {
  date: string;
  apiUsd: number | null;
  feeUsd: number | null;
}

const W = 960;
const H = 270;
const L = 56;
const R = 944;
const TOP = 58;
const BASE = 238;

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const f = v / p;
  const n = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return n * p;
}

function axisLabel(v: number): string {
  if (v >= 1000) return `$${Math.round(v / 100) / 10}k`;
  return `$${Number.isInteger(v) ? v : v.toFixed(2)}`;
}

/** 每日等价 API 成本柱 + 每日订阅费虚线（设计稿 Cost.dc.html 的"回本日"图）。纯 SVG，响应式（viewBox）。 */
export function DailyCostChart({ days, feeConfigured }: { days: Day[]; feeConfigured: boolean }) {
  const t = useT();
  const [hover, setHover] = useState<number | null>(null);
  const fee = feeConfigured ? (days[days.length - 1]?.feeUsd ?? null) : null;

  const geo = useMemo(() => {
    const max = niceMax(Math.max(...days.map((d) => d.apiUsd ?? 0), fee ?? 0, 0.0001) * 1.05);
    const n = Math.max(1, days.length);
    const slot = (R - L - 12) / n;
    const bw = Math.max(2, Math.min(22, slot * 0.68));
    const y = (v: number): number => BASE - (v / max) * (BASE - TOP + 0);
    return { max, slot, bw, y };
  }, [days, fee]);

  const over = fee === null ? 0 : days.filter((d) => (d.apiUsd ?? 0) >= (d.feeUsd ?? Infinity)).length;
  const ticks = [0, 1, 2, 3].map((i) => (geo.max * i) / 3);
  const labelEvery = Math.max(1, Math.ceil(days.length / 7));
  const hoverDay = hover === null ? null : days[hover];

  return (
    <div style={{ position: 'relative' }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ display: 'block', width: '100%', height: 'auto' }} role="img" aria-label={t('cost.chart.aria', { n: days.length })} data-testid="cost-daily-chart" onMouseLeave={() => setHover(null)}>
        {ticks.map((v, i) => (
          <g key={i}>
            <line x1={L} y1={geo.y(v)} x2={R} y2={geo.y(v)} stroke="var(--grid)" strokeWidth={1} strokeDasharray={i === 0 ? undefined : '3 5'} />
            <text x={0} y={geo.y(v) + 4} fontSize={12} fill="var(--muted)">
              {axisLabel(v)}
            </text>
          </g>
        ))}
        {days.map((d, i) => {
          const v = d.apiUsd ?? 0;
          const h = Math.max(v > 0 ? 2 : 0, BASE - geo.y(v));
          const x = L + 6 + i * geo.slot + (geo.slot - geo.bw) / 2;
          return (
            <g key={d.date} onMouseEnter={() => setHover(i)}>
              <rect x={L + 6 + i * geo.slot} y={TOP - 10} width={geo.slot} height={BASE - TOP + 10} fill="transparent" />
              <rect x={x} y={BASE - h} width={geo.bw} height={h} rx={Math.min(5, geo.bw / 3)} fill="var(--accent)" opacity={hover === null || hover === i ? 1 : 0.55} data-testid="cost-bar" data-date={d.date} data-usd={d.apiUsd ?? ''} />
            </g>
          );
        })}
        {fee !== null && (
          <g>
            <line x1={L} y1={geo.y(fee)} x2={R} y2={geo.y(fee)} stroke="var(--amber)" strokeWidth={2} strokeDasharray="6 5" data-testid="cost-fee-line" />
            <text x={R} y={geo.y(fee) - 8} fontSize={12} fontWeight={600} textAnchor="end" fill="var(--text)">
              {t('cost.chart.feeLabel', { fee: formatUsd(fee) })}
            </text>
          </g>
        )}
        {days.map((d, i) =>
          i % labelEvery === 0 || i === days.length - 1 ? (
            <text key={d.date} x={L + 6 + i * geo.slot + geo.slot / 2} y={260} fontSize={12} textAnchor="middle" fill="var(--muted)">
              {d.date.slice(5).replace('-', '/')}
            </text>
          ) : null,
        )}
      </svg>
      {hoverDay && hover !== null && (
        <div
          role="tooltip"
          data-testid="cost-chart-tip"
          style={{
            position: 'absolute',
            top: 0,
            zIndex: 2,
            // 右半区时翻到柱子左侧，避免溢出图表右缘
            left: `${((L + 6 + hover * geo.slot + geo.slot / 2) / W) * 100}%`,
            transform: (L + 6 + hover * geo.slot) / W > 0.5 ? 'translateX(calc(-100% - 10px))' : 'translateX(10px)',
            padding: '8px 12px',
            borderRadius: 14,
            background: 'var(--card)',
            border: '1px solid var(--line)',
            boxShadow: 'var(--shadowPop)',
            fontSize: 12.5,
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
          }}
        >
          <div style={{ color: 'var(--muted)' }}>{hoverDay.date}</div>
          <div className="num">{formatUsd(hoverDay.apiUsd)}</div>
          {hoverDay.feeUsd !== null && <div style={{ color: 'var(--muted)' }}>{t('cost.chart.feeTip', { fee: formatUsd(hoverDay.feeUsd) })}</div>}
        </div>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20, color: 'var(--muted)', fontSize: 12.5, marginTop: 8 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 12, height: 12, borderRadius: 4, background: 'var(--accent)' }} />
          {t('cost.chart.legendApi')}
        </span>
        {fee !== null && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 18, borderTop: '2px dashed var(--amber)' }} />
            {t('cost.chart.legendFee')}
          </span>
        )}
        {fee !== null && days.length > 0 && (
          <span style={{ marginLeft: 'auto' }} data-testid="cost-over-count">
            {t('cost.chart.over', { n: over, total: days.length })}
          </span>
        )}
      </div>
    </div>
  );
}

import type { ReactNode } from 'react';

export interface DonutSegment {
  key: string;
  color: string;
  value: number;
}

interface DonutProps {
  segments: DonutSegment[];
  size?: number;
  /** 中心文字（大号数字 + 小号说明） */
  center?: { main: string; sub?: string };
  ariaLabel: string;
  testId?: string;
  children?: ReactNode;
}

const R = 70;
const C = 2 * Math.PI * R;
const GAP = 3;

/** 环形图：r = 70、描边 22、段间留 3px 间隙、中心显示总数（设计稿规格；纯 SVG）。 */
export function Donut({ segments, size = 150, center, ariaLabel, testId }: DonutProps) {
  const total = segments.reduce((a, x) => a + Math.max(0, x.value), 0);
  let cum = 0;
  return (
    <svg width={size} height={size} viewBox="0 0 200 200" role="img" aria-label={ariaLabel} data-testid={testId} data-total={total} style={{ flex: 'none' }}>
      <g transform="rotate(-90 100 100)">
        <circle cx="100" cy="100" r={R} fill="none" stroke="var(--track)" strokeWidth="22" />
        {total > 0 &&
          segments.map((s) => {
            const frac = Math.max(0, s.value) / total;
            const len = Math.max(0, frac * C - (segments.filter((x) => x.value > 0).length > 1 ? GAP : 0));
            const off = -cum * C;
            cum += frac;
            if (frac <= 0) return null;
            return <circle key={s.key} cx="100" cy="100" r={R} fill="none" stroke={s.color} strokeWidth="22" strokeDasharray={`${len} ${C - len}`} strokeDashoffset={off} data-segment={s.key} data-share={frac} />;
          })}
      </g>
      {center && (
        <>
          <text x="100" y={center.sub ? 98 : 108} textAnchor="middle" fontSize={center.sub ? 26 : 28} fontWeight="600" fill="var(--text)" style={{ fontVariantNumeric: 'tabular-nums' }}>
            {center.main}
          </text>
          {center.sub && (
            <text x="100" y="118" textAnchor="middle" fontSize="12" fill="var(--muted)">
              {center.sub}
            </text>
          )}
        </>
      )}
    </svg>
  );
}

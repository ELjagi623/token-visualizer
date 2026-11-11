import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { formatDelta, formatExact, formatTokenParts } from '../lib/format.ts';
import type { TokenParts } from '../lib/format.ts';
import { useT } from '../state/store.ts';
import { Card } from './Card.tsx';
import { CountUp } from './CountUp.tsx';
import { Icon } from './icons.tsx';
import type { IconName } from './icons.tsx';
import { Pill } from './Pill.tsx';
import { Skeleton } from './Skeleton.tsx';
import { Sparkline } from './Sparkline.tsx';
import s from './StatTile.module.css';

interface StatTileProps {
  icon: IconName;
  title: string;
  /** 数值；null = 无数据（显示 —） */
  value: number | null;
  /** 自定义格式化（默认 formatTokenParts 缩写）；返回 num + unit */
  formatParts?: (n: number) => TokenParts;
  /** 紧跟数字后的单位文字（如 "tokens" / "次"）；缩写单位（K/M/B）会并入它前面 */
  unit?: string;
  note?: ReactNode;
  /** 环比：小数（0.12 = +12%）；null = 上期为 0，显示 —；undefined = 不显示环比胶囊 */
  deltaPct?: number | null;
  /** 底部迷你曲线数据 */
  spark?: readonly number[];
  /** 数据尚未到达：数字位置显示骨架 */
  loading?: boolean;
  /** 右上角"部分"徽标（首次扫描期间数字还会增长） */
  partial?: boolean;
  /** 迷你曲线画成虚线且无面积（未配置 / 无数据的占位态） */
  dashed?: boolean;
  /** 精确值悬浮说明（title） */
  hint?: string;
  /** 精确值文本（默认按整数千分位）；非整数指标（小时 / 百分比）用它 */
  exactText?: string;
  /** 自定义整体格式化（含滚动中的中间值），如金额 "$912.40"：设置后忽略缩写单位逻辑 */
  formatNum?: (n: number) => string;
  testId?: string;
}

/** 指标卡：线性图标 + 标题 + 大数字（44px）+ 小单位（16px 灰色，基线对齐）+ 说明 + 通栏迷你面积曲线。 */
export function StatTile({ icon, title, value, formatParts = formatTokenParts, unit, note, deltaPct, spark, loading = false, partial = false, dashed = false, hint, exactText, formatNum, testId }: StatTileProps) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(id);
  }, [copied]);

  const exact = exactText ?? (value === null ? '—' : formatExact(value));
  const parts = value === null ? null : formatParts(value);
  const unitText = parts ? [parts.unit, unit].filter(Boolean).join(' ') : unit;
  // 数字滚动期间沿用目标值的缩写单位与小数位，避免 K/M/B 在中途跳变
  const fmt = (n: number): string => {
    if (formatNum) return formatNum(n);
    if (!parts || n === value) return parts?.num ?? '—';
    const idx = ['', 'K', 'M', 'B', 'T'].indexOf(parts.unit);
    if (idx === 0) {
      const dec = (parts.num.split('.')[1] ?? '').length;
      return dec > 0 ? n.toFixed(dec) : Math.round(n).toLocaleString('en-US');
    }
    const scale = idx > 0 ? 1000 ** idx : 1;
    return (n / scale).toFixed((parts.num.split('.')[1] ?? '').length);
  };
  const delta = deltaPct === undefined ? null : formatDelta(deltaPct);

  const copy = (): void => {
    if (value === null) return;
    void navigator.clipboard
      ?.writeText(exactText ?? String(Math.round(value)))
      .then(() => setCopied(true))
      .catch(() => undefined);
  };

  return (
    <Card as="article" padding="none" className={s.tile} data-testid={testId} data-value={value ?? ''}>
      <div className={s.head}>
        <div className={s.title}>
          <Icon name={icon} />
          <span>{title}</span>
        </div>
        <div className={s.badges}>
          {partial && (
            <Pill tone="blue" dot={false} size="sm">
              {t('tile.partial')}
            </Pill>
          )}
          {delta && (
            <span className={`${s.delta} num`} data-testid={testId ? `${testId}-delta` : undefined} data-dir={delta.dir}>
              {delta.text}
            </span>
          )}
        </div>
      </div>
      <div className={s.value}>
        {loading && value === null ? (
          <Skeleton width={140} height={40} />
        ) : (
          <>
            <button type="button" className={`${s.numBtn} num`} title={hint ? `${t('tile.copyHint', { exact })}
${hint}` : t('tile.copyHint', { exact })} aria-label={`${title}: ${exact}`} onClick={copy} data-testid={testId ? `${testId}-num` : undefined}>
              {value === null ? '—' : <CountUp value={value} format={fmt} fromZero />}
            </button>
            {unitText && <span className={`unit ${s.unitText}`}>{unitText}</span>}
          </>
        )}
      </div>
      {note && <div className={s.note}>{note}</div>}
      <div className={s.spacer} />
      {copied && (
        <span className={s.copied} role="status">
          {t('tile.copied')}
        </span>
      )}
      {spark && spark.length > 1 ? <Sparkline values={spark} width={300} height={56} pad={6} strokeWidth={2} bleed={24} dashed={dashed} /> : <div style={{ height: 56 }} />}
    </Card>
  );
}

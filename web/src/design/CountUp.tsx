import { useTweenNumber } from '../lib/hooks.ts';

interface CountUpProps {
  value: number;
  /** 把（动画中的）数值格式化成文本 */
  format: (n: number) => string;
  /** 首次出现时从 0 滚动到目标值 */
  fromZero?: boolean;
  duration?: number;
}

/** 数字滚动：值变化时在 ~350 ms 内 ease-out 过渡；`data-value` 始终是精确目标值。 */
export function CountUp({ value, format, fromZero = false, duration = 350 }: CountUpProps) {
  const shown = useTweenNumber(value, duration, fromZero);
  return <span data-value={value}>{format(shown)}</span>;
}

import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

/** 订阅 CSS 媒体查询。 */
export function useMediaQuery(query: string): boolean {
  const get = (): boolean => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
  const [matches, setMatches] = useState<boolean>(get);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = (): void => setMatches(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return matches;
}

/** 弹层关闭：点击外部或按 Esc。 */
export function useDismiss(ref: RefObject<HTMLElement | null>, open: boolean, close: () => void): void {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [ref, open, close]);
}

/** 每秒触发一次重渲染（用于相对时间等）。interval 为 0 时停用。 */
export function useTick(intervalMs: number): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (intervalMs <= 0) return;
    const id = setInterval(() => setN((x) => x + 1), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return n;
}

/** 数值 / 数组的补间动画（300–400 ms ease-out）。减少动效 / 页面隐藏时直接跳到目标值。 */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function useTweenArray(target: readonly number[], ms = 350): number[] {
  const [v, setV] = useState<number[]>(() => [...target]);
  const cur = useRef<number[]>(v);
  cur.current = v;
  const targetKey = target.join(',');
  useEffect(() => {
    const from = cur.current;
    const to = [...target];
    if (from.length !== to.length || prefersReducedMotion() || document.visibilityState === 'hidden' || ms <= 0) {
      setV(to);
      return;
    }
    if (from.every((x, i) => x === to[i])) return;
    const t0 = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const step = (): void => {
      const p = Math.min(1, (performance.now() - t0) / ms);
      const e = 1 - (1 - p) ** 3;
      setV(p >= 1 ? to : to.map((x, i) => (from[i] ?? 0) + (x - (from[i] ?? 0)) * e));
      if (p < 1) timer = setTimeout(step, 16);
    };
    step();
    return () => {
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey, ms]);
  return prefersReducedMotion() ? [...target] : v;
}

export function useTweenNumber(target: number, ms = 350, fromZero = false): number {
  const [v, setV] = useState<number>(fromZero ? 0 : target);
  const cur = useRef<number>(v);
  cur.current = v;
  useEffect(() => {
    const from = cur.current;
    if (from === target) return;
    if (prefersReducedMotion() || document.visibilityState === 'hidden' || ms <= 0) {
      setV(target);
      return;
    }
    const t0 = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const step = (): void => {
      const p = Math.min(1, (performance.now() - t0) / ms);
      const e = 1 - (1 - p) ** 3;
      setV(p >= 1 ? target : from + (target - from) * e);
      if (p < 1) timer = setTimeout(step, 16);
    };
    step();
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [target, ms]);
  // 减少动效：渲染时直接取目标值（不等 effect），数据一到首帧就是终值
  return prefersReducedMotion() ? target : v;
}

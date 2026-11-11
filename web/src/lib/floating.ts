import { useLayoutEffect } from 'react';
import type { RefObject } from 'react';

/**
 * 下拉面板的定位：面板用 position: fixed，按触发器的位置算出 left / top，并夹在视口内。
 * 这样它不会被内容区（overflow 裁剪）切掉，也不会被左侧项目栏盖住（z-index 高于项目栏与抽屉）。
 * - 默认右对齐触发器（面板右边缘 = 触发器右边缘）；alignLeft 时左对齐；
 * - 放不下时左右夹紧到视口边缘；下方空间不够而上方够时翻到触发器上方；
 * - 打开期间窗口缩放 / 任何容器滚动都会重新定位。
 */
export function useFloatingPanel(anchor: RefObject<HTMLElement | null>, panel: RefObject<HTMLElement | null>, open: boolean, alignLeft = false): void {
  useLayoutEffect(() => {
    if (!open) return;
    const place = (): void => {
      const a = anchor.current;
      const p = panel.current;
      if (!a || !p) return;
      const r = a.getBoundingClientRect();
      const w = p.offsetWidth;
      const h = p.offsetHeight;
      const M = 8;
      let left = alignLeft ? r.left : r.right - w;
      left = Math.max(M, Math.min(left, window.innerWidth - w - M));
      let top = r.bottom + 8;
      if (top + h > window.innerHeight - M && r.top - 8 - h >= M) top = r.top - 8 - h;
      p.style.left = `${Math.round(left)}px`;
      p.style.top = `${Math.round(Math.max(M, top))}px`;
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [anchor, panel, open, alignLeft]);
}

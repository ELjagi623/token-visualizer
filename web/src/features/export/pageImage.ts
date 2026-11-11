import { toJpeg } from 'html-to-image';

/**
 * 把当前页面的"滚动内容区"完整渲染成一张 JPG 长图并下载。
 * 只渲染内容区本身（标题、筛选条、各个卡片，一直到页面底部），不含顶栏、导航和左侧项目栏。
 * - 内容区在固定外壳里是滚动容器 #main 的子元素，它自己的高度就是整页高度，所以不需要滚动拼接；
 * - 带 data-export-skip 的元素（导出按钮 / 打开着的导出面板）不进图；
 * - 图表是 canvas，会被转成位图；背景色取页面当前主题的背景（JPG 没有透明）。
 */

const MAX_SIDE = 16000; // 浏览器 canvas 边长上限的保守值
const PAD = 24;

/**
 * 内容里有自己滚动的区域（日历热力图默认滚到最近几周、宽表格等）。克隆出来的节点滚动位置会归零且露出滚动条，
 * 所以截图前临时：隐藏滚动条，并把已滚动的内容用 transform 平移到与当前所见一致；截图后原样恢复。
 */
function freezeScrollers(root: HTMLElement): () => void {
  const restores: Array<() => void> = [];
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
    const cs = getComputedStyle(el);
    const scrollable = /(auto|scroll)/.test(cs.overflowX) || /(auto|scroll)/.test(cs.overflowY);
    if (!scrollable || (el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1)) continue;
    const prevSb = el.style.scrollbarWidth;
    el.style.scrollbarWidth = 'none';
    restores.push(() => {
      el.style.scrollbarWidth = prevSb;
    });
    const sl = el.scrollLeft;
    const st = el.scrollTop;
    if (sl > 0 || st > 0) {
      for (const child of Array.from(el.children) as HTMLElement[]) {
        const prev = child.style.transform;
        child.style.transform = `translate(${-sl}px, ${-st}px) ${cs.transform === 'none' ? '' : child.style.transform}`.trim();
        restores.push(() => {
          child.style.transform = prev;
        });
      }
    }
  }
  return () => restores.forEach((r) => r());
}

export function exportFileName(page: string): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `token-visualizer-${page}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.jpg`;
}

export async function renderPageJpg(): Promise<{ dataUrl: string; page: string }> {
  const el = document.querySelector<HTMLElement>('#main [data-testid="content"]');
  if (!el) throw new Error('content not found');
  const page = el.getAttribute('data-page') ?? 'page';
  await document.fonts.ready;
  const w = Math.ceil(el.scrollWidth) + PAD * 2;
  const h = Math.ceil(el.scrollHeight) + PAD * 2;
  // 太长的页面自动降低倍率，保证单边不超过 canvas 上限
  const pixelRatio = Math.max(0.5, Math.min(2, MAX_SIDE / h, MAX_SIDE / w));
  const bg = getComputedStyle(document.body).backgroundColor;
  const unfreeze = freezeScrollers(el);
  let dataUrl: string;
  try {
    dataUrl = await toJpeg(el, {
    quality: 0.92,
    pixelRatio,
    backgroundColor: bg,
    width: w,
    height: h,
    style: { margin: '0', padding: `${PAD}px`, boxSizing: 'border-box', width: `${w}px`, height: `${h}px`, overflow: 'visible' },
    filter: (node) => !(node instanceof HTMLElement && node.hasAttribute('data-export-skip')),
    });
  } finally {
    unfreeze();
  }
  return { dataUrl, page };
}

export function downloadDataUrl(dataUrl: string, filename: string): void {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

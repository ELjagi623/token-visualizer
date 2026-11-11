/**
 * 项目切换耗时打点：点击（或方向键）切换项目 → 内容区数据更新完成。
 * 结果挂在 window.__tvPerf 上，供 E2E 读取（p95 < 200 ms 的验收）。
 */
export interface PerfSample {
  project: string;
  ms: number;
}

interface PerfState {
  pending: { project: string; t0: number } | null;
  samples: PerfSample[];
}

declare global {
  interface Window {
    __tvPerf?: PerfState;
  }
}

function state(): PerfState {
  window.__tvPerf ??= { pending: null, samples: [] };
  return window.__tvPerf;
}

export function markSwitch(project: string): void {
  state().pending = { project, t0: performance.now() };
}

export function markReady(project: string): void {
  const s = state();
  if (!s.pending || s.pending.project !== project) return;
  s.samples.push({ project, ms: performance.now() - s.pending.t0 });
  if (s.samples.length > 500) s.samples.shift();
  s.pending = null;
}

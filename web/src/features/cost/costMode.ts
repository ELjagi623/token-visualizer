/**
 * 成本口径（等价 API / 订阅摊销）的全局选择：记在 localStorage（`tv.costMode`），默认等价 API。
 * 独立的小 store，不依赖总览页的筛选状态；总览 / 会话 / 成本模块共用。
 */
import { create } from 'zustand';
import { lsGet, lsSet } from '../../lib/storage.ts';
import type { CostBlock, CostMode } from './types.ts';

const KEY = 'tv.costMode';

interface CostModeState {
  mode: CostMode;
  setMode: (m: CostMode) => void;
}

export const useCostMode = create<CostModeState>((set) => ({
  mode: lsGet(KEY) === 'sub' ? 'sub' : 'api',
  setMode: (m) => {
    lsSet(KEY, m);
    set({ mode: m });
  },
}));

/** 按口径取金额（null = 无法计算 → 界面显示 —）。 */
export function costOf(block: CostBlock | null | undefined, mode: CostMode): number | null {
  if (!block) return null;
  return mode === 'api' ? block.apiUsd : block.subUsd;
}

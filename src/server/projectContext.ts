/**
 * 聚合上下文：在 store 视图之上应用项目覆盖规则（重命名 / 置顶 / 隐藏）。
 *
 * 隐藏 = 记录整体剔除：ctx.records 不含隐藏项目的记录，ctx.projects 不含它们，
 * 所以 aggregate 的"全部"、groupByProject、summary、周期卡、成本、导出……自然一致，分组之和 = 合计。
 * （隐藏项目的信息单独放在 ctx.hidden，供项目栏底部"已隐藏 N 个 · 恢复"与设置页使用。）
 */
import type { AggregateContext } from './core/aggregate.ts';
import { buildProjectIndex } from './core/projects.ts';
import type { ProjectIndex, ProjectInfo, ProjectOverrides } from './core/projects.ts';
import type { OverrideMap } from './overrides.ts';
import { SCRATCH_ID } from './overrides.ts';
import type { StoreView } from './store/types.ts';

export interface HiddenItem {
  id: string;
  displayName: string;
  path: string | null;
  isScratchGroup: boolean;
  requests: number;
  lastTs: number | null;
}

export interface AppContext extends AggregateContext {
  /** 被隐藏的项目（含整组隐藏的 Scratch） */
  hidden: HiddenItem[];
  hiddenKeys: ReadonlySet<string>;
  /** 未隐藏前的完整索引（用于校验 id / 取原始名称） */
  fullIndex: ProjectIndex;
  overrides: OverrideMap;
  /** 被重命名的项目的原始（自动识别）名称：id → 名称 */
  defaultNames: ReadonlyMap<string, string>;
}

/** 传给 buildProjectIndex 的覆盖项：只带名称与置顶（隐藏由本模块处理，合并不支持）。 */
function indexOverrides(map: OverrideMap): ProjectOverrides {
  const out: ProjectOverrides = {};
  for (const [k, v] of Object.entries(map)) {
    if (k === SCRATCH_ID) continue;
    if (v.name || v.pinned) out[k] = { ...(v.name ? { name: v.name } : {}), ...(v.pinned ? { pinned: true } : {}) };
  }
  return out;
}

function toHidden(p: ProjectInfo): HiddenItem {
  return { id: p.id, displayName: p.displayName, path: p.path, isScratchGroup: p.isScratchGroup, requests: p.records, lastTs: p.lastTs };
}

export function buildAppContext(view: Pick<StoreView, 'records' | 'folderKeys'>, groupScratch: boolean, overrides: OverrideMap): AppContext {
  const ov = indexOverrides(overrides);
  const full = buildProjectIndex(view.records, { groupScratch, folderKeys: view.folderKeys, overrides: ov });

  const hiddenKeys = new Set<string>();
  const scratchHidden = overrides[SCRATCH_ID]?.hidden === true;
  for (const info of full.byId.values()) {
    if (info.isScratchGroup) continue;
    if (overrides[info.id]?.hidden || (scratchHidden && info.isScratch)) hiddenKeys.add(info.id);
  }

  let projects = full;
  let records = view.records;
  const hidden: HiddenItem[] = [];
  if (hiddenKeys.size > 0) {
    records = view.records.filter((r) => !hiddenKeys.has(r.projectKey));
    projects = buildProjectIndex(records, { groupScratch, folderKeys: view.folderKeys.filter((k) => !hiddenKeys.has(k)), overrides: ov });
    if (scratchHidden) {
      const kids = [...full.byId.values()].filter((p) => !p.isScratchGroup && p.isScratch);
      hidden.push({
        id: SCRATCH_ID,
        displayName: 'Scratch',
        path: null,
        isScratchGroup: true,
        requests: kids.reduce((a, c) => a + c.records, 0),
        lastTs: kids.reduce<number | null>((a, c) => (c.lastTs !== null && (a === null || c.lastTs > a) ? c.lastTs : a), null),
      });
    }
    for (const k of [...hiddenKeys].sort()) {
      const info = full.byId.get(k);
      if (!info) continue;
      if (scratchHidden && info.isScratch) continue; // 随整组一起隐藏，不单独列出
      hidden.push(toHidden(info));
    }
  }
  // Scratch 组的置顶标记
  const group = projects.byId.get(SCRATCH_ID);
  if (group && overrides[SCRATCH_ID]?.pinned) group.pinned = true;
  const defaultNames = new Map<string, string>();
  if (Object.values(overrides).some((o) => o.name)) {
    const plain = buildProjectIndex(view.records, { groupScratch, folderKeys: view.folderKeys });
    for (const [id, o] of Object.entries(overrides)) {
      const info = plain.byId.get(id);
      if (o.name && info) defaultNames.set(id, info.displayName);
    }
  }
  return { records, projects, hidden, hiddenKeys, fullIndex: full, overrides, defaultNames };
}

/** 某个 id 是否是已知项目（文件夹 key / scratch），含已隐藏的。 */
export function isKnownProjectId(ctx: AppContext, id: string): boolean {
  if (id === SCRATCH_ID) return ctx.fullIndex.byId.has(SCRATCH_ID) || [...ctx.fullIndex.byId.values()].some((p) => p.isScratch);
  return ctx.fullIndex.byId.has(id);
}

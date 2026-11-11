/**
 * 项目归组。
 *
 * 项目 = 数据根下一级子文件夹（`projectKey`）。
 * - 显示名 / 真实路径：取该文件夹内"记录数最多的 cwd"（并列取最近出现者）的最后一级目录名；完整 cwd 作路径；
 *   同文件夹有多个 cwd 时给出 `cwds[]`（按记录数降序，并列按最近出现）；无 cwd → 退回文件夹名并标记 `pathUnknown`。
 * - Scratch（桌面版临时对话，`...\scratch-workspaces\<uuid>\<uuid>\scratch-YYYY-MM-DD-xxxxxx`）：
 *   按 cwd 或文件夹名识别；`groupScratch` 开启时归并成一个虚拟项目 `scratch`（含 `children[]`）。
 * - `overrides`（重命名 / 隐藏 / 置顶 / 合并）：本阶段只实现数据结构与纯函数语义，UI 与持久化在阶段 9。
 *   隐藏只打标记（`hidden`），合并后被合并者并入目标的 `memberKeys`。
 */
import type { UsageRecord } from '../../shared/types.ts';

export const SCRATCH_GROUP_ID = 'scratch';

export interface ProjectOverride {
  name?: string;
  hidden?: boolean;
  pinned?: boolean;
  /** 合并到另一个项目文件夹（projectKey）。 */
  mergeInto?: string;
}

export type ProjectOverrides = Record<string, ProjectOverride>;

export interface ProjectInfo {
  /** 项目 id：普通项目 = projectKey；Scratch 组 = `scratch`。 */
  id: string;
  displayName: string;
  /** 完整真实路径（主 cwd）；未知为 null。 */
  path: string | null;
  /** 该文件夹内出现过的全部 cwd（主 cwd 在前）。 */
  cwds: string[];
  /** 没有任何 cwd 可用，显示名退回了文件夹名。 */
  pathUnknown: boolean;
  isScratchGroup: boolean;
  /** 是否是 Scratch 临时对话文件夹（无论是否被归并）。 */
  isScratch: boolean;
  /** 本项目覆盖的文件夹（projectKey）。普通项目通常 1 个；Scratch 组 / 合并目标为多个。 */
  memberKeys: string[];
  children?: ProjectInfo[];
  /** 去重后记录数。 */
  records: number;
  firstTs: number | null;
  lastTs: number | null;
  renamed: boolean;
  hidden: boolean;
  pinned: boolean;
  /** 被合并进本项目的其它文件夹。 */
  mergedFrom?: string[];
}

export interface ProjectIndex {
  /** 顶层项目列表（Scratch 归并后为 非 scratch 数 + 1；按 id 字典序，确定）。 */
  list: ProjectInfo[];
  byId: Map<string, ProjectInfo>;
  /** 某项目 id 覆盖的文件夹；未知 id → undefined。 */
  keysFor(id: string): string[] | undefined;
  /** 某文件夹归属的顶层项目 id（经 Scratch 归并 / 合并后）。 */
  idOfKey(projectKey: string): string;
  groupScratch: boolean;
}

const SCRATCH_CWD = /[\\/]scratch-workspaces[\\/].*[\\/]scratch-[^\\/]*[\\/]*$/i;
const SCRATCH_FOLDER = /scratch-workspaces-.*-scratch-[^\\/]+$/i;

export function isScratchPath(cwd: string): boolean {
  return SCRATCH_CWD.test(cwd);
}

export function isScratchFolderName(key: string): boolean {
  return SCRATCH_FOLDER.test(key);
}

/** 路径最后一级目录名（兼容 `\` 与 `/`，忽略末尾分隔符）。 */
export function lastSegment(p: string): string {
  const parts = p.split(/[\\/]+/).filter((s) => s.length > 0);
  return parts.length > 0 ? parts[parts.length - 1]! : p;
}

interface FolderAcc {
  key: string;
  records: number;
  firstTs: number | null;
  lastTs: number | null;
  cwdCount: Map<string, { n: number; last: number }>;
}

export interface BuildProjectsOptions {
  /** 是否把 Scratch 归并成一个虚拟项目，默认 true。 */
  groupScratch?: boolean;
  overrides?: ProjectOverrides;
  /** 数据根下的全部文件夹名（含没有任何记录的）；缺省只用记录里出现过的。 */
  folderKeys?: Iterable<string>;
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function buildProjectIndex(records: readonly UsageRecord[], options: BuildProjectsOptions = {}): ProjectIndex {
  const groupScratch = options.groupScratch ?? true;
  const overrides = options.overrides ?? {};

  const folders = new Map<string, FolderAcc>();
  const ensure = (key: string): FolderAcc => {
    let f = folders.get(key);
    if (!f) {
      f = { key, records: 0, firstTs: null, lastTs: null, cwdCount: new Map() };
      folders.set(key, f);
    }
    return f;
  };
  for (const k of options.folderKeys ?? []) ensure(k);
  for (const r of records) {
    const f = ensure(r.projectKey);
    f.records++;
    if (f.firstTs === null || r.ts < f.firstTs) f.firstTs = r.ts;
    if (f.lastTs === null || r.ts > f.lastTs) f.lastTs = r.ts;
    if (r.cwd) {
      const c = f.cwdCount.get(r.cwd);
      if (c) {
        c.n++;
        if (r.ts > c.last) c.last = r.ts;
      } else f.cwdCount.set(r.cwd, { n: 1, last: r.ts });
    }
  }

  const infos = new Map<string, ProjectInfo>();
  for (const f of folders.values()) {
    const cwds = [...f.cwdCount.entries()]
      .sort((a, b) => b[1].n - a[1].n || b[1].last - a[1].last || cmpStr(a[0], b[0]))
      .map(([c]) => c);
    const main = cwds[0];
    const o = overrides[f.key];
    const scratch = isScratchFolderName(f.key) || (main !== undefined && isScratchPath(main));
    infos.set(f.key, {
      id: f.key,
      displayName: o?.name?.trim() ? o.name.trim() : main !== undefined ? lastSegment(main) : f.key,
      path: main ?? null,
      cwds,
      pathUnknown: main === undefined,
      isScratchGroup: false,
      isScratch: scratch,
      memberKeys: [f.key],
      records: f.records,
      firstTs: f.firstTs,
      lastTs: f.lastTs,
      renamed: !!o?.name?.trim(),
      hidden: !!o?.hidden,
      pinned: !!o?.pinned,
    });
  }

  // 合并（含链式 / 防环）：被合并者并入最终目标
  const targetOf = (key: string): string => {
    let cur = key;
    const seen = new Set<string>([cur]);
    for (let i = 0; i < 8; i++) {
      const to = overrides[cur]?.mergeInto;
      if (!to || !infos.has(to)) break;
      if (to === key) return key; // 回到起点：这是个环，忽略该合并
      if (seen.has(to)) break;
      cur = to;
      seen.add(cur);
    }
    return cur;
  };
  const mergedAway = new Set<string>();
  for (const key of [...infos.keys()].sort(cmpStr)) {
    const t = targetOf(key);
    if (t === key) continue;
    const src = infos.get(key)!;
    const dst = infos.get(t)!;
    dst.memberKeys.push(...src.memberKeys);
    dst.records += src.records;
    dst.firstTs = minNullable(dst.firstTs, src.firstTs);
    dst.lastTs = maxNullable(dst.lastTs, src.lastTs);
    for (const c of src.cwds) if (!dst.cwds.includes(c)) dst.cwds.push(c);
    (dst.mergedFrom ??= []).push(key);
    mergedAway.add(key);
  }

  const top: ProjectInfo[] = [];
  const scratchChildren: ProjectInfo[] = [];
  for (const info of infos.values()) {
    if (mergedAway.has(info.id)) continue;
    if (groupScratch && info.isScratch) scratchChildren.push(info);
    else top.push(info);
  }
  scratchChildren.sort((a, b) => cmpStr(a.id, b.id));
  if (scratchChildren.length > 0) {
    top.push({
      id: SCRATCH_GROUP_ID,
      displayName: 'Scratch',
      path: null,
      cwds: [],
      pathUnknown: false,
      isScratchGroup: true,
      isScratch: true,
      memberKeys: scratchChildren.flatMap((c) => c.memberKeys),
      children: scratchChildren,
      records: scratchChildren.reduce((a, c) => a + c.records, 0),
      firstTs: scratchChildren.reduce<number | null>((a, c) => minNullable(a, c.firstTs), null),
      lastTs: scratchChildren.reduce<number | null>((a, c) => maxNullable(a, c.lastTs), null),
      renamed: false,
      hidden: false,
      pinned: false,
    });
  }
  top.sort((a, b) => cmpStr(a.id, b.id));

  const byId = new Map<string, ProjectInfo>();
  const idOfKeyMap = new Map<string, string>();
  for (const p of top) {
    byId.set(p.id, p);
    for (const k of p.memberKeys) idOfKeyMap.set(k, p.id);
    for (const c of p.children ?? []) byId.set(c.id, c); // Scratch 子项也可单独查询
  }
  // 被合并者 / 子项也能按 id 查（指向自己的 memberKeys）
  return {
    list: top,
    byId,
    groupScratch,
    keysFor: (id) => byId.get(id)?.memberKeys,
    idOfKey: (key) => idOfKeyMap.get(key) ?? key,
  };
}

function minNullable(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

function maxNullable(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

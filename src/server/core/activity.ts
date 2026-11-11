/**
 * AI 运行时长（估算）：本机上 AI 实际"工作"了多久。
 *
 * 算法（与 docs/design/active-time-probe.mjs 一致）：
 *   每个会话文件内按行序遍历"事件"——assistant 行与 user 行（user 行只看 `message.content[0].type`：
 *   `tool_result` 算 AI 事件，其余算真人事件；不读正文）。对每个 AI 事件，若它与上一个事件
 *   （任意 AI / 真人事件）的间隔 ≤ 15 分钟，则把该间隔计为 AI 工作时间；更长视为空闲 / 等待，不计；
 *   以真人输入结尾的间隔（人在想 / 打字）不计。
 *   各文件的区间做并集：
 *     - 主数字「AI 运行时长」= 所有文件区间的并集（挂钟时间，并行的会话 / 子代理只算一次）；
 *     - 次要数字「累计 agent 时长」= 各文件区间之和（并行会重复计入）。
 *
 * 区间用"扁平数组"保存：[s0, e0, s1, e1, …]（毫秒时间戳），缓存只存区间，不存任何正文。
 */
import type { AggregateContext } from './aggregate.ts';

export const ACTIVE_GAP_MS = 15 * 60_000;

/**
 * 在区间列表末尾追加 [s, e]：若与最后一个区间相接 / 重叠（s 落在最后区间内）则就地合并，否则新增。
 * 解析器与增量续读共用这个函数，所以"一次性全量"与"分段增量"的结果逐项相同。
 */
export function appendInterval(list: number[], s: number, e: number): void {
  const n = list.length;
  if (n >= 2) {
    const ls = list[n - 2]!;
    const le = list[n - 1]!;
    if (s >= ls && s <= le) {
      if (e > le) list[n - 1] = e;
      return;
    }
  }
  list.push(s, e);
}

/** 把两个按顺序产生的区间列表拼接（边界处按 appendInterval 的规则合并）。 */
export function concatIntervals(a: readonly number[], b: readonly number[]): number[] {
  const out = a.slice();
  for (let i = 0; i + 1 < b.length; i += 2) appendInterval(out, b[i]!, b[i + 1]!);
  return out;
}

/** 区间并集：返回按起点升序、互不相交的扁平数组。 */
export function unionIntervals(lists: ReadonlyArray<readonly number[]>): number[] {
  const pairs: Array<[number, number]> = [];
  for (const l of lists) for (let i = 0; i + 1 < l.length; i += 2) if (l[i + 1]! > l[i]!) pairs.push([l[i]!, l[i + 1]!]);
  pairs.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const out: number[] = [];
  for (const [s, e] of pairs) {
    const n = out.length;
    if (n >= 2 && s <= out[n - 1]!) {
      if (e > out[n - 1]!) out[n - 1] = e;
    } else out.push(s, e);
  }
  return out;
}

export function totalIntervalMs(flat: readonly number[]): number {
  let t = 0;
  for (let i = 0; i + 1 < flat.length; i += 2) t += flat[i + 1]! - flat[i]!;
  return t;
}

/** 把（已并集、升序的）区间裁剪到 [from, to)。 */
export function clipIntervals(flat: readonly number[], from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const s = Math.max(flat[i]!, from);
    const e = Math.min(flat[i + 1]!, to);
    if (e > s) out.push(s, e);
  }
  return out;
}

/**
 * 把（已并集、升序的）区间按桶切分：starts 是桶起点升序，`end` 是最后一个桶的终点。
 * 返回每个桶内的活跃毫秒数（区间先被裁剪到 [starts[0], end)）。
 */
export function allocateToBuckets(flat: readonly number[], starts: readonly number[], end: number): number[] {
  const out = new Array<number>(starts.length).fill(0);
  if (starts.length === 0) return out;
  let b = 0;
  for (let i = 0; i + 1 < flat.length; i += 2) {
    let s = flat[i]!;
    const e = Math.min(flat[i + 1]!, end);
    if (e <= starts[0]!) continue;
    if (s < starts[0]!) s = starts[0]!;
    // 区间升序且互不相交：b 只会向前走
    while (b + 1 < starts.length && starts[b + 1]! <= s) b++;
    let cur = s;
    let k = b;
    while (cur < e && k < starts.length) {
      const bEnd = k + 1 < starts.length ? starts[k + 1]! : end;
      const seg = Math.min(e, bEnd) - cur;
      if (seg > 0) out[k]! += seg;
      cur = Math.min(e, bEnd);
      if (cur >= bEnd) k++;
      else break;
    }
  }
  return out;
}

/** 一个文件的活跃区间（来自 FileState）。 */
export interface FileActivity {
  relPath: string;
  projectKey: string;
  isSubagentFile: boolean;
  intervals: readonly number[];
}

export interface ActivityFilter {
  /** 限定项目文件夹（projectKey）；null = 全部 */
  keys: ReadonlySet<string> | null;
  includeSidechain: boolean;
}

export interface ActivitySet {
  /** 并集（扁平、升序） */
  union: number[];
  /** 各文件（各自先并集）总时长之和，毫秒 */
  sumMs: number;
  /** 各文件并集后的区间，用于按窗口裁剪求和 */
  perFile: number[][];
}

const memo = new WeakMap<readonly FileActivity[], Map<string, ActivitySet>>();

export function activitySet(files: readonly FileActivity[], f: ActivityFilter): ActivitySet {
  let m = memo.get(files);
  if (!m) {
    m = new Map();
    memo.set(files, m);
  }
  const key = `${f.includeSidechain ? 1 : 0}|${f.keys ? [...f.keys].sort().join('\u0001') : '*'}`;
  const hit = m.get(key);
  if (hit) return hit;
  const perFile: number[][] = [];
  for (const file of files) {
    if (f.keys && !f.keys.has(file.projectKey)) continue;
    if (!f.includeSidechain && file.isSubagentFile) continue;
    const u = unionIntervals([file.intervals]);
    if (u.length > 0) perFile.push(u);
  }
  const union = unionIntervals(perFile);
  let sumMs = 0;
  for (const p of perFile) sumMs += totalIntervalMs(p);
  const res = { union, sumMs, perFile };
  m.set(key, res);
  return res;
}

export interface ActivityResult {
  /** 窗口内并集（挂钟时间），毫秒 */
  activeMs: number;
  /** 窗口内各文件之和（并行重复计入），毫秒 */
  activeMsSum: number;
  /** 与 buckets 对齐的并集毫秒数 */
  perBucket: number[];
}

/**
 * 在窗口 [from, to) 内统计；buckets 为桶起点升序（可空）。
 * 约定：Σ perBucket = activeMs（区间先裁剪到窗口再分桶）。
 */
export function computeActivity(set: ActivitySet, from: number, to: number, bucketStarts: readonly number[]): ActivityResult {
  const clipped = clipIntervals(set.union, from, to);
  const perBucket = bucketStarts.length > 0 ? allocateToBuckets(clipped, bucketStarts, to) : [];
  let sum = 0;
  for (const p of set.perFile) sum += totalIntervalMs(clipIntervals(p, from, to));
  return { activeMs: totalIntervalMs(clipped), activeMsSum: sum, perBucket };
}

/** AggregateContext 上可选携带活跃数据。 */
export interface ActivityContext extends AggregateContext {
  activity?: readonly FileActivity[];
}

/**
 * 全局去重：每个 message 在整个数据根内只计一次（跨文件、跨项目）。
 *
 * 键：`message.id`；无 id 退回 `requestId`；两者皆无则不去重（每行一条记录，占位 id）。
 *
 * 合并规则（对同一个键的所有出现）：
 * - usage 各数值字段（input / cacheWrite / 5m / 1h / cacheRead / output / thinking / webSearch / webFetch）取最大值；
 * - ts 取最早；
 * - tools 取并集（按 tool_use block id 去重）；
 * - stopReason 取最后一个非空值；model 取第一个值（<synthetic> 行已在解析层排除）；
 * - 其余元数据（serviceTier / speed / effort / entrypoint / gitBranch / version / requestId）取第一个非空值；
 * - **所有权**（sessionId / projectKey / cwd / isSidechain / agentId / sourceFile）：
 *   归属"文件首条记录时间戳最早"的那个文件；时间戳并列（或缺失）时按文件路径字典序。
 *   实现上把所有文件按 (firstTs 升序, path 升序) 排好，再顺序消费，因此"第一个/最后一个"
 *   对任意摄入顺序都是确定的（这也是阶段 3 增量重算的基础）。
 */
import type { ParseStats, UsageRecord } from '../../shared/types.ts';
import type { ParsedRow } from './parser.ts';

/** 一个文件对去重器的输入。 */
export interface DedupeFileInput {
  /** 相对数据根、使用 `/` 分隔的路径；同时是所有权并列时的排序键。 */
  path: string;
  /** 数据根下一级文件夹名。 */
  projectKey: string;
  /** 文件首条（任意 type）带合法时间戳的记录的时间；未知为 null（排在最后）。 */
  firstTs: number | null;
  /** 记录缺 sessionId 时的回退（主会话 = 文件名；子代理 = 父会话目录名）。 */
  defaultSessionId: string;
  /** 文件位于 `<session>/subagents/` 下。 */
  isSubagentFile: boolean;
  /** 从文件名 `agent-<id>.jsonl` 解析出的 agentId。 */
  agentIdFromName?: string;
  /** 该文件按行序排列的 assistant 行。 */
  rows: ParsedRow[];
}

export interface DedupeStats {
  uniqueMessages: number;
  duplicatesDropped: number;
  crossFileDuplicates: number;
}

export interface DedupeResult {
  /** 按 (ts, messageId) 升序，顺序确定。 */
  records: UsageRecord[];
  stats: DedupeStats;
}

/** 所有权顺序：firstTs 小者优先（null 视为 +∞），并列按路径字典序（码元序，与区域设置无关）。 */
export function compareOwnership(a: { firstTs: number | null; path: string }, b: { firstTs: number | null; path: string }): number {
  const ta = a.firstTs ?? Number.POSITIVE_INFINITY;
  const tb = b.firstTs ?? Number.POSITIVE_INFINITY;
  if (ta !== tb) return ta < tb ? -1 : 1;
  if (a.path === b.path) return 0;
  return a.path < b.path ? -1 : 1;
}

interface Acc {
  ownerPath: string;
  crossFile: boolean;
  messageId: string;
  requestId?: string;
  ts: number;
  model: string;
  sessionId?: string;
  projectKey: string;
  cwd?: string;
  isSidechain?: boolean;
  agentId?: string;
  input: number;
  cacheWrite: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
  thinking: number;
  webSearch: number;
  webFetch: number;
  serviceTier?: string;
  speed?: string;
  effort?: string;
  entrypoint?: string;
  gitBranch?: string;
  version?: string;
  stopReason?: string;
  /** block id → 工具名 */
  toolBlocks: Map<string, string>;
  /** 该出现所在文件的回退信息（取所有权文件的） */
  fallbackSession: string;
  fallbackSidechain: boolean;
  fallbackAgentId?: string;
}

function newAcc(file: DedupeFileInput, row: ParsedRow, messageId: string): Acc {
  return {
    ownerPath: file.path,
    crossFile: false,
    messageId,
    ts: row.ts,
    model: row.model,
    projectKey: file.projectKey,
    input: 0,
    cacheWrite: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheRead: 0,
    output: 0,
    thinking: 0,
    webSearch: 0,
    webFetch: 0,
    toolBlocks: new Map(),
    fallbackSession: file.defaultSessionId,
    fallbackSidechain: file.isSubagentFile,
    fallbackAgentId: file.agentIdFromName,
  };
}

function mergeRow(acc: Acc, file: DedupeFileInput, row: ParsedRow): void {
  if (row.ts < acc.ts) acc.ts = row.ts;
  if (row.input > acc.input) acc.input = row.input;
  if (row.cacheWrite > acc.cacheWrite) acc.cacheWrite = row.cacheWrite;
  if (row.cacheWrite5m > acc.cacheWrite5m) acc.cacheWrite5m = row.cacheWrite5m;
  if (row.cacheWrite1h > acc.cacheWrite1h) acc.cacheWrite1h = row.cacheWrite1h;
  if (row.cacheRead > acc.cacheRead) acc.cacheRead = row.cacheRead;
  if (row.output > acc.output) acc.output = row.output;
  if (row.thinking > acc.thinking) acc.thinking = row.thinking;
  if (row.webSearch > acc.webSearch) acc.webSearch = row.webSearch;
  if (row.webFetch > acc.webFetch) acc.webFetch = row.webFetch;

  acc.requestId ??= row.requestId;
  acc.serviceTier ??= row.serviceTier;
  acc.speed ??= row.speed;
  acc.effort ??= row.effort;
  acc.entrypoint ??= row.entrypoint;
  acc.gitBranch ??= row.gitBranch;
  acc.version ??= row.version;
  if (row.stopReason) acc.stopReason = row.stopReason;

  // 所有权字段：只认所有权文件内的出现
  if (file.path === acc.ownerPath) {
    acc.sessionId ??= row.sessionId;
    acc.cwd ??= row.cwd;
    acc.isSidechain ??= row.isSidechain;
    acc.agentId ??= row.agentId;
  }

  for (let i = 0; i < row.tools.length; i++) {
    const t = row.tools[i]!;
    // 没有 block id 的极端情况：用"文件 + 行偏移 + 序号"做键（每次出现各算一次，不跨出现去重）
    const key = t.id ?? `~${file.path}:${row.offset}:${i}`;
    if (!acc.toolBlocks.has(key)) acc.toolBlocks.set(key, t.name);
  }
}

function finalize(acc: Acc): UsageRecord {
  const counts = new Map<string, number>();
  for (const name of acc.toolBlocks.values()) counts.set(name, (counts.get(name) ?? 0) + 1);
  const rec: UsageRecord = {
    messageId: acc.messageId,
    ts: acc.ts,
    model: acc.model,
    sessionId: acc.sessionId ?? acc.fallbackSession,
    projectKey: acc.projectKey,
    isSidechain: acc.isSidechain ?? acc.fallbackSidechain,
    input: acc.input,
    cacheWrite: acc.cacheWrite,
    cacheWrite5m: acc.cacheWrite5m,
    cacheWrite1h: acc.cacheWrite1h,
    cacheRead: acc.cacheRead,
    output: acc.output,
    thinking: acc.thinking,
    webSearch: acc.webSearch,
    webFetch: acc.webFetch,
    tools: Object.fromEntries([...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))),
    sourceFile: acc.ownerPath,
  };
  if (acc.requestId !== undefined) rec.requestId = acc.requestId;
  if (acc.cwd !== undefined) rec.cwd = acc.cwd;
  const agentId = acc.agentId ?? acc.fallbackAgentId;
  if (agentId !== undefined) rec.agentId = agentId;
  if (acc.serviceTier !== undefined) rec.serviceTier = acc.serviceTier;
  if (acc.speed !== undefined) rec.speed = acc.speed;
  if (acc.effort !== undefined) rec.effort = acc.effort;
  if (acc.entrypoint !== undefined) rec.entrypoint = acc.entrypoint;
  if (acc.gitBranch !== undefined) rec.gitBranch = acc.gitBranch;
  if (acc.version !== undefined) rec.version = acc.version;
  if (acc.stopReason !== undefined) rec.stopReason = acc.stopReason;
  return rec;
}

const SLICE = 4096;

function* dedupeSteps(files: DedupeFileInput[]): Generator<void, DedupeResult> {
  const ordered = [...files].sort(compareOwnership);
  const map = new Map<string, Acc>();
  const noId: Acc[] = [];
  let duplicatesDropped = 0;
  let work = 0;

  for (const file of ordered) {
    for (const row of file.rows) {
      const key = row.messageId ? `m:${row.messageId}` : row.requestId ? `r:${row.requestId}` : undefined;
      if (key === undefined) {
        // 无任何 id：不去重，每行独立成一条
        const acc = newAcc(file, row, `noid:${file.path}:${row.offset}`);
        mergeRow(acc, file, row);
        noId.push(acc);
      } else {
        let acc = map.get(key);
        if (!acc) {
          acc = newAcc(file, row, row.messageId ?? row.requestId!);
          map.set(key, acc);
        } else {
          duplicatesDropped++;
          if (file.path !== acc.ownerPath) acc.crossFile = true;
        }
        mergeRow(acc, file, row);
      }
      if (++work % SLICE === 0) yield;
    }
  }

  let crossFileDuplicates = 0;
  const records: UsageRecord[] = [];
  for (const acc of map.values()) {
    if (acc.crossFile) crossFileDuplicates++;
    records.push(finalize(acc));
    if (++work % SLICE === 0) yield;
  }
  for (const acc of noId) records.push(finalize(acc));

  records.sort((a, b) => (a.ts !== b.ts ? a.ts - b.ts : a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1 : 0));

  return {
    records,
    stats: { uniqueMessages: records.length, duplicatesDropped, crossFileDuplicates },
  };
}

/** 对一组文件的 assistant 行做全局去重。纯函数，不依赖传入顺序。 */
export function dedupeGlobal(files: DedupeFileInput[]): DedupeResult {
  const g = dedupeSteps(files);
  let r = g.next();
  while (!r.done) r = g.next();
  return r.value;
}

/** 与 dedupeGlobal 结果完全相同，但每处理一批就让出事件循环（大数据量时不长时间阻塞）。 */
export async function dedupeGlobalAsync(files: DedupeFileInput[]): Promise<DedupeResult> {
  const g = dedupeSteps(files);
  let r = g.next();
  while (!r.done) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    r = g.next();
  }
  return r.value;
}

/** 把去重层统计写入 ParseStats。 */
export function applyDedupeStats(stats: ParseStats, d: DedupeStats): void {
  stats.uniqueMessages = d.uniqueMessages;
  stats.duplicatesDropped = d.duplicatesDropped;
  stats.crossFileDuplicates = d.crossFileDuplicates;
}

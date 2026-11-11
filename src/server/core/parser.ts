/**
 * 流式 JSONL 解析（单文件、按字节区间）。
 *
 * 要点：
 * - 以固定大小的块读取，从不把整个文件读入内存；
 * - 只消费到区间内**最后一个换行符**，返回 `consumedUntilOffset`，半行留待下次；
 * - 每个非空行都做 JSON.parse：损坏行跳过并计数（`corruptLines`）；
 * - 非 `assistant` 行忽略，但计入 `typeCounts`；
 * - 只提取用量与元数据字段；`tool_use` 只取 `name`/`id`，绝不读 `input`；用户正文等一概不碰；
 * - `<synthetic>` 模型行直接丢弃，只计数。
 * - 另外产出（不读正文）：AI 活跃区间（assistant 行与 user 行的时间戳，user 行只看 content[0].type）与
 *   首条真人消息的前 ≤ 40 字标题（原文不保存）。
 *
 * 关于"廉价预过滤"：计划允许"改用更稳妥的做法"。因为 `corruptLines` 与 `typeCounts`
 * 必须对**每一行**精确（损坏行通常不含 "assistant" 字样），任何基于子串的预过滤都会漏数，
 * 所以这里不做预过滤，对每个非空行直接 JSON.parse（实测吞吐见开发报告）。
 */
import type { ParseStats } from '../../shared/types.ts';
import { emptyParseStats } from '../../shared/types.ts';
import { ACTIVE_GAP_MS, appendInterval } from './activity.ts';
import { safeFs } from './safeFs.ts';
import { titleFromUserRow } from './title.ts';
import type { SafeFs } from './safeFs.ts';

export const SYNTHETIC_MODEL = '<synthetic>';
const LF = 0x0a;

/** 一条 assistant 行（尚未跨行 / 跨文件去重）的提取结果。 */
export interface ParsedRow {
  /** 该行首字节在文件内的偏移（用于缺 id 行的确定性占位 id）。 */
  offset: number;
  messageId?: string;
  requestId?: string;
  ts: number;
  /** 原始模型名；缺失为 "unknown"。 */
  model: string;
  sessionId?: string;
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
  /** tool_use blocks：只含 id 与 name。 */
  tools: Array<{ id?: string; name: string }>;
}

export interface ParseRangeOptions {
  /** 起始字节偏移（必须是行首），默认 0。 */
  startOffset?: number;
  /** 结束字节偏移（不含），默认文件当前大小。 */
  endOffset?: number;
  /** 每次读取的块大小，默认 1 MiB。 */
  chunkSize?: number;
  fs?: SafeFs;
  /** 续读时：区间之前最后一个"事件"（assistant / user 行）的时间戳；全量解析为 null。 */
  prevEventTs?: number | null;
  /** 提供则流式回调每行而不在 `rows` 中累积（超大文件用）。 */
  onRow?: (row: ParsedRow) => void;
  /** 每读完一块后回调：本次调用累计已读取的字节数（用于进度显示）。 */
  onProgress?: (bytesReadSoFar: number) => void;
}

export interface ParseRangeResult {
  rows: ParsedRow[];
  /** 已消费到的偏移 = 区间内最后一个换行符之后。下次从这里续读。 */
  consumedUntilOffset: number;
  /** 打开时的文件大小。 */
  fileSize: number;
  /** 本次区间内第一个带合法顶层 `timestamp` 的行的时间（epoch ms，任意 type）；没有则 null。 */
  firstTs: number | null;
  /** 区间末尾尚未以换行结束的字节数（半行，未消费）。 */
  pendingBytes: number;
  /** 本区间内的 AI 活跃区间（扁平 [s0,e0,s1,e1,…]，毫秒；已就地合并相接的区间）。 */
  activity: number[];
  /** 本区间末尾最后一个事件的时间戳（供下次续读）；区间内没有事件则沿用传入的 prevEventTs。 */
  lastEventTs: number | null;
  /** 本区间内第一条真人消息的前 ≤ 40 字（子代理行除外）；没有则 null。 */
  title: string | null;
  /** 解析层计数（dedupe 层字段为 0）。`filesParsed` 仅在 startOffset===0 时为 1。 */
  stats: ParseStats;
}

// ---------------------------------------------------------------------------
// 字段提取辅助
// ---------------------------------------------------------------------------

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

function hasNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function str(v: unknown, max = 500): string | undefined {
  if (typeof v !== 'string' || v.length === 0) return undefined;
  return v.length > max ? v.slice(0, max) : v;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseTs(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/**
 * 从已解析的 assistant 行对象提取 ParsedRow。
 * 返回 null 表示该行应被排除（并已在 stats 中计数）。
 */
function extractRow(o: Record<string, unknown>, ts: number | null, offset: number, stats: ParseStats): ParsedRow | null {
  const message = isObj(o.message) ? o.message : undefined;
  const rawModel = message ? str(message.model, 300) : undefined;
  if (rawModel === SYNTHETIC_MODEL) {
    stats.syntheticExcluded++;
    return null;
  }
  if (ts === null) {
    stats.missingTimestamp++;
    return null;
  }

  const messageId = message ? str(message.id, 200) : undefined;
  const requestId = str(o.requestId, 200);
  if (!messageId && !requestId) stats.missingId++;

  const usage = message && isObj(message.usage) ? message.usage : undefined;
  let input = 0;
  let cacheWrite = 0;
  let cacheWrite5m = 0;
  let cacheWrite1h = 0;
  let cacheRead = 0;
  let output = 0;
  let thinking = 0;
  let webSearch = 0;
  let webFetch = 0;
  let serviceTier: string | undefined;
  let speed: string | undefined;

  if (!usage) {
    stats.missingUsage++;
  } else {
    input = num(usage.input_tokens);
    cacheRead = num(usage.cache_read_input_tokens);
    output = num(usage.output_tokens);
    const cc = isObj(usage.cache_creation) ? usage.cache_creation : undefined;
    if (cc) {
      cacheWrite5m = num(cc.ephemeral_5m_input_tokens);
      cacheWrite1h = num(cc.ephemeral_1h_input_tokens);
    } else {
      stats.missingCacheBreakdown++;
    }
    cacheWrite = hasNum(usage.cache_creation_input_tokens)
      ? num(usage.cache_creation_input_tokens)
      : cacheWrite5m + cacheWrite1h;
    const det = isObj(usage.output_tokens_details) ? usage.output_tokens_details : undefined;
    if (det && hasNum(det.thinking_tokens)) {
      thinking = num(det.thinking_tokens);
    } else {
      stats.missingThinking++;
    }
    const stu = isObj(usage.server_tool_use) ? usage.server_tool_use : undefined;
    if (stu) {
      webSearch = num(stu.web_search_requests);
      webFetch = num(stu.web_fetch_requests);
    }
    serviceTier = str(usage.service_tier, 64);
    speed = str(usage.speed, 64);
  }

  const tools: Array<{ id?: string; name: string }> = [];
  if (message && Array.isArray(message.content)) {
    for (const block of message.content) {
      // 只看 type / id / name，绝不读取 block.input 等其它字段
      if (isObj(block) && block.type === 'tool_use') {
        const name = str(block.name, 200);
        if (name) tools.push({ id: str(block.id, 200), name });
      }
    }
  }

  return {
    offset,
    messageId,
    requestId,
    ts,
    model: rawModel ?? 'unknown',
    sessionId: str(o.sessionId, 200),
    cwd: str(o.cwd, 1000),
    isSidechain: typeof o.isSidechain === 'boolean' ? o.isSidechain : undefined,
    agentId: str(o.agentId, 200),
    input,
    cacheWrite,
    cacheWrite5m,
    cacheWrite1h,
    cacheRead,
    output,
    thinking,
    webSearch,
    webFetch,
    serviceTier,
    speed,
    effort: str(o.effort, 64),
    entrypoint: str(o.entrypoint, 64),
    gitBranch: str(o.gitBranch, 300),
    version: str(o.version, 64),
    stopReason: message ? str(message.stop_reason, 64) : undefined,
    tools,
  };
}

// ---------------------------------------------------------------------------
// 区间解析
// ---------------------------------------------------------------------------

export async function parseFileRange(filePath: string, options: ParseRangeOptions = {}): Promise<ParseRangeResult> {
  const fs = options.fs ?? safeFs;
  const chunkSize = Math.max(1, options.chunkSize ?? 1024 * 1024);
  const start = options.startOffset ?? 0;
  const stats = emptyParseStats();
  const rows: ParsedRow[] = [];
  const emit = options.onRow ?? ((r: ParsedRow) => void rows.push(r));
  let firstTs: number | null = null;
  const activity: number[] = [];
  let prevEvent: number | null = options.prevEventTs ?? null;
  let title: string | null = null;

  const handle = await fs.openRead(filePath);
  try {
    const size = handle.size;
    const end = Math.min(options.endOffset ?? size, size);
    if (start === 0) {
      stats.filesParsed = 1;
      if (size === 0) stats.emptyFiles = 1;
    }
    if (start < 0 || start > end) {
      // 起点超过终点：没有可读内容（例如文件被截断，调用方应改为从 0 重解析）。
      return { rows, consumedUntilOffset: Math.min(Math.max(start, 0), end), fileSize: size, firstTs, pendingBytes: 0, activity: [], lastEventTs: options.prevEventTs ?? null, title: null, stats };
    }

    let first = start === 0; // 是否是文件的第一行（处理 BOM）

    const handleLine = (buf: Buffer, from: number, to: number, lineOffset: number): void => {
      // 去掉行尾 \r
      if (to > from && buf[to - 1] === 0x0d) to--;
      if (to <= from) return; // 空行：忽略，不计入 linesRead
      let text = buf.toString('utf8', from, to);
      if (first) {
        first = false;
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      }
      if (text.trim().length === 0) return;
      stats.linesRead++;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        stats.corruptLines++;
        return;
      }
      if (!isObj(parsed)) {
        stats.typeCounts['(none)'] = (stats.typeCounts['(none)'] ?? 0) + 1;
        return;
      }
      const type = typeof parsed.type === 'string' && parsed.type.length > 0 ? parsed.type : '(none)';
      // typeCounts 用 null 原型语义：避免 '__proto__' 之类的 type 名污染
      addCount(stats.typeCounts, type);
      const ts = parseTs(parsed.timestamp);
      if (firstTs === null && ts !== null) firstTs = ts;
      // AI 活跃区间：assistant 行 / tool_result 型 user 行 = AI 事件；其它 user 行 = 真人事件（只看 content[0].type）
      if (ts !== null && (type === 'assistant' || type === 'user')) {
        let ai = type === 'assistant';
        if (!ai) {
          const msg = isObj(parsed.message) ? parsed.message : undefined;
          const c = msg ? msg.content : undefined;
          const first: unknown = Array.isArray(c) ? c[0] : undefined;
          ai = isObj(first) && first.type === 'tool_result';
          if (!ai && title === null) title = titleFromUserRow(parsed);
        }
        if (ai && prevEvent !== null) {
          const gap = ts - prevEvent;
          if (gap >= 0 && gap <= ACTIVE_GAP_MS) appendInterval(activity, prevEvent, ts);
        }
        prevEvent = ts;
      }
      if (type !== 'assistant') return;
      stats.assistantRows++;
      const row = extractRow(parsed, ts, lineOffset, stats);
      if (row) emit(row);
    };

    let pos = start; // 下一次要读取的偏移
    let carry: Buffer[] = []; // 尚未遇到换行的前缀
    let carryLen = 0;
    let carryStart = start; // 当前未完成行的首字节偏移 = 已消费到的偏移

    while (pos < end) {
      const buf = await handle.read(pos, Math.min(chunkSize, end - pos));
      if (buf.length === 0) break; // 文件在读取中被截断
      const bufStart = pos;
      pos += buf.length;
      options.onProgress?.(pos - start);

      let lineStart = 0;
      let nl: number;
      while ((nl = buf.indexOf(LF, lineStart)) !== -1) {
        if (carryLen > 0) {
          carry.push(buf.subarray(lineStart, nl));
          const whole = Buffer.concat(carry);
          handleLine(whole, 0, whole.length, carryStart);
          carry = [];
          carryLen = 0;
        } else {
          handleLine(buf, lineStart, nl, bufStart + lineStart);
        }
        lineStart = nl + 1;
        carryStart = bufStart + lineStart;
      }
      if (lineStart < buf.length) {
        // 保留引用而不是拷贝：buf 是本次独立分配的，不会被复用
        carry.push(buf.subarray(lineStart));
        carryLen += buf.length - lineStart;
      }
    }

    return {
      rows,
      consumedUntilOffset: carryStart,
      fileSize: size,
      firstTs,
      pendingBytes: carryLen,
      activity,
      lastEventTs: prevEvent,
      title,
      stats,
    };
  } finally {
    await handle.close();
  }
}

function addCount(map: Record<string, number>, key: string, n = 1): void {
  if (key === '__proto__') key = '(__proto__)';
  if (key.length > 100) key = key.slice(0, 100);
  map[key] = (Object.hasOwn(map, key) ? (map[key] as number) : 0) + n;
}

/** 便捷封装：整文件一次读完（到当前大小）。 */
export async function parseWholeFile(filePath: string, options: Omit<ParseRangeOptions, 'startOffset'> = {}): Promise<ParseRangeResult> {
  return parseFileRange(filePath, { ...options, startOffset: 0 });
}

/** 把 add 的计数累加到 target（含 typeCounts）。 */
export function addParseStats(target: ParseStats, add: ParseStats): void {
  for (const k of Object.keys(target) as Array<keyof ParseStats>) {
    if (k === 'typeCounts') continue;
    (target[k] as number) += add[k] as number;
  }
  for (const [t, n] of Object.entries(add.typeCounts)) addCount(target.typeCounts, t, n);
}

/**
 * 前后端共用类型。仅使用可擦除的 TS 语法（无 enum / namespace / 参数属性），
 * 以便 Node 原生 type-stripping 直接运行。
 */

/** 去重后的一条助手消息（一次 API 调用）的用量与元数据。不含任何对话正文。 */
export interface UsageRecord {
  /** `message.id`；无 id 时退回 `requestId`；两者皆无则为 `noid:<文件>:<字节偏移>` 的确定性占位。 */
  messageId: string;
  requestId?: string;
  /** 毫秒时间戳（UTC epoch ms）。重复行取最早一条。 */
  ts: number;
  /** 原始模型名（路径型 / org/name 型原样保留；缺失记为 "unknown"）。归一化在阶段 2。 */
  model: string;
  sessionId: string;
  /** 数据根下一级文件夹名（有损编码，只作分组键，不用来还原路径）。 */
  projectKey: string;
  cwd?: string;
  isSidechain: boolean;
  agentId?: string;
  /** `input_tokens` */
  input: number;
  /** `cache_creation_input_tokens`（总写入；缺失时回退为 5m + 1h 细分之和） */
  cacheWrite: number;
  /** `cache_creation.ephemeral_5m_input_tokens`，缺失为 0 */
  cacheWrite5m: number;
  /** `cache_creation.ephemeral_1h_input_tokens`，缺失为 0 */
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
  /** `output_tokens_details.thinking_tokens`（包含在 output 内），缺失为 0 */
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
  /** 工具名 → 调用次数（仅 name；按 tool_use block id 去重）。 */
  tools: Record<string, number>;
  /**
   * 所有权文件：该 message 归属的 .jsonl，相对数据根、统一使用 `/` 分隔。
   * （session / project / cwd 均取自该文件内的那次出现。）
   */
  sourceFile: string;
}

/** 解析 + 去重的统计。所有计数都可跨增量累计（阶段 3）。 */
export interface ParseStats {
  /** 已解析的文件数（含空文件） */
  filesParsed: number;
  /** 读取的总行数（含非 assistant、损坏行） */
  linesRead: number;
  /** `type === "assistant"` 的行数（含 synthetic、缺 id 行） */
  assistantRows: number;
  /** 去重后的唯一消息数 = 最终 UsageRecord 数（缺 id 行各自算一条） */
  uniqueMessages: number;
  /** 被合并掉的重复行数（同文件内 + 跨文件） */
  duplicatesDropped: number;
  /** 出现在 2 个及以上不同文件中的唯一 message 数 */
  crossFileDuplicates: number;
  /** `<synthetic>` 模型的行数（完全排除，不进入 UsageRecord） */
  syntheticExcluded: number;
  /** 无法 JSON.parse 的行数（不含末尾无换行的半行，那是"待续读"） */
  corruptLines: number;
  /** 大小为 0 的文件数 */
  emptyFiles: number;
  /** message.id 与 requestId 皆缺的 assistant 行数（不去重） */
  missingId: number;
  /** 各 `type` 的行数（assistant 以外的也计入；无 type 记为 "(none)"） */
  typeCounts: Record<string, number>;
  /** 无法确定时间戳（缺失/非法）而被排除的 assistant 行数 */
  missingTimestamp: number;
  /** 行级（去重前）计数：assistant 行缺 `message.usage` 整体 */
  missingUsage: number;
  /** 行级（去重前）计数：有 usage 但缺 `cache_creation` 5m/1h 细分 */
  missingCacheBreakdown: number;
  /** 行级（去重前）计数：有 usage 但缺 `thinking_tokens` */
  missingThinking: number;
}

export function emptyParseStats(): ParseStats {
  return {
    filesParsed: 0,
    linesRead: 0,
    assistantRows: 0,
    uniqueMessages: 0,
    duplicatesDropped: 0,
    crossFileDuplicates: 0,
    syntheticExcluded: 0,
    corruptLines: 0,
    emptyFiles: 0,
    missingId: 0,
    typeCounts: {},
    missingTimestamp: 0,
    missingUsage: 0,
    missingCacheBreakdown: 0,
    missingThinking: 0,
  };
}

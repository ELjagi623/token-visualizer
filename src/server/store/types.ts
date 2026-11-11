import type { ParseStats, UsageRecord } from '../../shared/types.ts';
import type { FileActivity } from '../core/activity.ts';
import type { ParsedRow } from '../core/parser.ts';

/** 单个 .jsonl 文件的解析状态（缓存中按文件保存；全局视图由它们重新去重得出）。状态对象视为不可变：更新时整体替换。 */
export interface FileState {
  /** 相对数据根、`/` 分隔 */
  relPath: string;
  projectKey: string;
  isSubagentFile: boolean;
  defaultSessionId: string;
  agentIdFromName?: string;
  /** 上次扫描时观察到的文件大小 / mtime（用于"未变化则完全跳过"） */
  size: number;
  mtimeMs: number;
  /** 已消费到的偏移（最后一个换行符之后）；半行留待下次 */
  offset: number;
  /** 文件头部 headLen 字节（≤ 4096）的 sha1 */
  headLen: number;
  headHash: string;
  /** 已消费区域末尾 tailLen 字节（≤ 4096）的 sha1，用于发现"前面的内容被改写" */
  tailLen: number;
  tailHash: string;
  /** 首个带顶层 timestamp 的行的时间（取自 offset 0 的那次解析；增量只在仍为 null 时补） */
  firstTs: number | null;
  /** 解析层计数（只累计已消费的字节区间，所以重复扫描不会重复计数） */
  stats: ParseStats;
  /** 该文件内按行序排列的 assistant 行（去重前） */
  rows: ParsedRow[];
  /** 首条真人消息的前 ≤ 40 字（仅主会话文件；原文不保存）；没有为 null。 */
  title: string | null;
  /** AI 活跃区间（扁平 [s0,e0,…]，毫秒）；见 core/activity.ts。 */
  activity: number[];
  /** 最后一个事件（assistant / user 行）的时间戳，供增量续读计算跨读取边界的间隔。 */
  lastEventTs: number | null;
}

/** custom-title.json 的状态：只保留 ≤ 40 字符的标题。 */
export interface TitleFileState {
  /** 相对数据根的路径 */
  relPath: string;
  sessionId: string;
  size: number;
  mtimeMs: number;
  title: string | null;
}

export type ScanStateName = 'idle' | 'scanning' | 'error';

export interface Progress {
  state: ScanStateName;
  phase: 'full' | 'incremental';
  filesDone: number;
  filesTotal: number;
  bytesDone: number;
  bytesTotal: number;
  /** 本次扫描开始时间（epoch ms）；从未扫描为 null */
  startedAt: number | null;
  /** 最近一次成功完成扫描的时间（epoch ms）；从未成功为 null */
  lastScanAt: number | null;
  /** state=error 时的中文可读原因 */
  lastError?: string;
}

/** 对外的只读视图（全局去重后的结果）。 */
export interface StoreView {
  /** 单调递增；视图每发布一次 +1 */
  dataVersion: number;
  records: UsageRecord[];
  stats: ParseStats;
  /** 数据根下含 .jsonl 的全部文件夹（含只有空文件的），用作 buildProjectIndex 的 folderKeys */
  folderKeys: string[];
  /** 会话 id → custom-title.json 标题（≤ 40 字符） */
  titles: Map<string, string>;
  /** 会话 id → 首条真人消息前 ≤ 40 字（无 custom-title 时的回退；仅本机显示，不得进入导出） */
  autoTitles: Map<string, string>;
  /** 各文件的 AI 活跃区间（供 AI 运行时长聚合） */
  activity: FileActivity[];
  /** 最新一条记录的时间戳；无记录为 null */
  lastRecordTs: number | null;
}

export interface StoreStatus extends Progress {
  dataVersion: number;
  lastRecordTs: number | null;
  /** 非致命问题（如个别文件读取失败），最多保留 20 条 */
  warnings: string[];
}

export interface StoreMetrics {
  /** 已执行的扫描次数（单飞合并后的实际次数） */
  scans: number;
  /** 整文件（从 offset 0）解析的次数 */
  fullParses: number;
  /** 从偏移续读的次数 */
  incrementalParses: number;
  /** 缓存加载结果：loaded / missing / discarded:<原因> / none（未尝试） */
  cacheLoad: string;
  cacheSaves: number;
  cacheBytes: number;
}

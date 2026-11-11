/**
 * 扫描器：单个文件的"全量 / 增量"解析，以及 custom-title.json 的读取。
 *
 * 决策（对一个已有状态 prev 的文件）：
 *   - size 与 mtime 都没变           → 由调用方直接跳过（不读任何字节）
 *   - size 增长且 offset > 0         → 校验"已消费区域"的头 / 尾哈希，没变 → 从 offset 续读；变了 → 整文件重解析
 *   - size 缩小 / 等长但 mtime 变了   → 整文件重解析（旧贡献由新状态整体替换而撤销）
 *   - offset == 0（空文件 / 只有半行） → 整文件重解析
 *
 * 状态对象不可变：返回新的 FileState，旧对象不被修改（便于缓存 / 视图重算在后台读取旧快照）。
 */
import crypto from 'node:crypto';
import path from 'node:path';
import type { ParseStats } from '../../shared/types.ts';
import { concatIntervals } from '../core/activity.ts';
import { addParseStats, parseFileRange } from '../core/parser.ts';
import { cleanTitle, MAX_TITLE_CHARS } from '../core/title.ts';
import type { UsageFileInfo } from '../core/loadRoot.ts';
import { safeFs } from '../core/safeFs.ts';
import type { SafeFs } from '../core/safeFs.ts';
import type { FileState, TitleFileState } from './types.ts';

export const HASH_BYTES = 4096;
export { cleanTitle, MAX_TITLE_CHARS };

function sha1(buf: Buffer): string {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

interface Hashes {
  headLen: number;
  headHash: string;
  tailLen: number;
  tailHash: string;
}

/** 读取 [0, headLen) 与 [offset - tailLen, offset) 并取哈希（一次 open）。 */
async function readHashes(fs: SafeFs, abs: string, headLen: number, offset: number, reuseHead?: { len: number; hash: string }): Promise<Hashes> {
  const tailLen = Math.min(HASH_BYTES, offset);
  if (headLen === 0 || tailLen === 0) return { headLen: 0, headHash: '', tailLen: 0, tailHash: '' };
  const h = await fs.openRead(abs);
  try {
    let headHash: string;
    if (reuseHead && reuseHead.len === headLen) headHash = reuseHead.hash;
    else headHash = sha1(await h.read(0, headLen));
    const tailHash = sha1(await h.read(offset - tailLen, tailLen));
    return { headLen, headHash, tailLen, tailHash };
  } finally {
    await h.close();
  }
}

/** 已消费区域的头 / 尾是否仍与记录一致（文件被改写 / 替换时为 false）。 */
async function verifyPrefix(fs: SafeFs, abs: string, prev: FileState): Promise<boolean> {
  const h = await fs.openRead(abs);
  try {
    if (h.size < prev.offset) return false;
    const head = await h.read(0, prev.headLen);
    if (head.length !== prev.headLen || sha1(head) !== prev.headHash) return false;
    const tail = await h.read(prev.offset - prev.tailLen, prev.tailLen);
    return tail.length === prev.tailLen && sha1(tail) === prev.tailHash;
  } finally {
    await h.close();
  }
}

export interface ProcessHooks {
  /** 本次处理新读取的字节增量 */
  onBytes?: (delta: number) => void;
  chunkSize?: number;
}

export interface ProcessResult {
  state: FileState;
  kind: 'full' | 'incremental';
  /** 是否改变了对外视图（续读只读到半行 / 空行时为 false：状态要更新，但视图与 dataVersion 不变） */
  viewChanged: boolean;
}

/** 需要读取的字节数估计（用于进度总量）。 */
export function estimateBytes(info: UsageFileInfo, prev: FileState | undefined): number {
  if (prev && prev.offset > 0 && info.size > prev.size) return info.size - prev.offset;
  return info.size;
}

export async function processFile(fs: SafeFs, info: UsageFileInfo, prev: FileState | undefined, hooks: ProcessHooks = {}): Promise<ProcessResult> {
  let incremental = false;
  if (prev && prev.offset > 0 && info.size > prev.size) incremental = await verifyPrefix(fs, info.absPath, prev);

  let last = 0;
  const onProgress = (n: number): void => {
    hooks.onBytes?.(n - last);
    last = n;
  };

  if (incremental && prev) {
    const res = await parseFileRange(info.absPath, { fs, startOffset: prev.offset, endOffset: info.size, chunkSize: hooks.chunkSize, onProgress, prevEventTs: prev.lastEventTs });
    const stats: ParseStats = structuredClone(prev.stats);
    addParseStats(stats, res.stats);
    const offset = res.consumedUntilOffset;
    // 没有消费新字节（只读到半行）：哈希窗口不变，不必再读
    const hashes: Hashes =
      offset === prev.offset
        ? { headLen: prev.headLen, headHash: prev.headHash, tailLen: prev.tailLen, tailHash: prev.tailHash }
        : await readHashes(fs, info.absPath, Math.min(HASH_BYTES, offset), offset, { len: prev.headLen, hash: prev.headHash });
    return {
      kind: 'incremental',
      viewChanged: res.rows.length > 0 || res.stats.linesRead > 0,
      state: {
        ...base(info),
        offset,
        ...hashes,
        firstTs: prev.firstTs ?? res.firstTs,
        stats,
        rows: res.rows.length > 0 ? prev.rows.concat(res.rows) : prev.rows,
        title: prev.title ?? (info.isSubagentFile ? null : res.title),
        activity: res.activity.length > 0 ? concatIntervals(prev.activity, res.activity) : prev.activity,
        lastEventTs: res.lastEventTs,
      },
    };
  }

  const res = await parseFileRange(info.absPath, { fs, startOffset: 0, endOffset: info.size, chunkSize: hooks.chunkSize, onProgress });
  const offset = res.consumedUntilOffset;
  const hashes = await readHashes(fs, info.absPath, Math.min(HASH_BYTES, offset), offset);
  return {
    kind: 'full',
    viewChanged: true,
    state: { ...base(info), offset, ...hashes, firstTs: res.firstTs, stats: res.stats, rows: res.rows, title: info.isSubagentFile ? null : res.title, activity: res.activity, lastEventTs: res.lastEventTs },
  };
}

function base(info: UsageFileInfo): Pick<FileState, 'relPath' | 'projectKey' | 'isSubagentFile' | 'defaultSessionId' | 'agentIdFromName' | 'size' | 'mtimeMs'> {
  const b: Pick<FileState, 'relPath' | 'projectKey' | 'isSubagentFile' | 'defaultSessionId' | 'agentIdFromName' | 'size' | 'mtimeMs'> = {
    relPath: info.relPath,
    projectKey: info.projectKey,
    isSubagentFile: info.isSubagentFile,
    defaultSessionId: info.defaultSessionId,
    size: info.size,
    mtimeMs: info.mtimeMs,
  };
  if (info.agentIdFromName !== undefined) b.agentIdFromName = info.agentIdFromName;
  return b;
}

// ---------------------------------------------------------------------------
// custom-title.json
// ---------------------------------------------------------------------------

export interface TitleFileInfo {
  absPath: string;
  relPath: string;
  sessionId: string;
  size: number;
  mtimeMs: number;
}

/** 枚举 `<项目>/<会话>/custom-title.json`。 */
export async function listTitleFiles(root: string, fs: SafeFs = safeFs): Promise<TitleFileInfo[]> {
  const out: TitleFileInfo[] = [];
  const projects = (await fs.readdir(root)).filter((e) => e.isDirectory).sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const proj of projects) {
    const projDir = path.join(root, proj.name);
    let entries;
    try {
      entries = await fs.readdir(projDir);
    } catch {
      continue;
    }
    for (const e of entries.filter((x) => x.isDirectory).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const abs = path.join(projDir, e.name, 'custom-title.json');
      try {
        const st = await fs.stat(abs);
        if (st.isFile) out.push({ absPath: abs, relPath: `${proj.name}/${e.name}/custom-title.json`, sessionId: e.name, size: st.size, mtimeMs: st.mtimeMs });
      } catch {
        // 没有该文件
      }
    }
  }
  return out;
}

/** 读取 custom-title.json 并只取 customTitle 字段（≤ 40 字符）。文件损坏 / 过大 → null。 */
export async function readTitle(fs: SafeFs, info: TitleFileInfo): Promise<TitleFileState> {
  let title: string | null = null;
  if (info.size > 0 && info.size <= 64 * 1024) {
    const h = await fs.openRead(info.absPath);
    try {
      const buf = await h.read(0, info.size);
      try {
        const o = JSON.parse(buf.toString('utf8')) as unknown;
        if (typeof o === 'object' && o !== null) title = cleanTitle((o as Record<string, unknown>).customTitle);
      } catch {
        title = null;
      }
    } finally {
      await h.close();
    }
  }
  return { relPath: info.relPath, sessionId: info.sessionId, size: info.size, mtimeMs: info.mtimeMs, title };
}

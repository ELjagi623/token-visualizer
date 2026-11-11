/**
 * 数据根枚举 + 解析 + 全局去重的最小编排（阶段 1 的"最小入口"；阶段 3 的扫描器会复用枚举与单文件解析）。
 *
 * 文件白名单：只枚举
 *   - `<项目文件夹>/<sessionId>.jsonl`
 *   - `<项目文件夹>/<sessionId>/subagents/*.jsonl`
 * 其它一切（`*.meta.json`、`*.prefix.json`、`tool-results/`、`custom-title.json`、`memory/` …）都不当作用量数据。
 */
import path from 'node:path';
import type { ParseStats, UsageRecord } from '../../shared/types.ts';
import { emptyParseStats } from '../../shared/types.ts';
import { applyDedupeStats, dedupeGlobal } from './dedupe.ts';
import type { DedupeFileInput } from './dedupe.ts';
import { addParseStats, parseFileRange } from './parser.ts';
import { safeFs } from './safeFs.ts';
import type { SafeFs } from './safeFs.ts';

export interface UsageFileInfo {
  absPath: string;
  /** 相对数据根，使用 `/` 分隔。 */
  relPath: string;
  projectKey: string;
  isSubagentFile: boolean;
  defaultSessionId: string;
  agentIdFromName?: string;
  /** 枚举时的文件大小（字节）。 */
  size: number;
  /** 枚举时的修改时间（毫秒）。 */
  mtimeMs: number;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const JSONL = /\.jsonl$/i;

/** 枚举数据根下所有用量 `.jsonl`（确定性排序）。根目录不可读则抛出原生错误，由调用方转为中文提示。 */
export async function listUsageFiles(root: string, fs: SafeFs = safeFs): Promise<UsageFileInfo[]> {
  const out: UsageFileInfo[] = [];
  const projects = (await fs.readdir(root)).filter((e) => e.isDirectory).sort((a, b) => cmp(a.name, b.name));
  for (const proj of projects) {
    const projDir = path.join(root, proj.name);
    let entries;
    try {
      entries = await fs.readdir(projDir);
    } catch {
      continue; // 单个项目目录不可读：跳过，不影响其它项目
    }
    entries.sort((a, b) => cmp(a.name, b.name));
    for (const e of entries) {
      if (e.isFile && JSONL.test(e.name)) {
        const abs = path.join(projDir, e.name);
        const st = await safeStatOrNull(fs, abs);
        if (!st) continue;
        out.push({
          absPath: abs,
          relPath: `${proj.name}/${e.name}`,
          projectKey: proj.name,
          isSubagentFile: false,
          defaultSessionId: e.name.replace(JSONL, ''),
          size: st.size,
          mtimeMs: st.mtimeMs,
        });
      } else if (e.isDirectory) {
        const subDir = path.join(projDir, e.name, 'subagents');
        let subs;
        try {
          subs = await fs.readdir(subDir);
        } catch {
          continue; // 没有 subagents 目录
        }
        subs.sort((a, b) => cmp(a.name, b.name));
        for (const s of subs) {
          if (!s.isFile || !JSONL.test(s.name)) continue;
          const abs = path.join(subDir, s.name);
          const st = await safeStatOrNull(fs, abs);
          if (!st) continue;
          const base = s.name.replace(JSONL, '');
          const m = /^agent-(.+)$/.exec(base);
          out.push({
            absPath: abs,
            relPath: `${proj.name}/${e.name}/subagents/${s.name}`,
            projectKey: proj.name,
            isSubagentFile: true,
            defaultSessionId: e.name,
            agentIdFromName: m ? m[1] : undefined,
            size: st.size,
            mtimeMs: st.mtimeMs,
          });
        }
      }
    }
  }
  return out;
}

async function safeStatOrNull(fs: SafeFs, p: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    return await fs.stat(p);
  } catch {
    return null; // 枚举与 stat 之间文件消失
  }
}

export interface ParseRootOptions {
  fs?: SafeFs;
  /**
   * 每个文件只读到的字节数上限（相对路径 → 大小），且**只解析其中列出的文件**。用于"快照"：真实目录持续增长时，
   * 两套实现都只读到同一快照。缺省为各文件当前大小。
   */
  limits?: Map<string, number>;
  chunkSize?: number;
}

export interface ParsedFile {
  info: UsageFileInfo;
  firstTs: number | null;
  consumedUntilOffset: number;
  pendingBytes: number;
}

export interface ParseRootResult {
  records: UsageRecord[];
  stats: ParseStats;
  files: ParsedFile[];
}

/** 解析整个数据根并做全局去重。 */
export async function parseDataRoot(root: string, options: ParseRootOptions = {}): Promise<ParseRootResult> {
  const fs = options.fs ?? safeFs;
  let infos = await listUsageFiles(root, fs);
  // 给了 limits（快照）就只解析快照里的文件：枚举之后才出现的新文件一律忽略
  if (options.limits) infos = infos.filter((i) => options.limits!.has(i.relPath));
  const stats = emptyParseStats();
  const inputs: DedupeFileInput[] = [];
  const files: ParsedFile[] = [];

  for (const info of infos) {
    const limit = options.limits?.get(info.relPath) ?? info.size; // 默认读到枚举时的大小（快照语义）
    const res = await parseFileRange(info.absPath, { fs, endOffset: limit, chunkSize: options.chunkSize });
    addParseStats(stats, res.stats);
    inputs.push({
      path: info.relPath,
      projectKey: info.projectKey,
      firstTs: res.firstTs,
      defaultSessionId: info.defaultSessionId,
      isSubagentFile: info.isSubagentFile,
      agentIdFromName: info.agentIdFromName,
      rows: res.rows,
    });
    files.push({ info, firstTs: res.firstTs, consumedUntilOffset: res.consumedUntilOffset, pendingBytes: res.pendingBytes });
  }

  const d = dedupeGlobal(inputs);
  applyDedupeStats(stats, d.stats);
  return { records: d.records, stats, files };
}

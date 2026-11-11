/**
 * 所有文件系统访问的唯一入口。
 *
 * - 读：`createSafeFs()` 只暴露 open/read/stat/readdir 类只读接口；
 *   打开文件内容时强制文件名白名单（`*.jsonl`、`custom-title.json`），
 *   因此 `.credentials.json`、`*.meta.json`、`*.prefix.json` 等永远读不到。
 * - 写：`createAppDataWriter()` 只允许写入"应用数据目录"，且写入前断言目标路径
 *   既在应用数据目录内、又不在任何受保护目录（数据根、`~/.claude`）内。
 *
 * 业务代码不得直接 import `node:fs` 去读写数据根；请经由本模块。
 */
import { promises as fsp, realpathSync, watch as fsWatch } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** 违反只读 / 白名单 / 写入范围规则时抛出。 */
export class SafeFsViolation extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'SafeFsViolation';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// 路径工具
// ---------------------------------------------------------------------------

/** 解析符号链接 / junction：对最深的已存在祖先取 realpath，再拼回不存在的尾部。 */
export function resolveReal(p: string): string {
  const abs = path.resolve(p);
  const tail: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      const real = realpathSync.native(cur);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs; // 到根了仍不存在
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

/** child 是否等于 parent 或位于 parent 之内（Windows 下大小写不敏感，由 path.relative 保证）。 */
export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  if (rel === '') return true;
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Claude Code 自己的配置目录，永远受保护（只读）。 */
export function claudeHomeDir(): string {
  return path.join(os.homedir(), '.claude');
}

// ---------------------------------------------------------------------------
// 只读接口
// ---------------------------------------------------------------------------

export interface ReadHandle {
  /** 打开时的文件大小（字节）。 */
  readonly size: number;
  /** 从 position 读取最多 length 字节；返回实际读到的内容（可能更短）。 */
  read(position: number, length: number): Promise<Buffer>;
  close(): Promise<void>;
}

export interface StatResult {
  size: number;
  mtimeMs: number;
  isFile: boolean;
  isDirectory: boolean;
}

export interface DirEntry {
  name: string;
  /** 注意：符号链接既不算 isFile 也不算 isDirectory（不跟随）。 */
  isFile: boolean;
  isDirectory: boolean;
}

export interface SafeFs {
  openRead(filePath: string): Promise<ReadHandle>;
  stat(p: string): Promise<StatResult>;
  readdir(dir: string): Promise<DirEntry[]>;
  /** 累计从文件内容读取的字节数（测试用，断言"只读新增字节"）。 */
  readonly bytesRead: number;
  /** 累计 openRead 次数（测试用，断言"未重新解析任何文件"）。 */
  readonly opens: number;
}

/** 可读取内容的文件名白名单。 */
export function isReadableDataFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith('.jsonl') || lower === 'custom-title.json';
}

export interface SafeFsOptions {
  /** 每次实际读取后回调（路径、字节数）。 */
  onRead?: (filePath: string, bytes: number) => void;
}

export function createSafeFs(options: SafeFsOptions = {}): SafeFs {
  let bytesRead = 0;
  let opens = 0;
  return {
    get bytesRead() {
      return bytesRead;
    },
    get opens() {
      return opens;
    },
    async openRead(filePath: string): Promise<ReadHandle> {
      const base = path.basename(filePath);
      if (!isReadableDataFileName(base)) {
        throw new SafeFsViolation('NOT_WHITELISTED', `拒绝读取非白名单文件：${base}`);
      }
      const fh: FileHandle = await fsp.open(filePath, 'r'); // 只读标志
      opens++;
      let size: number;
      try {
        size = (await fh.stat()).size;
      } catch (e) {
        await fh.close();
        throw e;
      }
      return {
        size,
        async read(position: number, length: number): Promise<Buffer> {
          if (length <= 0) return Buffer.alloc(0);
          const buf = Buffer.allocUnsafe(length);
          let filled = 0;
          while (filled < length) {
            const { bytesRead: n } = await fh.read(buf, filled, length - filled, position + filled);
            if (n === 0) break;
            filled += n;
          }
          bytesRead += filled;
          options.onRead?.(filePath, filled);
          return filled === length ? buf : buf.subarray(0, filled);
        },
        close: () => fh.close(),
      };
    },
    async stat(p: string): Promise<StatResult> {
      const s = await fsp.stat(p);
      return { size: s.size, mtimeMs: s.mtimeMs, isFile: s.isFile(), isDirectory: s.isDirectory() };
    },
    async readdir(dir: string): Promise<DirEntry[]> {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      return entries.map((e) => ({ name: e.name, isFile: e.isFile(), isDirectory: e.isDirectory() }));
    },
  };
}

/**
 * 监听目录变化（只观察事件，不读任何内容；用于"文件变化触发刷新"）。
 * 返回取消函数；平台不支持递归监听 / 出错时静默返回空操作。
 * （刻意不放进 SafeFs 对象：SafeFs 只暴露 openRead / stat / readdir。）
 */
export function watchDirectory(dir: string, onEvent: () => void): () => void {
  try {
    const w = fsWatch(dir, { recursive: true, persistent: false }, () => onEvent());
    w.on('error', () => w.close());
    return () => w.close();
  } catch {
    return () => {};
  }
}

/** 进程级默认只读实例。 */
export const safeFs: SafeFs = createSafeFs();

// ---------------------------------------------------------------------------
// 应用数据目录写接口
// ---------------------------------------------------------------------------

export interface AppDataWriterOptions {
  /** 应用数据目录（缓存、设置写这里）。 */
  appDataDir: string;
  /** 当前所有数据根目录（可随设置变化，所以是函数）。`~/.claude` 总是额外受保护。 */
  protectedRoots: () => string[];
}

export interface AppDataWriter {
  readonly appDataDir: string;
  /** 把相对（相对应用数据目录）或绝对路径解析为经校验的绝对路径。 */
  resolve(target: string): string;
  /** 读取应用数据目录内的文件；不存在返回 null。（仅限应用数据目录，用于读自己的缓存 / 设置。） */
  readFile(target: string): Promise<Buffer | null>;
  mkdirp(target?: string): Promise<void>;
  writeFile(target: string, data: string | Uint8Array): Promise<void>;
  /** 先写同目录临时文件再 rename，保证原子。 */
  atomicWriteFile(target: string, data: string | Uint8Array): Promise<void>;
  remove(target: string): Promise<void>;
}

/**
 * 断言 target 可写：必须在 appDataDir 内，且不在任何受保护目录内。
 * 返回规范化后的绝对路径。
 */
export function assertWritable(target: string, appDataDir: string, protectedRoots: string[]): string {
  const abs = path.resolve(appDataDir, target);
  const real = resolveReal(abs);
  const appReal = resolveReal(appDataDir);
  const guards = [...protectedRoots, claudeHomeDir()].filter((r) => r && r.length > 0);
  for (const g of guards) {
    const gReal = resolveReal(g);
    if (isInside(real, gReal) || isInside(abs, path.resolve(g))) {
      throw new SafeFsViolation('WRITE_INSIDE_PROTECTED', `拒绝写入受保护的只读目录：${abs}`);
    }
  }
  if (!isInside(real, appReal)) {
    throw new SafeFsViolation('WRITE_OUTSIDE_APPDATA', `只允许写入应用数据目录，拒绝：${abs}`);
  }
  return abs;
}

export function createAppDataWriter(opts: AppDataWriterOptions): AppDataWriter {
  const check = (t: string): string => assertWritable(t, opts.appDataDir, opts.protectedRoots());
  return {
    appDataDir: opts.appDataDir,
    resolve: check,
    async readFile(target) {
      const abs = check(target);
      try {
        return await fsp.readFile(abs);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw e;
      }
    },
    async mkdirp(target = '.') {
      await fsp.mkdir(check(target), { recursive: true });
    },
    async writeFile(target, data) {
      const abs = check(target);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, data);
    },
    async atomicWriteFile(target, data) {
      const abs = check(target);
      const tmp = `${abs}.${process.pid}.${Date.now()}.tmp`;
      check(tmp);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(tmp, data);
      try {
        await fsp.rename(tmp, abs);
      } catch (e) {
        await fsp.rm(tmp, { force: true });
        throw e;
      }
    },
    async remove(target) {
      await fsp.rm(check(target), { recursive: true, force: true });
    },
  };
}

/**
 * 数据仓库：持有每个文件的解析状态，对外提供"全局去重后的视图"，负责缓存加载 / 保存与扫描调度。
 *
 * 核心不变量（有一致性测试守住）：
 *   视图 = dedupeGlobal(所有文件状态)，与"从零全量解析当前目录"逐项相同。
 *   增量只是让"每个文件的状态"更便宜地更新，去重始终对全部文件的 rows 重新做一遍，
 *   所以跨文件重复 id 出现 / 消失 / 所有权转移时结果自动正确。
 *
 * 并发模型：
 *   - 单飞：同一时刻只有一次扫描在跑；扫描期间的重复触发合并成"之后再跑一次"（rebuild 优先于 refresh）；
 *   - 文件并行解析（默认 4 个）；每个文件的状态在完成时整体替换（不可变），视图在后台分片重算；
 *   - 视图发布与 dataVersion 绑定：每发布一次视图 dataVersion + 1（首次全量期间会陆续发布"部分结果"）。
 */
import { dedupeGlobalAsync } from '../core/dedupe.ts';
import type { DedupeFileInput } from '../core/dedupe.ts';
import { listUsageFiles } from '../core/loadRoot.ts';
import type { UsageFileInfo } from '../core/loadRoot.ts';
import { createAppDataWriter, createSafeFs } from '../core/safeFs.ts';
import type { AppDataWriter, SafeFs } from '../core/safeFs.ts';
import type { FileActivity } from '../core/activity.ts';
import { addParseStats } from '../core/parser.ts';
import { emptyParseStats } from '../../shared/types.ts';
import type { ParseStats } from '../../shared/types.ts';
import { applyDedupeStats } from '../core/dedupe.ts';
import { CACHE_FILE, loadCache, rootIdentity, saveCache } from './cache.ts';
import { estimateBytes, listTitleFiles, processFile, readTitle } from './scanner.ts';
import type { FileState, Progress, StoreMetrics, StoreStatus, StoreView, TitleFileState } from './types.ts';
import { L } from '../i18n.ts';

export interface StoreOptions {
  dataRoot: string;
  appDataDir: string;
  /** 只读文件接口（测试可注入带计数器的实例）。 */
  fs?: SafeFs;
  /** 并行解析的文件数，默认 4。 */
  concurrency?: number;
  chunkSize?: number;
  now?: () => number;
  /** 部分视图重算的最小间隔，默认 500 ms（实际取其与 3 倍上次重算耗时的较大者）。 */
  recomputeMinMs?: number;
  /** 状态事件的节流间隔，默认 100 ms。 */
  statusThrottleMs?: number;
  /** 是否读写缓存，默认 true。 */
  persistCache?: boolean;
}

export type ScanMode = 'refresh' | 'rebuild';

export interface ChangeEvent {
  kind: 'data' | 'status';
  status: StoreStatus;
}

type Listener = (e: ChangeEvent) => void;

const MAX_WARNINGS = 20;

function emptyView(): StoreView {
  return { dataVersion: 0, records: [], stats: emptyParseStats(), folderKeys: [], titles: new Map(), autoTitles: new Map(), activity: [], lastRecordTs: null };
}

export class Store {
  dataRoot: string;
  readonly appDataDir: string;
  readonly metrics: StoreMetrics = { scans: 0, fullParses: 0, incrementalParses: 0, cacheLoad: 'none', cacheSaves: 0, cacheBytes: 0 };

  private readonly fs: SafeFs;
  private readonly writer: AppDataWriter;
  private readonly concurrency: number;
  private readonly chunkSize: number | undefined;
  private readonly now: () => number;
  private readonly recomputeMinMs: number;
  private readonly statusThrottleMs: number;
  private readonly persist: boolean;

  private states = new Map<string, FileState>();
  private titleStates = new Map<string, TitleFileState>();
  private view: StoreView = emptyView();
  private progress: Progress = { state: 'idle', phase: 'full', filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0, startedAt: null, lastScanAt: null };
  private warnings: string[] = [];
  private listeners = new Set<Listener>();
  private closed = false;

  // 视图重算
  private viewDirty = false;
  private publishing: Promise<void> | null = null;
  private publishTimer: NodeJS.Timeout | null = null;
  private lastRecomputeMs = 0;
  // 缓存
  private cacheDirty = false;
  // 状态事件节流
  private statusTimer: NodeJS.Timeout | null = null;
  private statusPending = false;
  private lastStatusEmit = 0;
  // 单飞
  private running = false;
  private pendingMode: ScanMode | null = null;
  private pendingWaiters: Array<() => void> = [];
  private idleWaiters: Array<() => void> = [];
  private switching: Promise<void> | null = null;

  constructor(options: StoreOptions) {
    this.dataRoot = options.dataRoot;
    this.appDataDir = options.appDataDir;
    this.fs = options.fs ?? createSafeFs();
    this.concurrency = Math.max(1, options.concurrency ?? 4);
    this.chunkSize = options.chunkSize;
    this.now = options.now ?? Date.now;
    this.recomputeMinMs = options.recomputeMinMs ?? 500;
    this.statusThrottleMs = options.statusThrottleMs ?? 100;
    this.persist = options.persistCache ?? true;
    this.writer = createAppDataWriter({ appDataDir: options.appDataDir, protectedRoots: () => [this.dataRoot] });
  }

  // ---------------------------------------------------------------------
  // 对外读取
  // ---------------------------------------------------------------------

  /** 当前已发布的视图（首次全量期间是"已解析部分"）。 */
  getView(): StoreView {
    return this.view;
  }

  getStatus(): StoreStatus {
    return { ...this.progress, dataVersion: this.view.dataVersion, lastRecordTs: this.view.lastRecordTs, warnings: [...this.warnings] };
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 等待当前扫描（含排队中的）全部结束。 */
  async idle(): Promise<void> {
    while (this.switching) await this.switching;
    await this.waitScans();
    while (this.switching) await this.switching;
  }

  private async waitScans(): Promise<void> {
    if (!this.running && !this.pendingMode) return;
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  close(): void {
    this.closed = true;
    if (this.publishTimer) clearTimeout(this.publishTimer);
    if (this.statusTimer) clearTimeout(this.statusTimer);
    this.publishTimer = null;
    this.statusTimer = null;
    this.listeners.clear();
  }

  // ---------------------------------------------------------------------
  // 生命周期
  // ---------------------------------------------------------------------

  /** 读取缓存（如有）并发布初始视图，不扫描磁盘。 */
  async init(): Promise<void> {
    this.states.clear();
    this.titleStates.clear();
    if (this.persist) {
      const r = await loadCache(this.writer, this.dataRoot);
      if (r.ok) {
        for (const f of r.snapshot.files) this.states.set(f.relPath, f);
        for (const t of r.snapshot.titleFiles) this.titleStates.set(t.relPath, t);
        this.metrics.cacheLoad = 'loaded';
        this.metrics.cacheBytes = r.bytes;
        this.viewDirty = true;
      } else {
        this.metrics.cacheLoad = r.reason === 'missing' ? 'missing' : `discarded:${r.reason}`;
      }
    }
    await this.flushPublish();
  }

  /** init() + 第一次扫描。 */
  async start(): Promise<void> {
    await this.init();
    await this.refreshNow();
  }

  /** 立即刷新（增量）。单飞：扫描中再次触发会合并成"当前扫描结束后再跑一次"。 */
  refreshNow(): Promise<void> {
    return this.request('refresh');
  }

  /** 丢弃全部状态与缓存，整体重建。 */
  rebuild(): Promise<void> {
    return this.request('rebuild');
  }

  /** 切换数据根：清空状态、尝试读取该根的缓存，然后扫描。 */
  switchDataRoot(root: string): Promise<void> {
    const p = (async () => {
      await this.waitScans();
      this.dataRoot = root;
      this.progress = { ...this.progress, state: 'idle', lastError: undefined, lastScanAt: null };
      await this.init();
      await this.refreshNow();
    })();
    this.switching = p.finally(() => {
      if (this.switching === tracked) this.switching = null;
    });
    const tracked = this.switching;
    return p;
  }

  private request(mode: ScanMode): Promise<void> {
    if (this.closed) return Promise.resolve();
    const p = new Promise<void>((resolve) => this.pendingWaiters.push(resolve));
    this.pendingMode = mode === 'rebuild' || this.pendingMode === 'rebuild' ? 'rebuild' : 'refresh';
    if (!this.running) void this.kick();
    return p;
  }

  private async kick(): Promise<void> {
    this.running = true;
    try {
      while (this.pendingMode) {
        const mode = this.pendingMode;
        const waiters = this.pendingWaiters;
        this.pendingMode = null;
        this.pendingWaiters = [];
        try {
          await this.runScan(mode);
        } catch (e) {
          this.setError(e);
        }
        for (const w of waiters) w();
      }
    } finally {
      this.running = false;
      const ws = this.idleWaiters;
      this.idleWaiters = [];
      for (const w of ws) w();
    }
  }

  // ---------------------------------------------------------------------
  // 扫描
  // ---------------------------------------------------------------------

  private async runScan(mode: ScanMode): Promise<void> {
    const root = this.dataRoot;
    this.metrics.scans++;
    if (mode === 'rebuild') {
      this.states = new Map();
      this.titleStates = new Map();
      this.warnings = [];
      this.viewDirty = true;
      this.cacheDirty = true;
      if (this.persist) {
        try {
          await this.writer.remove(CACHE_FILE);
        } catch {
          // 删除失败不致命：之后会被新缓存覆盖
        }
      }
    }
    const phase: Progress['phase'] = this.states.size === 0 ? 'full' : 'incremental';
    this.setProgress({ state: 'scanning', phase, filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0, startedAt: this.now(), lastError: undefined });

    let infos: UsageFileInfo[];
    try {
      infos = await listUsageFiles(root, this.fs);
    } catch (e) {
      this.setError(e);
      return;
    }

    // 1) 已消失的文件：撤销其贡献
    const seen = new Set(infos.map((i) => i.relPath));
    let changed = false;
    if (this.states.size > 0) {
      const next = new Map(this.states);
      for (const k of this.states.keys()) {
        if (!seen.has(k)) {
          next.delete(k);
          changed = true;
        }
      }
      this.states = next;
    }

    // 2) 计划：新增 / 变化 的文件
    const work: Array<{ info: UsageFileInfo; prev: FileState | undefined }> = [];
    for (const info of infos) {
      const prev = this.states.get(info.relPath);
      if (prev && prev.size === info.size && prev.mtimeMs === info.mtimeMs) continue;
      work.push({ info, prev });
    }
    const bytesTotal = work.reduce((a, w) => a + estimateBytes(w.info, w.prev), 0);
    this.setProgress({ filesTotal: work.length, bytesTotal });

    // 3) 并行执行
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const i = next++;
        if (i >= work.length) return;
        const { info, prev } = work[i]!;
        try {
          const r = await processFile(this.fs, info, prev, {
            chunkSize: this.chunkSize,
            onBytes: (d) => this.setProgress({ bytesDone: this.progress.bytesDone + d }),
          });
          if (r.kind === 'full') this.metrics.fullParses++;
          else this.metrics.incrementalParses++;
          const m = new Map(this.states);
          m.set(info.relPath, r.state);
          this.states = m;
          if (r.viewChanged) {
            changed = true;
            this.markDirty();
          } else this.cacheDirty = true;
        } catch (e) {
          this.warn(L(`读取 ${info.relPath} 失败：${(e as Error).message}`, `Failed to read ${info.relPath}: ${(e as Error).message}`));
        }
        this.setProgress({ filesDone: this.progress.filesDone + 1 });
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, work.length) }, () => worker()));

    // 4) 会话标题（custom-title.json，仅取 ≤ 40 字符的标题；未变化的不重读）
    if (await this.scanTitles(root)) changed = true;

    if (changed) {
      this.viewDirty = true;
      this.cacheDirty = true;
    }
    await this.flushPublish();
    if (this.cacheDirty) await this.saveCacheNow();
    this.setProgress({ state: 'idle', lastScanAt: this.now(), lastError: undefined });
    this.emitStatus(true);
  }

  private async scanTitles(root: string): Promise<boolean> {
    let files;
    try {
      files = await listTitleFiles(root, this.fs);
    } catch {
      return false;
    }
    let changed = false;
    const seen = new Set(files.map((f) => f.relPath));
    const next = new Map(this.titleStates);
    for (const k of this.titleStates.keys()) {
      if (!seen.has(k)) {
        next.delete(k);
        changed = true;
      }
    }
    for (const f of files) {
      const prev = next.get(f.relPath);
      if (prev && prev.size === f.size && prev.mtimeMs === f.mtimeMs) continue;
      try {
        const t = await readTitle(this.fs, f);
        if (!prev || prev.title !== t.title || prev.sessionId !== t.sessionId) changed = true;
        next.set(f.relPath, t);
      } catch (e) {
        this.warn(L(`读取 ${f.relPath} 失败：${(e as Error).message}`, `Failed to read ${f.relPath}: ${(e as Error).message}`));
      }
    }
    this.titleStates = next;
    return changed;
  }

  // ---------------------------------------------------------------------
  // 视图发布
  // ---------------------------------------------------------------------

  private markDirty(): void {
    this.viewDirty = true;
    this.cacheDirty = true;
    this.schedulePublish();
  }

  private schedulePublish(): void {
    if (this.publishTimer || this.publishing || this.closed) return;
    const wait = Math.max(this.recomputeMinMs, this.lastRecomputeMs * 3);
    this.publishTimer = setTimeout(() => {
      this.publishTimer = null;
      void this.flushPublish();
    }, wait);
    this.publishTimer.unref?.();
  }

  /** 若视图过期则（分片）重算并发布；等待进行中的发布。 */
  private async flushPublish(): Promise<void> {
    if (this.publishTimer) {
      clearTimeout(this.publishTimer);
      this.publishTimer = null;
    }
    while (this.publishing) await this.publishing;
    if (!this.viewDirty) return;
    this.publishing = (async () => {
      try {
        while (this.viewDirty) {
          this.viewDirty = false;
          const t0 = this.now();
          await this.publishOnce();
          this.lastRecomputeMs = this.now() - t0;
        }
      } finally {
        this.publishing = null;
      }
    })();
    await this.publishing;
  }

  private async publishOnce(): Promise<void> {
    const snapshot = [...this.states.values()]; // 状态对象不可变，可安全地在后台读取
    const titles = new Map<string, string>();
    for (const t of this.titleStates.values()) if (t.title) titles.set(t.sessionId, t.title);
    const autoTitles = new Map<string, string>();
    const activity: FileActivity[] = [];
    for (const s of snapshot) {
      if (!s.isSubagentFile && s.title && !autoTitles.has(s.defaultSessionId)) autoTitles.set(s.defaultSessionId, s.title);
      if (s.activity.length > 0) activity.push({ relPath: s.relPath, projectKey: s.projectKey, isSubagentFile: s.isSubagentFile, intervals: s.activity });
    }
    const inputs: DedupeFileInput[] = snapshot.map((s) => ({
      path: s.relPath,
      projectKey: s.projectKey,
      firstTs: s.firstTs,
      defaultSessionId: s.defaultSessionId,
      isSubagentFile: s.isSubagentFile,
      agentIdFromName: s.agentIdFromName,
      rows: s.rows,
    }));
    const d = await dedupeGlobalAsync(inputs);
    const stats: ParseStats = emptyParseStats();
    for (const s of snapshot) addParseStats(stats, s.stats);
    applyDedupeStats(stats, d.stats);
    const folderKeys = [...new Set(snapshot.map((s) => s.projectKey))].sort();
    const last = d.records.length > 0 ? d.records[d.records.length - 1]!.ts : null;
    this.view = { dataVersion: this.view.dataVersion + 1, records: d.records, stats, folderKeys, titles, autoTitles, activity, lastRecordTs: last };
    this.emit({ kind: 'data', status: this.getStatus() });
  }

  // ---------------------------------------------------------------------
  // 缓存
  // ---------------------------------------------------------------------

  private async saveCacheNow(): Promise<void> {
    if (!this.persist) {
      this.cacheDirty = false;
      return;
    }
    this.cacheDirty = false;
    try {
      const bytes = await saveCache(this.writer, { dataRoot: this.dataRoot, files: [...this.states.values()], titleFiles: [...this.titleStates.values()] }, this.now());
      this.metrics.cacheSaves++;
      this.metrics.cacheBytes = bytes;
    } catch (e) {
      this.cacheDirty = true;
      this.warn(L(`写入缓存失败：${(e as Error).message}`, `Failed to write the cache: ${(e as Error).message}`));
    }
  }

  // ---------------------------------------------------------------------
  // 状态 / 事件
  // ---------------------------------------------------------------------

  private warn(msg: string): void {
    if (this.warnings.length < MAX_WARNINGS) this.warnings.push(msg);
  }

  private setProgress(patch: Partial<Progress>): void {
    this.progress = { ...this.progress, ...patch };
    if (this.progress.lastError === undefined) delete this.progress.lastError;
    this.emitStatus(false);
  }

  private setError(e: unknown): void {
    const err = e as NodeJS.ErrnoException;
    const root = this.dataRoot;
    let msg: string;
    if (err.code === 'ENOENT') msg = L(`数据根目录不存在：${root}。请在设置中重新选择，或确认 Claude Code 已产生过会话。`, `The data folder does not exist: ${root}. Choose another one in Settings, or make sure Claude Code has created sessions.`);
    else if (err.code === 'ENOTDIR') msg = L(`数据根路径不是目录：${root}`, `The data folder path is not a folder: ${root}`);
    else if (err.code === 'EACCES' || err.code === 'EPERM') msg = L(`没有权限读取数据根目录：${root}`, `No permission to read the data folder: ${root}`);
    else msg = L(`读取数据根目录失败：${err.message ?? String(e)}`, `Failed to read the data folder: ${err.message ?? String(e)}`);
    this.setProgress({ state: 'error', lastError: msg });
    this.emitStatus(true);
  }

  private emitStatus(force: boolean): void {
    if (this.closed || this.listeners.size === 0) return;
    const nowMs = Date.now();
    if (!force && nowMs - this.lastStatusEmit < this.statusThrottleMs) {
      if (!this.statusTimer) {
        this.statusPending = true;
        this.statusTimer = setTimeout(() => {
          this.statusTimer = null;
          if (this.statusPending) this.emitStatus(true);
        }, this.statusThrottleMs);
        this.statusTimer.unref?.();
      }
      return;
    }
    this.statusPending = false;
    this.lastStatusEmit = nowMs;
    this.emit({ kind: 'status', status: this.getStatus() });
  }

  private emit(e: ChangeEvent): void {
    if (this.closed) return;
    for (const l of [...this.listeners]) {
      try {
        l(e);
      } catch {
        // 监听器异常不影响仓库
      }
    }
  }

  /** 数据根的比较键（测试 / 调用方判断是否同一目录）。 */
  get rootKey(): string {
    return rootIdentity(this.dataRoot);
  }
}

/**
 * 监听 / 轮询：定时触发 store.refreshNow()，可选再用 fs.watch 事件（去抖）提前触发。
 *
 * - 轮询间隔默认 5 s，可配置 2–60 s（`minIntervalMs`/`maxIntervalMs` 仅为测试可放宽）；
 * - 只在上一次刷新结束后才安排下一次（不会重叠）；store 本身也是单飞并合并重复触发；
 * - 数据根不可读（state=error）时仍按间隔重试，目录出现后自动恢复；
 * - 定时器 / 监听器都 unref，不阻止进程退出；`stop()` 彻底清理。
 */
import { watchDirectory } from '../core/safeFs.ts';
import type { Store } from './store.ts';

export interface WatcherOptions {
  intervalMs?: number;
  minIntervalMs?: number;
  maxIntervalMs?: number;
  /** 额外用 fs.watch 事件触发（默认关闭） */
  useFsWatch?: boolean;
  fsWatchDebounceMs?: number;
}

export const DEFAULT_POLL_MS = 5000;

export class Watcher {
  private readonly store: Store;
  private readonly minMs: number;
  private readonly maxMs: number;
  private readonly useFsWatch: boolean;
  private readonly debounceMs: number;
  private ms: number;
  private timer: NodeJS.Timeout | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private stopWatch: (() => void) | null = null;
  private watchedRoot: string | null = null;
  private running = false;

  constructor(store: Store, options: WatcherOptions = {}) {
    this.store = store;
    this.minMs = options.minIntervalMs ?? 2000;
    this.maxMs = options.maxIntervalMs ?? 60_000;
    this.useFsWatch = options.useFsWatch ?? false;
    this.debounceMs = options.fsWatchDebounceMs ?? 300;
    this.ms = this.clamp(options.intervalMs ?? DEFAULT_POLL_MS);
  }

  get intervalMs(): number {
    return this.ms;
  }

  /** 修改轮询间隔（钳制到 [min, max]）；若已启动则立即按新间隔重排。 */
  setIntervalMs(ms: number): void {
    this.ms = this.clamp(ms);
    if (this.running && this.timer) {
      clearTimeout(this.timer);
      this.schedule();
    }
  }

  private clamp(ms: number): number {
    return Math.min(this.maxMs, Math.max(this.minMs, Math.floor(ms)));
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.attachFsWatch();
    this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    this.timer = null;
    this.debounce = null;
    this.stopWatch?.();
    this.stopWatch = null;
    this.watchedRoot = null;
  }

  private schedule(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, this.ms);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    try {
      this.attachFsWatch();
      await this.store.refreshNow();
    } catch {
      // refreshNow 不会抛；保险起见
    }
    this.schedule();
  }

  private attachFsWatch(): void {
    if (!this.useFsWatch) return;
    const root = this.store.dataRoot;
    if (this.watchedRoot === root && this.stopWatch) return;
    this.stopWatch?.();
    this.watchedRoot = root;
    this.stopWatch = watchDirectory(root, () => {
      if (!this.running) return;
      if (this.debounce) clearTimeout(this.debounce);
      this.debounce = setTimeout(() => {
        this.debounce = null;
        void this.store.refreshNow();
      }, this.debounceMs);
      this.debounce.unref?.();
    });
  }
}

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Store } from '../src/server/store/store.ts';
import { Watcher } from '../src/server/store/watcher.ts';
import { assistantLine, loadExpected } from './helpers.ts';
import type { Expected } from './helpers.ts';
import { expectViewEqualsFull, tmpWorld } from './storeHelpers.ts';

const expected: Expected = loadExpected();
const A2 = 'D--Work-alpha/a1a1a1a1-0000-4000-8000-000000000002.jsonl';

async function waitFor(cond: () => boolean, ms = 3000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 15));
  }
  return cond();
}

describe('watcher：轮询', () => {
  it('间隔钳制到 [2 s, 60 s]，默认 5 s；运行中可改', () => {
    const store = new Store({ dataRoot: '.', appDataDir: '.', persistCache: false });
    expect(new Watcher(store).intervalMs).toBe(5000);
    expect(new Watcher(store, { intervalMs: 500 }).intervalMs).toBe(2000);
    expect(new Watcher(store, { intervalMs: 999_999 }).intervalMs).toBe(60_000);
    const w = new Watcher(store, { intervalMs: 10_000 });
    w.setIntervalMs(3000);
    expect(w.intervalMs).toBe(3000);
    w.setIntervalMs(1);
    expect(w.intervalMs).toBe(2000);
    store.close();
  });

  it('不调用 refreshNow：追加记录后在一个轮询间隔内 dataVersion 增加、新记录被计入；stop() 后不再扫描', async () => {
    const w = tmpWorld();
    try {
      const store = new Store({ dataRoot: w.root, appDataDir: w.app });
      await store.start();
      const watcher = new Watcher(store, { intervalMs: 60, minIntervalMs: 20 });
      watcher.start();
      const v0 = store.getView().dataVersion;
      const target = path.join(w.root, ...A2.split('/'));
      const t0 = Date.now();
      fs.appendFileSync(target, `${assistantLine({ id: 'msg_poll', input: 5, out: 5, ts: '2026-10-09T00:00:00.000Z' })}\n`);
      expect(await waitFor(() => store.getView().dataVersion > v0)).toBe(true);
      expect(Date.now() - t0).toBeLessThan(1500);
      expect(store.getView().stats.uniqueMessages).toBe(expected.stats.uniqueMessages + 1);
      await expectViewEqualsFull(store, w.root);
      watcher.stop();
      await store.idle();
      const scans = store.metrics.scans;
      fs.appendFileSync(target, `${assistantLine({ id: 'msg_after_stop', ts: '2026-10-09T01:00:00.000Z' })}\n`);
      await new Promise((r) => setTimeout(r, 300));
      expect(store.metrics.scans).toBe(scans);
      expect(store.getView().records.some((r) => r.messageId === 'msg_after_stop')).toBe(false);
      store.close();
    } finally {
      w.cleanup();
    }
  });

  it('数据根不存在时轮询重试；目录出现后自动恢复', async () => {
    const w = tmpWorld(false);
    try {
      const root = path.join(w.root, 'later');
      const store = new Store({ dataRoot: root, appDataDir: w.app });
      await store.start();
      expect(store.getStatus().state).toBe('error');
      const watcher = new Watcher(store, { intervalMs: 40, minIntervalMs: 20 });
      watcher.start();
      fs.mkdirSync(path.join(root, 'P'), { recursive: true });
      fs.writeFileSync(path.join(root, 'P', 's.jsonl'), `${assistantLine({ id: 'msg_late' })}\n`);
      expect(await waitFor(() => store.getStatus().state === 'idle' && store.getView().records.length === 1)).toBe(true);
      watcher.stop();
      store.close();
    } finally {
      w.cleanup();
    }
  });

  it('可选 fs.watch：轮询间隔很长时也能由文件事件触发刷新', async () => {
    const w = tmpWorld();
    try {
      const store = new Store({ dataRoot: w.root, appDataDir: w.app });
      await store.start();
      const watcher = new Watcher(store, { intervalMs: 600_000, minIntervalMs: 20, maxIntervalMs: 600_000, useFsWatch: true, fsWatchDebounceMs: 30 });
      watcher.start();
      // fs.watch 的就绪时机不确定（满载时可能晚于固定的 100 ms）：每隔 300 ms 追加一条不同 id 的记录，
      // 直到 dataVersion 增加。轮询间隔是 600 s，所以只可能由文件事件触发——测试意图不变，只是不再依赖固定等待。
      const v0 = store.getView().dataVersion;
      const file = path.join(w.root, ...A2.split('/'));
      let n = 0;
      const t0 = Date.now();
      while (store.getView().dataVersion <= v0 && Date.now() - t0 < 15_000) {
        fs.appendFileSync(file, `${assistantLine({ id: `msg_fswatch_${n++}`, ts: '2026-10-09T00:00:00.000Z' })}\n`);
        await waitFor(() => store.getView().dataVersion > v0, 300);
      }
      expect(store.getView().dataVersion).toBeGreaterThan(v0);
      watcher.stop();
      store.close();
    } finally {
      w.cleanup();
    }
  });
});

describe('测试装置自检：心跳延迟检测能发现同步阻塞', () => {
  it('故意同步占用 400 ms 会被测出 > 250 ms', async () => {
    let max = 0;
    let last = performance.now();
    const hb = setInterval(() => {
      const now = performance.now();
      max = Math.max(max, now - last - 50);
      last = now;
    }, 50);
    await new Promise((r) => setTimeout(r, 120));
    const end = performance.now() + 400;
    while (performance.now() < end) {
      /* busy */
    }
    await new Promise((r) => setTimeout(r, 120));
    clearInterval(hb);
    expect(max).toBeGreaterThan(250);
  });
});

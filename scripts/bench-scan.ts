/**
 * 扫描器基准：首次全量 / 无变化增量 / 冷启动读缓存 的耗时，进度回调次数，缓存大小，峰值内存。
 *
 *   npm run bench -- [--root "<数据根>"]
 *
 * 只读：数据根只读；缓存写到临时应用数据目录（运行结束后删除），不会碰你真实的 %APPDATA%\TokenVisualizer。
 * "冷启动"由一个全新的子进程完成（真正的进程冷启动 + 读缓存 + 发布视图）。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { defaultDataRoot } from '../src/server/core/paths.ts';
import { CACHE_FILE } from '../src/server/store/cache.ts';
import { Store } from '../src/server/store/store.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const root = arg('--root') ?? defaultDataRoot();

if (process.argv.includes('--child-warm')) {
  // 子进程：全新进程冷启动，读缓存并发布视图
  const appDataDir = arg('--appdata')!;
  const t0 = performance.now();
  const store = new Store({ dataRoot: root, appDataDir });
  await store.init();
  const ms = performance.now() - t0;
  const v = store.getView();
  console.log(JSON.stringify({ initMs: Math.round(ms), cacheLoad: store.metrics.cacheLoad, records: v.records.length, files: v.stats.filesParsed, rssMB: Math.round(process.memoryUsage().rss / 1048576) }));
  store.close();
} else {
  const appDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-bench-'));
  let peak = 0;
  const timer = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss);
  }, 50);
  try {
    console.log(`数据根（只读）：${root}`);
    const store = new Store({ dataRoot: root, appDataDir, statusThrottleMs: 50 });
    const bytes: number[] = [];
    store.onChange((e) => {
      if (e.status.state === 'scanning') bytes.push(e.status.bytesDone);
    });
    let t = performance.now();
    await store.start();
    const full = performance.now() - t;
    peak = Math.max(peak, process.memoryUsage().rss);
    const st = store.getStatus();
    const monotonic = bytes.every((b, i) => i === 0 || b >= bytes[i - 1]!);
    const v = store.getView();
    console.log(`首次全量：${(full / 1000).toFixed(2)} s；文件 ${v.stats.filesParsed}，唯一消息 ${v.stats.uniqueMessages}，跨文件重复 ${v.stats.crossFileDuplicates}，损坏行 ${v.stats.corruptLines}`);
    console.log(`进度回调：${bytes.length} 次（${monotonic ? '单调递增' : '【非单调】'}），最终 ${st.filesDone}/${st.filesTotal} 个文件，${st.bytesDone}/${st.bytesTotal} 字节；dataVersion ${st.dataVersion}`);
    const cacheFile = path.join(appDataDir, ...CACHE_FILE.split('/'));
    console.log(`缓存文件：${(fs.statSync(cacheFile).size / 1048576).toFixed(2)} MB`);

    t = performance.now();
    await store.refreshNow();
    console.log(`无变化增量刷新：${(performance.now() - t).toFixed(0)} ms（解析文件 ${store.metrics.fullParses - st.filesTotal + store.metrics.incrementalParses} 个）`);
    store.close();

    const t1 = performance.now();
    const out = execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--child-warm', '--root', root, '--appdata', appDataDir], { encoding: 'utf8' });
    const wall = performance.now() - t1;
    const child = JSON.parse(out.trim().split('\n').pop()!) as { initMs: number; cacheLoad: string; records: number; files: number; rssMB: number };
    console.log(`冷启动读缓存（全新子进程）：load+发布 ${child.initMs} ms，含进程启动共 ${wall.toFixed(0)} ms（缓存 ${child.cacheLoad}，记录 ${child.records}，文件 ${child.files}，子进程 RSS ${child.rssMB} MB）`);
    console.log(`峰值 RSS（全量扫描进程）：${Math.round(peak / 1048576)} MB`);
    if (full > 120_000) console.log('注意：首次全量超过 120 s，见开发报告中的原因与优化建议。');
    if (wall > 3000) console.log('注意：冷启动超过 3 s。');
  } finally {
    clearInterval(timer);
    fs.rmSync(appDataDir, { recursive: true, force: true });
  }
}

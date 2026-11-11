/**
 * 最小命令行入口：对一个数据根做"解析 + 全局去重"，打印 ParseStats、各 token 字段总和、耗时与内存。
 *
 *   npm run parse -- --root "<数据根>" [--json]
 *
 * 只读：每个文件只读到枚举时的大小（快照语义），不写任何文件。
 */
import { performance } from 'node:perf_hooks';
import { parseDataRoot } from '../src/server/core/loadRoot.ts';
import { defaultDataRoot } from '../src/server/core/paths.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const root = arg('--root') ?? defaultDataRoot();
const asJson = process.argv.includes('--json');

let peakRss = 0;
const timer = setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
}, 50);

const t0 = performance.now();
try {
  const r = await parseDataRoot(root);
  const ms = performance.now() - t0;
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
  const sum = (f: (x: (typeof r.records)[number]) => number): number => r.records.reduce((a, x) => a + f(x), 0);
  const totals = {
    input: sum((x) => x.input),
    cacheWrite: sum((x) => x.cacheWrite),
    cacheRead: sum((x) => x.cacheRead),
    output: sum((x) => x.output),
    thinking: sum((x) => x.thinking),
  };
  const out = {
    root,
    elapsedMs: Math.round(ms),
    peakRssMB: Math.round(peakRss / 1048576),
    stats: r.stats,
    totals: { ...totals, total: totals.input + totals.cacheWrite + totals.cacheRead + totals.output },
  };
  if (asJson) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.log(`数据根：${root}`);
    console.log(`耗时 ${out.elapsedMs} ms，峰值 RSS ${out.peakRssMB} MB`);
    console.log(`文件 ${r.stats.filesParsed}，行 ${r.stats.linesRead}，assistant 行 ${r.stats.assistantRows}`);
    console.log(`唯一消息 ${r.stats.uniqueMessages}，去重丢弃 ${r.stats.duplicatesDropped}（其中涉及跨文件的唯一消息 ${r.stats.crossFileDuplicates}）`);
    console.log(`synthetic 排除 ${r.stats.syntheticExcluded}，损坏行 ${r.stats.corruptLines}，空文件 ${r.stats.emptyFiles}，缺 id ${r.stats.missingId}`);
    console.log(`Total ${out.totals.total}（input ${totals.input} / cacheWrite ${totals.cacheWrite} / cacheRead ${totals.cacheRead} / output ${totals.output}；thinking ${totals.thinking} 含在 output 内）`);
  }
} catch (e) {
  const err = e as NodeJS.ErrnoException;
  if (err.code === 'ENOENT') console.error(`数据根目录不存在：${root}`);
  else if (err.code === 'EACCES' || err.code === 'EPERM') console.error(`没有权限读取数据根目录：${root}`);
  else console.error(`解析失败：${err.message}`);
  process.exitCode = 1;
} finally {
  clearInterval(timer);
}

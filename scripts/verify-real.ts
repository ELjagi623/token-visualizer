/**
 * 独立核对脚本：`npm run verify -- --root "<数据根>" [--tz Asia/Shanghai]`
 *
 * 用与主实现互不共享代码的朴素实现（scripts/verify/naive.ts）和主实现各算一遍，
 * 两边都只读到启动时快照的 (路径, 大小)；有差异 → 打印前 20 条并以退出码 1 结束，零差异 → 0。
 * 只读，不写任何文件。
 */
import { performance } from 'node:perf_hooks';
import { defaultDataRoot } from '../src/server/core/paths.ts';
import { systemTimeZone } from '../src/server/systemTz.ts';
import { runVerify } from './verify/run.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const root = arg('--root') ?? defaultDataRoot();
const tz = arg('--tz') ?? systemTimeZone();

let peak = 0;
const timer = setInterval(() => {
  peak = Math.max(peak, process.memoryUsage().rss);
}, 50);

const t0 = performance.now();
try {
  const r = await runVerify(root, tz);
  const ms = Math.round(performance.now() - t0);
  peak = Math.max(peak, process.memoryUsage().rss);
  const sum = (f: typeof r.main.totals): number => f.input + f.cacheWrite + f.cacheRead + f.output;
  console.log(`数据根：${root}`);
  console.log(`时区：${tz}；快照：${r.snapshotFiles} 个 .jsonl，${(r.snapshotBytes / 1048576).toFixed(1)} MB`);
  console.log(`唯一消息数：朴素 ${r.naive.uniqueMessages} / 主 ${r.main.uniqueMessages}`);
  console.log(`跨文件重复（出现在 ≥2 个文件的唯一消息）：朴素 ${r.naive.crossFileDuplicates} / 主 ${r.main.crossFileDuplicates}`);
  console.log(`Total token：朴素 ${sum(r.naive.totals)} / 主 ${sum(r.main.totals)}`);
  console.log(`项目 ${Object.keys(r.main.byProject).length}，模型 ${Object.keys(r.main.byModel).length}，有数据的日子 ${Object.keys(r.main.byDay).length}，会话 ${Object.keys(r.main.bySession).length}`);
  console.log(`耗时 ${ms} ms，峰值 RSS ${Math.round(peak / 1048576)} MB`);
  if (r.diffs.length === 0) {
    console.log('结果：零差异');
  } else {
    console.log(`结果：发现 ${r.diffs.length} 处差异（前 20 条）：`);
    for (const d of r.diffs.slice(0, 20)) console.log(`  - ${d}`);
    process.exitCode = 1;
  }
} catch (e) {
  const err = e as NodeJS.ErrnoException;
  if (err.code === 'ENOENT') console.error(`数据根目录不存在：${root}`);
  else console.error(`核对失败：${err.message}`);
  process.exitCode = 2;
} finally {
  clearInterval(timer);
}

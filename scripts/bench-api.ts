/**
 * API 基准：对 /api/projects、/api/summary、/api/timeseries（含 split=model）各发 50 次请求，输出 p50 / p95；
 * 另测"缓存未命中"的首次耗时（用不同参数组合绕开缓存）。
 *
 *   npm run bench:api -- [--root "<数据根>"] [--tz Asia/Shanghai]
 *
 * 只读：数据根只读；缓存 / 设置写临时应用数据目录（结束后删除）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createApp } from '../src/server/app.ts';
import { defaultDataRoot } from '../src/server/core/paths.ts';
import { systemTimeZone } from '../src/server/systemTz.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const root = arg('--root') ?? defaultDataRoot();
const tz = arg('--tz') ?? systemTimeZone();
const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-bench-api-'));

function pct(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

async function timeIt(url: string): Promise<{ ms: number; bytes: number }> {
  const t = performance.now();
  const r = await fetch(url);
  const text = await r.text();
  if (r.status !== 200) throw new Error(`${url} → ${r.status} ${text.slice(0, 200)}`);
  return { ms: performance.now() - t, bytes: text.length };
}

try {
  console.log(`数据根（只读）：${root}，时区 ${tz}`);
  const app = await createApp({ dataRoot: root, appDataDir: appData, port: 0 });
  const base = `http://127.0.0.1:${app.port}`;
  const t0 = performance.now();
  await app.store.idle();
  const st = app.store.getView().stats;
  console.log(`首次扫描 ${Math.round(performance.now() - t0)} ms：文件 ${st.filesParsed}，唯一消息 ${st.uniqueMessages}`);

  const endpoints: Array<[string, string]> = [
    ['/api/projects', `/api/projects?tz=${tz}`],
    ['/api/summary', `/api/summary?range=all&tz=${tz}`],
    ['/api/timeseries', `/api/timeseries?range=all&granularity=day&tz=${tz}`],
    ['/api/timeseries split=model', `/api/timeseries?range=all&granularity=day&split=model&tz=${tz}`],
    ['/api/timeseries hour 30d', `/api/timeseries?range=30d&granularity=hour&split=model&tz=${tz}`],
  ];
  let ok = true;
  console.log('\n缓存预热后（50 次请求）：');
  for (const [name, url] of endpoints) {
    const first = await timeIt(`${base}${url}`); // 预热（可能未命中）
    const times: number[] = [];
    for (let i = 0; i < 50; i++) times.push((await timeIt(`${base}${url}`)).ms);
    times.sort((a, b) => a - b);
    const p95 = pct(times, 95);
    if (p95 >= 100) ok = false;
    console.log(`  ${name.padEnd(30)} p50 ${pct(times, 50).toFixed(1)} ms  p95 ${p95.toFixed(1)} ms  max ${times[times.length - 1]!.toFixed(1)} ms  首次 ${first.ms.toFixed(1)} ms  ${(first.bytes / 1024).toFixed(0)} KB`);
  }

  console.log('\n缓存未命中（每次换参数组合；要求 < 300 ms）：');
  const misses: Array<[string, number]> = [];
  const grans = ['hour', 'day', 'week', 'month'];
  const splits = ['none', 'tokenType', 'model', 'project'];
  const ranges = ['7d', '30d', '90d', 'all'];
  let n = 0;
  for (const g of grans) {
    for (const s of splits) {
      const r = ranges[n++ % ranges.length]!;
      const url = `/api/timeseries?granularity=${g}&split=${s}&range=${r}&basis=${n % 2 ? 'fresh' : 'total'}&tz=${tz}`;
      misses.push([url, (await timeIt(`${base}${url}`)).ms]);
    }
  }
  for (const s of ['total', 'recent', 'name', 'today']) misses.push([`/api/projects?sort=${s}&basis=fresh`, (await timeIt(`${base}/api/projects?sort=${s}&basis=fresh&tz=${tz}`)).ms]);
  for (const r of ranges) misses.push([`/api/summary?range=${r}&includeSidechain=false`, (await timeIt(`${base}/api/summary?range=${r}&includeSidechain=false&tz=${tz}`)).ms]);
  const ms = misses.map((m) => m[1]).sort((a, b) => a - b);
  const worst = misses.reduce((a, b) => (b[1] > a[1] ? b : a));
  if (ms[ms.length - 1]! >= 300) ok = false;
  console.log(`  ${misses.length} 个未命中请求：p50 ${pct(ms, 50).toFixed(1)} ms  p95 ${pct(ms, 95).toFixed(1)} ms  max ${ms[ms.length - 1]!.toFixed(1)} ms（最慢：${worst[0]}）`);
  console.log(ok ? '\n结论：满足 预热 p95 < 100 ms、未命中 < 300 ms' : '\n结论：存在超过门槛的请求（见上）');
  await app.close();
  process.exitCode = ok ? 0 : 1;
} finally {
  fs.rmSync(appData, { recursive: true, force: true });
}

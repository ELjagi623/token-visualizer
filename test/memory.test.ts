import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseFileRange } from '../src/server/core/parser.ts';
import { assistantLine, makeTmpDir, rmDir } from './helpers.ts';

const TARGET_BYTES = 52 * 1024 * 1024; // ≥ 50 MB
let tmp: string;
let bigFile: string;

beforeAll(() => {
  tmp = makeTmpDir('tv-mem-');
  bigFile = path.join(tmp, 'big.jsonl');
  // 合成一个更接近真实的文件：大量几十 KB 的 user/tool_result 行 + 夹杂 assistant 行（流式重复 id）
  const filler = JSON.stringify({ type: 'user', timestamp: '2026-10-01T00:00:00.000Z', message: { role: 'user', content: 'x'.repeat(20_000) } });
  const fd = fs.openSync(bigFile, 'w');
  let written = 0;
  let i = 0;
  while (written < TARGET_BYTES) {
    const parts: string[] = [];
    for (let k = 0; k < 400; k++) {
      parts.push(assistantLine({ id: `msg_${Math.floor(i / 2)}`, ts: new Date(Date.UTC(2026, 9, 1) + i * 1000).toISOString(), out: i % 50, input: 1, cacheRead: 1000 }));
      if (k % 20 === 0) parts.push(filler);
      i++;
    }
    const chunk = `${parts.join('\n')}\n`;
    fs.writeSync(fd, chunk);
    written += Buffer.byteLength(chunk);
  }
  fs.closeSync(fd);
}, 120_000);

afterAll(() => rmDir(tmp));

describe('流式解析内存（验收 7）', () => {
  it('解析 ≥ 50 MB 文件时 RSS 增量 < 200 MB（且结果正确）', async () => {
    expect(fs.statSync(bigFile).size).toBeGreaterThanOrEqual(50 * 1024 * 1024);
    const base = process.memoryUsage().rss;
    let peak = base;
    const timer = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss);
    }, 10);
    let rowCount = 0;
    let lines = 0;
    try {
      const r = await parseFileRange(bigFile, {
        onRow: () => {
          rowCount++;
          if ((rowCount & 1023) === 0) peak = Math.max(peak, process.memoryUsage().rss);
        },
      });
      lines = r.stats.linesRead;
      peak = Math.max(peak, process.memoryUsage().rss);
      expect(r.rows).toEqual([]);
      expect(r.pendingBytes).toBe(0);
      expect(r.consumedUntilOffset).toBe(r.fileSize);
      expect(r.stats.corruptLines).toBe(0);
    } finally {
      clearInterval(timer);
    }
    expect(rowCount).toBeGreaterThan(10_000);
    expect(lines).toBeGreaterThan(rowCount);
    const deltaMb = (peak - base) / (1024 * 1024);
    console.log(`[mem] 解析 ${(fs.statSync(bigFile).size / 1024 / 1024).toFixed(1)} MB，${rowCount} 行 assistant，RSS 峰值增量 ${deltaMb.toFixed(1)} MB`);
    expect(deltaMb).toBeLessThan(200);
  });

  it('累积 rows 模式（默认）同样 < 200 MB', async () => {
    const base = process.memoryUsage().rss;
    let peak = base;
    const timer = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss);
    }, 10);
    try {
      const r = await parseFileRange(bigFile);
      peak = Math.max(peak, process.memoryUsage().rss);
      expect(r.rows.length).toBeGreaterThan(10_000);
    } finally {
      clearInterval(timer);
    }
    const deltaMb = (peak - base) / (1024 * 1024);
    console.log(`[mem] 累积模式 RSS 峰值增量 ${deltaMb.toFixed(1)} MB`);
    expect(deltaMb).toBeLessThan(200);
  });
});

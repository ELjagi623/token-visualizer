/**
 * AI 运行时长（批次 B）：区间算法、解析器产出、增量 = 全量、并集 / 之和、按桶切分（含跨午夜）、会话标题截断。
 * 全部用测试内手算的合成数据，不依赖 fixture（fixture 由其它批次共用）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { activitySet, allocateToBuckets, appendInterval, clipIntervals, computeActivity, concatIntervals, totalIntervalMs, unionIntervals } from '../src/server/core/activity.ts';
import { parseFileRange } from '../src/server/core/parser.ts';
import { enumerateBuckets } from '../src/server/core/time.ts';
import { cleanTitle, titleFromUserRow } from '../src/server/core/title.ts';
import { Store } from '../src/server/store/store.ts';
import { makeTmpDir, rmDir } from './helpers.ts';

const MIN = 60_000;
const T0 = Date.parse('2026-10-01T00:00:00.000Z');
const iso = (min: number): string => new Date(T0 + min * MIN).toISOString();

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmDir(dirs.pop()!);
});
function tmp(): string {
  const d = makeTmpDir('tv-act-');
  dirs.push(d);
  return d;
}

function asst(min: number, id: string): string {
  return JSON.stringify({ type: 'assistant', timestamp: iso(min), sessionId: 's1', message: { id, model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 1, output_tokens: 1 } } });
}
function human(min: number, text: unknown = 'hello'): string {
  return JSON.stringify({ type: 'user', timestamp: iso(min), sessionId: 's1', message: { role: 'user', content: text } });
}
function toolResult(min: number): string {
  return JSON.stringify({ type: 'user', timestamp: iso(min), sessionId: 's1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'SECRET_BODY_MARKER' }] } });
}
function system(min: number): string {
  return JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: 5 * MIN, timestamp: iso(min) });
}

describe('区间辅助函数', () => {
  it('appendInterval 合并相接 / 重叠的区间，间隔则新增', () => {
    const l: number[] = [];
    appendInterval(l, 0, 10);
    appendInterval(l, 10, 20);
    appendInterval(l, 15, 18);
    appendInterval(l, 30, 40);
    expect(l).toEqual([0, 20, 30, 40]);
  });

  it('unionIntervals：乱序 / 重叠 / 相接 → 升序互不相交；并集 ≤ 各自之和', () => {
    const u = unionIntervals([[0, 10, 50, 60], [5, 20, 60, 70], [100, 100]]);
    expect(u).toEqual([0, 20, 50, 70]);
    expect(totalIntervalMs(u)).toBe(40);
  });

  it('clipIntervals 裁剪到 [from, to)', () => {
    expect(clipIntervals([0, 10, 20, 30], 5, 25)).toEqual([5, 10, 20, 25]);
    expect(clipIntervals([0, 10], 10, 20)).toEqual([]);
  });

  it('allocateToBuckets：区间被桶边界切分，总和 = 窗口内总量', () => {
    // 桶 [0,10) [10,20) [20,30)；区间 [5,25) 与 [27,40)（后者被窗口 30 截断）
    const out = allocateToBuckets([5, 25, 27, 40], [0, 10, 20], 30);
    expect(out).toEqual([5, 10, 5 + 3]);
    expect(out.reduce((a, b) => a + b, 0)).toBe(23);
    // 起点早于首桶：先裁剪
    expect(allocateToBuckets([-5, 5], [0, 10], 20)).toEqual([5, 0]);
  });

  it('concatIntervals：续读边界处合并', () => {
    expect(concatIntervals([0, 10], [10, 20, 40, 50])).toEqual([0, 20, 40, 50]);
    expect(concatIntervals([0, 10], [20, 30])).toEqual([0, 10, 20, 30]);
  });
});

describe('解析器：AI 活跃区间（手算）', () => {
  // 事件序列（分钟）：
  //   0 人类 | 1 AI | 2 tool_result | 30 AI（间隔 28 > 15，不计）| 31 人类 | 33 AI（2 分钟）| 34 system(忽略) | 40 人类 | 60 AI（20 > 15，不计）
  // 区间：[1,2]... 详见断言
  const lines = [human(0, 'Please refactor the parser module and keep going SECRET_BODY_MARKER tail'), asst(1, 'm1'), toolResult(2), asst(30, 'm2'), human(31), asst(33, 'm3'), system(34), human(40), asst(60, 'm4')];

  it('间隔 ≤ 15 分钟的 AI 事件计入；空闲 / 真人输入前的间隔不计；system 行忽略', async () => {
    const d = tmp();
    const f = path.join(d, 's1.jsonl');
    fs.writeFileSync(f, `${lines.join('\n')}\n`);
    const r = await parseFileRange(f);
    // [0,1] AI(1) 与上一事件(人类 0) 间隔 1 分钟 → 计；[1,2] tool_result → 计；两段相接合并为 [0,2]
    // 30: 间隔 28 → 不计；33: 与 31(人类) 间隔 2 → 计 [31,33]；60: 与 40 间隔 20 → 不计
    expect(r.activity).toEqual([T0, T0 + 2 * MIN, T0 + 31 * MIN, T0 + 33 * MIN]);
    expect(totalIntervalMs(r.activity)).toBe(4 * MIN);
    expect(r.lastEventTs).toBe(T0 + 60 * MIN);
  });

  it('首条真人消息前 40 字作标题，原文其余部分不保留（也不含 SECRET_BODY_MARKER）', async () => {
    const d = tmp();
    const f = path.join(d, 's1.jsonl');
    fs.writeFileSync(f, `${lines.join('\n')}\n`);
    const r = await parseFileRange(f);
    expect(r.title).toBe('Please refactor the parser module and ke');
    expect(Array.from(r.title!).length).toBeLessThanOrEqual(40);
    expect(JSON.stringify(r)).not.toContain('SECRET_BODY_MARKER');
    expect(JSON.stringify(r)).not.toContain('keep going');
  });

  it('标题规则：跳过 isMeta / 子代理 / 以 < 开头的系统注入文本；数组内容取第一个 text 块；中文按字符截断', () => {
    expect(titleFromUserRow({ type: 'user', isMeta: true, message: { content: 'meta' } })).toBeNull();
    expect(titleFromUserRow({ type: 'user', isSidechain: true, message: { content: 'sub' } })).toBeNull();
    expect(titleFromUserRow({ type: 'user', message: { content: '<command-name>/init</command-name>' } })).toBeNull();
    expect(titleFromUserRow({ type: 'user', message: { content: [{ type: 'image' }, { type: 'text', text: '  第一段   文字\n第二行' }] } })).toBe('第一段 文字 第二行');
    expect(titleFromUserRow({ type: 'user', message: { content: '字'.repeat(100) } })).toBe('字'.repeat(40));
    expect(cleanTitle('   ')).toBeNull();
    expect(cleanTitle(123)).toBeNull();
  });

  it('增量续读 = 一次性全量（任意切点；含跨读取边界的间隔）', async () => {
    const d = tmp();
    const f = path.join(d, 's1.jsonl');
    const text = `${lines.join('\n')}\n`;
    fs.writeFileSync(f, text);
    const full = await parseFileRange(f);
    // 在每个行首切开
    const offsets: number[] = [];
    let pos = 0;
    for (const l of lines) {
      pos += Buffer.byteLength(l) + 1;
      offsets.push(pos);
    }
    for (const cut of offsets.slice(0, -1)) {
      const a = await parseFileRange(f, { startOffset: 0, endOffset: cut });
      const b = await parseFileRange(f, { startOffset: cut, prevEventTs: a.lastEventTs });
      expect(concatIntervals(a.activity, b.activity), `切点 ${cut}`).toEqual(full.activity);
      expect(b.lastEventTs).toBe(full.lastEventTs);
      expect(a.title ?? b.title).toBe(full.title);
    }
  });

  it('时间戳乱序：负间隔不计，不产生负长度区间', async () => {
    const d = tmp();
    const f = path.join(d, 's1.jsonl');
    fs.writeFileSync(f, `${[asst(10, 'a'), asst(5, 'b'), asst(6, 'c')].join('\n')}\n`);
    const r = await parseFileRange(f);
    expect(r.activity).toEqual([T0 + 5 * MIN, T0 + 6 * MIN]);
  });
});

describe('并集 / 之和 / 按桶切分', () => {
  it('并行会话 + 子代理：主数字取并集，次要数字是各文件之和；过滤项目与子代理', () => {
    const files = [
      { relPath: 'P1/s1.jsonl', projectKey: 'P1', isSubagentFile: false, intervals: [0, 10 * MIN] },
      { relPath: 'P1/s1/subagents/agent-a.jsonl', projectKey: 'P1', isSubagentFile: true, intervals: [5 * MIN, 20 * MIN] },
      { relPath: 'P2/s2.jsonl', projectKey: 'P2', isSubagentFile: false, intervals: [100 * MIN, 130 * MIN] },
    ];
    const all = activitySet(files, { keys: null, includeSidechain: true });
    expect(totalIntervalMs(all.union)).toBe((20 + 30) * MIN); // [0,20] ∪ [100,130]
    expect(all.sumMs).toBe((10 + 15 + 30) * MIN); // 并行部分重复计入
    expect(activitySet(files, { keys: null, includeSidechain: false }).sumMs).toBe(40 * MIN);
    expect(activitySet(files, { keys: new Set(['P1']), includeSidechain: true }).sumMs).toBe(25 * MIN);
    const win = computeActivity(all, 8 * MIN, 110 * MIN, []);
    expect(win.activeMs).toBe((12 + 10) * MIN);
    expect(win.activeMsSum).toBe((2 + 12 + 10) * MIN);
  });

  it('跨午夜按本地日切分（Asia/Shanghai：UTC 15:50 – 16:20 跨本地 00:00）；各桶之和 = 窗口总量；任一桶 ≤ 桶长', () => {
    const tz = 'Asia/Shanghai';
    const s = Date.parse('2026-10-01T15:50:00.000Z');
    const e = Date.parse('2026-10-01T16:20:00.000Z');
    const files = [{ relPath: 'P/s.jsonl', projectKey: 'P', isSubagentFile: false, intervals: [s, e] }];
    const set = activitySet(files, { keys: null, includeSidechain: true });
    const from = Date.parse('2026-10-01T00:00:00.000Z');
    const to = Date.parse('2026-10-03T00:00:00.000Z');
    const buckets = enumerateBuckets(from, to, 'day', tz);
    const r = computeActivity(set, from, to, buckets.map((b) => b.start));
    const dayKeys = buckets.map((b) => b.key);
    const i1 = dayKeys.indexOf('2026-10-01');
    const i2 = dayKeys.indexOf('2026-10-02');
    expect(r.perBucket[i1]).toBe(10 * MIN);
    expect(r.perBucket[i2]).toBe(20 * MIN);
    expect(r.perBucket.reduce((a, b) => a + b, 0)).toBe(r.activeMs);
    expect(r.activeMs).toBe(30 * MIN);
    for (const v of r.perBucket) expect(v).toBeLessThanOrEqual(24 * 3600_000);
    // 小时粒度：同一区间落在三个小时桶 [23:00,00:00)=10 分钟、[00:00,01:00)=20 分钟
    const hb = enumerateBuckets(from, to, 'hour', tz);
    const hr = computeActivity(set, from, to, hb.map((b) => b.start));
    expect(hr.perBucket.filter((v) => v > 0)).toEqual([10 * MIN, 20 * MIN]);
  });
});

describe('Store：区间随文件进入视图，增量追加与全量结果一致', () => {
  it('追加记录（含半行补全）后 view.activity 与"从零全量解析当前文件"相同；子代理文件区间并入；缓存重载后保持', async () => {
    const root = path.join(tmp(), 'projects');
    const app = path.join(tmp(), 'app');
    const P = path.join(root, 'D--P');
    fs.mkdirSync(P, { recursive: true });
    fs.mkdirSync(path.join(P, 's1', 'subagents'), { recursive: true });
    const main = path.join(P, 's1.jsonl');
    const sub = path.join(P, 's1', 'subagents', 'agent-x.jsonl');
    fs.writeFileSync(main, `${[human(0, 'Fix the bug'), asst(1, 'a1'), asst(3, 'a2')].join('\n')}\n`);
    fs.writeFileSync(sub, `${[JSON.stringify({ ...JSON.parse(asst(2, 'b1')), isSidechain: true }), JSON.stringify({ ...JSON.parse(asst(6, 'b2')), isSidechain: true })].join('\n')}\n`);
    const store = new Store({ dataRoot: root, appDataDir: app });
    await store.start();
    const flat = (): number[] => unionIntervals(store.getView().activity.map((a) => a.intervals));
    expect(flat()).toEqual([T0, T0 + 6 * MIN]); // main [0,3] ∪ sub [2,6]
    expect(store.getView().autoTitles.get('s1')).toBe('Fix the bug');
    // 追加：先写半行，再补全
    const line = asst(8, 'a3');
    fs.appendFileSync(main, line.slice(0, 30));
    await store.refreshNow();
    fs.appendFileSync(main, `${line.slice(30)}\n${human(50)}\n${asst(52, 'a4')}\n`);
    await store.refreshNow();
    const incremental = flat();
    // 全量对照：新 Store 无缓存从零解析同一目录
    const store2 = new Store({ dataRoot: root, appDataDir: path.join(tmp(), 'app2'), persistCache: false });
    await store2.start();
    expect(unionIntervals(store2.getView().activity.map((a) => a.intervals))).toEqual(incremental);
    // 手算：main：[0,3] 之后 a3@8 与 a2@3 间隔 5 → [3,8]；human@50；a4@52 → [50,52]；sub：[2,6]
    expect(totalIntervalMs(incremental)).toBe((8 + 2) * MIN);
    store.close();
    store2.close();
    // 冷启动读缓存：区间与标题仍在
    const store3 = new Store({ dataRoot: root, appDataDir: app });
    await store3.init();
    expect(unionIntervals(store3.getView().activity.map((a) => a.intervals))).toEqual(incremental);
    expect(store3.getView().autoTitles.get('s1')).toBe('Fix the bug');
    store3.close();
  });
});

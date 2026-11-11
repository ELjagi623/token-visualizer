/**
 * 阶段 3 独立测试（测试工程师编写）。
 * 视图正确性一律对照 `test/naiveView.ts`（测试者自写的朴素全量实现）以及 parseDataRoot（从零全量解析当前目录）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { parseDataRoot } from '../src/server/core/loadRoot.ts';
import { createSafeFs } from '../src/server/core/safeFs.ts';
import type { SafeFs } from '../src/server/core/safeFs.ts';
import { CACHE_FILE } from '../src/server/store/cache.ts';
import { Store } from '../src/server/store/store.ts';
import type { StoreOptions } from '../src/server/store/store.ts';
import { Watcher } from '../src/server/store/watcher.ts';
import { FIXTURE_ROOT, makeTmpDir, rmDir, snapshotDir } from './helpers.ts';
import { diffAgainstNaive, naiveView } from './naiveView.ts';

const bases: string[] = [];
afterAll(() => {
  for (const b of bases) rmDir(b);
});

interface World {
  root: string;
  app: string;
  base: string;
  clock: number;
}
function newWorld(copyFixture = false): World {
  const base = makeTmpDir('tv-p3t-');
  bases.push(base);
  const root = path.join(base, 'projects');
  const app = path.join(base, 'appdata');
  fs.mkdirSync(root, { recursive: true });
  if (copyFixture) fs.cpSync(FIXTURE_ROOT, root, { recursive: true });
  return { root, app, base, clock: Date.parse('2026-11-01T00:00:00Z') };
}
/** 每次修改后把 mtime 推到一个严格递增的新值（避免 ms 级时钟撞车造成的假阴性）。 */
function bump(w: World, file: string): void {
  w.clock += 1500;
  fs.utimesSync(file, new Date(w.clock), new Date(w.clock));
}
const abs = (w: World, rel: string): string => path.join(w.root, ...rel.split('/'));
function put(w: World, rel: string, data: string | Buffer): void {
  const p = abs(w, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
  bump(w, p);
}
function append(w: World, rel: string, data: string | Buffer): void {
  const p = abs(w, rel);
  fs.appendFileSync(p, data);
  bump(w, p);
}

function mkStore(w: World, extra: Partial<StoreOptions> = {}): { store: Store; sfs: SafeFs } {
  const sfs = createSafeFs();
  const store = new Store({ dataRoot: w.root, appDataDir: w.app, fs: sfs, statusThrottleMs: 0, ...extra });
  return { store, sfs };
}

const iso = (ms: number): string => new Date(ms).toISOString();
function line(id: string | null, ts: number, o: { out?: number; inp?: number; cr?: number; cw?: number; session?: string; model?: string; cwd?: string; reqId?: string } = {}): string {
  const message: Record<string, unknown> = {
    model: o.model ?? 'claude-sonnet-5',
    role: 'assistant',
    content: [{ type: 'text', text: 'reply 回复 SECRET_BODY_MARKER' }],
    usage: { input_tokens: o.inp ?? 1, output_tokens: o.out ?? 2, cache_read_input_tokens: o.cr ?? 3, cache_creation_input_tokens: o.cw ?? 4 },
  };
  if (id) message.id = id;
  return JSON.stringify({ type: 'assistant', timestamp: iso(ts), sessionId: o.session ?? 's', cwd: o.cwd ?? 'C:\\用户\\王测试\\项目', ...(o.reqId ? { requestId: o.reqId } : {}), message }) + '\n';
}
const modeLine = (ts?: number): string => JSON.stringify({ type: 'mode', mode: 'normal', ...(ts !== undefined ? { timestamp: iso(ts) } : {}) }) + '\n';

async function check(store: Store, w: World, label: string): Promise<void> {
  const nv = naiveView(w.root);
  const diffs = diffAgainstNaive(store.getView(), nv);
  expect(diffs, `${label}: 视图 vs 朴素实现`).toEqual([]);
  const full = await parseDataRoot(w.root);
  expect(store.getView().stats, `${label}: stats vs 从零全量`).toEqual(full.stats);
  expect(store.getView().records, `${label}: records vs 从零全量`).toEqual(full.records);
}

function rngOf(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x9e3779b9) >>> 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t ^= t >>> 15;
    t = Math.imul(t, 0x735a2d97);
    t ^= t >>> 15;
    return (t >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// 1. 增量 vs 全量：随机破坏性操作序列
// ---------------------------------------------------------------------------
function readFixtureSources(): Array<{ rel: string; data: Buffer }> {
  const out: Array<{ rel: string; data: Buffer }> = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const a = path.join(d, e.name);
      if (e.isDirectory()) walk(a);
      else if (e.name.endsWith('.jsonl')) out.push({ rel: path.relative(FIXTURE_ROOT, a).split(path.sep).join('/'), data: fs.readFileSync(a) });
    }
  };
  walk(FIXTURE_ROOT);
  return out;
}

function synthSources(rnd: () => number): Array<{ rel: string; data: Buffer }> {
  const ri = (n: number): number => Math.floor(rnd() * n);
  const out: Array<{ rel: string; data: Buffer }> = [];
  const nFiles = 5 + ri(3);
  const t0 = Date.parse('2026-10-10T00:00:00Z');
  for (let f = 0; f < nFiles; f++) {
    const proj = `P${ri(3)}`;
    const rel = f === nFiles - 1 ? `${proj}/s${f}/subagents/agent-z${f}.jsonl` : `${proj}/s${f}.jsonl`;
    let text = '';
    const n = 8 + ri(25);
    const start = t0 + ri(5) * 1000; // firstTs 并列
    if (rnd() < 0.3) text += modeLine(); // 首行无时间戳
    for (let i = 0; i < n; i++) {
      const r = rnd();
      const ts = start + i * 1000 + ri(3) * 400;
      if (r < 0.05) text += '{"type":"assistant","message":{"id":"cut\n';
      else if (r < 0.08) text += 'garbage line 乱码\n';
      else if (r < 0.14) text += modeLine(ts);
      else if (r < 0.18) text += JSON.stringify({ type: 'assistant', timestamp: iso(ts), message: { model: '<synthetic>', id: 'syn' + i, usage: { input_tokens: 0, output_tokens: 0 } } }) + '\n';
      else if (r < 0.22) text += JSON.stringify({ type: 'assistant', timestamp: iso(ts), requestId: 'req' + ri(4), message: { model: 'claude-x', usage: { input_tokens: ri(9), output_tokens: ri(9) } } }) + '\n';
      else text += line('id' + ri(12), ts, { out: ri(500), inp: ri(50), cr: ri(9000), cw: ri(900), session: 'sess' + f });
    }
    out.push({ rel, data: Buffer.from(text) });
  }
  return out;
}

async function fuzzOnce(seed: number, source: 'fixture' | 'synthetic'): Promise<void> {
  const rnd = rngOf(seed);
  const ri = (n: number): number => Math.floor(rnd() * n);
  const w = newWorld();
  const sources = source === 'fixture' ? readFixtureSources() : synthSources(rnd);
  // 目标内容与当前已写入长度
  const full = new Map<string, Buffer>(sources.map((s) => [s.rel, s.data]));
  const cur = new Map<string, number>(); // 不在表中 = 文件不存在
  let { store } = mkStore(w, { concurrency: 1 + (seed % 4) });
  await store.start();
  const sync = (rel: string): void => {
    const p = abs(w, rel);
    const want = full.get(rel)!.subarray(0, cur.get(rel)!);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, want);
    bump(w, p);
  };
  const names = (): string[] => [...full.keys()];
  const steps = 70;
  let resumeN = 0;
  for (let step = 0; step < steps; step++) {
    const op = rnd();
    const rel = names()[ri(names().length)]!;
    const buf = full.get(rel)!;
    const c = cur.get(rel);
    if (op < 0.45) {
      // 追加一段：随机字节数，可能切在行中间 / 多字节字符中间
      const from = c ?? 0;
      if (from < buf.length) {
        const to = rnd() < 0.2 ? buf.length : Math.min(buf.length, from + 1 + ri(Math.max(2, Math.floor(buf.length / 3))));
        if (c === undefined) {
          cur.set(rel, to);
          sync(rel);
        } else {
          append(w, rel, buf.subarray(from, to));
          cur.set(rel, to);
        }
      }
    } else if (op < 0.55 && c !== undefined) {
      // 删除
      fs.rmSync(abs(w, rel));
      cur.delete(rel);
    } else if (op < 0.65 && c !== undefined && c > 1) {
      // 截断到更短（可能停在行中间）
      const to = ri(c);
      cur.set(rel, to);
      fs.truncateSync(abs(w, rel), to);
      bump(w, abs(w, rel));
    } else if (op < 0.72 && c !== undefined) {
      // 整体改写：用另一个文件的内容（不同内容，长度任意）
      const other = full.get(names()[ri(names().length)]!)!;
      full.set(rel, other);
      cur.set(rel, ri(other.length + 1));
      sync(rel);
    } else if (op < 0.78 && c !== undefined && c > 20) {
      // 等长覆盖：改头部与尾部各一个字节（保持长度）
      const p = abs(w, rel);
      const d = Buffer.from(fs.readFileSync(p));
      d[ri(Math.min(40, d.length))] = 0x58; // 'X'
      d[d.length - 1 - ri(Math.min(40, d.length))] = 0x59;
      full.set(rel, Buffer.concat([d, full.get(rel)!.subarray(d.length)]));
      fs.writeFileSync(p, d);
      bump(w, p);
    } else if (op < 0.9 && c !== undefined && c > 0) {
      // 恢复会话副本：复制某文件前若干个完整行，加一个更早/更晚时间戳的前导行
      const text = buf.subarray(0, c).toString('utf8');
      const lines = text.split('\n').slice(0, 1 + ri(8));
      const lead = modeLine(Date.parse('2026-10-10T00:00:00Z') + (rnd() < 0.5 ? -86_400_000 : 86_400_000 * 40));
      const rrel = `${rel.split('/')[0]}/resume${resumeN++}.jsonl`;
      const data = Buffer.from(lead + lines.join('\n') + '\n');
      full.set(rrel, data);
      cur.set(rrel, rnd() < 0.5 ? data.length : ri(data.length + 1));
      sync(rrel);
    }
    // 偶尔：关闭 store，在关闭期间做一次变更，再用缓存启动
    if (rnd() < 0.08) {
      await store.idle();
      store.close();
      const k = names()[ri(names().length)]!;
      const kb = full.get(k)!;
      const kc = cur.get(k) ?? 0;
      if (kc < kb.length) {
        const to = Math.min(kb.length, kc + 1 + ri(300));
        if (cur.get(k) === undefined) {
          cur.set(k, to);
          sync(k);
        } else {
          append(w, k, kb.subarray(kc, to));
          cur.set(k, to);
        }
      }
      ({ store } = mkStore(w, { concurrency: 1 + (seed % 3) }));
      await store.init();
      expect(store.metrics.cacheLoad, `seed ${seed}`).toMatch(/^(loaded|missing)$/);
      await store.refreshNow();
      await check(store, w, `seed ${seed} step ${step} (缓存重启)`);
      continue;
    }
    if (rnd() < 0.65) {
      await store.refreshNow();
      await check(store, w, `seed ${seed} step ${step} op ${op.toFixed(2)} ${rel}`);
    }
  }
  await store.refreshNow();
  await check(store, w, `seed ${seed} 最终`);
  // 最终：补全所有文件到完整内容后，视图应等于"完整 fixture"的全量
  for (const [rel, b] of full) {
    if (cur.get(rel) === undefined) {
      cur.set(rel, b.length);
      sync(rel);
    } else if (cur.get(rel)! < b.length) {
      append(w, rel, b.subarray(cur.get(rel)!));
      cur.set(rel, b.length);
    }
  }
  await store.refreshNow();
  await check(store, w, `seed ${seed} 补全后`);
  // 无变化再刷新：零读取、版本不变
  const v0 = store.getView().dataVersion;
  await store.refreshNow();
  expect(store.getView().dataVersion).toBe(v0);
  store.close();
}

describe('增量 == 全量（随机破坏性操作序列）', () => {
  it('fixture 内容：12 个种子，追加/删除/截断/改写/等长覆盖/恢复副本/关闭重启读缓存，每步视图 == 朴素实现 == 从零全量', async () => {
    for (let seed = 1; seed <= 12; seed++) await fuzzOnce(seed * 7919, 'fixture');
  }, 120_000);
  it('合成数据（id 池小、firstTs 并列、首行无时间戳、缺 id、损坏行）：24 个种子', async () => {
    for (let seed = 1; seed <= 24; seed++) await fuzzOnce(seed * 104729, 'synthetic');
  }, 180_000);
});

// ---------------------------------------------------------------------------
// 2. 增量规则
// ---------------------------------------------------------------------------
describe('增量规则', () => {
  const T = Date.parse('2026-10-10T00:00:00Z');

  it('大小与 mtime 都不变：零读取、dataVersion 不变、不重新解析', async () => {
    const w = newWorld(true);
    const { store, sfs } = mkStore(w);
    await store.start();
    await store.refreshNow(); // 让缓存稳定
    const o = sfs.opens, b = sfs.bytesRead, v = store.getView().dataVersion;
    const f = store.metrics.fullParses, i = store.metrics.incrementalParses;
    for (let k = 0; k < 3; k++) await store.refreshNow();
    expect([sfs.opens, sfs.bytesRead, store.getView().dataVersion, store.metrics.fullParses, store.metrics.incrementalParses]).toEqual([o, b, v, f, i]);
    store.close();
  });

  it('追加：只续读新增字节（含头尾哈希窗口 ≤ 3×4KB），不整文件重读；不重复计入', async () => {
    const w = newWorld();
    let body = '';
    for (let i = 0; i < 1500; i++) body += line('big' + i, T + i * 1000, { out: i % 50, session: 'big' });
    put(w, 'P/big.jsonl', body);
    put(w, 'P/other.jsonl', line('o1', T));
    const { store, sfs } = mkStore(w);
    await store.start();
    const rel = 'P/big.jsonl';
    const size0 = fs.statSync(abs(w, rel)).size;
    expect(size0).toBeGreaterThan(200_000);
    const before = { ...store.getView().stats };
    const add = line('msg_new_1', T + 99_000_000, { out: 7, session: 'big' });
    const br = sfs.bytesRead;
    const fp = store.metrics.fullParses;
    append(w, rel, add);
    await store.refreshNow();
    const read = sfs.bytesRead - br;
    expect(store.metrics.fullParses).toBe(fp);
    expect(store.metrics.incrementalParses).toBeGreaterThan(0);
    expect(read).toBeGreaterThanOrEqual(Buffer.byteLength(add));
    expect(read).toBeLessThanOrEqual(Buffer.byteLength(add) + 4096 * 3);
    expect(read).toBeLessThan(size0 / 10);
    expect(store.getView().stats.uniqueMessages).toBe(before.uniqueMessages + 1);
    expect(store.getView().stats.duplicatesDropped).toBe(before.duplicatesDropped);
    await check(store, w, '追加后');
    // 再追加一条与已有 id 相同的流式重复行（usage 更大）：不新增唯一消息，取最大值
    append(w, rel, line('msg_new_1', T + 99_000_500, { out: 70, session: 'big' }));
    await store.refreshNow();
    expect(store.getView().stats.uniqueMessages).toBe(before.uniqueMessages + 1);
    expect(store.getView().records.find((r) => r.messageId === 'msg_new_1')!.output).toBe(70);
    await check(store, w, '重复行');
    store.close();
  });

  it('半行：不发布（dataVersion 不变）、不计损坏行；补全后发布；补全一条损坏行则 corruptLines +1', async () => {
    const w = newWorld();
    put(w, 'P/a.jsonl', line('m1', T));
    const { store } = mkStore(w);
    await store.start();
    const v0 = store.getView().dataVersion;
    const half = line('m2', T + 1000, { out: 9 });
    const cut = Math.floor(half.length / 2);
    append(w, 'P/a.jsonl', half.slice(0, cut));
    await store.refreshNow();
    expect(store.getView().dataVersion).toBe(v0);
    expect(store.getView().stats.corruptLines).toBe(0);
    expect(store.getView().stats.uniqueMessages).toBe(1);
    append(w, 'P/a.jsonl', half.slice(cut, cut + 20)); // 再追加一点，仍无换行
    await store.refreshNow();
    expect(store.getView().dataVersion).toBe(v0);
    append(w, 'P/a.jsonl', half.slice(cut + 20));
    await store.refreshNow();
    expect(store.getView().dataVersion).toBeGreaterThan(v0);
    expect(store.getView().stats.uniqueMessages).toBe(2);
    await check(store, w, '半行补全');
    // 损坏行：先半行后补全成损坏行
    const v1 = store.getView().dataVersion;
    append(w, 'P/a.jsonl', '{"type":"assistant","mes');
    await store.refreshNow();
    expect(store.getView().stats.corruptLines).toBe(0);
    append(w, 'P/a.jsonl', 'broken\n');
    await store.refreshNow();
    expect(store.getView().stats.corruptLines).toBe(1);
    expect(store.getView().dataVersion).toBeGreaterThan(v1);
    // 重复扫描不重复计数
    for (let i = 0; i < 3; i++) await store.refreshNow();
    expect(store.getView().stats.corruptLines).toBe(1);
    await check(store, w, '损坏行');
    store.close();
  });

  it('变小 / 等长但 mtime 变 / 头部被改写后变长 / 尾部被改写后变长：整文件重解析（fullParses 增加）且结果 == 全量', async () => {
    const mk = (): World => {
      const w = newWorld();
      let body = '';
      for (let i = 0; i < 80; i++) body += line('m' + i, T + i * 1000, { out: i + 1 });
      put(w, 'P/a.jsonl', body);
      return w;
    };
    const cases: Array<[string, (w: World) => void]> = [
      ['变小', (w) => fs.truncateSync(abs(w, 'P/a.jsonl'), 3000)],
      ['等长 mtime 变（改中段一个数字）', (w) => { const p = abs(w, 'P/a.jsonl'); const d = fs.readFileSync(p); const i = d.indexOf('"output_tokens":', 4000) + 16; d[i] = d[i] === 0x35 ? 0x36 : 0x35; fs.writeFileSync(p, d); }],
      ['头部改写 + 变长', (w) => { const p = abs(w, 'P/a.jsonl'); const d = fs.readFileSync(p); d[10] = 0x5a; fs.writeFileSync(p, Buffer.concat([d, Buffer.from(line('mx', T + 9e6))])); }],
      ['已消费尾部改写 + 变长', (w) => { const p = abs(w, 'P/a.jsonl'); const d = fs.readFileSync(p); d[d.length - 30] = 0x5a; fs.writeFileSync(p, Buffer.concat([d, Buffer.from(line('mx', T + 9e6))])); }],
      ['删除后重建为更短内容', (w) => { fs.rmSync(abs(w, 'P/a.jsonl')); put(w, 'P/a.jsonl', line('only', T)); }],
    ];
    for (const [name, mutate] of cases) {
      const w = mk();
      const { store } = mkStore(w);
      await store.start();
      const f0 = store.metrics.fullParses;
      const inc0 = store.metrics.incrementalParses;
      mutate(w);
      bump(w, abs(w, 'P/a.jsonl'));
      await store.refreshNow();
      expect(store.metrics.fullParses, name).toBe(f0 + 1);
      expect(store.metrics.incrementalParses, name).toBe(inc0);
      await check(store, w, name);
      store.close();
    }
  });

  it('firstTs：首行无时间戳的文件在增量补到第一个时间戳后，所有权按该时间戳计算；截断重写为更晚的开头后所有权随之转移', async () => {
    const w = newWorld();
    put(w, 'B/b.jsonl', modeLine(T + 5000) + line('M', T + 6000, { out: 1, session: 'sb' }));
    put(w, 'A/a.jsonl', modeLine()); // 无时间戳
    const { store } = mkStore(w);
    await store.start();
    await check(store, w, '初始');
    append(w, 'A/a.jsonl', line('M', T + 1000, { out: 5, session: 'sa' })); // A 的第一个时间戳 T+1000 < B 的 T+5000
    await store.refreshNow();
    await check(store, w, 'A 补到更早的 firstTs');
    expect(store.getView().records.find((r) => r.messageId === 'M')!.sourceFile).toBe('A/a.jsonl');
    // 重写 A：开头改为更晚的时间戳（并变短）
    put(w, 'A/a.jsonl', modeLine(T + 90_000) + line('M', T + 91_000, { out: 5, session: 'sa' }));
    await store.refreshNow();
    await check(store, w, 'A 重写为更晚');
    expect(store.getView().records.find((r) => r.messageId === 'M')!.sourceFile).toBe('B/b.jsonl');
    // 重写 A 为更长且更早
    put(w, 'A/a.jsonl', modeLine(T) + line('x1', T + 1) + line('x2', T + 2) + line('M', T + 3, { out: 9, session: 'sa' }));
    await store.refreshNow();
    await check(store, w, 'A 重写为更早');
    expect(store.getView().records.find((r) => r.messageId === 'M')!.sourceFile).toBe('A/a.jsonl');
    store.close();
  });

  it('同一 id 在跨文件后出现：恢复会话先于原始出现、删除所有权文件后转交，总量不丢（每步 == 全量）', async () => {
    const w = newWorld();
    put(w, 'P/resume.jsonl', modeLine(T + 10_000) + line('X', T + 1000, { out: 3, session: 'r' }) + line('Y', T + 2000, { out: 4, session: 'r' }));
    const { store } = mkStore(w);
    await store.start();
    await check(store, w, '仅副本');
    put(w, 'P/orig.jsonl', modeLine(T) + line('X', T + 1000, { out: 9, session: 'o' }) + line('Z', T + 3000, { session: 'o' }));
    await store.refreshNow();
    await check(store, w, '原始出现');
    const x = store.getView().records.find((r) => r.messageId === 'X')!;
    expect([x.sourceFile, x.sessionId, x.output]).toEqual(['P/orig.jsonl', 'o', 9]);
    expect(store.getView().stats.crossFileDuplicates).toBe(1);
    fs.rmSync(abs(w, 'P/orig.jsonl'));
    await store.refreshNow();
    await check(store, w, '删除原始');
    const x2 = store.getView().records.find((r) => r.messageId === 'X')!;
    expect([x2.sourceFile, x2.output]).toEqual(['P/resume.jsonl', 3]);
    expect(store.getView().stats.crossFileDuplicates).toBe(0);
    store.close();
  });

  it('已记录的设计局限：中段被原地改写且大小/头尾不变、mtime 也恢复 → 不会被发现（用 rebuild() 兜底）', async () => {
    const w = newWorld();
    let body = '';
    for (let i = 0; i < 200; i++) body += line('m' + i, T + i * 1000, { out: 100 });
    put(w, 'P/a.jsonl', body);
    const { store, sfs } = mkStore(w);
    await store.start();
    const p = abs(w, 'P/a.jsonl');
    const st = fs.statSync(p);
    const d = fs.readFileSync(p);
    const i = d.indexOf('"output_tokens":100', 20_000) + 16;
    d[i + 2] = 0x39; // 100 -> 109 （同长度）
    fs.writeFileSync(p, d);
    fs.utimesSync(p, st.atime, st.mtime); // 恢复 mtime
    const b0 = sfs.bytesRead;
    await store.refreshNow();
    expect(sfs.bytesRead).toBe(b0); // 大小/mtime 都没变 → 零读取（符合规则，也是局限）
    expect((await parseDataRoot(w.root)).stats.uniqueMessages).toBe(200);
    expect(store.getView().records.reduce((a, r) => a + r.output, 0)).toBe(200 * 100);
    await store.rebuild();
    expect(store.getView().records.reduce((a, r) => a + r.output, 0)).toBe(200 * 100 + 9);
    store.close();
  });

  it('refreshNow 并发合并（单飞）：同时触发多次只产生有限次扫描，全部 resolve，结果正确', async () => {
    const w = newWorld(true);
    const { store } = mkStore(w);
    await store.start();
    const s0 = store.metrics.scans;
    append(w, 'D--Work-beta/bbbbbbbb-0000-4000-8000-000000000000.jsonl', line('burst', T + 77e6));
    const ps = Array.from({ length: 12 }, () => store.refreshNow());
    await Promise.all(ps);
    expect(store.metrics.scans - s0).toBeLessThanOrEqual(2);
    expect(store.getStatus().state).toBe('idle');
    await check(store, w, '并发');
    store.close();
  });

  it('dataVersion 严格单调；进度（filesDone/bytesDone）在一次扫描内单调不减；全量期间 state=scanning', async () => {
    const w = newWorld();
    for (let f = 0; f < 6; f++) {
      let body = '';
      for (let i = 0; i < 300; i++) body += line(`f${f}-${i}`, T + f * 1e6 + i * 1000, { session: 's' + f });
      put(w, `P${f % 2}/s${f}.jsonl`, body);
    }
    const { store } = mkStore(w, { chunkSize: 4096, concurrency: 2 });
    const versions: number[] = [];
    const prog: Array<[number, number, number]> = [];
    let sawScanning = false;
    store.onChange((e) => {
      versions.push(e.status.dataVersion);
      if (e.status.state === 'scanning') {
        sawScanning = true;
        prog.push([e.status.filesDone, e.status.bytesDone, e.status.filesTotal]);
      }
    });
    await store.start();
    expect(sawScanning).toBe(true);
    for (let i = 1; i < versions.length; i++) expect(versions[i]).toBeGreaterThanOrEqual(versions[i - 1]!);
    for (let i = 1; i < prog.length; i++) {
      expect(prog[i]![0]).toBeGreaterThanOrEqual(prog[i - 1]![0]);
      expect(prog[i]![1]).toBeGreaterThanOrEqual(prog[i - 1]![1]);
    }
    expect(new Set(prog.map((p) => p[1])).size).toBeGreaterThan(1);
    const st = store.getStatus();
    expect([st.state, st.filesDone, st.filesTotal]).toEqual(['idle', 6, 6]);
    expect(st.bytesDone).toBe(st.bytesTotal);
    expect(st.lastScanAt).not.toBeNull();
    store.close();
  });
});

// ---------------------------------------------------------------------------
// 3. 缓存
// ---------------------------------------------------------------------------
function cachePath(w: World): string {
  return path.join(w.app, ...CACHE_FILE.split('/'));
}
function rewriteCache(w: World, f: (text: string) => string): void {
  const text = zlib.gunzipSync(fs.readFileSync(cachePath(w))).toString('utf8');
  fs.writeFileSync(cachePath(w), zlib.gzipSync(Buffer.from(f(text))));
}

describe('缓存', () => {
  it('写入后再启动：读缓存、零读取零解析、视图与全量一致；应用数据目录里只有一个缓存文件、没有 tmp 残留', async () => {
    const w = newWorld(true);
    const a = mkStore(w);
    await a.store.start();
    const files = fs.readdirSync(path.join(w.app, 'cache'));
    expect(files).toEqual(['usage-cache.json.gz']);
    a.store.close();
    const b = mkStore(w);
    await b.store.init();
    expect(b.store.metrics.cacheLoad).toBe('loaded');
    expect([b.sfs.opens, b.sfs.bytesRead]).toEqual([0, 0]);
    await check(b.store, w, '仅缓存');
    await b.store.refreshNow();
    expect([b.sfs.opens, b.store.metrics.fullParses, b.store.metrics.incrementalParses]).toEqual([0, 0, 0]);
    expect(b.store.getView().dataVersion).toBe(1);
    b.store.close();
  });

  it('schemaVersion 不符 → 丢弃并全量重建（结果正确）；之后写出的新缓存带当前版本', async () => {
    const w = newWorld(true);
    const a = mkStore(w);
    await a.store.start();
    a.store.close();
    rewriteCache(w, (t) => t.replace(/"schemaVersion":\d+/, '"schemaVersion":999'));
    const b = mkStore(w);
    await b.store.init();
    expect(b.store.metrics.cacheLoad).toMatch(/^discarded:/);
    expect(b.store.getView().records.length).toBe(0);
    await b.store.refreshNow();
    expect(b.store.metrics.fullParses).toBe(14);
    await check(b.store, w, '版本不符');
    expect(zlib.gunzipSync(fs.readFileSync(cachePath(w))).toString('utf8')).not.toContain('"schemaVersion":999');
    b.store.close();
  });

  it('各种损坏的缓存文件：不崩溃、丢弃并回退全量，结果正确', async () => {
    const w = newWorld(true);
    const a = mkStore(w);
    await a.store.start();
    a.store.close();
    const good = fs.readFileSync(cachePath(w));
    const goodText = zlib.gunzipSync(good).toString('utf8');
    const gz = (s: string): Buffer => zlib.gzipSync(Buffer.from(s));
    const lines = goodText.split('\n').filter(Boolean);
    const variants: Array<[string, Buffer]> = [
      ['零字节', Buffer.alloc(0)],
      ['gzip 截断一半', good.subarray(0, Math.floor(good.length / 2))],
      ['gzip 只剩头 10 字节', good.subarray(0, 10)],
      ['随机垃圾', Buffer.from(Array.from({ length: 500 }, (_, i) => (i * 131 + 7) & 255))],
      ['合法 gzip 但内容不是 JSON', gz('not json at all\n')],
      ['缺 end 记录', gz(lines.slice(0, -1).join('\n') + '\n')],
      ['缺 head 记录', gz(lines.slice(1).join('\n') + '\n')],
      ['少一个 rows 批次', gz(lines.filter((l, i) => !(l.startsWith('{"t":"rows"') && i === lines.findIndex((x) => x.startsWith('{"t":"rows"')))).join('\n') + '\n')],
      ['某行 JSON 被截断', gz(lines.map((l, i) => (i === 3 ? l.slice(0, l.length - 7) : l)).join('\n') + '\n')],
      ['size 字段变成字符串', gz(goodText.replace(/"size":(\d+)/, '"size":"$1"'))],
      ['stats 字段缺失', gz(goodText.replace(/"linesRead":\d+,/, ''))],
      ['未知记录类型', gz(goodText + '{"t":"weird"}\n')],
      ['rows 中 ts 不是数字', gz(goodText.replace(/"ts":\d+/, '"ts":"x"'))],
      ['数据根不同', gz(goodText.replace(/"dataRoot":"[^"]*"/, '"dataRoot":"z:\\\\elsewhere"'))],
      ['行内 NUL 与乱码', Buffer.concat([good.subarray(0, 40), Buffer.from([0, 0, 0, 255, 254]), good.subarray(40)])],
    ];
    for (const [name, data] of variants) {
      fs.writeFileSync(cachePath(w), data);
      const s = mkStore(w);
      await s.store.init();
      expect(s.store.metrics.cacheLoad, name).toMatch(/^(discarded:|missing)/);
      await s.store.refreshNow();
      expect(s.store.getStatus().state, name).toBe('idle');
      await check(s.store, w, `损坏缓存：${name}`);
      s.store.close();
    }
  });

  it('缓存装载后，关闭期间的离线变更（追加/删除/截断/新增）被正确增量处理 == 全量', async () => {
    const w = newWorld(true);
    const a = mkStore(w);
    await a.store.start();
    a.store.close();
    append(w, 'D--Work-alpha/a1a1a1a1-0000-4000-8000-000000000001.jsonl', line('off1', Date.parse('2026-10-20T00:00:00Z')));
    fs.rmSync(abs(w, 'D--Work-beta/bbbbbbbb-0000-4000-8000-000000000001.jsonl'));
    fs.truncateSync(abs(w, 'D--Work-beta/bbbbbbbb-0000-4000-8000-000000000002.jsonl'), 500);
    bump(w, abs(w, 'D--Work-beta/bbbbbbbb-0000-4000-8000-000000000002.jsonl'));
    put(w, 'NEW/new.jsonl', line('newid', Date.parse('2026-10-21T00:00:00Z')));
    const b = mkStore(w);
    await b.store.start();
    expect(b.store.metrics.cacheLoad).toBe('loaded');
    expect(b.store.metrics.fullParses).toBeLessThanOrEqual(3); // 截断的 + 新增的（+ 可能 1 个）
    await check(b.store, w, '离线变更');
    b.store.close();
  });

  it('隐私：解压后的缓存不含对话正文/思考/工具 input/meta/prefix 内容；标题 ≤ 40 字符', async () => {
    const w = newWorld(true);
    const longTitle = '这是一个很长的会话标题'.repeat(8) + ' SECRET_BODY_MARKER 尾部';
    put(w, 'D--Work-alpha/a1a1a1a1-0000-4000-8000-000000000002/custom-title.json', JSON.stringify({ customTitle: longTitle, other: 'Please refactor SECRET_BODY_MARKER' }));
    const a = mkStore(w);
    await a.store.start();
    a.store.close();
    const text = zlib.gunzipSync(fs.readFileSync(cachePath(w))).toString('utf8');
    // 批次 B：首条真人消息前 ≤ 40 字可作标题
    for (const bad of ['SECRET_BODY_MARKER', 'keep going', 'reply text', 'prefix body', 'echo ', 'thinking about', 'this tail must never']) expect(text, bad).not.toContain(bad);
    const titles = text.split('\n').filter((l) => l.startsWith('{"t":"title"')).map((l) => JSON.parse(l));
    expect(titles.length).toBeGreaterThan(0);
    for (const t of titles) if (t.title) expect(Array.from(t.title as string).length).toBeLessThanOrEqual(40);
    expect(titles.find((t) => t.relPath.includes('0002'))!.title).toBe(Array.from(longTitle).slice(0, 40).join(''));
    // 缓存里出现过的全部 JSON 键：不应有 content / text / message / input 这类正文承载键
    const keys = new Set<string>();
    const walk = (o: unknown): void => {
      if (Array.isArray(o)) o.forEach(walk);
      else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { keys.add(k); walk(v); }
    };
    for (const l of text.split('\n').filter(Boolean)) walk(JSON.parse(l));
    for (const k of ['content', 'text', 'message', 'prompt', 'customTitle']) expect(keys.has(k), `键 ${k}`).toBe(false);
  });

  it('只写应用数据目录：应用数据目录被误配进数据根 → 缓存写入被拒、数据根不变、扫描照常、给出警告', async () => {
    const w = newWorld(true);
    const before = JSON.stringify(snapshotDir(w.root));
    const s = mkStore({ ...w, app: path.join(w.root, 'appdata-inside') });
    await s.store.start();
    expect(JSON.stringify(snapshotDir(w.root))).toBe(before);
    expect(fs.existsSync(path.join(w.root, 'appdata-inside'))).toBe(false);
    expect(s.store.getStatus().warnings.join('\n')).toMatch(/缓存/);
    expect(s.store.getStatus().state).toBe('idle');
    await check(s.store, w, '误配');
    s.store.close();
    // 应用数据目录 == 数据根本身
    const s2 = mkStore({ ...w, app: w.root });
    await s2.store.start();
    expect(JSON.stringify(snapshotDir(w.root))).toBe(before);
    s2.store.close();
  });

  it('整个扫描（全量 + 增量 + rebuild）期间数据根 (路径,大小,mtime) 不变；写入只发生在应用数据目录', async () => {
    const w = newWorld(true);
    const before = JSON.stringify(snapshotDir(w.root));
    const s = mkStore(w);
    await s.store.start();
    await s.store.refreshNow();
    await s.store.rebuild();
    expect(JSON.stringify(snapshotDir(w.root))).toBe(before);
    expect(fs.existsSync(w.app)).toBe(true);
    // 读取过的路径只有 .jsonl 与 custom-title.json（不含 meta / prefix）
    const seen = new Set<string>();
    const sfs = createSafeFs({ onRead: (p) => seen.add(path.basename(p)) });
    const t = new Store({ dataRoot: w.root, appDataDir: path.join(w.base, 'app-x'), fs: sfs });
    await t.start();
    for (const n of seen) expect(n.endsWith('.jsonl') || n === 'custom-title.json', n).toBe(true);
    t.close();
    s.store.close();
  });
});

// ---------------------------------------------------------------------------
// 4. 数据根错误 / 恢复；监视器
// ---------------------------------------------------------------------------
describe('数据根错误与恢复', () => {
  it('不存在 → state=error 且 lastError 为中文可读原因，进程不崩溃；创建后下一次刷新自动恢复；再次消失 → error 但保留已有数据', async () => {
    const w = newWorld();
    fs.rmSync(w.root, { recursive: true });
    const { store } = mkStore(w);
    await store.start();
    const st = store.getStatus();
    expect(st.state).toBe('error');
    expect(st.lastError).toMatch(/数据根目录不存在/);
    expect(st.lastError).toContain(w.root);
    fs.mkdirSync(w.root, { recursive: true });
    put(w, 'P/a.jsonl', line('m1', Date.parse('2026-10-10T00:00:00Z')));
    await store.refreshNow();
    expect(store.getStatus().state).toBe('idle');
    expect(store.getStatus().lastError).toBeUndefined();
    expect(store.getView().stats.uniqueMessages).toBe(1);
    fs.rmSync(w.root, { recursive: true });
    await store.refreshNow();
    expect(store.getStatus().state).toBe('error');
    expect(store.getView().stats.uniqueMessages).toBe(1);
    fs.mkdirSync(w.root, { recursive: true });
    await store.refreshNow();
    expect(store.getStatus().state).toBe('idle');
    expect(store.getView().stats.uniqueMessages).toBe(0); // 目录里确实没有文件了
    store.close();
  });

  it('数据根是个文件 → 可读错误，不崩溃', async () => {
    const w = newWorld();
    fs.rmSync(w.root, { recursive: true });
    fs.writeFileSync(w.root, 'x');
    const { store } = mkStore(w);
    await store.start();
    expect(store.getStatus().state).toBe('error');
    expect(store.getStatus().lastError).toMatch(/[\u4e00-\u9fa5]/);
    store.close();
  });

  it('运行中写入 损坏行 / 空文件 / 缺字段记录：不崩溃，corruptLines/emptyFiles/missingUsage 各 +1，重复扫描不再增加', async () => {
    const w = newWorld(true);
    const { store } = mkStore(w);
    await store.start();
    const s0 = { ...store.getView().stats };
    append(w, 'D--Work-alpha/a1a1a1a1-0000-4000-8000-000000000002.jsonl', '{"type":"assistant","message":{"id":"x\n');
    put(w, 'D--Work-alpha/empty-new.jsonl', '');
    append(w, 'D--Work-beta/bbbbbbbb-0000-4000-8000-000000000000.jsonl', JSON.stringify({ type: 'assistant', timestamp: '2026-10-22T00:00:00Z', message: { id: 'nousage', model: 'claude-x' } }) + '\n');
    for (let i = 0; i < 3; i++) await store.refreshNow();
    const s1 = store.getView().stats;
    expect([s1.corruptLines - s0.corruptLines, s1.emptyFiles - s0.emptyFiles, s1.missingUsage - s0.missingUsage]).toEqual([1, 1, 1]);
    expect(store.getStatus().state).toBe('idle');
    await check(store, w, '运行时容错');
    store.close();
  });
});

describe('Watcher', () => {
  it('轮询间隔钳制到 2–60 s；到点自动刷新并发布新数据；stop 后不再刷新', async () => {
    const w = newWorld();
    put(w, 'P/a.jsonl', line('m1', Date.parse('2026-10-10T00:00:00Z')));
    const { store } = mkStore(w);
    await store.start();
    expect(new Watcher(store, { intervalMs: 100 }).intervalMs).toBe(2000);
    expect(new Watcher(store, { intervalMs: 9_999_999 }).intervalMs).toBe(60_000);
    expect(new Watcher(store, { intervalMs: 7000 }).intervalMs).toBe(7000);
    const wt = new Watcher(store, { intervalMs: 60, minIntervalMs: 60 });
    wt.start();
    const v0 = store.getView().dataVersion;
    append(w, 'P/a.jsonl', line('m2', Date.parse('2026-10-10T00:00:05Z')));
    const t0 = Date.now();
    while (store.getView().dataVersion === v0 && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 20));
    expect(store.getView().dataVersion).toBeGreaterThan(v0);
    expect(store.getView().stats.uniqueMessages).toBe(2);
    wt.stop();
    await store.idle();
    const scans = store.metrics.scans;
    await new Promise((r) => setTimeout(r, 300));
    expect(store.metrics.scans).toBe(scans);
    await check(store, w, 'watcher');
    store.close();
  });
});

describe('杂项', () => {
  it('rebuild：丢弃状态与缓存并全量重解析，结果不变', async () => {
    const w = newWorld(true);
    const { store } = mkStore(w);
    await store.start();
    const recs = JSON.stringify(store.getView().records);
    const fp = store.metrics.fullParses;
    await store.rebuild();
    expect(store.metrics.fullParses - fp).toBe(14);
    expect(JSON.stringify(store.getView().records)).toBe(recs);
    expect(store.getStatus().phase).toBe('full');
    store.close();
  });

  it('switchDataRoot：切到另一个根后视图只含新根数据（缓存按根区分）', async () => {
    const w = newWorld(true);
    const w2 = newWorld();
    put(w2, 'Q/q.jsonl', line('qq', Date.parse('2026-10-10T00:00:00Z')));
    const { store } = mkStore(w);
    await store.start();
    await store.switchDataRoot(w2.root);
    expect(store.getView().stats.uniqueMessages).toBe(1);
    expect(store.getView().records[0]!.messageId).toBe('qq');
    await store.switchDataRoot(w.root);
    expect(store.getView().stats.uniqueMessages).toBe(59);
    store.close();
    void os;
  });
});

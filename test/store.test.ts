import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { aggregate } from '../src/server/core/aggregate.ts';
import { dedupeGlobal, dedupeGlobalAsync } from '../src/server/core/dedupe.ts';
import type { DedupeFileInput } from '../src/server/core/dedupe.ts';
import { listUsageFiles, parseDataRoot } from '../src/server/core/loadRoot.ts';
import { parseFileRange } from '../src/server/core/parser.ts';
import { buildProjectIndex } from '../src/server/core/projects.ts';
import { createSafeFs } from '../src/server/core/safeFs.ts';
import { CACHE_FILE, CACHE_SCHEMA_VERSION } from '../src/server/store/cache.ts';
import { Store } from '../src/server/store/store.ts';
import type { ChangeEvent } from '../src/server/store/store.ts';
import { assistantLine, baseQuery, FIXTURE_ROOT, loadExpected, MARKER, snapshotDir } from './helpers.ts';
import type { Expected } from './helpers.ts';
import { expectViewEqualsFull, genBigRoot, genCrossFileSources, readSources, runAppendScenario, tmpWorld } from './storeHelpers.ts';

const expected: Expected = loadExpected();
const A1 = 'D--Work-alpha/a1a1a1a1-0000-4000-8000-000000000001.jsonl';
const A2 = 'D--Work-alpha/a1a1a1a1-0000-4000-8000-000000000002.jsonl';

function cacheAbs(app: string): string {
  return path.join(app, ...CACHE_FILE.split('/'));
}

describe('store：冷启动全量（验收 1）', () => {
  it('fixture：全量扫描结果 == 一次性解析 == expected；聚合结果也相同', async () => {
    const w = tmpWorld();
    try {
      const store = new Store({ dataRoot: FIXTURE_ROOT, appDataDir: w.app });
      await store.start();
      const full = await parseDataRoot(FIXTURE_ROOT);
      const v = store.getView();
      expect(v.records).toEqual(full.records);
      expect(v.stats).toEqual(full.stats);
      expect(v.stats.uniqueMessages).toBe(expected.stats.uniqueMessages);
      expect(v.stats.crossFileDuplicates).toBe(expected.stats.crossFileDuplicates);
      expect(v.stats.corruptLines).toBe(expected.stats.corruptLines);
      expect(v.stats.emptyFiles).toBe(expected.stats.emptyFiles);
      expect(v.folderKeys).toHaveLength(expected.projectFolderCount);
      expect(store.getStatus()).toMatchObject({ state: 'idle', phase: 'full', filesDone: 14, filesTotal: 14, dataVersion: 1 });
      expect(store.getStatus().lastScanAt).not.toBeNull();
      expect(v.lastRecordTs).toBe(Math.max(...v.records.map((r) => r.ts)));
      // 与阶段 2 一次性计算的聚合结果一致
      const mk = (records: typeof v.records, keys: string[]) => ({ records, projects: buildProjectIndex(records, { folderKeys: keys }) });
      const a = aggregate(mk(v.records, v.folderKeys), baseQuery({ split: 'model' }));
      const b = aggregate(mk(full.records, full.files.map((f) => f.info.projectKey)), baseQuery({ split: 'model' }));
      expect(a).toEqual(b);
      expect(a.summary.total).toBe(expected.totals.total);
      store.close();
    } finally {
      w.cleanup();
    }
  });

  it('会话标题：只取 custom-title.json 的 customTitle（≤ 40 字符）；更新 / 删除 / 损坏文件都正确', async () => {
    const w = tmpWorld();
    try {
      const store = new Store({ dataRoot: w.root, appDataDir: w.app });
      await store.start();
      const sid = 'a1a1a1a1-0000-4000-8000-000000000001';
      expect(store.getView().titles.get(sid)).toBe('Refactor the parser');
      const tf = path.join(w.root, 'D--Work-alpha', sid, 'custom-title.json');
      const v0 = store.getView().dataVersion;
      fs.writeFileSync(tf, JSON.stringify({ customTitle: `${'很长的标题'.repeat(20)}\n含换行`, other: MARKER }));
      await store.refreshNow();
      const t = store.getView().titles.get(sid)!;
      expect(Array.from(t)).toHaveLength(40);
      expect(t).not.toContain('\n');
      expect(store.getView().dataVersion).toBeGreaterThan(v0);
      fs.writeFileSync(tf, '{not json');
      await store.refreshNow();
      expect(store.getView().titles.has(sid)).toBe(false);
      fs.writeFileSync(tf, JSON.stringify({ customTitle: '  ' }));
      await store.refreshNow();
      expect(store.getView().titles.has(sid)).toBe(false);
      fs.writeFileSync(tf, JSON.stringify({ customTitle: '回来了' }));
      await store.refreshNow();
      expect(store.getView().titles.get(sid)).toBe('回来了');
      fs.rmSync(tf);
      await store.refreshNow();
      expect(store.getView().titles.size).toBe(0);
      // 缓存里没有标题以外的字段（other: MARKER 不会被存）
      store.close();
      const text = zlib.gunzipSync(fs.readFileSync(cacheAbs(w.app))).toString('utf8');
      expect(text).not.toContain(MARKER);
    } finally {
      w.cleanup();
    }
  });
});

describe('store：缓存与冷启动（验收 1、8 的 fixture 版）', () => {
  it('第二次启动读缓存：结果完全一致，且没有重新解析任何文件（打开次数 / 解析计数 / 读取字节均为 0）', async () => {
    const w = tmpWorld();
    try {
      const s1 = new Store({ dataRoot: w.root, appDataDir: w.app });
      await s1.start();
      const first = s1.getView();
      expect(s1.metrics.fullParses).toBe(14);
      expect(fs.existsSync(cacheAbs(w.app))).toBe(true);
      s1.close();

      const counting = createSafeFs();
      const s2 = new Store({ dataRoot: w.root, appDataDir: w.app, fs: counting });
      await s2.init(); // 只读缓存
      expect(s2.metrics.cacheLoad).toBe('loaded');
      expect(s2.getView().records).toEqual(first.records);
      expect(s2.getView().stats).toEqual(first.stats);
      expect(s2.getView().titles).toEqual(first.titles);
      expect(s2.getView().dataVersion).toBe(1);
      expect(counting.opens).toBe(0);
      await s2.refreshNow(); // 再扫描一次：文件都没变
      expect(s2.metrics.fullParses).toBe(0);
      expect(s2.metrics.incrementalParses).toBe(0);
      expect(counting.opens).toBe(0);
      expect(counting.bytesRead).toBe(0);
      expect(s2.getView().dataVersion).toBe(1); // 没变化 → dataVersion 不增
      expect(s2.metrics.cacheSaves).toBe(0);
      s2.close();
    } finally {
      w.cleanup();
    }
  });

  it('启动后文件有变化：只处理变化的文件', async () => {
    const w = tmpWorld();
    try {
      const s1 = new Store({ dataRoot: w.root, appDataDir: w.app });
      await s1.start();
      s1.close();
      fs.appendFileSync(path.join(w.root, ...A2.split('/')), `${assistantLine({ id: 'msg_offline', input: 7, out: 7, ts: '2026-10-09T00:00:00.000Z' })}\n`);
      const s2 = new Store({ dataRoot: w.root, appDataDir: w.app });
      await s2.start();
      expect(s2.metrics.fullParses).toBe(0);
      expect(s2.metrics.incrementalParses).toBe(1);
      await expectViewEqualsFull(s2, w.root);
      s2.close();
    } finally {
      w.cleanup();
    }
  });

  it('缓存只落在应用数据目录；数据根目录前后快照不变；缓存不含对话正文', async () => {
    const w = tmpWorld(false);
    try {
      const before = snapshotDir(FIXTURE_ROOT);
      const store = new Store({ dataRoot: FIXTURE_ROOT, appDataDir: w.app });
      await store.start();
      await store.rebuild();
      store.close();
      expect(snapshotDir(FIXTURE_ROOT)).toEqual(before);
      expect(fs.readdirSync(w.app)).toEqual(['cache']);
      const text = zlib.gunzipSync(fs.readFileSync(cacheAbs(w.app))).toString('utf8');
      // 首条真人消息只允许保留前 ≤ 40 字作为标题（批次 B）：'Please refactor' 可以出现，其后的内容不行
      for (const bad of [MARKER, 'SECRET', 'keep going', 'reply text', 'echo ', 'prefix body']) expect(text).not.toContain(bad);
      expect(JSON.parse(text.split('\n')[0]!)).toMatchObject({ t: 'head', schemaVersion: CACHE_SCHEMA_VERSION });
    } finally {
      w.cleanup();
    }
  });

  it('应用数据目录位于数据根之内：写缓存被拒绝（警告），数据根不被写入，扫描照常工作', async () => {
    const w = tmpWorld();
    try {
      const evilApp = path.join(w.root, 'appdata');
      const before = snapshotDir(w.root);
      const store = new Store({ dataRoot: w.root, appDataDir: evilApp });
      await store.start();
      expect(store.getView().stats.uniqueMessages).toBe(expected.stats.uniqueMessages);
      expect(store.getStatus().warnings.some((x) => x.includes('写入缓存失败'))).toBe(true);
      expect(fs.existsSync(evilApp)).toBe(false);
      expect(snapshotDir(w.root)).toEqual(before);
      store.close();
    } finally {
      w.cleanup();
    }
  });

  it('缓存损坏 / 截断 / 版本不符 / 数据根不同：丢弃并全量重建，不崩溃，结果正确', async () => {
    const w = tmpWorld();
    try {
      const s0 = new Store({ dataRoot: w.root, appDataDir: w.app });
      await s0.start();
      s0.close();
      const file = cacheAbs(w.app);
      const good = fs.readFileSync(file);
      const lines = zlib.gunzipSync(good).toString('utf8').split('\n').filter(Boolean);

      const variants: Array<[string, Buffer]> = [
        ['随机垃圾', Buffer.from('this is not gzip at all')],
        ['gzip 被截断', good.subarray(0, Math.floor(good.length / 2))],
        ['空文件', Buffer.alloc(0)],
        ['版本不符', zlib.gzipSync(lines.map((l, i) => (i === 0 ? JSON.stringify({ ...JSON.parse(l), schemaVersion: CACHE_SCHEMA_VERSION + 1 }) : l)).join('\n') + '\n')],
        ['缺少结尾记录', zlib.gzipSync(lines.slice(0, -1).join('\n') + '\n')],
        ['行内容被破坏', zlib.gzipSync(lines.map((l, i) => (i === 3 ? l.slice(0, 20) : l)).join('\n') + '\n')],
        ['rows 里的类型不对', zlib.gzipSync(lines.map((l) => (l.startsWith('{"t":"rows"') ? l.replace('"ts":', '"ts":"x","tsOrig":') : l)).join('\n') + '\n')],
      ];
      for (const [name, data] of variants) {
        fs.writeFileSync(file, data);
        const s = new Store({ dataRoot: w.root, appDataDir: w.app });
        await s.start();
        expect(s.metrics.cacheLoad.startsWith('discarded:'), `${name}: ${s.metrics.cacheLoad}`).toBe(true);
        expect(s.metrics.fullParses, name).toBe(14); // 全量重建
        await expectViewEqualsFull(s, w.root, name);
        expect(s.metrics.cacheSaves).toBe(1); // 重建后写回了新缓存
        s.close();
      }
      // 数据根不同：用同一个缓存换一个数据根
      const other = path.join(w.root, '..', 'other-root');
      fs.cpSync(FIXTURE_ROOT, other, { recursive: true });
      const s = new Store({ dataRoot: other, appDataDir: w.app });
      await s.start();
      expect(s.metrics.cacheLoad).toMatch(/discarded:.*数据根/);
      await expectViewEqualsFull(s, other);
      s.close();
    } finally {
      w.cleanup();
    }
  });

  it('原子写：保存过程中不会留下临时文件', async () => {
    const w = tmpWorld();
    try {
      const store = new Store({ dataRoot: w.root, appDataDir: w.app });
      await store.start();
      for (let i = 0; i < 3; i++) {
        fs.appendFileSync(path.join(w.root, ...A2.split('/')), `${assistantLine({ id: `msg_x${i}`, ts: '2026-10-09T00:00:00.000Z' })}\n`);
        await store.refreshNow();
      }
      expect(fs.readdirSync(path.join(w.app, 'cache'))).toEqual(['usage-cache.json.gz']);
      store.close();
    } finally {
      w.cleanup();
    }
  });
});

describe('store：增量（验收 2）', () => {
  it('追加半行 → 补全：dataVersion 仅在新记录出现时增加；只读新增字节；已有记录不被重复计入', async () => {
    const w = tmpWorld();
    try {
      // 先放一个较大的文件，使"读取字节数 ≈ 追加字节数"有区分度
      const big = path.join(w.root, 'D--Work-alpha', 'big-session.jsonl');
      const lines: string[] = [];
      for (let i = 0; i < 1500; i++) lines.push(assistantLine({ id: `msg_big_${i}`, ts: new Date(Date.UTC(2026, 9, 6) + i * 1000).toISOString(), out: i, session: 'big' }));
      fs.writeFileSync(big, `${lines.join('\n')}\n`);
      const size0 = fs.statSync(big).size;
      expect(size0).toBeGreaterThan(300_000);

      const counting = createSafeFs();
      const store = new Store({ dataRoot: w.root, appDataDir: w.app, fs: counting });
      await store.start();
      const uniq0 = store.getView().stats.uniqueMessages;
      const dup0 = store.getView().stats.duplicatesDropped;
      const v0 = store.getView().dataVersion;
      const b0 = counting.bytesRead;

      const line = assistantLine({ id: 'msg_new', ts: '2026-10-07T00:00:00.000Z', input: 11, out: 22, session: 'big' });
      const half = line.slice(0, 80);
      fs.appendFileSync(big, half);
      await store.refreshNow();
      expect(store.getView().dataVersion).toBe(v0); // 半行：视图不变
      expect(store.getView().stats.corruptLines).toBe(expected.stats.corruptLines); // 半行不算损坏行
      const read1 = counting.bytesRead - b0;
      expect(read1).toBeLessThan(Buffer.byteLength(half) + 2 * 4096 + 64);

      const b1 = counting.bytesRead;
      fs.appendFileSync(big, `${line.slice(80)}\n`);
      await store.refreshNow();
      const read2 = counting.bytesRead - b1;
      expect(store.getView().dataVersion).toBeGreaterThan(v0);
      expect(store.getView().stats.uniqueMessages).toBe(uniq0 + 1);
      expect(store.getView().stats.duplicatesDropped).toBe(dup0);
      expect(store.getView().records.find((r) => r.messageId === 'msg_new')).toMatchObject({ input: 11, output: 22, sessionId: 'big' });
      // 只读了"半行 + 补全部分"（= 整行）加几个 4 KB 哈希窗口（校验头 / 尾、更新尾），远小于文件大小
      expect(read2).toBeLessThan(Buffer.byteLength(line) + 1 + 3 * 4096 + 64);
      expect(read2).toBeLessThan(size0 / 10);
      expect(store.metrics.incrementalParses).toBe(2);
      expect(store.metrics.fullParses).toBe(15);
      await expectViewEqualsFull(store, w.root);
      store.close();
    } finally {
      w.cleanup();
    }
  });

  it('追加一条与已有 message 相同 id 的行（流式重复）：不重复计入，usage 取最大值', async () => {
    const w = tmpWorld();
    try {
      const store = new Store({ dataRoot: w.root, appDataDir: w.app });
      await store.start();
      const before = store.getView().records.find((r) => r.messageId === 'msg_alpha_grow')!;
      fs.appendFileSync(path.join(w.root, ...A1.split('/')), '');
      const target = path.join(w.root, ...A2.split('/'));
      fs.appendFileSync(target, `${assistantLine({ id: 'msg_alpha_grow', ts: '2026-10-05T01:01:00.900Z', out: 9999, model: 'claude-opus-5-5' })}\n`);
      await store.refreshNow();
      const after = store.getView().records.find((r) => r.messageId === 'msg_alpha_grow')!;
      expect(after.output).toBe(9999);
      expect(after.sourceFile).toBe(before.sourceFile);
      expect(store.getView().stats.uniqueMessages).toBe(expected.stats.uniqueMessages);
      expect(store.getView().stats.duplicatesDropped).toBe(expected.stats.duplicatesDropped + 1);
      await expectViewEqualsFull(store, w.root);
      store.close();
    } finally {
      w.cleanup();
    }
  });
});

describe('store：增量 vs 全量一致性（最大风险点）', () => {
  it('fixture 随机拆分追加（切在行中间 / 多字节字符中间；文件按随机顺序出现）：每一步都 == 从零全量解析', async () => {
    const sources = readSources(FIXTURE_ROOT);
    let totalSteps = 0;
    for (let seed = 1; seed <= 14; seed++) {
      const w = tmpWorld(false);
      try {
        const store = new Store({ dataRoot: w.root, appDataDir: w.app });
        await store.start(); // 空目录
        totalSteps += await runAppendScenario({ seed, sources, root: w.root, store, label: 'fixture' });
        // 最终等于完整 fixture 的解析结果（含 expected 数字，半行文件除外的 pending 部分未消费）
        expect(store.getView().stats.uniqueMessages).toBe(expected.stats.uniqueMessages);
        store.close();
      } finally {
        w.cleanup();
      }
    }
    expect(totalSteps).toBeGreaterThan(100);
  }, 120_000);

  it('合成的"跨文件重复很多"数据（id 池小、firstTs 并列、usage 各异）：随机追加顺序下每一步 == 全量', async () => {
    for (let seed = 100; seed < 124; seed++) {
      const w = tmpWorld(false);
      try {
        const store = new Store({ dataRoot: w.root, appDataDir: w.app, concurrency: 1 + (seed % 4) });
        await store.start();
        await runAppendScenario({ seed, sources: genCrossFileSources(seed), root: w.root, store, maxCuts: 6, refreshProb: 0.7, label: 'cross' });
        expect(store.getView().stats.crossFileDuplicates).toBeGreaterThan(0);
        store.close();
      } finally {
        w.cleanup();
      }
    }
  }, 180_000);

  it('跨文件重复 id 在"后出现的更早文件"里：所有权转移，且删除后再转回', async () => {
    const w = tmpWorld(false);
    try {
      const store = new Store({ dataRoot: w.root, appDataDir: w.app });
      await store.start();
      const src = Object.fromEntries(readSources(FIXTURE_ROOT).map((s) => [s.rel, s.data]));
      const put = (rel: string): void => {
        const abs = path.join(w.root, ...rel.split('/'));
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, src[rel]!);
      };
      // 先出现的是"恢复会话"副本（firstTs 更晚）：它暂时拥有重复的 message
      put(A2);
      await store.refreshNow();
      expect(store.getView().records.find((r) => r.messageId === 'msg_alpha_stream')!.sourceFile).toBe(A2);
      await expectViewEqualsFull(store, w.root, 'A2 only');
      // 原始文件后出现：所有权转给它
      put(A1);
      await store.refreshNow();
      const r1 = store.getView().records.find((r) => r.messageId === 'msg_alpha_stream')!;
      expect(r1.sourceFile).toBe(A1);
      expect(r1.sessionId).toBe('a1a1a1a1-0000-4000-8000-000000000001');
      expect(store.getView().stats.crossFileDuplicates).toBe(2); // stream 与 grow
      await expectViewEqualsFull(store, w.root, 'A1 arrives');
      // 删除原始文件：归属转回仍存在的出现者，总量不丢（验收 4）
      const total1 = store.getView().records.filter((r) => r.messageId === 'msg_alpha_stream' || r.messageId === 'msg_alpha_grow').reduce((a, r) => a + r.input + r.cacheWrite + r.cacheRead + r.output, 0);
      fs.rmSync(path.join(w.root, ...A1.split('/')));
      await store.refreshNow();
      const r2 = store.getView().records.find((r) => r.messageId === 'msg_alpha_stream')!;
      expect(r2.sourceFile).toBe(A2);
      expect(r2.sessionId).toBe('a1a1a1a1-0000-4000-8000-000000000002');
      const total2 = store.getView().records.filter((r) => r.messageId === 'msg_alpha_stream' || r.messageId === 'msg_alpha_grow').reduce((a, r) => a + r.input + r.cacheWrite + r.cacheRead + r.output, 0);
      expect(total2).toBe(total1);
      expect(store.getView().stats.crossFileDuplicates).toBe(0);
      await expectViewEqualsFull(store, w.root, 'A1 deleted');
      store.close();
    } finally {
      w.cleanup();
    }
  });

  it('并发度不影响结果（1 / 2 / 8）；dedupeGlobalAsync == dedupeGlobal', async () => {
    const views = [];
    for (const c of [1, 2, 8]) {
      const w = tmpWorld();
      try {
        const s = new Store({ dataRoot: w.root, appDataDir: w.app, concurrency: c, persistCache: false });
        await s.start();
        views.push(s.getView().records);
        s.close();
      } finally {
        w.cleanup();
      }
    }
    expect(views[1]).toEqual(views[0]);
    expect(views[2]).toEqual(views[0]);
    const infos = await listUsageFiles(FIXTURE_ROOT);
    const inputs: DedupeFileInput[] = [];
    for (const i of infos) {
      const r = await parseFileRange(i.absPath);
      inputs.push({ path: i.relPath, projectKey: i.projectKey, firstTs: r.firstTs, defaultSessionId: i.defaultSessionId, isSubagentFile: i.isSubagentFile, agentIdFromName: i.agentIdFromName, rows: r.rows });
    }
    expect(await dedupeGlobalAsync(inputs)).toEqual(dedupeGlobal(inputs));
  });
});

describe('store：截断 / 重写 / 删除 / 新增（验收 3、4）', () => {
  it('截断到更短、等长不同内容覆盖、前面内容被改写后追加、删除：旧贡献撤销，总量 == 从零全量', async () => {
    const w = tmpWorld();
    try {
      const store = new Store({ dataRoot: w.root, appDataDir: w.app });
      await store.start();
      const target = path.join(w.root, ...A1.split('/'));
      const original = fs.readFileSync(target);

      // 1) 截断到更短（在行边界）
      const cut = original.indexOf(0x0a, Math.floor(original.length / 2)) + 1;
      fs.writeFileSync(target, original.subarray(0, cut));
      const fp0 = store.metrics.fullParses;
      await store.refreshNow();
      expect(store.metrics.fullParses).toBe(fp0 + 1);
      expect(store.getView().stats.uniqueMessages).toBeLessThan(expected.stats.uniqueMessages);
      await expectViewEqualsFull(store, w.root, 'truncate');

      // 2) 等长不同内容覆盖（把 token 数字换掉，长度不变）
      const text = fs.readFileSync(target, 'utf8');
      const swapped = text.replace(/"input_tokens":(\d)/g, (_m, d: string) => `"input_tokens":${(Number(d) + 1) % 10}`);
      expect(Buffer.byteLength(swapped)).toBe(Buffer.byteLength(text));
      expect(swapped).not.toBe(text);
      fs.writeFileSync(target, swapped);
      // 保证 mtime 变化（部分文件系统精度较粗）
      const t = new Date(Date.now() + 2000);
      fs.utimesSync(target, t, t);
      await store.refreshNow();
      await expectViewEqualsFull(store, w.root, 'same-size overwrite');

      // 3) 前面内容被改写、同时变长（头部哈希变化）
      const rewritten = Buffer.concat([Buffer.from(swapped.replace('"type":"mode"', '"type":"MODE"')), Buffer.from(`${assistantLine({ id: 'msg_after_rewrite', ts: '2026-10-08T00:00:00.000Z' })}\n`)]);
      fs.writeFileSync(target, rewritten);
      const fp1 = store.metrics.fullParses;
      await store.refreshNow();
      expect(store.metrics.fullParses).toBe(fp1 + 1); // 头部变了 → 不是续读，而是整文件重解析
      await expectViewEqualsFull(store, w.root, 'head rewritten');

      // 4) 已消费区域末尾被改写、同时变长（尾部哈希变化）
      const cur = fs.readFileSync(target);
      const mutated = Buffer.from(cur);
      mutated[mutated.length - 10] = mutated[mutated.length - 10] === 0x61 ? 0x62 : 0x61;
      fs.writeFileSync(target, Buffer.concat([mutated, Buffer.from(`${assistantLine({ id: 'msg_after_rewrite2', ts: '2026-10-08T01:00:00.000Z' })}\n`)]));
      const fp2 = store.metrics.fullParses;
      await store.refreshNow();
      expect(store.metrics.fullParses).toBe(fp2 + 1);
      await expectViewEqualsFull(store, w.root, 'tail rewritten');

      // 5) 删除
      fs.rmSync(target);
      await store.refreshNow();
      expect(store.getView().stats.filesParsed).toBe(13);
      await expectViewEqualsFull(store, w.root, 'delete');

      // 6) 恢复（再次新增）
      fs.writeFileSync(target, original);
      await store.refreshNow();
      expect(store.getView().stats).toEqual((await parseDataRoot(FIXTURE_ROOT)).stats);
      store.close();
    } finally {
      w.cleanup();
    }
  });

  it('文件由空变非空 / 由非空截成空：emptyFiles 等计数随之正确', async () => {
    const w = tmpWorld();
    try {
      const store = new Store({ dataRoot: w.root, appDataDir: w.app });
      await store.start();
      const empty = path.join(w.root, 'D--Work-empty', 'eeeeeeee-0000-4000-8000-000000000001.jsonl');
      expect(store.getView().stats.emptyFiles).toBe(2);
      fs.writeFileSync(empty, `${assistantLine({ id: 'msg_was_empty' })}\n`);
      await store.refreshNow();
      expect(store.getView().stats.emptyFiles).toBe(1);
      await expectViewEqualsFull(store, w.root, 'empty→non-empty');
      fs.writeFileSync(empty, '');
      await store.refreshNow();
      expect(store.getView().stats.emptyFiles).toBe(2);
      await expectViewEqualsFull(store, w.root, 'non-empty→empty');
      store.close();
    } finally {
      w.cleanup();
    }
  });

  it('rebuild()：丢弃所有状态与缓存后整体重建，结果相同且 dataVersion 继续递增', async () => {
    const w = tmpWorld();
    try {
      const store = new Store({ dataRoot: w.root, appDataDir: w.app });
      await store.start();
      const v0 = store.getView();
      const fp = store.metrics.fullParses;
      await store.rebuild();
      expect(store.metrics.fullParses).toBe(fp + 14);
      expect(store.getView().dataVersion).toBeGreaterThan(v0.dataVersion);
      expect(store.getView().records).toEqual(v0.records);
      expect(store.getView().stats).toEqual(v0.stats);
      expect(store.getStatus().phase).toBe('full');
      expect(fs.existsSync(cacheAbs(w.app))).toBe(true);
      store.close();
    } finally {
      w.cleanup();
    }
  });
});

describe('store：容错（验收 5）', () => {
  it('运行中写入损坏行 / 空文件 / 缺字段记录：不崩溃，计数增量累计；重复扫描同一损坏行不重复计数', async () => {
    const w = tmpWorld();
    try {
      const store = new Store({ dataRoot: w.root, appDataDir: w.app });
      await store.start();
      const s0 = store.getView().stats;
      const target = path.join(w.root, ...A2.split('/'));
      fs.appendFileSync(target, 'garbage {{{ not json\n');
      fs.mkdirSync(path.join(w.root, 'D--Work-new'), { recursive: true });
      fs.writeFileSync(path.join(w.root, 'D--Work-new', 'empty.jsonl'), '');
      fs.appendFileSync(target, `${JSON.stringify({ type: 'assistant', timestamp: '2026-10-09T00:00:00Z', message: { id: 'msg_missing_fields', model: 'claude-sonnet-5' } })}\n`);
      await store.refreshNow();
      let s1 = store.getView().stats;
      expect(s1.corruptLines).toBe(s0.corruptLines + 1);
      expect(s1.emptyFiles).toBe(s0.emptyFiles + 1);
      expect(s1.missingUsage).toBe(s0.missingUsage + 1);
      expect(s1.uniqueMessages).toBe(s0.uniqueMessages + 1);
      expect(store.getStatus().state).toBe('idle');
      // 重复扫描（没有变化）与无关追加都不会让计数再增加
      await store.refreshNow();
      await store.refreshNow();
      fs.appendFileSync(target, `${assistantLine({ id: 'msg_unrelated', ts: '2026-10-09T01:00:00.000Z' })}\n`);
      await store.refreshNow();
      s1 = store.getView().stats;
      expect(s1.corruptLines).toBe(s0.corruptLines + 1);
      expect(s1.emptyFiles).toBe(s0.emptyFiles + 1);
      expect(s1.missingUsage).toBe(s0.missingUsage + 1);
      await expectViewEqualsFull(store, w.root);
      store.close();
    } finally {
      w.cleanup();
    }
  });
});

describe('store：数据根不存在 / 恢复（验收 6）', () => {
  it('不存在 → state=error 且 lastError 为中文说明；创建目录并放入文件后下一次刷新自动恢复', async () => {
    const w = tmpWorld(false);
    try {
      const missing = path.join(w.root, 'not-yet');
      const store = new Store({ dataRoot: missing, appDataDir: w.app });
      await store.start();
      expect(store.getStatus().state).toBe('error');
      expect(store.getStatus().lastError).toContain('数据根目录不存在');
      expect(store.getStatus().lastError).toContain(missing);
      expect(store.getView().records).toEqual([]);
      await store.refreshNow(); // 仍然不崩溃
      expect(store.getStatus().state).toBe('error');
      fs.mkdirSync(path.join(missing, 'P'), { recursive: true });
      fs.writeFileSync(path.join(missing, 'P', 's.jsonl'), `${assistantLine({ id: 'msg_recover' })}\n`);
      await store.refreshNow();
      expect(store.getStatus().state).toBe('idle');
      expect(store.getStatus().lastError).toBeUndefined();
      expect(store.getView().records.map((r) => r.messageId)).toEqual(['msg_recover']);
      // 数据根又消失：报错但保留已有数据（不闪空）
      fs.rmSync(missing, { recursive: true });
      await store.refreshNow();
      expect(store.getStatus().state).toBe('error');
      expect(store.getView().records).toHaveLength(1);
      store.close();
    } finally {
      w.cleanup();
    }
  });

  it('数据根是个文件：给出可读的错误而不是崩溃', async () => {
    const w = tmpWorld(false);
    try {
      const f = path.join(w.root, 'afile');
      fs.writeFileSync(f, 'x');
      const store = new Store({ dataRoot: f, appDataDir: w.app });
      await store.start();
      expect(store.getStatus().state).toBe('error');
      expect(store.getStatus().lastError).toMatch(/不是目录|读取数据根目录失败|不存在/);
      store.close();
    } finally {
      w.cleanup();
    }
  });

  it('switchDataRoot：切到另一个目录后重新扫描（旧缓存不会混入）', async () => {
    const a = tmpWorld();
    const b = tmpWorld(false);
    try {
      fs.mkdirSync(path.join(b.root, 'Q'), { recursive: true });
      fs.writeFileSync(path.join(b.root, 'Q', 's.jsonl'), `${assistantLine({ id: 'msg_b' })}\n`);
      const store = new Store({ dataRoot: a.root, appDataDir: a.app });
      await store.start();
      expect(store.getView().stats.uniqueMessages).toBe(expected.stats.uniqueMessages);
      await store.switchDataRoot(b.root);
      expect(store.getView().records.map((r) => r.messageId)).toEqual(['msg_b']);
      expect(store.getView().folderKeys).toEqual(['Q']);
      store.close();
    } finally {
      a.cleanup();
      b.cleanup();
    }
  });
});

describe('store：单飞、进度与事件', () => {
  it('并发触发 10 次 refreshNow：合并成至多 2 次实际扫描（单飞）', async () => {
    const w = tmpWorld();
    try {
      const store = new Store({ dataRoot: w.root, appDataDir: w.app });
      await store.start();
      const scans0 = store.metrics.scans;
      await Promise.all(Array.from({ length: 10 }, () => store.refreshNow()));
      expect(store.metrics.scans - scans0).toBeLessThanOrEqual(2);
      // rebuild 优先于排队的 refresh
      const p1 = store.refreshNow();
      const p2 = store.refreshNow();
      const p3 = store.rebuild();
      await Promise.all([p1, p2, p3]);
      expect(store.getStatus().state).toBe('idle');
      await expectViewEqualsFull(store, w.root);
      store.close();
    } finally {
      w.cleanup();
    }
  });

  it('进度模型：scanning → idle；filesDone/bytesDone 单调；回调 > 1 次；增量阶段 phase=incremental', async () => {
    const w = tmpWorld(false);
    try {
      genBigRoot(w.root, { files: 8, totalBytes: 40 * 1024 * 1024 });
      const store = new Store({ dataRoot: w.root, appDataDir: w.app, statusThrottleMs: 0, concurrency: 2 });
      const events: ChangeEvent[] = [];
      store.onChange((e) => events.push(e));
      await store.start();
      const scanning = events.filter((e) => e.status.state === 'scanning');
      expect(scanning.length).toBeGreaterThan(1);
      const bytes = scanning.map((e) => e.status.bytesDone);
      const done = scanning.map((e) => e.status.filesDone);
      for (let i = 1; i < bytes.length; i++) {
        expect(bytes[i]!).toBeGreaterThanOrEqual(bytes[i - 1]!);
        expect(done[i]!).toBeGreaterThanOrEqual(done[i - 1]!);
      }
      expect(new Set(bytes).size).toBeGreaterThan(5);
      const last = store.getStatus();
      expect(last).toMatchObject({ state: 'idle', phase: 'full', filesTotal: 8, filesDone: 8 });
      expect(last.bytesDone).toBe(last.bytesTotal);
      expect(scanning[0]!.status.phase).toBe('full');
      expect(events[events.length - 1]!.status.state).toBe('idle');

      fs.appendFileSync(path.join(w.root, 'proj-0', 'big-0.jsonl'), `${assistantLine({ id: 'msg_inc' })}\n`);
      await store.refreshNow();
      expect(store.getStatus()).toMatchObject({ phase: 'incremental', filesTotal: 1, filesDone: 1 });
      expect(store.getStatus().bytesTotal).toBeLessThan(1000);
      store.close();
    } finally {
      w.cleanup();
    }
  }, 120_000);

  it('首次全量期间可读取"已解析部分"的视图（部分结果可用，dataVersion 陆续递增）', async () => {
    const w = tmpWorld(false);
    try {
      genBigRoot(w.root, { files: 10, totalBytes: 60 * 1024 * 1024 });
      const store = new Store({ dataRoot: w.root, appDataDir: w.app, concurrency: 1, recomputeMinMs: 5 });
      const partial: Array<{ v: number; n: number }> = [];
      store.onChange((e) => {
        if (e.kind === 'data' && e.status.state === 'scanning') partial.push({ v: e.status.dataVersion, n: store.getView().records.length });
      });
      await store.start();
      const final = store.getView().records.length;
      expect(partial.length).toBeGreaterThan(0);
      expect(partial.some((p) => p.n > 0 && p.n < final)).toBe(true);
      for (let i = 1; i < partial.length; i++) {
        expect(partial[i]!.v).toBeGreaterThan(partial[i - 1]!.v);
        expect(partial[i]!.n).toBeGreaterThanOrEqual(partial[i - 1]!.n);
      }
      await expectViewEqualsFull(store, w.root);
      store.close();
    } finally {
      w.cleanup();
    }
  }, 120_000);
});

describe('store：事件循环不被长时间阻塞（验收 7）', () => {
  let world: ReturnType<typeof tmpWorld>;
  beforeAll(() => {
    world = tmpWorld(false);
    genBigRoot(world.root, { files: 8, totalBytes: 108 * 1024 * 1024, sharedEvery: 7 });
  }, 120_000);
  afterAll(() => world.cleanup());

  async function maxLag(run: () => Promise<void>): Promise<number> {
    let max = 0;
    let last = performance.now();
    const hb = setInterval(() => {
      const now = performance.now();
      max = Math.max(max, now - last - 50);
      last = now;
    }, 50);
    try {
      await run();
    } finally {
      clearInterval(hb);
    }
    return max;
  }

  it('全量扫描 ≥ 100 MB 合成目录期间，50 ms 心跳的最大额外延迟 < 250 ms', async () => {
    let bytes = 0;
    for (const e of fs.readdirSync(world.root, { recursive: true, withFileTypes: true })) if (e.isFile()) bytes += fs.statSync(path.join(e.parentPath, e.name)).size;
    expect(bytes).toBeGreaterThanOrEqual(100 * 1024 * 1024);
    const store = new Store({ dataRoot: world.root, appDataDir: world.app });
    const lag = await maxLag(() => store.start());
    // eslint-disable-next-line no-console
    console.log(`[eventloop] ${(bytes / 1048576).toFixed(0)} MB，records=${store.getView().records.length}，最大心跳延迟 ${lag.toFixed(0)} ms`);
    expect(lag).toBeLessThan(250);
    expect(store.getStatus().state).toBe('idle');
    // 增量刷新 / 重建 / 读缓存的启动也不阻塞
    fs.appendFileSync(path.join(world.root, 'proj-0', 'big-0.jsonl'), `${assistantLine({ id: 'msg_lag' })}\n`);
    expect(await maxLag(() => store.refreshNow())).toBeLessThan(250);
    store.close();
    const warm = new Store({ dataRoot: world.root, appDataDir: world.app });
    expect(await maxLag(() => warm.start())).toBeLessThan(250);
    expect(warm.metrics.cacheLoad).toBe('loaded');
    warm.close();
  }, 180_000);

  it('行数很多的目录（小行为主，~150k 行）：去重与缓存序列化也分片让出', async () => {
    const w = tmpWorld(false);
    try {
      genBigRoot(w.root, { files: 6, totalBytes: 60 * 1024 * 1024, fillerBytes: 0, sharedEvery: 5 });
      const store = new Store({ dataRoot: w.root, appDataDir: w.app });
      const lag = await maxLag(() => store.start());
      // eslint-disable-next-line no-console
      console.log(`[eventloop] 小行目录：records=${store.getView().records.length}，最大心跳延迟 ${lag.toFixed(0)} ms`);
      expect(store.getView().records.length).toBeGreaterThan(50_000);
      expect(lag).toBeLessThan(250);
      store.close();
    } finally {
      w.cleanup();
    }
  }, 180_000);
});

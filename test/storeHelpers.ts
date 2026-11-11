import fs from 'node:fs';
import path from 'node:path';
import { expect } from 'vitest';
import { parseDataRoot } from '../src/server/core/loadRoot.ts';
import type { Store } from '../src/server/store/store.ts';
import { assistantLine, FIXTURE_ROOT, makeTmpDir } from './helpers.ts';

/** 把 fixture 复制到一个临时数据根。返回 { root, app, cleanup }。 */
export function tmpWorld(copyFixture = true): { root: string; app: string; cleanup: () => void } {
  const base = makeTmpDir('tv-store-');
  const root = path.join(base, 'projects');
  const app = path.join(base, 'appdata');
  fs.mkdirSync(root, { recursive: true });
  if (copyFixture) fs.cpSync(FIXTURE_ROOT, root, { recursive: true });
  return { root, app, cleanup: () => fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}

/** 断言：store 当前视图与"从零全量解析当前目录"逐项相同。 */
export async function expectViewEqualsFull(store: Store, root: string, label = ''): Promise<void> {
  const full = await parseDataRoot(root);
  const v = store.getView();
  expect(v.stats, `${label} stats`).toEqual(full.stats);
  expect(v.records, `${label} records`).toEqual(full.records);
  expect(v.folderKeys, `${label} folderKeys`).toEqual([...new Set(full.files.map((f) => f.info.projectKey))].sort());
}

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SourceFile {
  rel: string;
  data: Buffer;
}

/** 读取目录下全部 .jsonl（含 subagents）为"源文件"。 */
export function readSources(root: string): SourceFile[] {
  const out: SourceFile[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.name.endsWith('.jsonl')) out.push({ rel: path.relative(root, abs).split(path.sep).join('/'), data: fs.readFileSync(abs) });
    }
  };
  walk(root);
  return out.sort((a, b) => (a.rel < b.rel ? -1 : 1));
}

/**
 * 随机追加场景：把每个源文件切成若干段（可以切在行中间、多字节字符中间），按随机顺序逐段追加到临时数据根，
 * 每一步（以一定概率）刷新并断言视图 == 从零全量解析。
 */
export async function runAppendScenario(opts: { seed: number; sources: SourceFile[]; root: string; store: Store; maxCuts?: number; refreshProb?: number; label?: string }): Promise<number> {
  const rand = rng(opts.seed);
  const pieces = opts.sources.map((s) => {
    const n = Math.floor(rand() * ((opts.maxCuts ?? 5) + 1));
    const cuts = [...new Set(Array.from({ length: n }, () => 1 + Math.floor(rand() * Math.max(1, s.data.length - 1))))].sort((a, b) => a - b);
    const parts: Buffer[] = [];
    let prev = 0;
    for (const c of [...cuts, s.data.length]) {
      if (c > prev) parts.push(s.data.subarray(prev, c));
      prev = c;
    }
    return { rel: s.rel, parts, next: 0 };
  });
  let steps = 0;
  for (;;) {
    const live = pieces.filter((p) => p.next < p.parts.length);
    if (live.length === 0) break;
    const p = live[Math.floor(rand() * live.length)]!;
    const abs = path.join(opts.root, ...p.rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.appendFileSync(abs, p.parts[p.next++]!);
    steps++;
    if (rand() < (opts.refreshProb ?? 0.6)) {
      await opts.store.refreshNow();
      await expectViewEqualsFull(opts.store, opts.root, `${opts.label ?? ''} seed=${opts.seed} step=${steps}`);
    }
  }
  await opts.store.refreshNow();
  await expectViewEqualsFull(opts.store, opts.root, `${opts.label ?? ''} seed=${opts.seed} final`);
  return steps;
}

/** 合成"跨文件重复很多"的数据：id 池小、firstTs 故意并列、usage 各不相同（取最大值语义）。 */
export function genCrossFileSources(seed: number, fileCount = 6): SourceFile[] {
  const rand = rng(seed);
  const firstTss = ['2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', '2026-10-02T00:00:00.000Z', '2026-10-03T12:00:00.000Z'];
  const out: SourceFile[] = [];
  for (let f = 0; f < fileCount; f++) {
    const folder = rand() < 0.5 ? 'projA' : 'projB';
    const sid = `s-${seed}-${f}`;
    const lines: string[] = [JSON.stringify({ type: 'user', timestamp: firstTss[Math.floor(rand() * firstTss.length)], message: { role: 'user', content: 'hi' }, sessionId: sid })];
    const msgs = 8 + Math.floor(rand() * 10);
    for (let m = 0; m < msgs; m++) {
      const id = `msg_pool_${Math.floor(rand() * 12)}`;
      const rows = 1 + Math.floor(rand() * 3);
      const ts = Date.UTC(2026, 9, 1 + Math.floor(rand() * 5), Math.floor(rand() * 24), Math.floor(rand() * 60));
      for (let r = 0; r < rows; r++) {
        lines.push(
          assistantLine({
            id: rand() < 0.05 ? undefined : id,
            req: `req_${id}`,
            ts: new Date(ts + r * 100).toISOString(),
            model: rand() < 0.5 ? 'claude-sonnet-5-5' : 'claude-opus-5-5',
            input: Math.floor(rand() * 50),
            out: Math.floor(rand() * 500) + r * 10,
            cacheRead: Math.floor(rand() * 5000),
            cacheWrite: Math.floor(rand() * 300),
            session: sid,
          }),
        );
      }
      if (rand() < 0.1) lines.push('{"corrupt": ');
      if (rand() < 0.1) lines.push(JSON.stringify({ type: 'system', timestamp: new Date(ts).toISOString() }));
    }
    out.push({ rel: `${folder}/${sid}.jsonl`, data: Buffer.from(`${lines.join('\n')}\n`, 'utf8') });
  }
  return out;
}

/** 生成大目录（真实感：很多大行 + 夹杂 assistant 行）。返回总字节数。 */
export function genBigRoot(root: string, opts: { files: number; totalBytes: number; fillerBytes?: number; sharedEvery?: number }): number {
  const filler = JSON.stringify({ type: 'user', timestamp: '2026-10-01T00:00:00.000Z', message: { role: 'user', content: 'x'.repeat(opts.fillerBytes ?? 20_000) } });
  const perFile = Math.floor(opts.totalBytes / opts.files);
  let total = 0;
  for (let f = 0; f < opts.files; f++) {
    const dir = path.join(root, `proj-${f % 4}`);
    fs.mkdirSync(dir, { recursive: true });
    const fd = fs.openSync(path.join(dir, `big-${f}.jsonl`), 'w');
    let written = 0;
    let i = 0;
    while (written < perFile) {
      const parts: string[] = [];
      for (let k = 0; k < 200; k++) {
        const shared = opts.sharedEvery && i % opts.sharedEvery === 0;
        parts.push(assistantLine({ id: shared ? `msg_shared_${i}` : `msg_${f}_${Math.floor(i / 2)}`, ts: new Date(Date.UTC(2026, 9, 1) + (f * 100_000 + i) * 1000).toISOString(), out: i % 50, input: 1, cacheRead: 1000, session: `sess-${f}` }));
        if (k % 10 === 0 && (opts.fillerBytes ?? 20_000) > 0) parts.push(filler);
        i++;
      }
      const chunk = `${parts.join('\n')}\n`;
      fs.writeSync(fd, chunk);
      written += Buffer.byteLength(chunk);
    }
    fs.closeSync(fd);
    total += written;
  }
  return total;
}

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const FIXTURE_ROOT = path.join(here, 'fixtures', 'projects');
export const EXPECTED_PATH = path.join(here, 'fixtures', 'expected.json');
export const MARKER = 'SECRET_BODY_MARKER';

// eslint 风格的宽松类型：expected.json 是测试数据，不值得为它建完整类型
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Expected = any;

export function loadExpected(): Expected {
  return JSON.parse(fs.readFileSync(EXPECTED_PATH, 'utf8'));
}

export function makeTmpDir(prefix = 'tv-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function rmDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

export interface SnapEntry {
  rel: string;
  size: number;
  mtimeMs: number;
  isDir: boolean;
}

/** (相对路径, 大小, mtime) 快照，用于只读审计。 */
export function snapshotDir(root: string): SnapEntry[] {
  const out: SnapEntry[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      const st = fs.statSync(abs);
      out.push({ rel: path.relative(root, abs).split(path.sep).join('/'), size: st.size, mtimeMs: st.mtimeMs, isDir: e.isDirectory() });
      if (e.isDirectory()) walk(abs);
    }
  };
  walk(root);
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return out;
}

/** 逐文件比较两个目录树（相对路径 + 字节内容）。返回差异描述；空数组 = 一致。 */
export function diffTrees(a: string, b: string): string[] {
  const list = (root: string): string[] => snapshotDir(root).filter((e) => !e.isDir).map((e) => e.rel);
  const la = list(a);
  const lb = list(b);
  const diffs: string[] = [];
  if (JSON.stringify(la) !== JSON.stringify(lb)) diffs.push(`文件清单不同：${la.length} vs ${lb.length}`);
  for (const rel of la) {
    if (!lb.includes(rel)) continue;
    const ba = fs.readFileSync(path.join(a, ...rel.split('/')));
    const bb = fs.readFileSync(path.join(b, ...rel.split('/')));
    if (!ba.equals(bb)) diffs.push(`内容不同：${rel}`);
  }
  return diffs;
}

/** 构造一条最小的 assistant 行（JSON 字符串）。 */
export function assistantLine(o: {
  id?: string;
  req?: string;
  ts?: string;
  model?: string;
  input?: number;
  out?: number;
  cacheRead?: number;
  cacheWrite?: number;
  session?: string;
  extra?: Record<string, unknown>;
}): string {
  const message: Record<string, unknown> = {
    model: o.model ?? 'claude-sonnet-5-5',
    ...(o.id ? { id: o.id } : {}),
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'hi' }],
    stop_reason: null,
    usage: {
      input_tokens: o.input ?? 1,
      cache_creation_input_tokens: o.cacheWrite ?? 0,
      cache_read_input_tokens: o.cacheRead ?? 0,
      output_tokens: o.out ?? 1,
    },
  };
  return JSON.stringify({
    type: 'assistant',
    message,
    ...(o.req ? { requestId: o.req } : {}),
    timestamp: o.ts ?? '2026-10-01T00:00:00.000Z',
    sessionId: o.session ?? 's1',
    cwd: 'D:\\x',
    isSidechain: false,
    ...o.extra,
  });
}

// ---------------------------------------------------------------------------
// 阶段 2 共用：解析一次 fixture，得到记录与项目索引
// ---------------------------------------------------------------------------
import { buildProjectIndex } from '../src/server/core/projects.ts';
import type { ProjectIndex } from '../src/server/core/projects.ts';
import { parseDataRoot } from '../src/server/core/loadRoot.ts';
import type { ParseRootResult } from '../src/server/core/loadRoot.ts';
import type { AggregateContext, AggregateQuery } from '../src/server/core/aggregate.ts';

export interface FixtureCtx {
  parsed: ParseRootResult;
  groupedProjects: ProjectIndex;
  flatProjects: ProjectIndex;
  ctx: AggregateContext;
  flatCtx: AggregateContext;
}

let fixtureCtxPromise: Promise<FixtureCtx> | undefined;

export function loadFixtureCtx(): Promise<FixtureCtx> {
  fixtureCtxPromise ??= (async () => {
    const parsed = await parseDataRoot(FIXTURE_ROOT);
    const folderKeys = parsed.files.map((f) => f.info.projectKey);
    const groupedProjects = buildProjectIndex(parsed.records, { groupScratch: true, folderKeys });
    const flatProjects = buildProjectIndex(parsed.records, { groupScratch: false, folderKeys });
    return {
      parsed,
      groupedProjects,
      flatProjects,
      ctx: { records: parsed.records, projects: groupedProjects },
      flatCtx: { records: parsed.records, projects: flatProjects },
    };
  })();
  return fixtureCtxPromise;
}

/** 默认查询（可覆盖）：全部项目、全部时间、Shanghai、按日、Total。 */
export function baseQuery(over: Partial<AggregateQuery> = {}): AggregateQuery {
  return {
    projects: 'all',
    range: { kind: 'all' },
    granularity: 'day',
    tz: 'Asia/Shanghai',
    weekStart: 'monday',
    basis: 'total',
    split: 'none',
    includeSidechain: true,
    now: Date.parse('2026-10-20T12:00:00.000Z'),
    ...over,
  };
}

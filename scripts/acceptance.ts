/**
 * 自动验收：`npm run acceptance [-- --real] [-- --e2e] [-- --skip-unit] [-- --out <文件>]`
 *
 * 对 test/fixtures（合成数据，期望值由 make-fixture 的声明式规格推出）自动核对 PRD 第 10 节可自动化的条目，
 * 以及成本守恒、AI 运行时长手算、隐藏项目、只读 / 零外网审计；逐条 PASS / FAIL 写入 docs/ACCEPTANCE.md，
 * 任何 FAIL → 退出码 1。
 *
 * 复用而不重写：
 *   - 数据来源 test/fixtures + expected.json、独立的朴素实现 test/naiveView.ts、HTTP 层交叉核对 test/apiCrossCheck.ts、
 *     启动辅助 test/apiHelpers.ts / test/e2e/server.ts；
 *   - 默认还会跑一遍 `vitest`（JSON 报告）与 `npm run typecheck`，把对应单测文件的通过数并入相关行作为"支撑证据"；
 *   - `--e2e` 另外跑 `npm run test:e2e`（约 5 分钟，不并发其它浏览器进程）；
 *   - `--real` 追加真实数据（~/.claude/projects，只读）的快照核对：verify 脚本、二次启动时间、运行时长探针对账、写入 / 外网审计。
 *
 * 只读保证：数据根只读；应用只写临时应用数据目录；本脚本只写 docs/ACCEPTANCE.md 与系统临时目录。
 */
// 验收断言按中文文案核对；默认语言是英文，这里用 TV_LANG 固定为中文（子进程继承）
process.env.TV_LANG ??= 'zh';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { crossCheck } from '../test/apiCrossCheck.ts';
import { getJson, putJson, startApp } from '../test/apiHelpers.ts';
import type { TestApp } from '../test/apiHelpers.ts';
import { FIXTURE_ROOT, loadExpected, MARKER, makeTmpDir, rmDir, snapshotDir } from '../test/helpers.ts';
import { naiveRecords, naiveView } from '../test/naiveView.ts';
import type { NaiveMsg } from '../test/naiveView.ts';
import { startServer } from '../test/e2e/server.ts';
import type { TestServer } from '../test/e2e/server.ts';
import { builtinDefaults } from '../src/server/cost/prices.ts';
import { builtinPlans } from '../src/server/cost/plans.ts';
import { defaultDataRoot } from '../src/server/core/paths.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */

const ROOT = path.resolve(import.meta.dirname, '..');
const NOW = Date.parse('2026-10-20T12:00:00.000Z');
const TZ = 'Asia/Shanghai';
const MIN = 60_000;
const expected: any = loadExpected();

const argv = process.argv.slice(2);
const flag = (n: string): boolean => argv.includes(n);
const argVal = (n: string): string | undefined => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const WITH_REAL = flag('--real');
const WITH_E2E = flag('--e2e');
const SKIP_UNIT = flag('--skip-unit');
const OUT = path.resolve(ROOT, argVal('--out') ?? path.join('docs', 'ACCEPTANCE.md'));
const REAL_ROOT = argVal('--root') ?? defaultDataRoot();

// ---------------------------------------------------------------------------
// 迷你断言 / 记录框架
// ---------------------------------------------------------------------------
type Status = 'PASS' | 'FAIL' | 'SKIP';
interface Row {
  id: string;
  prd: string;
  title: string;
  status: Status;
  evidence: string;
  ms: number;
  detail?: string;
  support?: string;
}
const rows: Row[] = [];
let assertCount = 0;

class Fail extends Error {}
function ok(cond: unknown, msg: string): void {
  assertCount++;
  if (!cond) throw new Fail(msg);
}
const show = (v: unknown): string => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s === undefined ? 'undefined' : s.length > 160 ? `${s.slice(0, 160)}…` : s;
};
function eq(actual: unknown, want: unknown, label: string): void {
  assertCount++;
  if (JSON.stringify(actual) !== JSON.stringify(want)) throw new Fail(`${label}：实际 ${show(actual)}，期望 ${show(want)}`);
}
function near(actual: number | null | undefined, want: number, eps: number, label: string): void {
  assertCount++;
  if (typeof actual !== 'number' || !Number.isFinite(actual) || Math.abs(actual - want) > eps) throw new Fail(`${label}：实际 ${show(actual)}，期望 ${want}（容差 ${eps}）`);
}
const sum = (xs: number[]): number => xs.reduce((a, c) => a + c, 0);
const fmt = (n: number): string => n.toLocaleString('en-US');

async function check(id: string, prd: string, title: string, fn: () => Promise<string>): Promise<void> {
  const t0 = performance.now();
  const before = assertCount;
  let row: Row;
  try {
    const ev = await fn();
    row = { id, prd, title, status: 'PASS', evidence: `${ev}（断言 ${assertCount - before} 条）`, ms: performance.now() - t0 };
  } catch (e) {
    const err = e as Error;
    row = { id, prd, title, status: 'FAIL', evidence: err instanceof Fail ? err.message : `异常：${err.message}`, ms: performance.now() - t0, detail: err instanceof Fail ? undefined : err.stack };
  }
  rows.push(row);
  console.log(`${row.status === 'PASS' ? 'PASS' : row.status === 'FAIL' ? 'FAIL' : 'SKIP'}  ${id.padEnd(4)} ${title}  (${Math.round(row.ms)} ms)${row.status === 'FAIL' ? `\n      ${row.evidence}` : ''}`);
}
function skip(id: string, prd: string, title: string, why: string): void {
  rows.push({ id, prd, title, status: 'SKIP', evidence: why, ms: 0 });
  console.log(`SKIP  ${id.padEnd(4)} ${title}：${why}`);
}

// ---------------------------------------------------------------------------
// 资源登记：任何退出路径都要关干净
// ---------------------------------------------------------------------------
const apps: TestApp[] = [];
const servers: TestServer[] = [];
const procs: ChildProcess[] = [];
const tmpDirs: string[] = [];
async function app(opts: Parameters<typeof startApp>[0] = {}): Promise<TestApp> {
  const a = await startApp(opts);
  apps.push(a);
  return a;
}
async function closeApp(a: TestApp): Promise<void> {
  const i = apps.indexOf(a);
  if (i >= 0) apps.splice(i, 1);
  await a.close();
}
function tmp(prefix: string): string {
  const d = makeTmpDir(prefix);
  tmpDirs.push(d);
  return d;
}
async function cleanupAll(): Promise<void> {
  for (const a of apps.splice(0)) await a.close().catch(() => {});
  for (const s of servers.splice(0)) await s.stop().catch(() => {});
  for (const p of procs.splice(0)) if (p.exitCode === null) p.kill();
  for (const d of tmpDirs.splice(0)) {
    try {
      rmDir(d);
    } catch {
      // 清理失败不影响结论
    }
  }
}
process.on('SIGINT', () => {
  void cleanupAll().finally(() => process.exit(130));
});

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
function hashTree(root: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of snapshotDir(root)) if (!e.isDir) m.set(e.rel, `${e.size}:${crypto.createHash('sha256').update(fs.readFileSync(path.join(root, ...e.rel.split('/')))).digest('hex')}`);
  return m;
}
function diffMaps(a: Map<string, string>, b: Map<string, string>): string[] {
  const out: string[] = [];
  for (const [k, v] of a) if (!b.has(k)) out.push(`消失：${k}`);
  else if (b.get(k) !== v) out.push(`变化：${k}`);
  for (const k of b.keys()) if (!a.has(k)) out.push(`新增：${k}`);
  return out;
}
const B = (a: TestApp): string => a.base;
const get = async (a: TestApp, p: string): Promise<any> => {
  const r = await getJson(a.base, p);
  if (r.status !== 200) throw new Fail(`GET ${p} → ${r.status} ${show(r.body)}`);
  return r.body;
};
const put = async (a: TestApp, p: string, body: unknown): Promise<any> => {
  const r = await putJson(a.base, p, body);
  if (r.status !== 200) throw new Fail(`PUT ${p} → ${r.status} ${show(r.body)}`);
  return r.body;
};
const post = async (a: TestApp, p: string): Promise<any> => {
  const r = await fetch(`${a.base}${p}`, { method: 'POST' });
  const t = await r.text();
  if (r.status >= 400) throw new Fail(`POST ${p} → ${r.status} ${t.slice(0, 200)}`);
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
};
const dateOf = (ts: number, tz = TZ): string => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts));
const daysIn = (date: string): number => new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)), 0)).getUTCDate();

/** 极简 CSV 解析（支持双引号转义）；返回 { note, header, rows }，自动跳过 # 开头的说明行与 BOM。 */
function parseCsv(text: string): { bom: boolean; notes: string[]; header: string[]; rows: Record<string, string>[] } {
  const bom = text.charCodeAt(0) === 0xfeff;
  const body = bom ? text.slice(1) : text;
  const recs: string[][] = [];
  let cur: string[] = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (q) {
      if (c === '"') {
        if (body[i + 1] === '"') {
          cell += '"';
          i++;
        } else q = false;
      } else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      cur.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && body[i + 1] === '\n') i++;
      cur.push(cell);
      cell = '';
      recs.push(cur);
      cur = [];
    } else cell += c;
  }
  if (cell !== '' || cur.length > 0) {
    cur.push(cell);
    recs.push(cur);
  }
  const notes = recs.filter((r) => r[0]?.startsWith('#')).map((r) => r.join(','));
  const data = recs.filter((r) => !(r[0]?.startsWith('#') ?? false) && !(r.length === 1 && r[0] === ''));
  const header = data[0] ?? [];
  return { bom, notes, header, rows: data.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? '']))) };
}

// 固定价格表（USD / M）：输入 1、输出 5、5m 写 2、1h 写 3、读 0.1
const FLAT = { inputUsdPerM: 1, outputUsdPerM: 5, cacheWrite5mUsdPerM: 2, cacheWrite1hUsdPerM: 3, cacheReadUsdPerM: 0.1 };
const FLAT_RULE = { pattern: 'claude-*', match: 'glob', ...FLAT };

// 项目目标：all + 每个有记录的项目文件夹（Scratch 三个并入 scratch 组）
const scratchKeys: string[] = (expected.projects as any[]).filter((p) => p.isScratch).map((p) => p.projectKey);
const scratchTotal = sum((expected.projects as any[]).filter((p) => p.isScratch).map((p) => p.total));
const projectTargets: Array<{ id: string; total: number }> = [
  { id: 'all', total: expected.totals.total },
  ...(expected.projects as any[]).filter((p) => !p.isScratch && p.total > 0).map((p) => ({ id: p.projectKey as string, total: p.total as number })),
  { id: 'scratch', total: scratchTotal },
];

// ---------------------------------------------------------------------------
// 阶段 A：进程内应用（fixture）上的 PRD 条目
// ---------------------------------------------------------------------------
async function phaseFixtureApi(): Promise<void> {
  const fixtureBefore = hashTree(FIXTURE_ROOT);
  const view = naiveView(FIXTURE_ROOT);
  const msgs: NaiveMsg[] = naiveRecords(view);
  const A = await app();

  await check('#1', 'PRD-10.1', '去重：请求数 = 唯一 message.id；总 token = 去重后各字段求和', async () => {
    const s = (await get(A, '/api/summary?range=all')).summary;
    const comp = await get(A, '/api/analysis/composition?range=all');
    eq(s.requests, msgs.length, '请求数 vs 独立朴素实现的唯一消息数');
    eq(s.requests, expected.stats.uniqueMessages, '请求数 vs expected.stats.uniqueMessages');
    const nsum = (f: 'input' | 'cacheWrite' | 'cacheRead' | 'output'): number => sum(msgs.map((m) => m[f]));
    eq([comp.input, comp.cacheWrite, comp.cacheRead, comp.output], [nsum('input'), nsum('cacheWrite'), nsum('cacheRead'), nsum('output')], '四类 token vs 朴素实现');
    eq([comp.input, comp.cacheWrite, comp.cacheRead, comp.output], [expected.totals.input, expected.totals.cacheWrite, expected.totals.cacheRead, expected.totals.output], '四类 token vs expected');
    eq(s.total, expected.totals.total, 'Total');
    // 会话级：每个会话的请求数 = 该会话唯一消息数（含子代理并入父会话）
    const sess = await get(A, '/api/sessions?range=all&pageSize=500');
    eq(sess.rows.length, Object.keys(expected.sessions).length, '会话数');
    for (const r of sess.rows) {
      const n = msgs.filter((m) => m.session === r.id).length;
      eq(r.requests, n, `会话 ${r.id.slice(0, 8)} 请求数 vs 朴素唯一数`);
    }
    const q = await get(A, '/api/analysis/quality');
    eq(q.assistantRows - q.syntheticExcluded - q.uniqueMessages, q.duplicatesDropped, '去重前 assistant 行 − <synthetic> − 唯一消息 = 丢弃的重复');
    ok(q.crossFileDuplicates >= 1, '夹具含跨文件重复');
    return `唯一消息 ${s.requests} 条（去重前 assistant 行 ${q.assistantRows}，丢弃重复 ${q.duplicatesDropped}，其中跨文件 ${q.crossFileDuplicates}）；Total ${fmt(s.total)}；${sess.rows.length} 个会话逐一与朴素实现对账`;
  });

  await check('#2', 'PRD-10.2', '项目识别：与文件夹一一对应、Scratch 归并、中文路径取自 cwd', async () => {
    const pj = await get(A, '/api/projects');
    const top: any[] = pj.projects;
    const group = top.find((p) => p.isScratchGroup);
    ok(group, '存在 Scratch 归并组');
    eq(group.children.map((c: any) => c.id).sort(), [...scratchKeys].sort(), 'Scratch 组子项 = 3 个 scratch 文件夹');
    const flat = top.filter((p) => !p.isScratchGroup).length + group.children.length;
    eq(flat, expected.projectFolderCount, '展开后项目数 = 文件夹数（含只有空文件的文件夹）');
    for (const e of expected.projects as any[]) {
      const item = e.isScratch ? group.children.find((c: any) => c.id === e.projectKey) : top.find((p) => p.id === e.projectKey);
      ok(item, `项目 ${e.projectKey.slice(0, 24)} 存在`);
      eq([item.displayName, item.path ?? null], [e.displayName, e.path ?? null], `项目 ${e.displayName} 显示名 / 路径（取自 cwd）`);
    }
    const demo = (expected.projects as any[]).find((p) => p.projectKey === 'C--Users-----Work-demo');
    ok(/王测试/.test(demo.path), '夹具含中文用户名路径');
    const demoItem = top.find((p) => p.id === 'C--Users-----Work-demo');
    ok(demoItem.displayName === 'demo' && /王测试/.test(demoItem.path), '中文路径显示正确（显示名 demo，路径含"王测试"，非文件夹名 C--Users-----Work-demo）');
    // 关闭归并 → 顶层 = 全部文件夹
    await put(A, '/api/settings', { groupScratch: false });
    const flatTop = (await get(A, '/api/projects')).projects.length;
    eq(flatTop, expected.projectFolderCount, '关闭 Scratch 归并后顶层项目数 = 文件夹数');
    await put(A, '/api/settings', { groupScratch: true });
    return `${expected.projectFolderCount} 个文件夹 = ${top.length - 1} 个普通项目 + Scratch 组（${group.children.length} 个子项）；关闭归并后 ${flatTop} 个；中文路径 ${demo.path} → 显示名 ${demoItem.displayName}`;
  });

  await check('#3', 'PRD-10.3', '总量 = 曲线各点之和（小时 / 日 / 周 / 月四粒度，全部 + 每个项目，Total 与 Fresh）', async () => {
    let n = 0;
    for (const t of projectTargets) {
      const s = (await get(A, `/api/summary?range=all&project=${encodeURIComponent(t.id)}`)).summary;
      eq(s.total, t.total, `${t.id} 累计总量 vs expected`);
      for (const g of ['hour', 'day', 'week', 'month']) {
        const ts = await get(A, `/api/timeseries?range=all&project=${encodeURIComponent(t.id)}&granularity=${g}`);
        eq(sum(ts.points.map((p: any) => p.total)), t.total, `${t.id} ${g} Σ曲线`);
        eq(sum(ts.points.map((p: any) => p.requests)), s.requests, `${t.id} ${g} Σ请求数`);
        n++;
      }
      const fr = await get(A, `/api/timeseries?range=all&project=${encodeURIComponent(t.id)}&granularity=week&basis=fresh`);
      eq(sum(fr.points.map((p: any) => p.value)), (await get(A, `/api/summary?range=all&project=${encodeURIComponent(t.id)}&basis=fresh`)).summary.value, `${t.id} Fresh Σ曲线`);
    }
    return `${projectTargets.length} 个项目目标（含全部与 Scratch 组）× 4 粒度 = ${n} 条曲线，Σ曲线 = 累计 = expected，Fresh 同样成立`;
  });

  await check('#3x', 'PRD-10.3/4/5/6', '独立交叉核对（复用 test/apiCrossCheck.ts：HTTP 层 × 朴素实现，4 时区 × 4 粒度 × 周起始日 × 拆分 × 项目列表）', async () => {
    const r = await crossCheck(B(A), msgs, { now: NOW, tzs: ['UTC', 'Asia/Shanghai', 'America/New_York', 'Asia/Kolkata'] });
    if (r.fails.length > 0) throw new Fail(`${r.fails.length} 项不一致，首条：${r.fails[0]}`);
    assertCount += r.checks;
    return `${fmt(r.checks)} 项比较全部一致，覆盖 UTC / 上海 / 纽约(DST) / 加尔各答(+5:30)`;
  });

  await check('#4', 'PRD-10.4', '"今日 / 昨日 / 本周 / 本月"边界：固定 TV_NOW 与时区，与 expected 及曲线区间一致', async () => {
    let n = 0;
    for (const c of expected.phase2.nowCases as any[]) {
      const t = await app({ now: () => Date.parse(c.nowIso), settings: { timezone: c.tz, weekStart: c.weekStart } });
      const s = await get(t, '/api/summary?range=all');
      for (const k of ['today', 'yesterday', 'thisWeek', 'prevWeek', 'thisMonth', 'prevMonth'] as const) {
        const p = s.periods[k].summary;
        eq({ r: p.requests, t: p.total, f: p.fresh }, { r: c[k].requests, t: c[k].total, f: c[k].fresh }, `${c.name} ${k}`);
        n++;
      }
      // 周期卡 = 曲线对应区间之和
      const today = await get(t, '/api/timeseries?range=today&granularity=hour');
      eq(sum(today.points.map((p: any) => p.total)), s.periods.today.summary.total, `${c.name} 今日曲线(小时) Σ = 今日卡`);
      const month = await get(t, '/api/timeseries?range=thisMonth&granularity=day');
      eq(sum(month.points.map((p: any) => p.total)), s.periods.thisMonth.summary.total, `${c.name} 本月曲线(日) Σ = 本月卡`);
      await closeApp(t);
    }
    // 上海午夜边界：UTC 15:59:59 / 16:00:00 落相邻两日；换 UTC 则落同一日
    const d = (await get(A, '/api/timeseries?range=custom&from=2026-10-10&to=2026-10-11&project=D--Work-timeprobe&granularity=day')).points.map((p: any) => [p.key, p.requests]);
    eq(d, [['2026-10-10', 1], ['2026-10-11', 4]], '上海午夜前后一秒分属两日');
    const u = (await get(A, '/api/timeseries?range=custom&from=2026-10-10&to=2026-10-11&project=D--Work-timeprobe&granularity=day&tz=UTC')).points.map((p: any) => [p.key, p.requests]);
    eq(u, [['2026-10-10', 4], ['2026-10-11', 2]], 'UTC 下同一批记录的日归属不同');
    return `${(expected.phase2.nowCases as any[]).length} 个 now/时区/周起始日场景 × 6 个周期 = ${n} 项与 expected 一致（含纽约 DST 结束日、上海午夜后 30 分钟、UTC 月初）；今日 / 本月卡 = 对应曲线之和；午夜前后一秒日归属正确`;
  });

  await check('#5', 'PRD-10.5', '模型分析：占比之和 = 100%、<synthetic> 不入占比、本地模型归一化并标记', async () => {
    const m = await get(A, '/api/analysis/models?range=all');
    near(sum(m.models.map((x: any) => x.share)), 1, 1e-9, '占比之和');
    ok(!m.models.some((x: any) => /synthetic/.test(x.key)), '模型表无 <synthetic>');
    ok(expected.stats.syntheticExcluded > 0, '夹具含 <synthetic> 记录');
    eq(sum(m.models.map((x: any) => x.total)), expected.totals.total, '各模型 token 之和 = 总量（<synthetic> 不计）');
    for (const x of m.models) eq(x.total, expected.models[x.key].total, `模型 ${x.key} token`);
    const ts = await get(A, '/api/timeseries?range=all&split=model');
    ok(!ts.series.some((s: any) => /synthetic/.test(s.key) || /synthetic/.test(String(s.label))), '曲线拆分无 <synthetic>');
    const locals = m.models.filter((x: any) => x.isLocal);
    const cloudNames = m.models.filter((x: any) => !x.isLocal).map((x: any) => x.key);
    const gguf = m.models.find((x: any) => /\.gguf$/i.test(x.key));
    ok(gguf?.isLocal === true, 'gguf 路径型模型标记为本地');
    eq(gguf.display, 'Qwen3-35B-A3B', 'gguf 归一化显示名（去路径与量化后缀）');
    ok(m.models.find((x: any) => x.key === 'qwen/qwen3-coder-next')?.isLocal === true, 'org/name 型本地模型标记为本地');
    ok(cloudNames.every((k: string) => k.startsWith('claude-')), '云端模型都是 claude-*');
    const fam = await get(A, '/api/analysis/models?range=all&mergeFamilies=true');
    eq(fam.total, m.total, '家族合并后总量不变');
    near(sum(fam.models.map((x: any) => x.share)), 1, 1e-9, '家族合并后占比之和');
    return `${m.models.length} 个模型占比之和 ${sum(m.models.map((x: any) => x.share)).toFixed(12)}；排除 <synthetic> ${expected.stats.syntheticExcluded} 条；本地模型 ${locals.length} 个（${locals.map((x: any) => x.display).join(' / ')}）；家族合并 ${fam.models.length} 组总量不变`;
  });

  await check('#6', 'PRD-10.6', '口径切换：Total − Fresh = 缓存读之和（全部 / 各项目 / 各粒度 / 各卡片）', async () => {
    let n = 0;
    for (const t of projectTargets) {
      const tot = (await get(A, `/api/summary?range=all&project=${encodeURIComponent(t.id)}&basis=total`)).summary;
      const fr = (await get(A, `/api/summary?range=all&project=${encodeURIComponent(t.id)}&basis=fresh`)).summary;
      eq(tot.total - fr.value, tot.cacheRead, `${t.id} Total − Fresh = 缓存读`);
      eq(fr.value, tot.fresh, `${t.id} Fresh 口径的 value = fresh`);
      n++;
    }
    eq((await get(A, '/api/summary?range=all')).summary.cacheRead, expected.totals.cacheRead, '全部缓存读 = expected');
    for (const g of ['hour', 'day', 'week', 'month']) {
      const a = await get(A, `/api/timeseries?range=all&granularity=${g}&basis=total`);
      const b = await get(A, `/api/timeseries?range=all&granularity=${g}&basis=fresh`);
      eq(sum(a.points.map((p: any) => p.value)) - sum(b.points.map((p: any) => p.value)), expected.totals.cacheRead, `${g} 曲线 Total − Fresh`);
    }
    const pa = await get(A, '/api/projects?basis=total');
    const pb = await get(A, '/api/projects?basis=fresh');
    eq(pa.all.value - pb.all.value, expected.totals.cacheRead, '项目栏合计 Total − Fresh');
    const m1 = await get(A, '/api/analysis/models?range=all&basis=total');
    const m2 = await get(A, '/api/analysis/models?range=all&basis=fresh');
    eq(m1.total - m2.total, expected.totals.cacheRead, '模型分析 Total − Fresh');
    const w = (await get(A, '/api/summary?range=all')).periods;
    const wf = (await get(A, '/api/summary?range=all&basis=fresh')).periods;
    for (const k of ['today', 'thisWeek', 'thisMonth']) eq(w[k].summary.total - wf[k].summary.value, w[k].summary.cacheRead, `周期卡 ${k} Total − Fresh`);
    return `缓存读合计 ${fmt(expected.totals.cacheRead)}：Total ${fmt(expected.totals.total)} − Fresh ${fmt(expected.totals.fresh)}；${n} 个项目目标 + 4 粒度曲线 + 项目栏 + 模型分析 + 周期卡全部成立`;
  });

  await check('#7a', 'PRD-10.7（API 层）', '项目切换后端响应：每次切换所需的 4 个请求 p95 < 200 ms（fixture，冷缓存）', async () => {
    const A2 = await app({ settings: { timezone: TZ } });
    const lat: number[] = [];
    for (const t of projectTargets) {
      for (const k of ['summary', 'timeseries', 'analysis/models', 'sessions']) {
        const qs = k === 'timeseries' ? '&granularity=day&split=model' : k === 'sessions' ? '&pageSize=20' : '';
        const t0 = performance.now();
        const r = await fetch(`${A2.base}/api/${k}?range=30d&project=${encodeURIComponent(t.id)}${qs}`);
        await r.text();
        ok(r.status === 200, `${k} 200`);
        lat.push(performance.now() - t0);
      }
    }
    lat.sort((a, b) => a - b);
    const p95 = lat[Math.min(lat.length - 1, Math.floor(lat.length * 0.95))]!;
    ok(p95 < 200, `p95 ${p95.toFixed(1)} ms ≥ 200 ms`);
    await closeApp(A2);
    return `${lat.length} 次冷请求 p50 ${lat[Math.floor(lat.length / 2)]!.toFixed(1)} ms / p95 ${p95.toFixed(1)} ms / max ${lat[lat.length - 1]!.toFixed(1)} ms（界面渲染的切换 p95 由 e2e 的 batchB 用例度量）`;
  });

  await check('#13', 'PRD-10.13', '导出：CSV / JSON 求和 = 界面累计（日 / 模型 / 会话，Total 与 Fresh，各项目），不含正文标记与标题', async () => {
    const S = await app();
    await put(S, '/api/prices', { rules: [FLAT_RULE] });
    const cost = await get(S, '/api/cost/summary?range=all');
    let files = 0;
    const kinds = ['daily', 'model', 'session'] as const;
    const cols = (h: string[]): string[] => h.filter((c) => /title|name_text|message|content|prompt/i.test(c));
    for (const kind of kinds) {
      const r = await fetch(`${S.base}/api/export?kind=${kind}&format=csv&range=all`);
      ok(r.status === 200, `${kind} csv 200`);
      const buf = Buffer.from(await r.arrayBuffer());
      ok(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf, `${kind} CSV 以 UTF-8 BOM 开头`);
      const text = buf.toString('utf8');
      for (const bad of [MARKER, 'this tail must never', 'keep going']) ok(!text.includes(bad), `${kind} CSV 不含正文片段 ${bad}`);
      const csv = parseCsv(text);
      ok(csv.notes.length === 1 && /估算/.test(csv.notes[0]!), `${kind} CSV 首行为"估算"说明`);
      eq(cols(csv.header), [], `${kind} 列名不含标题 / 正文类列`);
      eq(sum(csv.rows.map((x) => Number(x.total_tokens))), expected.totals.total, `${kind} CSV Σ total_tokens = 界面累计`);
      eq(sum(csv.rows.map((x) => Number(x.cache_read_tokens))), expected.totals.cacheRead, `${kind} CSV Σ cache_read`);
      near(sum(csv.rows.map((x) => Number(x.cost_api_usd || 0))), cost.api.totalUsd, 1e-6, `${kind} CSV Σ cost_api_usd = 成本卡`);
      files++;
      const j = await (await fetch(`${S.base}/api/export?kind=${kind}&format=json&range=all`)).text();
      for (const bad of [MARKER, 'this tail must never', 'keep going']) ok(!j.includes(bad), `${kind} JSON 不含正文片段`);
      const jj = JSON.parse(j);
      eq(jj.meta.rowCount, jj.rows.length, `${kind} JSON rowCount`);
      eq(sum(jj.rows.map((x: any) => x.total_tokens)), expected.totals.total, `${kind} JSON Σ total_tokens`);
      files++;
    }
    // 日导出逐日 = expected 日汇总（上海）
    const daily = parseCsv(await (await fetch(`${S.base}/api/export?kind=daily&format=csv&range=all`)).text());
    const want = expected.phase2.dailyTotals[TZ] as Record<string, { requests: number; total: number }>;
    eq(daily.rows.length, Object.keys(want).length, '日导出行数 = 有记录的日子数');
    for (const r of daily.rows) eq([Number(r.requests), Number(r.total_tokens)], [want[r.date]!.requests, want[r.date]!.total], `日导出 ${r.date}`);
    // Fresh 口径 + 项目过滤 + 范围过滤
    const fr = parseCsv(await (await fetch(`${S.base}/api/export?kind=model&format=csv&range=all&basis=fresh`)).text());
    eq(sum(fr.rows.map((x) => Number(x.value_tokens))), expected.totals.fresh, 'Fresh 导出 Σ value_tokens');
    const alpha = parseCsv(await (await fetch(`${S.base}/api/export?kind=session&format=csv&range=all&project=D--Work-alpha`)).text());
    eq(sum(alpha.rows.map((x) => Number(x.total_tokens))), (await get(S, '/api/summary?range=all&project=D--Work-alpha')).summary.total, '项目过滤导出 Σ = 该项目累计');
    // 与界面口径一致：会话导出行数 = 会话页总数
    const sessCsv = parseCsv(await (await fetch(`${S.base}/api/export?kind=session&format=csv&range=all`)).text());
    eq(sessCsv.rows.length, (await get(S, '/api/sessions?range=all&pageSize=1')).total, '会话导出行数 = 会话页总数');
    await closeApp(S);
    return `${files} 个导出文件（日 / 模型 / 会话 × CSV / JSON）Σ total_tokens 全部 = ${fmt(expected.totals.total)}（界面累计）；日导出 ${daily.rows.length} 行逐日与 expected 一致；Fresh Σ = ${fmt(expected.totals.fresh)}；CSV 带 BOM 与"估算"说明行；无正文标记、无标题列`;
  });

  const fixtureAfter = hashTree(FIXTURE_ROOT);
  const d = diffMaps(fixtureBefore, fixtureAfter);
  await check('#12a', 'PRD-10.12（fixture 读写）', '进程内应用全程运行后，fixture 数据根逐字节无变化', async () => {
    eq(d, [], 'fixture 目录变化');
    return `${fixtureBefore.size} 个文件的 (大小 + SHA-256) 前后一致`;
  });
}

// ---------------------------------------------------------------------------
// 成本守恒（口径 ① 与 ②）
// ---------------------------------------------------------------------------
async function phaseCost(): Promise<void> {
  const view = naiveView(FIXTURE_ROOT);
  const recs = naiveRecords(view);

  await check('C1', '成本口径 ①', '等价 API 成本：固定价格表手算、分组之和 = 合计、本地模型 0 且不计价、未计价绝不当 0', async () => {
    const A = await app();
    await put(A, '/api/prices', { rules: [FLAT_RULE] });
    const byType = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
    let assumed = 0;
    for (const [model, u] of Object.entries<any>(expected.models)) {
      if (!model.startsWith('claude-')) continue;
      const unknown = Math.max(0, u.cacheWrite - u.cacheWrite5m - u.cacheWrite1h);
      assumed += unknown;
      byType.input += u.input / 1e6;
      byType.output += (u.output * 5) / 1e6;
      byType.cacheWrite += (u.cacheWrite5m * 2 + u.cacheWrite1h * 3 + unknown * 2) / 1e6;
      byType.cacheRead += (u.cacheRead * 0.1) / 1e6;
    }
    const want = byType.input + byType.output + byType.cacheWrite + byType.cacheRead;
    const cs = await get(A, '/api/cost/summary?range=all');
    near(cs.api.totalUsd, want, 1e-6, '总成本手算');
    for (const k of ['input', 'output', 'cacheWrite', 'cacheRead'] as const) near(cs.api.byType[k], byType[k], 1e-6, `分项 ${k}`);
    eq(cs.api.assumedCacheWrite5mTokens, assumed, '缺 5m/1h 细分按 5m 价的 token 数');
    eq([cs.api.unpricedTokens, cs.api.unpricedModels], [0, []], '全部已计价');
    for (const m of cs.byModel.filter((x: any) => x.local)) eq([m.cost.apiUsd, m.cost.unpricedTokens], [null, 0], `本地模型 ${m.display} 不计价也不算未计价`);
    // 分组之和 = 合计
    const sm = await get(A, '/api/summary?range=all');
    near(sm.summary.cost.apiUsd, cs.api.totalUsd, 1e-9, 'summary.cost');
    for (const g of ['hour', 'day', 'week', 'month']) {
      for (const split of ['none', 'model', 'project']) {
        const ts = await get(A, `/api/timeseries?range=all&granularity=${g}&split=${split}`);
        near(sum(ts.points.map((p: any) => p.cost.apiUsd ?? 0)), cs.api.totalUsd, 1e-5, `${g}/${split} Σ点成本`);
        if (split !== 'none') near(sum(ts.series.map((s: any) => sum(s.costValues.api))), cs.api.totalUsd, 1e-5, `${g}/${split} Σ系列成本`);
      }
    }
    const pj = await get(A, '/api/projects');
    near(sum(pj.projects.map((p: any) => p.cost.apiUsd ?? 0)), cs.api.totalUsd, 1e-5, 'Σ项目成本');
    near(sum(cs.byProject.map((p: any) => p.cost.apiUsd ?? 0)), cs.api.totalUsd, 1e-5, 'Σ成本模块项目表');
    near(sum(cs.byModel.map((p: any) => p.cost.apiUsd ?? 0)), cs.api.totalUsd, 1e-5, 'Σ成本模块模型表');
    const ss = await get(A, '/api/sessions?range=all&pageSize=500');
    near(sum(ss.rows.map((r: any) => r.cost?.apiUsd ?? 0)), cs.api.totalUsd, 1e-5, 'Σ会话成本');
    // 未计价：不当 0
    await put(A, '/api/prices', { rules: [{ ...FLAT_RULE, pattern: 'claude-sonnet*' }, { pattern: 'claude-opus-5-5', match: 'exact', ...FLAT, inputUsdPerM: null }, { pattern: 'claude-opus-5', match: 'exact', ...FLAT, outputUsdPerM: null }, { pattern: 'claude-haiku*', match: 'glob', ...FLAT, cacheReadUsdPerM: null }] });
    const unBody = await get(A, '/api/cost/summary?range=all');
    const un = unBody.api;
    const unModels = ['claude-opus-5-5', 'claude-opus-5', 'claude-haiku-4-5'];
    eq(un.unpricedModels, [...unModels].sort(), '未计价模型清单');
    eq(un.unpricedTokens, sum(unModels.map((k) => expected.models[k].total)), '未计价 token = expected');
    ok(un.totalUsd > 0 && un.totalUsd < cs.api.totalUsd, '已计价部分 > 0 且小于全部（未计价部分既没被当 0 计入，也没被丢弃提示）');
    ok(/部分模型未计价/.test(unBody.notes.join('')), '给出"部分模型未计价"提示');
    await put(A, '/api/prices', { rules: [{ ...FLAT_RULE, inputUsdPerM: null }] });
    const none = await get(A, '/api/summary?range=all');
    eq(none.cost.apiUsd, null, '全部未计价 → apiUsd = null（不是 0）');
    await closeApp(A);
    return `总成本 $${want.toFixed(6)}（输入 ${byType.input.toFixed(6)} / 输出 ${byType.output.toFixed(6)} / 缓存写 ${byType.cacheWrite.toFixed(6)} / 缓存读 ${byType.cacheRead.toFixed(6)}）与手算一致；曲线（4 粒度 × 3 拆分）/ 项目 / 会话 / 模型表 Σ = 合计；未计价 3 个模型 ${fmt(un.unpricedTokens)} tokens 单独提示；全未计价为 null`;
  });

  await check('C2', '成本口径 ②', '订阅摊销守恒：日费 = 月费 ÷ 当月天数；有用量日分摊之和 = 日费；Σ分摊 + idle = 范围日费之和；回本手算', async () => {
    const A = await app();
    const FEE = 31;
    await put(A, '/api/prices', { rules: [{ pattern: 'claude-*', match: 'glob', ...FLAT, cacheWrite1hUsdPerM: 2 }] });
    await put(A, '/api/settings', { subscription: { plan: 'custom', monthlyFeeUsd: FEE } });
    const costOf = (r: NaiveMsg): number => (r.model.startsWith('claude-') ? (r.input + r.output * 5 + r.cacheWrite * 2 + r.cacheRead * 0.1) / 1e6 : 0);
    const dayCost = new Map<string, number>();
    const dayProj = new Map<string, Map<string, number>>();
    for (const r of recs) {
      const d = dateOf(r.ts);
      const c = costOf(r);
      dayCost.set(d, (dayCost.get(d) ?? 0) + c);
      const m = dayProj.get(d) ?? new Map<string, number>();
      m.set(r.folder, (m.get(r.folder) ?? 0) + c);
      dayProj.set(d, m);
    }
    const today = dateOf(NOW);
    const first = [...dayCost.keys()].sort()[0]!;
    let expSub = 0;
    let expIdle = 0;
    for (let ms = Date.parse(`${first}T12:00:00Z`); dateOf(ms, 'UTC') <= today; ms += 86_400_000) {
      const d = new Date(ms).toISOString().slice(0, 10);
      const fee = FEE / daysIn(d);
      if ((dayCost.get(d) ?? 0) > 0) expSub += fee;
      else expIdle += fee;
    }
    const cs = await get(A, `/api/cost/summary?range=all&tz=${TZ}`);
    near(cs.subscription.totalUsd, expSub, 1e-5, 'Σ分摊 = 有用量日的日费之和');
    near(cs.subscription.idleUsd, expIdle, 1e-5, '闲置日订阅费 idleUsd');
    near(cs.subscription.totalUsd + cs.subscription.idleUsd, expSub + expIdle, 1e-5, 'subUsd + idleUsd = 范围内日订阅费之和');
    ok(expIdle > 0, '夹具含无记录的闲置日');
    near(cs.daily.find((x: any) => x.date === '2026-10-05').feeUsd, 1, 1e-9, '十月日费 = 31 ÷ 31 = $1');
    near(sum(cs.byProject.map((p: any) => p.cost.subUsd ?? 0)), cs.subscription.totalUsd, 1e-5, 'Σ项目分摊 = 总分摊');
    near(sum(cs.byModel.map((p: any) => p.cost.subUsd ?? 0)), cs.subscription.totalUsd, 1e-5, 'Σ模型分摊 = 总分摊');
    // 逐项目手算
    const subBy = new Map<string, number>();
    for (const [d, m] of dayProj) {
      const dc = dayCost.get(d) ?? 0;
      if (d > today || dc <= 0) continue;
      for (const [f, c] of m) subBy.set(f, (subBy.get(f) ?? 0) + ((FEE / daysIn(d)) * c) / dc);
    }
    const pj = await get(A, `/api/projects?tz=${TZ}`);
    for (const p of pj.projects) {
      const keys: string[] = p.isScratchGroup ? p.children.map((c: any) => c.id) : [p.id];
      near(p.cost.subUsd, sum(keys.map((k) => subBy.get(k) ?? 0)), 1e-5, `项目 ${p.displayName ?? p.id} 摊销额`);
    }
    for (const g of ['hour', 'day', 'week', 'month']) {
      const ts = await get(A, `/api/timeseries?range=all&granularity=${g}&tz=${TZ}`);
      near(sum(ts.points.map((p: any) => p.cost.subUsd ?? 0)), cs.subscription.totalUsd, 1e-5, `${g} Σ点摊销`);
    }
    // 回本（固定 now = 2026-10-20，十月已过 20 天 / 31 天）
    const mtd = sum(recs.filter((r) => r.ts >= Date.parse('2026-09-30T16:00:00Z') && r.ts <= NOW).map(costOf));
    const pb = await get(A, '/api/subscription/payback');
    eq([pb.month, pb.elapsedDays, pb.daysInMonth], ['2026-10', 20, 31], '回本月份 / 已过天数');
    near(pb.apiUsdMtd, mtd, 1e-5, '本月至今等价成本');
    near(pb.proratedFeeUsd, (FEE * 20) / 31, 1e-9, '已过天数摊销月费');
    near(pb.multipleMtd, mtd / FEE, 1e-3, '回本倍数');
    near(pb.projected.apiUsd, (mtd / 20) * 31, 1e-5, '整月预估成本');
    eq([pb.paidBack, pb.savingsUsd], [false, 0], '未超过月费 → 尚未回本，节省为 0 而非负数');
    await put(A, '/api/settings', { subscription: { monthlyFeeUsd: 0.01 } });
    const pb2 = await get(A, '/api/subscription/payback');
    ok(pb2.paidBack === true, '月费很低 → 已回本');
    near(pb2.savingsUsd, mtd - 0.01, 1e-5, '省下金额 = 成本 − 月费');
    await put(A, '/api/settings', { subscription: { plan: null, monthlyFeeUsd: null } });
    const none = await get(A, '/api/cost/summary?range=all');
    eq([none.subscription.configured, none.subscription.totalUsd], [false, null], '未设置订阅方案 → 口径②为空');
    eq((await get(A, '/api/subscription/payback')).configured, false, '未设置订阅方案 → 回本为空');
    await closeApp(A);
    return `月费 $31：Σ分摊 $${expSub.toFixed(4)} + 闲置 $${expIdle.toFixed(4)} = 范围日费之和 $${(expSub + expIdle).toFixed(4)}；逐项目 / 4 粒度曲线手算一致；本月至今 $${mtd.toFixed(6)} → ${(mtd / FEE).toFixed(4)}×，尚未回本；调低月费后回本；未设置订阅方案时为空`;
  });

  await check('C3', '价格来源', '内置价格 / 订阅月费：每个非空值都带 https 来源与核对日期', async () => {
    const rules = builtinDefaults().rules;
    let withPrice = 0;
    const dates = new Set<string>();
    for (const r of rules) {
      const has = [r.inputUsdPerM, r.outputUsdPerM, r.cacheWrite5mUsdPerM, r.cacheWrite1hUsdPerM, r.cacheReadUsdPerM].some((x) => x !== null);
      if (!has) continue;
      withPrice++;
      ok(/^https:\/\//.test(r.sourceUrl ?? ''), `${r.id} 缺 sourceUrl`);
      ok(/^\d{4}-\d{2}-\d{2}$/.test(r.checkedAt ?? ''), `${r.id} 缺 checkedAt`);
      dates.add(r.checkedAt!);
    }
    const plans = builtinPlans().plans;
    let fees = 0;
    for (const p of plans) {
      if (p.monthlyFeeUsd === null) continue;
      fees++;
      ok(/^https:\/\//.test(p.sourceUrl ?? ''), `${p.id} 缺 sourceUrl`);
      ok(/^\d{4}-\d{2}-\d{2}$/.test(p.checkedAt ?? ''), `${p.id} 缺 checkedAt`);
    }
    ok(withPrice > 5, '内置价格条数');
    return `内置价格 ${withPrice} 条、订阅档位月费 ${fees} 条均带来源与核对日期（${[...dates].join(' / ')}）；无来源的非空价格 = 0 条`;
  });
}

// ---------------------------------------------------------------------------
// AI 运行时长：手算合成数据
// ---------------------------------------------------------------------------
function writeActivityRoot(root: string): { s1: string; s2: string } {
  const M = Date.parse('2026-10-01T16:00:00.000Z'); // 上海 2026-10-02 00:00
  const iso = (m: number): string => new Date(M + m * MIN).toISOString();
  let n = 0;
  const asst = (m: number, sid: string, cwd: string, side: boolean): string =>
    JSON.stringify({ type: 'assistant', timestamp: iso(m), sessionId: sid, cwd, isSidechain: side, message: { id: `msg_act_${++n}`, model: 'claude-sonnet-5-5', role: 'assistant', content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } });
  const human = (m: number, sid: string, cwd: string): string => JSON.stringify({ type: 'user', timestamp: iso(m), sessionId: sid, cwd, message: { role: 'user', content: `${'x'.repeat(45)}${MARKER}` } });
  const tool = (m: number, sid: string, cwd: string): string => JSON.stringify({ type: 'user', timestamp: iso(m), sessionId: sid, cwd, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: MARKER }] } });
  const P = 'D:\\P';
  const Q = 'D:\\Q';
  // 主会话 s1（项目 P）：人 -30 → AI -25(间隔5 计) → tool_result -10(间隔15 恰好计) → AI +5(间隔15 计，跨午夜) →
  //   AI +25(间隔20 不计) → 人 +27(以真人输入结尾的间隔不计) → AI +30(间隔3 计) → AI +60(间隔30 不计)
  const s1 = [human(-30, 's1', P), asst(-25, 's1', P, false), tool(-10, 's1', P), asst(5, 's1', P, false), asst(25, 's1', P, false), human(27, 's1', P), asst(30, 's1', P, false), asst(60, 's1', P, false)];
  // 子代理（与主会话并行、重叠）：-20, -12(间隔 8 计), 0(间隔 12 计) → [-20, 0]
  const sub = [asst(-20, 's1', P, true), asst(-12, 's1', P, true), asst(0, 's1', P, true)];
  // 会话 s2（项目 Q，次日 +1440）：人 0 → AI +10(计) → AI +40(间隔 30 不计)
  const s2 = [human(1440, 's2', Q), asst(1450, 's2', Q, false), asst(1480, 's2', Q, false)];
  const dP = path.join(root, 'D--P');
  const dQ = path.join(root, 'D--Q');
  fs.mkdirSync(path.join(dP, 's1', 'subagents'), { recursive: true });
  fs.mkdirSync(dQ, { recursive: true });
  const f1 = path.join(dP, 's1.jsonl');
  const f2 = path.join(dQ, 's2.jsonl');
  fs.writeFileSync(f1, `${s1.join('\n')}\n`);
  fs.writeFileSync(path.join(dP, 's1', 'subagents', 'agent-a.jsonl'), `${sub.join('\n')}\n`);
  fs.writeFileSync(f2, `${s2.join('\n')}\n`);
  return { s1: f1, s2: f2 };
}

async function phaseActivity(): Promise<void> {
  await check('A1', 'AI 运行时长', '手算对账：并行并集、>15 分钟空闲不计、真人输入前间隔不计、跨午夜按日切分、增量 = 全量', async () => {
    const base = tmp('tv-acc-act-');
    const root = path.join(base, 'projects');
    const { s2 } = writeActivityRoot(root);
    const A = await app({ dataRoot: root });
    const range = 'range=custom&from=2026-10-01&to=2026-10-03';
    // 手算（分钟）：主会话 [-30,5] ∪ [27,30] = 38；子代理 [-20,0] = 20；s2 [1440,1450] = 10 → 并集 48、之和 68
    const all = (await get(A, `/api/summary?${range}`)).summary;
    eq([all.activeMs, all.activeMsSum], [48 * MIN, 68 * MIN], '并集 48 分钟 / 各文件之和 68 分钟（并行子代理重叠只算一次）');
    const days = await get(A, `/api/timeseries?${range}&granularity=day`);
    eq(days.points.map((p: any) => [p.key, p.activeMs / MIN]), [['2026-10-01', 30], ['2026-10-02', 8], ['2026-10-03', 10]], '跨午夜：[-30,5] 在 10-01 记 30 分钟、10-02 记 5 分钟（+ [27,30] 3 分钟）');
    eq(sum(days.points.map((p: any) => p.activeMs)), all.activeMs, '日桶之和 = 范围并集');
    const hours = await get(A, `/api/timeseries?${range}&granularity=hour`);
    eq(hours.points.filter((p: any) => p.activeMs > 0).map((p: any) => p.activeMs / MIN), [30, 8, 10], '小时桶（23 点 30 / 0 点 8 / 次日 0 点 10）');
    for (const p of hours.points) ok(p.activeMs <= 3_600_000, '任一小时桶 ≤ 1 小时');
    for (const g of ['week', 'month']) eq(sum((await get(A, `/api/timeseries?${range}&granularity=${g}`)).points.map((p: any) => p.activeMs)), all.activeMs, `${g} 粒度 Σ = 并集`);
    // 窗口裁剪：只看 10-02 一天 → 5 + 3 = 8 分钟（子代理 [-20,0] 在窗口外）
    const d2 = (await get(A, '/api/summary?range=custom&from=2026-10-02&to=2026-10-02')).summary;
    eq([d2.activeMs, d2.activeMsSum], [8 * MIN, 8 * MIN], '单日窗口裁剪');
    ok(d2.activeMs <= 24 * 3600_000, 'activeMs ≤ 范围时长');
    // 项目 / 子代理筛选
    const p = (await get(A, `/api/summary?${range}&project=D--P`)).summary;
    eq([p.activeMs, p.activeMsSum], [38 * MIN, 58 * MIN], '项目 P：并集 38 / 之和 58');
    const q = (await get(A, `/api/summary?${range}&project=D--Q`)).summary;
    eq([q.activeMs, q.activeMsSum], [10 * MIN, 10 * MIN], '项目 Q');
    const ns = (await get(A, `/api/summary?${range}&includeSidechain=false`)).summary;
    eq([ns.activeMs, ns.activeMsSum], [48 * MIN, 48 * MIN], '不含子代理：主会话 38 + s2 10（子代理 20 分钟被排除，之和随之从 68 降到 48）');
    // 不泄露正文
    for (const pth of ['/api/summary?range=all', '/api/sessions?range=all', `/api/timeseries?${range}&granularity=hour`]) ok(!JSON.stringify(await get(A, pth)).includes(MARKER), `${pth} 不含正文标记`);
    // 增量追加（含半行）后 = 全量重新解析
    const M = Date.parse('2026-10-01T16:00:00.000Z');
    const iso = (m: number): string => new Date(M + m * MIN).toISOString();
    const line = (m: number, id: string): string => JSON.stringify({ type: 'assistant', timestamp: iso(m), sessionId: 's2', cwd: 'D:\\Q', isSidechain: false, message: { id, model: 'claude-sonnet-5-5', role: 'assistant', content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 1, output_tokens: 1 } } });
    const l1 = line(1485, 'msg_act_x1');
    fs.appendFileSync(s2, l1.slice(0, 40)); // 半行：不得消费
    await post(A, '/api/refresh');
    eq((await get(A, `/api/summary?${range}`)).summary.activeMs, 48 * MIN, '半行不改变结果');
    fs.appendFileSync(s2, `${l1.slice(40)}\n${JSON.stringify({ type: 'user', timestamp: iso(1490), sessionId: 's2', message: { role: 'user', content: 'x' } })}\n${line(1492, 'msg_act_x2')}\n`);
    await post(A, '/api/refresh');
    // s2：[1440,1450] + [1480,1485](间隔 5) + [1490,1492] = 10 + 5 + 2；人 1490 前的间隔(1485→1490)不计
    const inc = (await get(A, `/api/summary?${range}`)).summary;
    eq([inc.activeMs, inc.activeMsSum], [(38 + 17) * MIN, (58 + 17) * MIN], '增量追加后的手算值');
    const B2 = await app({ dataRoot: root });
    const full = (await get(B2, `/api/summary?${range}`)).summary;
    eq([full.activeMs, full.activeMsSum], [inc.activeMs, inc.activeMsSum], '增量 = 从零全量解析');
    await closeApp(B2);
    await closeApp(A);
    return '并集 48 分钟 / 之和 68 分钟；日桶 [30, 8, 10] 分钟；小时桶 [30, 8, 10]；单日窗口 8 分钟；项目 P 38/58、Q 10/10、不含子代理 48/48；增量追加（含半行）后 55 分钟 = 全量解析；响应不含正文标记';
  });
}

// ---------------------------------------------------------------------------
// 隐藏项目：分组之和 = 合计
// ---------------------------------------------------------------------------
async function phaseHidden(): Promise<void> {
  await check('H1', '项目管理', '隐藏项目后：全部合计 / 曲线 / 项目分组 / 成本 / 运行时长 / 导出 / 会话一致地不含它，分组之和 = 合计；恢复后复原', async () => {
    const A = await app();
    await put(A, '/api/prices', { rules: [FLAT_RULE] });
    await put(A, '/api/settings', { subscription: { plan: 'custom', monthlyFeeUsd: 31 } });
    const snap = async (): Promise<any> => {
      const sm = await get(A, '/api/summary?range=all');
      const pr = await get(A, '/api/projects');
      const split = await get(A, '/api/timeseries?range=all&granularity=month&split=project');
      const ts = await get(A, '/api/timeseries?range=all&granularity=day');
      const ses = await get(A, '/api/sessions?range=all&pageSize=500');
      const exp = parseCsv(await (await fetch(`${A.base}/api/export?kind=daily&format=csv&range=all`)).text());
      const out = {
        total: sm.summary.total,
        req: sm.summary.requests,
        cost: sm.cost.apiUsd as number,
        sub: sm.cost.subUsd as number,
        active: sm.summary.activeMsSum as number,
        projSum: sum(pr.projects.map((p: any) => p.total)),
        projCost: sum(pr.projects.map((p: any) => p.cost.apiUsd ?? 0)),
        groups: sum(split.series.map((s: any) => s.total)),
        tsSum: sum(ts.points.map((p: any) => p.total)),
        sess: sum(ses.rows.map((r: any) => r.total)),
        exp: sum(exp.rows.map((r) => Number(r.total_tokens))),
        hidden: pr.hiddenCount as number,
      };
      eq(out.projSum, out.total, '项目分组之和 = 全部合计');
      eq(out.groups, out.total, '按项目拆分曲线之和 = 全部合计');
      eq(out.tsSum, out.total, '日曲线之和 = 全部合计');
      eq(out.sess, out.total, '会话之和 = 全部合计');
      eq(out.exp, out.total, '导出求和 = 全部合计');
      near(out.projCost, out.cost, 1e-5, '项目成本之和 = 全部成本');
      return out;
    };
    const base = await snap();
    eq(base.total, expected.totals.total, '基线 = expected');
    eq(base.hidden, 0, '基线无隐藏');
    const alphaTot = (expected.projects as any[]).find((p) => p.projectKey === 'D--Work-alpha').total;
    const alphaActive = (await get(A, '/api/summary?range=all&project=D--Work-alpha')).summary.activeMsSum;
    await put(A, '/api/project-overrides', { id: 'D--Work-alpha', hidden: true });
    const h1 = await snap();
    eq(h1.total, base.total - alphaTot, '隐藏 alpha 后合计 = 全部 − alpha');
    eq(h1.hidden, 1, '隐藏数 1');
    eq(h1.active, base.active - alphaActive, '运行时长（各文件之和）同步剔除隐藏项目');
    ok(h1.cost < base.cost && h1.sub !== null, '成本同步减少');
    eq((await get(A, '/api/summary?range=all&project=all')).summary.total, h1.total, 'project=all 与默认一致');
    await put(A, '/api/project-overrides', { id: 'scratch', hidden: true });
    const h2 = await snap();
    eq(h2.total, base.total - alphaTot - scratchTotal, '再隐藏整个 Scratch 组');
    eq(h2.hidden, 2, '隐藏数 2');
    await post(A, '/api/project-overrides/unhide-all');
    const h3 = await snap();
    eq({ ...h3 }, { ...base }, '恢复后全部数值与基线逐项相同');
    await closeApp(A);
    return `隐藏 alpha（−${fmt(alphaTot)}）→ 合计 ${fmt(h1.total)}；再隐藏 Scratch 组（−${fmt(scratchTotal)}）→ ${fmt(h2.total)}；每一步 项目分组 / 拆分曲线 / 日曲线 / 会话 / 导出 / 成本 之和 = 合计；全部恢复后 12 项指标与基线逐项相同`;
  });
}

// ---------------------------------------------------------------------------
// 实时服务会话：#8 增量刷新、#10 容错、#12 只读 / 零外网 / 无正文
// ---------------------------------------------------------------------------
interface AuditEvent {
  k: string;
  fn?: string;
  path?: string;
  host?: string;
  port?: number;
  url?: string;
  cmd?: string;
}
function readAudit(file: string): AuditEvent[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as AuditEvent);
}
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '::ffff:127.0.0.1', '0.0.0.0']);
const inside = (p: string, dir: string): boolean => {
  const rel = path.relative(path.resolve(dir), path.resolve(p));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/** 用审计钩子起真实的服务进程（node src/server/index.ts --no-open）。 */
async function startAuditedServer(o: { dataRoot: string; appData: string; log: string; now?: string }): Promise<{ url: string; proc: ChildProcess; stop: () => Promise<void> }> {
  fs.mkdirSync(o.appData, { recursive: true });
  const proc = spawn(process.execPath, ['--import', pathToFileURL(path.join(ROOT, 'scripts', 'audit-hook.mjs')).href, 'src/server/index.ts', '--no-open'], {
    cwd: ROOT,
    env: { ...process.env, TV_DATA_ROOT: o.dataRoot, TV_APPDATA_DIR: o.appData, TV_PORT: '0', TV_NO_OPEN: '1', TV_AUDIT_LOG: o.log, ...(o.now ? { TV_NOW: o.now } : {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  procs.push(proc);
  let out = '';
  proc.stdout?.on('data', (d: Buffer) => (out += d.toString('utf8')));
  proc.stderr?.on('data', (d: Buffer) => (out += d.toString('utf8')));
  const url = await new Promise<string>((resolve, reject) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      const m = /(http:\/\/127\.0\.0\.1:\d+\/)/.exec(out);
      if (m) {
        clearInterval(timer);
        resolve(m[1]!.replace(/\/$/, ''));
      } else if (Date.now() - t0 > 30_000 || proc.exitCode !== null) {
        clearInterval(timer);
        reject(new Fail(`服务没有启动：${out.slice(0, 300)}`));
      }
    }, 30);
  });
  return {
    url,
    proc,
    stop: async () => {
      if (proc.exitCode === null) {
        proc.kill();
        await new Promise<void>((r) => {
          proc.once('exit', () => r());
          setTimeout(r, 3000);
        });
      }
    },
  };
}
async function waitIdle(url: string, timeoutMs = 30_000): Promise<number> {
  const t0 = performance.now();
  for (;;) {
    try {
      const s = (await (await fetch(`${url}/api/status`)).json()) as any;
      if (s.state === 'idle' && s.lastScanAt !== null) return performance.now() - t0;
    } catch {
      // 继续等
    }
    if (performance.now() - t0 > timeoutMs) throw new Fail('等待服务扫描完成超时');
    await new Promise((r) => setTimeout(r, 30));
  }
}
const J = async (url: string, p: string): Promise<any> => {
  const r = await fetch(`${url}${p}`);
  const t = await r.text();
  if (r.status !== 200) throw new Fail(`GET ${p} → ${r.status} ${t.slice(0, 200)}`);
  return JSON.parse(t);
};

async function phaseLive(): Promise<void> {
  const base = tmp('tv-acc-live-');
  const dataRoot = path.join(base, 'projects');
  const appData = path.join(base, 'appdata');
  const log = path.join(base, 'audit.log');
  fs.cpSync(path.join(ROOT, 'test', 'fixtures', 'projects'), dataRoot, { recursive: true });
  const srv = await startAuditedServer({ dataRoot, appData, log, now: '2026-10-20T12:00:00.000Z' });
  const url = srv.url;
  let sentinel: Map<string, string> | null = null;
  let afterHash: Map<string, string> | null = null;
  let probeRows = 0;
  try {
    await waitIdle(url);
    await fetch(`${url}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ timezone: TZ }) });
    const alphaDir = path.join(dataRoot, 'D--Work-alpha');
    // 取一个以换行结尾的文件（夹具里有的文件故意以半行结尾，往里追加会把半行接成损坏行）
    const endsWithNl = (f: string): boolean => {
      const b = fs.readFileSync(path.join(alphaDir, f));
      return b.length > 0 && b[b.length - 1] === 0x0a;
    };
    const alphaFile = fs.readdirSync(alphaDir).filter((f) => f.endsWith('.jsonl') && endsWithNl(f)).sort()[0]!;
    const target = path.join(alphaDir, alphaFile);
    const sample = JSON.parse(fs.readFileSync(target, 'utf8').split('\n').find((l) => l.includes('"type":"assistant"'))!);
    const mk = (id: string, tsIso: string, extra: Record<string, unknown> = {}, usage: any = { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 1000, output_tokens: 50 }): string =>
      JSON.stringify({ ...sample, timestamp: tsIso, requestId: undefined, ...extra, message: { ...sample.message, id, model: 'claude-sonnet-5-5', usage } });

    // ---- #8 增量刷新 ----
    await check('#8', 'PRD-10.8', '增量刷新：向运行中的服务追加新记录，≤ 10 秒内 API 数字更新（真实服务进程，默认轮询）', async () => {
      const s0 = (await J(url, '/api/summary?range=all')).summary;
      const ts0 = await J(url, '/api/timeseries?range=all&granularity=day');
      const t0 = performance.now();
      fs.appendFileSync(target, `${mk('msg_acc_live_1', '2026-10-20T11:00:00.000Z')}\n`);
      let s1 = s0;
      for (;;) {
        s1 = (await J(url, '/api/summary?range=all')).summary;
        if (s1.requests === s0.requests + 1) break;
        if (performance.now() - t0 > 12_000) throw new Fail('12 秒内数字没有更新');
        await new Promise((r) => setTimeout(r, 100));
      }
      const dt = performance.now() - t0;
      ok(dt <= 10_000, `更新耗时 ${Math.round(dt)} ms > 10000 ms`);
      eq(s1.total - s0.total, 1150, '新增 total = 100 + 0 + 1000 + 50');
      const ts1 = await J(url, '/api/timeseries?range=all&granularity=day');
      eq(sum(ts1.points.map((p: any) => p.total)) - sum(ts0.points.map((p: any) => p.total)), 1150, '曲线同步 +1150');
      eq((await J(url, '/api/status')).dataVersion > 0, true, 'dataVersion 有效');
      return `追加 1 条记录后 ${Math.round(dt)} ms 内 /api/summary 的请求数 ${s0.requests} → ${s1.requests}、Total +1150、日曲线 Σ 同步（阈值 10 000 ms）`;
    });

    // ---- #10 容错 ----
    await check('#10', 'PRD-10.10', '容错：损坏行 / 空文件 / 缺字段 / 未知类型 / 半行，不崩溃并计入数据质量面板', async () => {
      const q0 = await J(url, '/api/analysis/quality');
      const s0 = (await J(url, '/api/summary?range=all')).summary;
      const pidAlive = srv.proc.exitCode === null;
      ok(pidAlive, '服务进程存活');
      const bad = path.join(alphaDir, 'zz-corrupt.jsonl');
      const nousage = JSON.stringify({ type: 'assistant', timestamp: '2026-10-20T11:10:00.000Z', sessionId: 'zz', cwd: 'D:\\Work\\alpha', message: { id: 'msg_acc_nousage', model: 'claude-sonnet-5-5', role: 'assistant', content: [] } });
      fs.writeFileSync(bad, `{"type":"assistant","message":{"id":\n${nousage}\n${JSON.stringify({ type: 'future-type-zzz', foo: 1 })}\n${JSON.stringify({ type: 'assistant', message: { id: 'msg_acc_notime', model: 'claude-sonnet-5-5', usage: { input_tokens: 1, output_tokens: 1 } } })}\nnot json at all\n`);
      fs.writeFileSync(path.join(alphaDir, 'zz-empty.jsonl'), '');
      // 半行：不带换行的未完成记录
      const half = mk('msg_acc_half', '2026-10-20T11:20:00.000Z');
      fs.appendFileSync(target, half.slice(0, half.length - 25));
      const r = await fetch(`${url}/api/refresh`, { method: 'POST' });
      ok(r.status === 200, 'refresh 200');
      const q1 = await J(url, '/api/analysis/quality');
      const s1 = (await J(url, '/api/summary?range=all')).summary;
      eq(q1.corruptLines - q0.corruptLines, 2, '损坏行 +2（截断 JSON + 非 JSON）');
      eq(q1.emptyFiles - q0.emptyFiles, 1, '空文件 +1');
      eq(q1.missingUsage - q0.missingUsage, 1, '缺 usage +1');
      ok(s1.requests - s0.requests <= 2, '缺字段 / 无时间戳记录不应制造大量请求');
      eq((await J(url, '/api/status')).state, 'idle', '服务仍处于 idle，未崩溃');
      ok(srv.proc.exitCode === null, '服务进程仍在运行');
      // 半行未被消费：补全后才 +1
      const before = (await J(url, '/api/summary?range=all')).summary.requests;
      fs.appendFileSync(target, `${half.slice(half.length - 25)}\n`);
      await fetch(`${url}/api/refresh`, { method: 'POST' });
      eq((await J(url, '/api/summary?range=all')).summary.requests - before, 1, '半行补全后 +1');
      for (const p of ['/api/summary?range=all', '/api/projects', '/api/sessions?range=all', '/api/analysis/models?range=all']) ok((await fetch(`${url}${p}`)).status === 200, `${p} 仍可用`);
      return `追加后质量面板：损坏行 ${q0.corruptLines}→${q1.corruptLines}、空文件 ${q0.emptyFiles}→${q1.emptyFiles}、缺 usage ${q0.missingUsage}→${q1.missingUsage}；未知类型 / 无时间戳 / 半行均未使服务崩溃（进程存活、state=idle、各端点 200）；半行补全后才计 1 条请求`;
    });

    // ---- #12 / 审计阶段：先固化"用户数据"基线，再让应用做一切会写盘的操作 ----
    sentinel = hashTree(dataRoot);
    const bodies: string[] = [];
    const rec = async (p: string, init?: RequestInit): Promise<void> => {
      const r = await fetch(`${url}${p}`, init);
      const t = await r.text();
      probeRows++;
      bodies.push(t);
    };
    const jsonPut = (body: unknown): RequestInit => ({ method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const gets = [
      '/api/status', '/api/projects', '/api/summary?range=all', '/api/timeseries?range=all&granularity=hour&split=model', '/api/timeseries?range=all&granularity=day&split=project', '/api/heatmap', '/api/day-detail?date=2026-10-05',
      '/api/analysis/models?range=all', '/api/analysis/composition?range=all', '/api/analysis/projects?range=all', '/api/analysis/sessions-top?range=all&limit=50', '/api/analysis/cache-efficiency?range=all', '/api/analysis/activity-grid?range=all',
      '/api/analysis/tools?range=all', '/api/analysis/sidechain?range=all', '/api/analysis/local-vs-cloud?range=all', '/api/analysis/quality', '/api/sessions?range=all&pageSize=500', '/api/cost/summary?range=all', '/api/subscription/payback', '/api/subscription/plans',
      '/api/prices', '/api/settings', '/api/project-overrides', '/api/timezones',
      '/api/export?kind=daily&format=csv&range=all', '/api/export?kind=model&format=json&range=all', '/api/export?kind=session&format=csv&range=all',
    ];
    for (const p of gets) await rec(p);
    for (const id of Object.keys(expected.sessions)) await rec(`/api/sessions/${id}`);
    await rec('/api/settings', jsonPut({ timezone: 'UTC', theme: 'dark', budget: { daily: 1000000, monthly: null }, subscription: { plan: 'custom', monthlyFeeUsd: 100 } }));
    await rec('/api/settings', jsonPut({ timezone: TZ, theme: 'light' }));
    await rec('/api/prices', jsonPut({ rules: [FLAT_RULE] }));
    await rec('/api/prices/reset', { method: 'POST' });
    await rec('/api/project-overrides', jsonPut({ id: 'D--Work-beta', name: '重命名测试', pinned: true, hidden: true }));
    await rec('/api/project-overrides/unhide-all', { method: 'POST' });
    await rec('/api/project-overrides', jsonPut({ id: 'D--Work-beta', name: null, pinned: false }));
    await rec('/api/settings/validate-root', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: dataRoot }) });
    await rec('/api/refresh', { method: 'POST' });
    await rec('/api/rebuild', { method: 'POST' });
    await waitIdle(url);
    await rec('/api/summary?range=all');
    // 静态资源：index.html 及其引用
    const idx = await (await fetch(`${url}/`)).text();
    const refs = [...idx.matchAll(/(?:src|href)="([^"#]+)"/g)].map((m) => m[1]!);
    const external = refs.filter((r) => /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(r));
    for (const r of refs.filter((x) => !external.includes(x))) {
      const rr = await fetch(new URL(r, `${url}/`).href);
      await rr.arrayBuffer();
    }
    afterHash = hashTree(dataRoot);

    await srv.stop();
    // 服务停止后读审计日志
    const ev = readAudit(log);

    await check('#12b', 'PRD-10.12', '只读：运行并执行全部写类接口后，数据根逐字节无变化；应用只写应用数据目录', async () => {
      eq(diffMaps(sentinel!, afterHash!), [], '数据根变化（运行 + 设置 / 价格 / 覆盖 / 刷新 / 重建 / 导出之后）');
      ok(ev.some((e) => e.k === 'ready'), '审计钩子已生效');
      const writes = ev.filter((e) => e.k === 'write' && e.path);
      ok(writes.length > 0, '审计到了写操作（证明钩子有效：设置 / 价格 / 缓存写盘）');
      const outside = writes.filter((e) => !inside(e.path!, appData));
      eq(outside.map((e) => `${e.fn}:${e.path}`), [], '应用数据目录之外的写操作');
      const files = new Set(writes.map((e) => path.relative(appData, e.path!).split(path.sep)[0]!.replace(/\.\d+\.\d+\.tmp$/, '')).filter(Boolean));
      const reads = ev.filter((e) => e.k === 'read' && e.path && inside(e.path, dataRoot) && ['open', 'readFile', 'createReadStream'].includes(e.fn ?? ''));
      const odd = reads.filter((e) => !/\.jsonl$/i.test(e.path!) && path.basename(e.path!).toLowerCase() !== 'custom-title.json');
      eq(odd.map((e) => e.path), [], '数据根内被打开读取的非 *.jsonl / custom-title.json 文件');
      return `数据根 ${sentinel!.size} 个文件前后 SHA-256 一致；审计到 ${writes.length} 次写操作全部在应用数据目录内（${[...files].join(' / ')}）；数据根内打开读取的文件 ${new Set(reads.map((e) => e.path)).size} 个，全部为 *.jsonl / custom-title.json`;
    });

    await check('#12c', 'PRD-10.12', '零外网：服务进程运行期外部连接 / DNS / fetch / 子进程 = 0；静态资源无外链', async () => {
      const conn = ev.filter((e) => e.k === 'connect');
      const ext = conn.filter((e) => !LOOPBACK.has(e.host ?? '') && !(e.host ?? '').startsWith('pipe:'));
      eq(ext.map((e) => `${e.host}:${e.port}`), [], '非回环出站连接');
      const dnsExt = ev.filter((e) => e.k === 'dns' && !LOOPBACK.has(e.host ?? ''));
      eq(dnsExt.map((e) => e.host), [], '非回环 DNS 解析');
      eq(ev.filter((e) => e.k === 'fetch' || e.k === 'http').map((e) => e.url ?? e.host), [], '服务进程内的 fetch / http(s).request');
      eq(ev.filter((e) => e.k === 'spawn').map((e) => e.cmd), [], '服务进程内的子进程（--no-open）');
      eq(external, [], 'index.html 外链');
      // 构建产物与源码里没有 http(s) 外链（命名空间 URI 除外）
      const bad: string[] = [];
      const dist = path.join(ROOT, 'web', 'dist');
      ok(fs.existsSync(path.join(dist, 'index.html')), 'web/dist 已构建（先 npm run build）');
      const walk = (d: string): void => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const f = path.join(d, e.name);
          if (e.isDirectory()) walk(f);
          else if (/\.(html|js|css|svg|json)$/.test(e.name)) {
            const txt = fs.readFileSync(f, 'utf8');
            for (const m of txt.matchAll(/https?:\/\/[^\s"'`)<>\\]+/g)) if (!/^https?:\/\/www\.w3\.org\//.test(m[0])) bad.push(`${path.relative(dist, f)}: ${m[0]}`);
          }
        }
      };
      walk(dist);
      eq(bad, [], 'web/dist 内的外链');
      return `审计到出站连接 ${conn.length} 次（全部回环：${[...new Set(conn.map((e) => `${e.host}`))].join(', ') || '无'}）；非回环连接 / DNS / fetch / 子进程均为 0；index.html 引用资源 ${refs.length} 个均为站内；web/dist 无外链（字体、图标均本地打包）。浏览器侧"网络请求只有 127.0.0.1"由 e2e batchB 用例断言`;
    });

    await check('#12d', 'PRD-10.8 隐私', '不含对话正文：全部 API / 导出响应（含 fixture 中带正文标记的记录）不含正文片段', async () => {
      const all = bodies.join('\n');
      for (const bad of [MARKER, 'this tail must never', 'keep going']) ok(!all.includes(bad), `响应含正文片段 ${bad}`);
      // fixture 文件里确实有该标记（否则断言没有意义）
      const raw = fs.readdirSync(dataRoot, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.jsonl')).map((f) => fs.readFileSync(path.join(dataRoot, f), 'utf8')).join('\n');
      ok(raw.includes(MARKER), '夹具数据含正文标记');
      return `${probeRows} 个 API / 导出响应共 ${fmt(all.length)} 字符不含标记 ${MARKER}、"this tail must never"、"keep going"；夹具源文件里确含这些标记`;
    });
  } finally {
    await srv.stop();
  }

  await check('#12e', 'PRD-10.12 自检', '审计钩子自检（金丝雀）：能抓到越界写、非白名单出站连接 / DNS / fetch，分类器会判为违规', async () => {
    const d = tmp('tv-acc-canary-');
    const clog = path.join(d, 'canary.log');
    const victim = path.join(d, 'outside-appdata.txt');
    const script = path.join(d, 'canary.mjs');
    fs.writeFileSync(
      script,
      [
        "import fs from 'node:fs'; import net from 'node:net'; import dns from 'node:dns';",
        "fs.writeFileSync(process.env.CANARY_FILE, 'x');",
        'fs.readFileSync(process.env.CANARY_FILE);',
        "await new Promise((r) => { const s = net.connect(9, '127.0.0.2'); s.on('error', r); s.on('connect', r); });",
        "await new Promise((r) => dns.lookup('127.0.0.2', () => r()));",
        "try { await fetch('http://127.0.0.2:9/'); } catch {}",
      ].join('\n'),
    );
    const r = spawnSync(process.execPath, ['--import', pathToFileURL(path.join(ROOT, 'scripts', 'audit-hook.mjs')).href, script], { env: { ...process.env, TV_AUDIT_LOG: clog, CANARY_FILE: victim }, encoding: 'utf8', timeout: 20_000 });
    ok(r.status === 0, `金丝雀进程退出码 ${r.status} ${r.stderr}`);
    const ev = readAudit(clog);
    ok(ev.some((e) => e.k === 'write' && e.path === victim), '抓到写操作');
    ok(!inside(victim, appData), '该写操作会被判为应用数据目录之外');
    ok(ev.some((e) => e.k === 'read' && e.path === victim), '抓到读操作');
    const c = ev.find((e) => e.k === 'connect' && e.host === '127.0.0.2');
    ok(c !== undefined && !LOOPBACK.has(c.host ?? ''), '抓到出站连接且被判为非回环');
    ok(ev.some((e) => e.k === 'dns' && e.host === '127.0.0.2'), '抓到 DNS');
    ok(ev.some((e) => e.k === 'fetch' && /127\.0\.0\.2/.test(e.url ?? '')), '抓到 fetch');
    return `金丝雀脚本的 1 次写 / 1 次读 / 1 次 TCP 连接 / 1 次 DNS / 1 次 fetch 全部被审计钩子记录（共 ${ev.length} 个事件），说明 #12b / #12c 的"0"不是钩子失效`;
  });
}

// ---------------------------------------------------------------------------
// 真实数据（只读，--real）
// ---------------------------------------------------------------------------
function statSnapshot(root: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of snapshotDir(root)) if (!e.isDir) m.set(e.rel, `${e.size}:${Math.round(e.mtimeMs)}`);
  return m;
}
async function phaseReal(): Promise<void> {
  if (!fs.existsSync(REAL_ROOT)) {
    skip('R*', 'PRD-10.9/12', '真实数据快照核对', `数据根不存在：${REAL_ROOT}`);
    return;
  }
  const snapBefore = statSnapshot(REAL_ROOT);
  const realBase = tmp('tv-acc-real-');
  const appData = path.join(realBase, 'appdata');
  const log1 = path.join(realBase, 'audit1.log');
  const log2 = path.join(realBase, 'audit2.log');
  let firstMs = 0;
  let progressSamples = 0;
  let totalReal = 0;
  let uniqueReal = 0;

  await check('R1', 'PRD-10.1/3（真实）', '真实数据：独立朴素实现 vs 主实现（npm run verify），零差异', async () => {
    const r = spawnSync(process.execPath, ['scripts/verify-real.ts', '--root', REAL_ROOT, '--tz', TZ], { cwd: ROOT, encoding: 'utf8', timeout: 240_000 });
    ok(r.status === 0, `verify 退出码 ${r.status}：${(r.stdout ?? '').split('\n').slice(-6).join(' | ')}`);
    const out = r.stdout ?? '';
    const um = /唯一消息数：朴素 (\d+) \/ 主 (\d+)/.exec(out);
    const tm = /Total token：朴素 (\d+) \/ 主 (\d+)/.exec(out);
    ok(um && tm, '解析 verify 输出');
    uniqueReal = Number(um![2]);
    totalReal = Number(tm![2]);
    const snapLine = out.split('\n').find((l) => l.includes('快照：'))?.trim();
    return `${snapLine ? `${snapLine}；` : ''}唯一消息 ${fmt(uniqueReal)}，Total ${fmt(totalReal)}，朴素实现与主实现零差异（verify 退出码 0）`;
  });

  await check('R2', 'PRD-10.9（真实）', '首次全量有进度、不卡死；二次启动（读缓存）≤ 3 秒到可交互', async () => {
    const s1 = await startAuditedServer({ dataRoot: REAL_ROOT, appData, log: log1 });
    try {
      const t0 = performance.now();
      const seen = new Set<string>();
      let sawScanning = false;
      for (;;) {
        const st = (await (await fetch(`${s1.url}/api/status`)).json()) as any;
        if (st.state === 'scanning') {
          sawScanning = true;
          seen.add(`${st.filesDone}/${st.filesTotal}`);
          // 扫描中其它端点必须可响应
          const t1 = performance.now();
          const pr = await fetch(`${s1.url}/api/projects`);
          await pr.text();
          ok(performance.now() - t1 < 2000, '扫描期间 /api/projects 响应 < 2 s（不假死）');
        }
        if (st.state === 'idle' && st.lastScanAt !== null) break;
        if (performance.now() - t0 > 180_000) throw new Fail('首次全量 > 180 s');
        await new Promise((r) => setTimeout(r, 40));
      }
      firstMs = performance.now() - t0;
      progressSamples = seen.size;
      const s = (await J(s1.url, '/api/summary?range=all')).summary;
      ok(Math.abs(s.requests - uniqueReal) <= Math.max(50, uniqueReal * 0.01), `API 请求数 ${s.requests} 与 verify 快照 ${uniqueReal} 相差过大（数据在增长时允许小偏差）`);
      ok(s.total >= totalReal * 0.99, 'API 总量不小于 verify 快照');
      await s1.stop();
      // 二次启动：同一应用数据目录（有缓存）
      const t2 = performance.now();
      const s2 = await startAuditedServer({ dataRoot: REAL_ROOT, appData, log: log2 });
      try {
        const sum2 = await (async (): Promise<any> => {
          for (;;) {
            const r = await fetch(`${s2.url}/api/summary?range=all`);
            if (r.status === 200) {
              const j = (await r.json()) as any;
              const st = (await (await fetch(`${s2.url}/api/status`)).json()) as any;
              if (st.state === 'idle' && st.lastScanAt !== null) return j;
            }
            if (performance.now() - t2 > 30_000) throw new Fail('二次启动 > 30 s');
            await new Promise((r2) => setTimeout(r2, 20));
          }
        })();
        const secondMs = performance.now() - t2;
        ok(secondMs <= 3000, `二次启动 ${Math.round(secondMs)} ms > 3000 ms`);
        ok(sum2.summary.requests > 0, '二次启动有数据');
        await s2.stop();
        return `首次全量 ${(firstMs / 1000).toFixed(1)} s，扫描期间观测到 ${progressSamples} 个不同进度值${sawScanning ? '' : '（扫描过快未捕获中间态）'}，且 /api/projects 始终 < 2 s；二次启动（含进程启动）到 summary 可用 ${Math.round(secondMs)} ms ≤ 3000 ms`;
      } finally {
        await s2.stop();
      }
    } finally {
      await s1.stop();
    }
  });

  await check('R3', 'PRD-10.12（真实）', '真实数据：服务进程外部连接 = 0、写入只在应用数据目录、只读 *.jsonl / custom-title.json；运行前后真实目录快照无变化', async () => {
    const ev = [...readAudit(log1), ...readAudit(log2)];
    const writes = ev.filter((e) => e.k === 'write' && e.path);
    ok(writes.length > 0, '审计到缓存写盘');
    eq(writes.filter((e) => !inside(e.path!, appData)).map((e) => `${e.fn}:${e.path}`), [], '应用数据目录之外的写');
    eq(ev.filter((e) => e.k === 'connect' && !LOOPBACK.has(e.host ?? '') && !(e.host ?? '').startsWith('pipe:')).map((e) => e.host), [], '非回环连接');
    eq(ev.filter((e) => e.k === 'dns' && !LOOPBACK.has(e.host ?? '')).map((e) => e.host), [], '非回环 DNS');
    const rd = ev.filter((e) => e.k === 'read' && e.path && inside(e.path, REAL_ROOT) && ['open', 'readFile', 'createReadStream'].includes(e.fn ?? ''));
    const odd = rd.filter((e) => !/\.jsonl$/i.test(e.path!) && path.basename(e.path!).toLowerCase() !== 'custom-title.json');
    eq(odd.map((e) => e.path), [], '数据根内被读取的其它文件');
    const claudeDir = path.resolve(REAL_ROOT, '..');
    eq(ev.filter((e) => (e.k === 'read' || e.k === 'write') && e.path && inside(e.path, claudeDir) && !inside(e.path, REAL_ROOT)).map((e) => e.path), [], '~/.claude 下数据根之外的任何读写（如 .credentials.json）');
    // 快照比较：只允许"增长"（Claude Code 自己在写日志），不允许应用造成的变化——
    // 这里的判据：既有文件不得变小 / 被删除；新增文件只能是 *.jsonl（应用没有写入数据根的任何路径，由上面的写审计保证）
    const snapAfter = statSnapshot(REAL_ROOT);
    const shrunk: string[] = [];
    for (const [k, v] of snapBefore) {
      const a = snapAfter.get(k);
      if (!a) shrunk.push(`消失：${k}`);
      else if (Number(a.split(':')[0]) < Number(v.split(':')[0])) shrunk.push(`变小：${k}`);
    }
    eq(shrunk, [], '真实数据目录中既有文件变小 / 消失');
    const added = [...snapAfter.keys()].filter((k) => !snapBefore.has(k));
    eq(added.filter((k) => !k.endsWith('.jsonl')), [], '新增的非 .jsonl 文件');
    const grown = [...snapAfter].filter(([k, v]) => snapBefore.get(k) !== undefined && snapBefore.get(k) !== v).length;
    return `两次启动共审计 ${ev.length} 个事件：写 ${writes.length} 次全在应用数据目录；非回环连接 / DNS = 0；数据根内只打开 *.jsonl（${new Set(rd.map((e) => e.path)).size} 个）；对 ~/.claude 其它位置零读写；快照 ${snapBefore.size} 个文件无缩小 / 消失（期间有 ${grown} 个文件因活跃会话自然增长、新增 ${added.length} 个 .jsonl，写审计证明不是应用所为）`;
  });

  await check('R4', 'AI 运行时长（真实）', '真实数据：API 的 activeMs / activeMsSum 与独立探针 active-time-probe.mjs 一致（±0.3 h，数据可能在增长）', async () => {
    const A = await app({ dataRoot: REAL_ROOT, settings: { timezone: 'UTC' } });
    const s = (await get(A, '/api/summary?range=all')).summary;
    const probe = spawnSync(process.execPath, [path.join(ROOT, 'docs', 'design', 'active-time-probe.mjs'), REAL_ROOT, '15'], { encoding: 'utf8', timeout: 120_000 });
    ok(probe.status === 0, '探针运行');
    const j = JSON.parse(probe.stdout);
    const uh = Number(String(j.wallClockUnion).replace(' h', ''));
    const sh = Number(String(j.perFileSum).replace(' h', ''));
    const apiU = s.activeMs / 3_600_000;
    const apiS = s.activeMsSum / 3_600_000;
    near(apiU, uh, 0.3, '并集（小时）');
    near(apiS, sh, 0.3, '各文件之和（小时）');
    ok(s.activeMs <= s.activeMsSum, '并集 ≤ 之和');
    await closeApp(A);
    return `API ${apiU.toFixed(2)} h / ${apiS.toFixed(2)} h；探针 ${uh} h / ${sh} h（15 分钟阈值，覆盖 ${j.distinctActiveDays} 个活跃日；与官方 turn_duration ${j.validation?.n ?? 0} 条对账：中位覆盖 ${j.validation?.medianCoverage ?? '-'}）`;
  });
}

// ---------------------------------------------------------------------------
// 回归：单测 / 类型检查 / e2e（作为支撑证据）
// ---------------------------------------------------------------------------
interface UnitResult {
  perFile: Map<string, { pass: number; fail: number }>;
  total: number;
  failed: number;
  ms: number;
  /** 失败用例（文件 › 名称 › 首行错误） */
  failures: Array<{ file: string; name: string; msg: string }>;
  /** 首轮失败的文件在重跑后的结果（仅对失败文件重跑一次，用来区分偶发与确定性失败） */
  retry?: { files: string[]; failed: number; ms: number };
}
function runNpm(args: string[], timeoutMs: number): { status: number | null; out: string; ms: number } {
  const t0 = performance.now();
  const r = spawnSync(`npm ${args.join(' ')}`, { cwd: ROOT, encoding: 'utf8', shell: true, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, ms: performance.now() - t0 };
}
function runUnit(): UnitResult | null {
  const out = path.join(tmp('tv-acc-vt-'), 'vitest.json');
  const r = runNpm(['exec', '--', 'vitest', 'run', '--reporter=json', `--outputFile=${out}`], 600_000);
  if (!fs.existsSync(out)) {
    console.log(`vitest 没有产出报告：${r.out.slice(-300)}`);
    return null;
  }
  const j = JSON.parse(fs.readFileSync(out, 'utf8')) as any;
  const perFile = new Map<string, { pass: number; fail: number }>();
  const failures: Array<{ file: string; name: string; msg: string }> = [];
  for (const f of j.testResults as any[]) {
    const name = path.basename(f.name as string);
    const a = perFile.get(name) ?? { pass: 0, fail: 0 };
    for (const t of f.assertionResults as any[]) {
      if (t.status === 'passed') a.pass++;
      else if (t.status === 'failed') {
        a.fail++;
        failures.push({ file: name, name: String(t.fullName ?? t.title), msg: String((t.failureMessages?.[0] ?? '').split('\n')[0]).slice(0, 200) });
      }
    }
    perFile.set(name, a);
  }
  const res: UnitResult = { perFile, total: j.numTotalTests, failed: j.numFailedTests, ms: r.ms, failures };
  if (res.failed > 0) {
    const files = [...new Set(failures.map((x) => x.file))].map((n) => `test/${n}`);
    const out2 = path.join(tmp('tv-acc-vt2-'), 'vitest.json');
    const r2 = runNpm(['exec', '--', 'vitest', 'run', ...files, '--reporter=json', `--outputFile=${out2}`], 300_000);
    const j2 = fs.existsSync(out2) ? (JSON.parse(fs.readFileSync(out2, 'utf8')) as any) : null;
    res.retry = { files, failed: j2 ? j2.numFailedTests : -1, ms: r2.ms };
  }
  return res;
}

// 各行 ← 支撑单测文件
const SUPPORT: Record<string, string[]> = {
  '#1': ['dedupe.test.ts', 'parser.test.ts', 'phase1-tester.test.ts', 'verify.test.ts', 'batchB-api.test.ts'],
  '#2': ['projects.test.ts', 'api.test.ts'],
  '#3': ['aggregate.test.ts', 'phase2-tester.test.ts', 'phase4-tester.test.ts'],
  '#3x': ['phase4-tester.test.ts'],
  '#4': ['time.test.ts', 'aggregate.test.ts', 'phase2-tester.test.ts'],
  '#5': ['models.test.ts', 'batchB-api.test.ts'],
  '#6': ['aggregate.test.ts', 'batchB-api.test.ts'],
  '#8': ['store.test.ts', 'phase3-tester.test.ts', 'watcher.test.ts'],
  '#10': ['parser.test.ts', 'store.test.ts', 'phase1-tester.test.ts'],
  '#12b': ['safeFs.test.ts', 'phase4-tester.test.ts'],
  '#12c': ['web-lib.test.ts', 'static.test.ts'],
  '#13': ['cost.test.ts'],
  C1: ['cost.test.ts', 'cost-format.test.ts'],
  C2: ['cost.test.ts'],
  C3: ['cost.test.ts'],
  A1: ['activity.test.ts', 'batchB-api.test.ts'],
  H1: ['cost.test.ts', 'projects.test.ts'],
};

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------
function esc(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}
function writeReport(o: { start: Date; ms: number; unit: UnitResult | null; typecheck: { ok: boolean; ms: number } | null; e2e: { ok: boolean; out: string; ms: number } | null }): void {
  const fails = rows.filter((r) => r.status === 'FAIL');
  const pass = rows.filter((r) => r.status === 'PASS').length;
  const skipped = rows.filter((r) => r.status === 'SKIP').length;
  const cmd = `npm run acceptance${WITH_REAL ? ' -- --real' : ''}${WITH_E2E ? ' -- --e2e' : ''}${SKIP_UNIT ? ' -- --skip-unit' : ''}`;
  const L: string[] = [];
  L.push('# 自动验收报告（npm run acceptance）');
  L.push('');
  L.push(`- 结论：**${fails.length === 0 ? '全部通过' : `${fails.length} 项失败`}**（PASS ${pass} / FAIL ${fails.length} / 未自动化或跳过 ${skipped}）`);
  L.push(`- 运行时间：${o.start.toLocaleString('zh-CN', { hour12: false })}（本机时间），总耗时 ${(o.ms / 1000).toFixed(1)} s`);
  L.push(`- 命令：\`${cmd}\`（Node ${process.version}，${process.platform}）`);
  L.push(`- 数据：\`test/fixtures/projects\`（合成数据，14 个文件、9 个项目文件夹），期望值来自 \`test/fixtures/expected.json\`（由 \`scripts/make-fixture.ts\` 的声明式规格推出，不是被测代码的输出）；固定"当前时间" TV_NOW = 2026-10-20T12:00:00Z，默认时区 ${TZ}`);
  L.push(`- 独立性：期望值要么来自上述 expected.json，要么来自与 \`src/\` 零共享代码的朴素实现（\`test/naiveView.ts\`、\`test/apiCrossCheck.ts\`）或脚本内手算；成本用固定价格表（输入 1 / 输出 5 / 5m 写 2 / 1h 写 3 / 读 0.1，USD 每百万 token）手算`);
  L.push('- 只读：数据根只读；被测服务只写临时应用数据目录；本脚本只写本文件与系统临时目录（均已清理）');
  L.push('');
  L.push('## 逐条结果');
  L.push('');
  L.push('| ID | PRD / 主题 | 检查项 | 结果 | 证据摘要 | 耗时 |');
  L.push('|---|---|---|---|---|---|');
  for (const r of rows) {
    const ev = esc(r.evidence) + (r.support ? `<br>支撑单测：${esc(r.support)}` : '');
    L.push(`| ${r.id} | ${r.prd} | ${esc(r.title)} | ${r.status === 'PASS' ? '**PASS**' : r.status === 'FAIL' ? '**FAIL**' : 'SKIP'} | ${ev} | ${r.ms ? (r.ms < 1000 ? `${Math.round(r.ms)} ms` : `${(r.ms / 1000).toFixed(1)} s`) : '—'} |`);
  }
  L.push('');
  L.push('## 不在本脚本内自动验证的 PRD 条目');
  L.push('');
  L.push('| PRD | 说明 | 由谁验证 |');
  L.push('|---|---|---|');
  L.push('| #7 项目切换 < 200 ms（界面渲染） | 脚本只度量后端响应（#7a）；界面渲染耗时 `window.__tvPerf` 在 e2e `batchB` 用例中度量 p95 | `npm run test:e2e`（可加 `--e2e` 一并执行） |');
  L.push('| #9 大数据 / 二次启动 ≤ 3 s | 需要真实数据；加 `--real` 度量（R2），否则见开发报告"性能自查" | `npm run acceptance -- --real` |');
  L.push('| #11 视觉一致性 | 需要对照设计稿与截图人工勾验（浅 / 深色 × 总览 / 分析 / 会话 / 设置 / 成本 / 首次扫描） | 统一测试 B；截图在 `test/screenshots/` |');
  L.push('| #12 浏览器侧外部请求 | 脚本用审计钩子验证服务进程（#12b / #12c）；浏览器侧"网络请求只有 127.0.0.1"、控制台 0 error / warn 由 e2e 断言 | `npm run test:e2e` |');
  L.push('');
  L.push('## 回归（支撑证据）');
  L.push('');
  if (o.unit) {
    L.push(`- \`vitest\`：${o.unit.total} 条，失败 ${o.unit.failed}，耗时 ${(o.unit.ms / 1000).toFixed(1)} s（${o.unit.failed === 0 ? '全部通过' : '有失败，见下'}）`);
    const bad = [...o.unit.perFile].filter(([, v]) => v.fail > 0);
    for (const [k, v] of bad) L.push(`  - 失败文件 ${k}：${v.fail} 条失败`);
  } else L.push('- `vitest`：未运行（`--skip-unit`）或未产出报告');
  if (o.typecheck) L.push(`- \`npm run typecheck\`：${o.typecheck.ok ? '通过' : '**失败**'}（${(o.typecheck.ms / 1000).toFixed(1)} s）`);
  if (o.e2e) L.push(`- \`npm run test:e2e\`：${o.e2e.ok ? '全部通过' : '**有失败**'}（${(o.e2e.ms / 1000).toFixed(0)} s）；${esc(o.e2e.out.trim().split('\n').slice(-3).join(' '))}`);
  else L.push('- `npm run test:e2e`：未运行（加 `--e2e`；约 5 分钟，运行期间不要并发其它浏览器进程）');
  L.push('');
  if (fails.length > 0) {
    L.push('## 失败详情');
    L.push('');
    for (const r of fails) {
      L.push(`### ${r.id} ${r.title}`);
      L.push('');
      L.push('```');
      L.push(r.evidence);
      if (r.detail) L.push(r.detail);
      L.push('```');
      L.push('');
    }
  }
  L.push('## 说明');
  L.push('');
  L.push('- 本文件由脚本生成，每次运行覆盖；失败的任何一行都会让脚本以非 0 退出码结束。');
  L.push('- "断言 N 条"是该行内部比较的次数；"支撑单测"是对应单测文件的通过 / 总数（本次 vitest 运行结果）。');
  L.push('- 夹具里有晚于固定 TV_NOW 的记录，所以夹具上"本月"周期与"截止此刻"的回本金额不同，这是预期的（真实数据里两者一致）。');
  L.push('');
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, L.join('\n'), 'utf8');
}

async function safePhase(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    const err = e as Error;
    rows.push({ id: `X-${name}`, prd: '脚本', title: `阶段 ${name} 异常中止`, status: 'FAIL', evidence: err.message.slice(0, 400), ms: 0, detail: err.stack });
    console.log(`FAIL  X-${name} 阶段异常：${err.message.slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
const start = new Date();
const t0 = performance.now();
console.log(`Token Visualizer 自动验收（${start.toISOString()}）`);
let unit: UnitResult | null = null;
let typecheck: { ok: boolean; ms: number } | null = null;
let e2e: { ok: boolean; out: string; ms: number } | null = null;
try {
  // 先跑耗 CPU 的单测 / 类型检查，再做对时间敏感的检查（#8 的 10 秒），避免互相抢资源
  if (!SKIP_UNIT) {
    console.log('— 运行 vitest 与 typecheck（支撑证据）…');
    unit = runUnit();
    const tc = runNpm(['run', 'typecheck'], 300_000);
    typecheck = { ok: tc.status === 0, ms: tc.ms };
    console.log(`  vitest：${unit ? `${unit.total} 条，失败 ${unit.failed}` : '无报告'}；typecheck：${typecheck.ok ? '通过' : '失败'}`);
  }
  console.log('— 数据 / 接口 / 成本 / 运行时长 / 隐藏项目 …');
  await safePhase('fixture', phaseFixtureApi);
  await safePhase('cost', phaseCost);
  await safePhase('activity', phaseActivity);
  await safePhase('hidden', phaseHidden);
  console.log('— 真实服务进程：增量刷新 / 容错 / 只读 / 零外网 …');
  await safePhase('live', phaseLive);
  if (WITH_REAL) {
    console.log('— 真实数据（只读）…');
    await safePhase('real', phaseReal);
  } else skip('R*', 'PRD-10.9', '真实数据快照核对', '未加 --real（可选）');
  if (WITH_E2E) {
    console.log('— e2e …');
    const r = runNpm(['run', 'test:e2e'], 900_000);
    e2e = { ok: r.status === 0, out: r.out, ms: r.ms };
  }
  if (unit && unit.failed > 0) {
    const names = unit.failures.map((x) => `${x.file} › ${x.name}`).join('；');
    const retryOk = unit.retry !== undefined && unit.retry.failed === 0;
    rows.push({
      id: 'U1',
      prd: '回归',
      title: '单元测试全部通过',
      status: retryOk ? 'PASS' : 'FAIL',
      evidence: retryOk ? `首轮 ${unit.failed} 条失败（${names}），仅重跑这些文件后全部通过——疑似偶发（环境 / 并发），请关注；其余 ${unit.total - unit.failed} 条首轮即通过` : `${unit.failed} 条失败：${names}${unit.retry ? `；重跑后仍失败 ${unit.retry.failed} 条` : ''}`,
      ms: unit.ms,
      detail: unit.failures.map((x) => `${x.file} › ${x.name}\n  ${x.msg}`).join('\n'),
    });
  }
  else if (unit) rows.push({ id: 'U1', prd: '回归', title: '单元测试全部通过', status: 'PASS', evidence: `${unit.total} 条 / ${unit.perFile.size} 个文件全部通过（断言 ${unit.total} 条）`, ms: unit.ms });
  if (typecheck) rows.push({ id: 'U2', prd: '回归', title: 'typecheck（根 / web / e2e 三个 tsconfig）', status: typecheck.ok ? 'PASS' : 'FAIL', evidence: typecheck.ok ? '无类型错误' : '见 npm run typecheck 输出', ms: typecheck.ms });
  if (e2e) rows.push({ id: 'U3', prd: '回归', title: 'e2e（Playwright）', status: e2e.ok ? 'PASS' : 'FAIL', evidence: e2e.out.trim().split('\n').slice(-2).join(' '), ms: e2e.ms });
  if (unit) {
    for (const r of rows) {
      const files = SUPPORT[r.id];
      if (!files) continue;
      r.support = files
        .map((f) => {
          const u = unit!.perFile.get(f);
          return u ? `${f} ${u.pass}/${u.pass + u.fail}` : null;
        })
        .filter(Boolean)
        .join('、');
    }
  }
} finally {
  await cleanupAll();
}
const ms = performance.now() - t0;
writeReport({ start, ms, unit, typecheck, e2e });
const nFail = rows.filter((r) => r.status === 'FAIL').length;
console.log(`\n${rows.filter((r) => r.status === 'PASS').length} PASS / ${nFail} FAIL / ${rows.filter((r) => r.status === 'SKIP').length} SKIP；耗时 ${(ms / 1000).toFixed(1)} s；报告 ${path.relative(ROOT, OUT)}`);
process.exit(nFail > 0 ? 1 : 0);

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { diffReports, makeMainBuilder, runVerify } from '../scripts/verify/run.ts';
import { naiveReport, takeSnapshot } from '../scripts/verify/naive.ts';
import { assistantLine, FIXTURE_ROOT, loadExpected, makeTmpDir, rmDir, snapshotDir } from './helpers.ts';
import type { Expected } from './helpers.ts';

const expected: Expected = loadExpected();
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');

describe('verify：独立核对脚本（验收 7）', () => {
  it('fixture 上四个时区都零差异，且与 expected 的关键数字一致', async () => {
    for (const tz of ['Asia/Shanghai', 'UTC', 'America/New_York', 'Asia/Kolkata']) {
      const r = await runVerify(FIXTURE_ROOT, tz);
      expect(r.diffs, tz).toEqual([]);
      expect(r.naive.uniqueMessages).toBe(expected.stats.uniqueMessages);
      expect(r.naive.crossFileDuplicates).toBe(expected.stats.crossFileDuplicates);
      expect(r.naive.totals.input).toBe(expected.totals.input);
      expect(r.naive.totals.cacheRead).toBe(expected.totals.cacheRead);
      expect(Object.keys(r.naive.byDay).length).toBe(Object.keys(expected.phase2.dailyTotals[tz]).length);
    }
  });

  it('朴素实现的 import 全部来自 node: 内置模块（不依赖 src/ 任何代码）', () => {
    const text = fs.readFileSync(path.join(repo, 'scripts', 'verify', 'naive.ts'), 'utf8');
    const specs = [...text.matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]!);
    expect(specs.length).toBeGreaterThan(0);
    for (const s of specs) expect(s.startsWith('node:'), s).toBe(true);
    expect(/require\(|import\(/.test(text)).toBe(false);
    expect(text).not.toMatch(/src\/(server|shared)/);
  });

  it('故意篡改主实现的一个字段：核对脚本能检出差异（总量 / 按项目 / 按模型 / 按日 / 按会话 同时报）', async () => {
    const tamper = makeMainBuilder({
      tamperRecords: (recs) => recs.map((r, i) => (i === 3 ? { ...r, output: r.output + 1 } : r)),
    });
    const r = await runVerify(FIXTURE_ROOT, 'Asia/Shanghai', tamper);
    expect(r.diffs.length).toBeGreaterThanOrEqual(5);
    expect(r.diffs.some((d) => d.startsWith('totals.output'))).toBe(true);
    for (const label of ['byProject', 'byModel', 'byDay', 'bySession']) expect(r.diffs.some((d) => d.startsWith(label)), label).toBe(true);
  });

  it('各种篡改都能被检出：丢记录、改时间（跨日）、改 token 类型、改模型名', async () => {
    const mk = (f: (recs: import('../src/shared/types.ts').UsageRecord[]) => import('../src/shared/types.ts').UsageRecord[]) => makeMainBuilder({ tamperRecords: f });
    const drop = await runVerify(FIXTURE_ROOT, 'UTC', mk((r) => r.slice(1)));
    expect(drop.diffs.some((d) => d.startsWith('byProject') || d.startsWith('bySession'))).toBe(true);
    expect(drop.diffs.some((d) => d.startsWith('totals'))).toBe(true);
    const shift = await runVerify(FIXTURE_ROOT, 'UTC', mk((r) => r.map((x, i) => (i === 10 ? { ...x, ts: x.ts + 3 * 86_400_000 } : x))));
    expect(shift.diffs.some((d) => d.startsWith('byDay'))).toBe(true);
    expect(shift.diffs.some((d) => d.startsWith('totals'))).toBe(false); // 总量不变，只有按日分布变
    const model = await runVerify(FIXTURE_ROOT, 'UTC', mk((r) => r.map((x, i) => (i === 5 ? { ...x, model: 'claude-fake-1' } : x))));
    expect(model.diffs.some((d) => d.startsWith('byModel'))).toBe(true);
    const cw = await runVerify(FIXTURE_ROOT, 'UTC', mk((r) => r.map((x, i) => (i === 7 ? { ...x, cacheWrite5m: x.cacheWrite5m + 1 } : x))));
    expect(cw.diffs.some((d) => d.startsWith('totals.cacheWrite5m'))).toBe(true);
  });

  it('diffReports：相同报告零差异；缺失键 / 数值不同都报告', async () => {
    const snap = takeSnapshot(FIXTURE_ROOT);
    const a = naiveReport(snap, 'UTC');
    const b = structuredClone(a);
    expect(diffReports(a, b)).toEqual([]);
    delete b.byModel[Object.keys(b.byModel)[0]!];
    b.byDay[Object.keys(b.byDay)[0]!]!.f.input += 5;
    const d = diffReports(a, b);
    expect(d.some((x) => x.includes('主实现中不存在'))).toBe(true);
    expect(d.some((x) => x.includes('.input'))).toBe(true);
  });

  describe('快照语义：目录在核对期间增长也不产生差异', () => {
    let tmp: string;
    beforeAll(() => {
      tmp = makeTmpDir('tv-verify-');
      fs.cpSync(FIXTURE_ROOT, tmp, { recursive: true });
    });
    afterAll(() => rmDir(tmp));

    it('快照之后追加行 / 新增文件：两边都忽略，零差异；再取新快照则两边同时看到新数据', async () => {
      const snap = takeSnapshot(tmp);
      const before = naiveReport(snap, 'Asia/Shanghai');
      // 快照之后：追加完整行 + 半行、并新增一个文件
      const target = path.join(tmp, 'D--Work-alpha', 'a1a1a1a1-0000-4000-8000-000000000002.jsonl');
      fs.appendFileSync(target, `${assistantLine({ id: 'msg_grown', input: 1000, out: 1000, ts: '2026-10-07T00:00:00.000Z' })}\n{"partial":`);
      fs.mkdirSync(path.join(tmp, 'D--Work-new'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'D--Work-new', 'n.jsonl'), `${assistantLine({ id: 'msg_newfile', input: 5, out: 5 })}\n`);
      const mainSnap = await makeMainBuilder()(tmp, snap, 'Asia/Shanghai');
      const naiveSnap = naiveReport(snap, 'Asia/Shanghai');
      expect(diffReports(naiveSnap, mainSnap)).toEqual([]);
      expect(naiveSnap.uniqueMessages).toBe(before.uniqueMessages);
      // 新快照：看到新数据，仍零差异
      const r = await runVerify(tmp, 'Asia/Shanghai');
      expect(r.diffs).toEqual([]);
      expect(r.naive.uniqueMessages).toBe(before.uniqueMessages + 2);
    });
  });

  it('命令行：退出码 0 / 1；不改动 fixture 目录（路径、大小、mtime 快照不变）', () => {
    const snapBefore = snapshotDir(FIXTURE_ROOT);
    const out = execFileSync(process.execPath, ['scripts/verify-real.ts', '--root', FIXTURE_ROOT, '--tz', 'Asia/Shanghai'], { cwd: repo, encoding: 'utf8' });
    expect(out).toContain('零差异');
    expect(out).toMatch(/唯一消息数：朴素 59 \/ 主 59/);
    expect(out).toMatch(/跨文件重复.*：朴素 3 \/ 主 3/);
    expect(snapshotDir(FIXTURE_ROOT)).toEqual(snapBefore);
    // 数据根不存在 → 非 0 且给出中文说明
    const bad = spawnSync(process.execPath, ['scripts/verify-real.ts', '--root', path.join(repo, 'no-such-dir')], { cwd: repo, encoding: 'utf8' });
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toContain('数据根目录不存在');
    // 非法时区 → 非 0
    const badTz = spawnSync(process.execPath, ['scripts/verify-real.ts', '--root', FIXTURE_ROOT, '--tz', 'Mars/Base'], { cwd: repo, encoding: 'utf8' });
    expect(badTz.status).not.toBe(0);
  }, 60_000);
});

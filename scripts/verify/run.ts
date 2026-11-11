/**
 * 核对流程：对同一份"快照"分别跑 朴素实现（naive.ts，不依赖 src/）与 主实现（src/server/core），
 * 比较总量 / 唯一消息数 / 按项目 / 按模型 / 按日（本地时区）/ 按会话，输出差异。
 *
 * 主实现这一侧通过 `MainReportBuilder` 注入：测试可以传入"故意篡改"的版本，证明本脚本确实能检出差异。
 */
import { aggregate, groupByModel, groupByProject, groupBySession } from '../../src/server/core/aggregate.ts';
import { parseDataRoot } from '../../src/server/core/loadRoot.ts';
import { buildProjectIndex } from '../../src/server/core/projects.ts';
import type { UsageRecord } from '../../src/shared/types.ts';
import { naiveReport, newGroup, takeSnapshot, zeroFields } from './naive.ts';
import type { Fields, Group, Report, SnapshotFile } from './naive.ts';

export interface MainBuildOptions {
  /** 在聚合前改写记录（测试用：模拟主实现的某个字段出错）。 */
  tamperRecords?: (records: UsageRecord[]) => UsageRecord[];
}

export type MainReportBuilder = (root: string, snapshot: SnapshotFile[], tz: string) => Promise<Report>;

const FIELDS: Array<keyof Fields> = ['input', 'cacheWrite', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead', 'output', 'thinking'];

function pickFields(u: Fields): Fields {
  const f = zeroFields();
  for (const k of FIELDS) f[k] = u[k];
  return f;
}

/** 用主实现（parseDataRoot + aggregate 系列）产出同结构的报告。 */
export function makeMainBuilder(options: MainBuildOptions = {}): MainReportBuilder {
  return async (root, snapshot, tz) => {
    const limits = new Map(snapshot.map((f) => [f.rel, f.size]));
    const parsed = await parseDataRoot(root, { limits });
    const records = options.tamperRecords ? options.tamperRecords(parsed.records) : parsed.records;
    const ctx = { records, projects: buildProjectIndex(records, { groupScratch: false }) };
    const base = {
      projects: 'all' as const,
      range: { kind: 'all' as const },
      granularity: 'day' as const,
      tz,
      weekStart: 'monday' as const,
      basis: 'total' as const,
      split: 'none' as const,
      includeSidechain: true,
      now: 0,
    };
    const agg = aggregate(ctx, base);
    const report: Report = {
      uniqueMessages: parsed.stats.uniqueMessages,
      crossFileDuplicates: parsed.stats.crossFileDuplicates,
      totals: pickFields(agg.summary),
      byProject: {},
      byModel: {},
      byDay: {},
      bySession: {},
    };
    const g = (requests: number, f: Fields): Group => ({ requests, f: pickFields(f) });
    for (const r of groupByProject(ctx, base)) report.byProject[r.id] = g(r.requests, r);
    for (const r of groupByModel(ctx, base)) report.byModel[r.key] = g(r.requests, r);
    for (const r of groupBySession(ctx, base)) report.bySession[r.sessionId] = g(r.requests, r);
    for (const p of agg.timeline) if (p.requests > 0) report.byDay[p.key] = g(p.requests, p);
    return report;
  };
}

function diffGroups(label: string, a: Record<string, Group>, b: Record<string, Group>, out: string[]): void {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of [...keys].sort()) {
    const x = a[k] ?? newGroup();
    const y = b[k] ?? newGroup();
    if (!a[k]) out.push(`${label}[${k}]：朴素实现中不存在，主实现有`);
    else if (!b[k]) out.push(`${label}[${k}]：主实现中不存在，朴素实现有`);
    else {
      if (x.requests !== y.requests) out.push(`${label}[${k}].requests：朴素 ${x.requests} ≠ 主 ${y.requests}`);
      for (const f of FIELDS) if (x.f[f] !== y.f[f]) out.push(`${label}[${k}].${f}：朴素 ${x.f[f]} ≠ 主 ${y.f[f]}`);
    }
  }
}

/** 逐项比较两份报告，返回差异描述（空数组 = 零差异）。 */
export function diffReports(naive: Report, main: Report): string[] {
  const out: string[] = [];
  if (naive.uniqueMessages !== main.uniqueMessages) out.push(`uniqueMessages：朴素 ${naive.uniqueMessages} ≠ 主 ${main.uniqueMessages}`);
  if (naive.crossFileDuplicates !== main.crossFileDuplicates) out.push(`crossFileDuplicates：朴素 ${naive.crossFileDuplicates} ≠ 主 ${main.crossFileDuplicates}`);
  for (const f of FIELDS) if (naive.totals[f] !== main.totals[f]) out.push(`totals.${f}：朴素 ${naive.totals[f]} ≠ 主 ${main.totals[f]}`);
  diffGroups('byProject', naive.byProject, main.byProject, out);
  diffGroups('byModel', naive.byModel, main.byModel, out);
  diffGroups('byDay', naive.byDay, main.byDay, out);
  diffGroups('bySession', naive.bySession, main.bySession, out);
  return out;
}

export interface VerifyResult {
  diffs: string[];
  naive: Report;
  main: Report;
  snapshotFiles: number;
  snapshotBytes: number;
}

export async function runVerify(root: string, tz: string, builder: MainReportBuilder = makeMainBuilder()): Promise<VerifyResult> {
  const snapshot = takeSnapshot(root); // 两套实现共用同一份 (路径, 大小) 快照
  const naive = naiveReport(snapshot, tz);
  const main = await builder(root, snapshot, tz);
  return {
    diffs: diffReports(naive, main),
    naive,
    main,
    snapshotFiles: snapshot.length,
    snapshotBytes: snapshot.reduce((a, f) => a + f.size, 0),
  };
}

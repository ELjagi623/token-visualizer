/**
 * 独立核对用的"最朴素"实现。
 *
 * 严格规则：本文件**不得 import `src/` 下的任何代码**，只用 Node 内置模块。
 * 做法故意写得笨：整文件读入内存 → 按 "\n" 切行 → 逐行 JSON.parse → Map 按 message.id 取各字段最大值。
 * （由 test/verify.test.ts 断言本文件的 import 只来自 node: 内置模块。）
 *
 * 口径（与主实现的"规格"一致，但代码互不共享）：
 *   - 只看 type === "assistant"；model === "<synthetic>" 丢弃；时间戳非法丢弃；
 *   - 键 = message.id，无则 requestId，再无则不去重（每行一条）；
 *   - 各 usage 字段取最大值；ts 取最早；
 *   - 归属文件 = firstTs（文件内第一个带顶层 timestamp 的行）最小者，并列按相对路径字典序；
 *     项目 / 会话 / 模型取自归属文件内的第一次出现；
 *   - 只读到快照大小，且只处理到最后一个换行符（半行忽略）。
 */
import fs from 'node:fs';
import path from 'node:path';

export interface Fields {
  input: number;
  cacheWrite: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
  thinking: number;
}

export interface Group {
  requests: number;
  f: Fields;
}

export interface Report {
  uniqueMessages: number;
  crossFileDuplicates: number;
  totals: Fields;
  byProject: Record<string, Group>;
  byModel: Record<string, Group>;
  /** 本地日期（所给时区）→ 当日汇总（只含有数据的日子） */
  byDay: Record<string, Group>;
  bySession: Record<string, Group>;
}

export interface SnapshotFile {
  rel: string; // 相对根、`/` 分隔
  abs: string;
  size: number;
  project: string;
  defaultSession: string;
}

export function zeroFields(): Fields {
  return { input: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, thinking: 0 };
}

export function newGroup(): Group {
  return { requests: 0, f: zeroFields() };
}

/** 枚举 `<项目>/*.jsonl` 与 `<项目>/<会话>/subagents/*.jsonl`，记录当前大小。 */
export function takeSnapshot(root: string): SnapshotFile[] {
  const out: SnapshotFile[] = [];
  for (const proj of fs.readdirSync(root, { withFileTypes: true })) {
    if (!proj.isDirectory()) continue;
    const pdir = path.join(root, proj.name);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(pdir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isFile() && e.name.toLowerCase().endsWith('.jsonl')) {
        const abs = path.join(pdir, e.name);
        out.push({ rel: `${proj.name}/${e.name}`, abs, size: fs.statSync(abs).size, project: proj.name, defaultSession: e.name.replace(/\.jsonl$/i, '') });
      } else if (e.isDirectory()) {
        const sdir = path.join(pdir, e.name, 'subagents');
        if (!fs.existsSync(sdir)) continue;
        for (const s of fs.readdirSync(sdir, { withFileTypes: true })) {
          if (s.isFile() && s.name.toLowerCase().endsWith('.jsonl')) {
            const abs = path.join(sdir, s.name);
            out.push({ rel: `${proj.name}/${e.name}/subagents/${s.name}`, abs, size: fs.statSync(abs).size, project: proj.name, defaultSession: e.name });
          }
        }
      }
    }
  }
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return out;
}

function n(x: unknown): number {
  return typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : 0;
}

function s(x: unknown): string | undefined {
  return typeof x === 'string' && x.length > 0 ? x : undefined;
}

function obj(x: unknown): Record<string, unknown> | undefined {
  return typeof x === 'object' && x !== null && !Array.isArray(x) ? (x as Record<string, unknown>) : undefined;
}

interface Row {
  file: SnapshotFile;
  firstTs: number | null;
  lineNo: number;
  ts: number;
  model: string;
  session: string | undefined;
  f: Fields;
}

function readPrefix(abs: string, size: number): Buffer {
  const fd = fs.openSync(abs, 'r');
  try {
    const buf = Buffer.alloc(size);
    let got = 0;
    while (got < size) {
      const k = fs.readSync(fd, buf, got, size - got, got);
      if (k === 0) break;
      got += k;
    }
    return buf.subarray(0, got);
  } finally {
    fs.closeSync(fd);
  }
}

const dayFmt = new Map<string, Intl.DateTimeFormat>();
function localDay(ts: number, tz: string): string {
  let f = dayFmt.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    dayFmt.set(tz, f);
  }
  return f.format(new Date(ts));
}

function add(g: Group, f: Fields): void {
  g.requests++;
  g.f.input += f.input;
  g.f.cacheWrite += f.cacheWrite;
  g.f.cacheWrite5m += f.cacheWrite5m;
  g.f.cacheWrite1h += f.cacheWrite1h;
  g.f.cacheRead += f.cacheRead;
  g.f.output += f.output;
  g.f.thinking += f.thinking;
}

/** 朴素实现：返回核对报告。 */
export function naiveReport(snapshot: SnapshotFile[], tz: string): Report {
  // key → 该 key 的所有出现
  const occ = new Map<string, Row[]>();
  const noKey: Row[] = [];

  for (const file of snapshot) {
    const buf = readPrefix(file.abs, file.size);
    const cut = buf.lastIndexOf(0x0a);
    if (cut < 0) continue;
    let text = buf.subarray(0, cut + 1).toString('utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const lines = text.split('\n');
    let firstTs: number | null = null;
    const rows: Array<{ key: string | null; row: Omit<Row, 'firstTs'> }> = [];
    lines.forEach((raw, lineNo) => {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (line.trim() === '') return;
      let o: unknown;
      try {
        o = JSON.parse(line);
      } catch {
        return;
      }
      const rec = obj(o);
      if (!rec) return;
      const ts = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : NaN;
      if (firstTs === null && Number.isFinite(ts)) firstTs = ts;
      if (rec.type !== 'assistant') return;
      const msg = obj(rec.message);
      const model = msg ? s(msg.model) : undefined;
      if (model === '<synthetic>') return;
      if (!Number.isFinite(ts)) return;
      const usage = obj(msg?.usage);
      const cc = obj(usage?.cache_creation);
      const c5 = n(cc?.ephemeral_5m_input_tokens);
      const c1 = n(cc?.ephemeral_1h_input_tokens);
      const ccTotal = usage?.cache_creation_input_tokens;
      const det = obj(usage?.output_tokens_details);
      const f: Fields = {
        input: n(usage?.input_tokens),
        cacheWrite: typeof ccTotal === 'number' && Number.isFinite(ccTotal) ? Math.max(0, ccTotal) : c5 + c1,
        cacheWrite5m: c5,
        cacheWrite1h: c1,
        cacheRead: n(usage?.cache_read_input_tokens),
        output: n(usage?.output_tokens),
        thinking: n(det?.thinking_tokens),
      };
      const id = msg ? s(msg.id) : undefined;
      const req = s(rec.requestId);
      const key = id ? `m:${id}` : req ? `r:${req}` : null;
      rows.push({ key, row: { file, lineNo, ts, model: model ?? 'unknown', session: s(rec.sessionId), f } });
    });
    for (const { key, row } of rows) {
      const full: Row = { ...row, firstTs };
      if (key === null) noKey.push(full);
      else {
        const a = occ.get(key);
        if (a) a.push(full);
        else occ.set(key, [full]);
      }
    }
  }

  const report: Report = { uniqueMessages: 0, crossFileDuplicates: 0, totals: zeroFields(), byProject: {}, byModel: {}, byDay: {}, bySession: {} };
  const bump = (m: Record<string, Group>, k: string, f: Fields): void => add((m[k] ??= newGroup()), f);

  const emit = (rows: Row[]): void => {
    // 归属：firstTs 最小（null 最晚），并列按路径字典序
    const rank = (r: Row): [number, string] => [r.firstTs ?? Infinity, r.file.rel];
    const owner = rows.reduce((best, r) => {
      const [t1, p1] = rank(r);
      const [t0, p0] = rank(best);
      return t1 < t0 || (t1 === t0 && p1 < p0) ? r : best;
    });
    const ownerRows = rows.filter((r) => r.file.rel === owner.file.rel).sort((a, b) => a.lineNo - b.lineNo);
    const first = ownerRows[0]!;
    const f = zeroFields();
    let ts = Infinity;
    for (const r of rows) {
      for (const k of Object.keys(f) as Array<keyof Fields>) if (r.f[k] > f[k]) f[k] = r.f[k];
      if (r.ts < ts) ts = r.ts;
    }
    const session = ownerRows.map((r) => r.session).find((x) => x !== undefined) ?? owner.file.defaultSession;
    report.uniqueMessages++;
    if (new Set(rows.map((r) => r.file.rel)).size > 1) report.crossFileDuplicates++;
    for (const k of Object.keys(f) as Array<keyof Fields>) report.totals[k] += f[k];
    bump(report.byProject, owner.file.project, f);
    bump(report.byModel, first.model, f);
    bump(report.byDay, localDay(ts, tz), f);
    bump(report.bySession, session, f);
  };

  for (const rows of occ.values()) emit(rows);
  for (const r of noKey) emit([r]);
  return report;
}

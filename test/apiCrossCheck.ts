/**
 * 测试者自写的"HTTP 层交叉核对"：只用 fetch 访问 API，期望值全部由朴素记录（naiveView）+ Intl 自行计算，
 * 不 import src/ 下的任何代码。
 */
import type { NaiveMsg } from './naiveView.ts';

const dtfs = new Map<string, Intl.DateTimeFormat>();
interface Lp {
  date: string;
  y: number;
  m: number;
  d: number;
  h: number;
  wd: number;
  hourStart: number;
}
function lp(ts: number, tz: string): Lp {
  let f = dtfs.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' });
    dtfs.set(tz, f);
  }
  const o: Record<string, string> = {};
  for (const p of f.formatToParts(new Date(ts))) o[p.type] = p.value;
  const wd = ({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 } as Record<string, number>)[o.weekday!]!;
  const ms = ((ts % 1000) + 1000) % 1000;
  return { date: `${o.year}-${o.month}-${o.day}`, y: +o.year!, m: +o.month!, d: +o.day!, h: +o.hour! % 24, wd, hourStart: ts - ((+o.minute! * 60 + +o.second!) * 1000 + ms) };
}
const addDays = (s: string, n: number): string => {
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const wkStart = (p: Lp, ws: string): string => addDays(p.date, -(ws === 'monday' ? (p.wd + 6) % 7 : p.wd));
const famOf = (m: string): string => {
  if (/[\\/]/.test(m) || m.toLowerCase().endsWith('.gguf')) return 'local';
  const l = m.toLowerCase();
  if (l.startsWith('claude-')) {
    if (l.includes('opus')) return 'opus';
    if (l.includes('sonnet')) return 'sonnet';
    if (l.includes('haiku')) return 'haiku';
  }
  return 'other';
};

type R = NaiveMsg & { total: number; fresh: number };
const sumOf = (rs: R[], f: keyof NaiveMsg | 'total' | 'fresh'): number => rs.reduce((a, r) => a + (r[f as keyof R] as number), 0);

export interface CrossResult {
  checks: number;
  fails: string[];
}

export async function crossCheck(base: string, msgs: NaiveMsg[], o: { now: number; tzs: string[]; granularities?: string[]; projectsToo?: boolean }): Promise<CrossResult> {
  const recs: R[] = msgs.map((m) => ({ ...m, total: m.input + m.cacheWrite + m.cacheRead + m.output, fresh: m.input + m.cacheWrite + m.output }));
  const res: CrossResult = { checks: 0, fails: [] };
  const eq = (a: unknown, b: unknown, msg: string): void => {
    res.checks++;
    const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort((p, q) => (p[0] < q[0] ? -1 : 1))) : x));
    const ja = canon(a);
    const jb = canon(b);
    if (ja !== jb && res.fails.length < 30) res.fails.push(`${msg}: api=${ja?.slice(0, 160)} expect=${jb?.slice(0, 160)}`);
    else if (ja !== jb) res.checks += 0;
  };
  const get = async (p: string): Promise<any> => {
    const r = await fetch(base + p);
    const j = await r.json();
    if (r.status !== 200) throw new Error(`${p} -> ${r.status} ${JSON.stringify(j)}`);
    return j;
  };
  const Q = (p: Record<string, string | undefined>): string =>
    '?' +
    Object.entries(p)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${encodeURIComponent(v!)}`)
      .join('&');

  const totAll = sumOf(recs, 'total');
  const granularities = o.granularities ?? ['hour', 'day', 'week', 'month'];

  for (const tz of o.tzs) {
    const ps = recs.map((r) => [r, lp(r.ts, tz)] as const);
    // ---- summary ----
    const s = await get('/api/summary' + Q({ tz, range: 'all' }));
    eq(s.summary.total, totAll, `${tz} summary.total`);
    eq(s.summary.fresh, sumOf(recs, 'fresh'), `${tz} summary.fresh`);
    eq(s.summary.requests, recs.length, `${tz} requests`);
    eq(s.summary.sessions, new Set(recs.map((r) => r.session)).size, `${tz} sessions`);
    eq(s.summary.activeDays, new Set(ps.map(([, p]) => p.date)).size, `${tz} activeDays`);
    const inSide = sumOf(recs, 'input') + sumOf(recs, 'cacheWrite') + sumOf(recs, 'cacheRead');
    eq(Math.abs(s.summary.cacheHitRate - sumOf(recs, 'cacheRead') / inSide) < 1e-12, true, `${tz} cacheHitRate`);
    eq(Math.abs(s.summary.outputInputRatio - sumOf(recs, 'output') / inSide) < 1e-12, true, `${tz} outputInputRatio`);
    // ---- periods (固定 now) ----
    for (const ws of ['monday', 'sunday']) {
      const sp = await get('/api/summary' + Q({ tz, weekStart: ws }));
      const np = lp(o.now, tz);
      const wk = wkStart(np, ws);
      const day = (d: string): number => ps.filter(([, p]) => p.date === d).reduce((a, [r]) => a + r.total, 0);
      const week = (w: string): number => ps.filter(([, p]) => wkStart(p, ws) === w).reduce((a, [r]) => a + r.total, 0);
      const month = (m: string): number => ps.filter(([, p]) => p.date.slice(0, 7) === m).reduce((a, [r]) => a + r.total, 0);
      const pm = np.m === 1 ? `${np.y - 1}-12` : `${np.y}-${String(np.m - 1).padStart(2, '0')}`;
      const per = sp.periods;
      eq(per.today.summary.total, day(np.date), `${tz}/${ws} today`);
      eq(per.yesterday.summary.total, day(addDays(np.date, -1)), `${tz}/${ws} yesterday`);
      eq(per.thisWeek.summary.total, week(wk), `${tz}/${ws} thisWeek`);
      eq(per.prevWeek.summary.total, week(addDays(wk, -7)), `${tz}/${ws} prevWeek`);
      eq(per.thisMonth.summary.total, month(`${np.y}-${String(np.m).padStart(2, '0')}`), `${tz}/${ws} thisMonth`);
      eq(per.prevMonth.summary.total, month(pm), `${tz}/${ws} prevMonth`);
      const y = day(addDays(np.date, -1));
      const t = day(np.date);
      eq(per.deltas.today.pct, y > 0 ? (t - y) / y : null, `${tz}/${ws} delta.today`);
    }
    // ---- timeseries ----
    for (const g of granularities) {
      for (const ws of g === 'week' ? ['monday', 'sunday'] : ['monday']) {
        const ts = await get('/api/timeseries' + Q({ tz, range: 'all', granularity: g, weekStart: ws }));
        const tag = `${tz}/${g}/${ws}`;
        eq(ts.points.reduce((a: number, p: any) => a + p.total, 0), totAll, `${tag} Σpoints`);
        eq(ts.summary.total, totAll, `${tag} summary.total`);
        const exp = new Map<string | number, { total: number; fresh: number; n: number }>();
        const keyOf = (p: Lp): string | number => (g === 'hour' ? p.hourStart : g === 'day' ? p.date : g === 'week' ? wkStart(p, ws) : p.date.slice(0, 7));
        for (const [r, p] of ps) {
          const k = keyOf(p);
          const e = exp.get(k) ?? { total: 0, fresh: 0, n: 0 };
          e.total += r.total;
          e.fresh += r.fresh;
          e.n++;
          exp.set(k, e);
        }
        const keys = [...exp.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        const first = keys[0]!;
        const last = keys[keys.length - 1]!;
        const all: Array<string | number> = [];
        if (g === 'hour') for (let t = first as number; t <= (last as number); t += 3600000) all.push(t);
        else if (g === 'day') for (let d = first as string; d <= (last as string); d = addDays(d, 1)) all.push(d);
        else if (g === 'week') for (let d = first as string; d <= (last as string); d = addDays(d, 7)) all.push(d);
        else {
          let [y, m] = (first as string).split('-').map(Number) as [number, number];
          while (`${y}-${String(m).padStart(2, '0')}` <= (last as string)) {
            all.push(`${y}-${String(m).padStart(2, '0')}`);
            if (m === 12) {
              y++;
              m = 1;
            } else m++;
          }
        }
        eq(ts.points.length, all.length, `${tag} bucket count (含空桶)`);
        const byKey = new Map<string | number, any>(ts.points.map((p: any) => [g === 'hour' ? p.start : p.key, p]));
        let bad = 0;
        for (const k of all) {
          const e = exp.get(k) ?? { total: 0, fresh: 0, n: 0 };
          const d = byKey.get(k);
          if (!d || d.total !== e.total || d.fresh !== e.fresh || d.requests !== e.n) {
            bad++;
            if (bad <= 2) eq(d ? [d.total, d.fresh, d.requests] : 'missing', [e.total, e.fresh, e.n], `${tag} bucket ${String(k)}`);
          }
        }
        eq(bad, 0, `${tag} bad buckets`);
        if (g !== 'hour') eq(ts.points.map((p: any) => p.key), all, `${tag} keys`);
      }
      // Total - Fresh
      const a = await get('/api/timeseries' + Q({ tz, granularity: g, basis: 'total' }));
      const b = await get('/api/timeseries' + Q({ tz, granularity: g, basis: 'fresh' }));
      eq(a.points.reduce((x: number, p: any) => x + p.value, 0) - b.points.reduce((x: number, p: any) => x + p.value, 0), sumOf(recs, 'cacheRead'), `${tz}/${g} Total-Fresh`);
      eq(b.points.reduce((x: number, p: any) => x + p.value, 0), sumOf(recs, 'fresh'), `${tz}/${g} fresh sum`);
    }
  }

  // ---- 拆分 ----
  const tz0 = o.tzs[0]!;
  for (const split of ['tokenType', 'model', 'project']) {
    for (const basis of ['total', 'fresh']) {
      const t = await get('/api/timeseries' + Q({ tz: tz0, split, basis, granularity: 'week' }));
      eq(t.series.reduce((a: number, s: any) => a + s.total, 0), sumOf(recs, basis === 'total' ? 'total' : 'fresh'), `split=${split}/${basis} Σseries`);
      for (let i = 0; i < t.points.length; i++) {
        const sv = t.series.reduce((a: number, s: any) => a + s.values[i], 0);
        if (sv !== t.points[i].value) {
          eq(sv, t.points[i].value, `split=${split}/${basis} bucket ${i}`);
          break;
        }
      }
      if (split === 'tokenType' && basis === 'fresh') eq(t.series.some((s: any) => /read/i.test(s.key)), false, 'fresh 下无 cacheRead 系列');
    }
  }
  {
    const t = await get('/api/timeseries' + Q({ tz: tz0, split: 'model' }));
    const byRaw = new Map<string, number>();
    for (const r of recs) byRaw.set(r.model, (byRaw.get(r.model) ?? 0) + r.total);
    eq(Object.fromEntries(t.series.map((s: any) => [s.key, s.total])), Object.fromEntries(byRaw), 'split=model 各模型总量（原始名）');
    eq(t.series.some((s: any) => String(s.key).includes('synthetic') || String(s.label).includes('synthetic')), false, 'split=model 无 <synthetic>');
    const shareSum = t.series.reduce((a: number, s: any) => a + s.total / totAll, 0);
    eq(Math.abs(shareSum - 1) < 1e-9, true, '模型占比之和 = 100%');
    for (const s of t.series) {
      const fam = famOf(s.key);
      eq([s.family, !!s.isLocal], [fam, fam === 'local'], `模型 ${s.key} family/isLocal`);
      if (/\.gguf$/i.test(s.key)) eq(/[\\/]|\.gguf/i.test(s.label), false, `gguf 显示名为纯文件名：${s.label}`);
    }
    const m = await get('/api/timeseries' + Q({ tz: tz0, split: 'model', mergeFamilies: 'true' }));
    const byFam = new Map<string, number>();
    for (const r of recs) byFam.set(famOf(r.model), (byFam.get(famOf(r.model)) ?? 0) + r.total);
    eq(Object.fromEntries(m.series.map((s: any) => [s.key, s.total])), Object.fromEntries(byFam), '家族合并各组总量');
    eq(m.series.reduce((a: number, s: any) => a + s.total, 0), totAll, '家族合并后总量不变');
    const flt = await get('/api/summary' + Q({ tz: tz0, models: [...byRaw.keys()][0]! }));
    eq(flt.summary.total, byRaw.get([...byRaw.keys()][0]!), 'models 过滤');
    const fam2 = await get('/api/summary' + Q({ tz: tz0, models: 'local', mergeFamilies: 'true' }));
    eq(fam2.summary.total, byFam.get('local') ?? 0, 'models=local 家族过滤');
  }
  // ---- 子代理 / 范围 / 项目过滤 ----
  {
    const ns = await get('/api/summary' + Q({ tz: tz0, includeSidechain: 'false' }));
    eq(ns.summary.total, sumOf(recs.filter((r) => !r.sidechain), 'total'), 'includeSidechain=false');
    const ps = recs.map((r) => [r, lp(r.ts, tz0)] as const);
    const np = lp(o.now, tz0);
    for (const [kind, n] of [['today', 1], ['7d', 7], ['30d', 30], ['90d', 90]] as const) {
      const from = addDays(np.date, -(n - 1));
      const want = ps.filter(([, p]) => p.date >= from && p.date <= np.date).reduce((a, [r]) => a + r.total, 0);
      const r = await get('/api/timeseries' + Q({ tz: tz0, range: kind, granularity: 'day' }));
      eq(r.summary.total, want, `range=${kind}`);
      eq(r.points.length, n, `range=${kind} 桶数`);
      eq(r.points.reduce((a: number, p: any) => a + p.total, 0), want, `range=${kind} Σpoints`);
    }
    const c = await get('/api/timeseries' + Q({ tz: tz0, range: 'custom', from: '2026-10-05', to: '2026-10-09', granularity: 'day' }));
    eq(c.points.map((p: any) => p.key), ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'], 'custom 范围 x 轴');
    eq(c.summary.total, ps.filter(([, p]) => p.date >= '2026-10-05' && p.date <= '2026-10-09').reduce((a, [r]) => a + r.total, 0), 'custom 总量');
    const impl = await get('/api/summary' + Q({ tz: tz0, from: '2026-10-05', to: '2026-10-09' }));
    eq(impl.summary.total, c.summary.total, '仅给 from/to 隐含 custom');
  }

  // ---- 项目列表 ----
  if (o.projectsToo !== false) {
    const folders = new Map<string, R[]>();
    for (const r of recs) folders.set(r.folder, [...(folders.get(r.folder) ?? []), r]);
    const cwdMain = (rs: R[]): string | undefined => {
      const m = new Map<string, { n: number; last: number }>();
      for (const r of rs) if (r.cwd) {
        const c = m.get(r.cwd) ?? { n: 0, last: 0 };
        c.n++;
        c.last = Math.max(c.last, r.ts);
        m.set(r.cwd, c);
      }
      return [...m].sort((a, b) => b[1].n - a[1].n || b[1].last - a[1].last)[0]?.[0];
    };
    const isScratch = (f: string, rs: R[]): boolean => /scratch-workspaces-.*-scratch-/.test(f) || /scratch-workspaces[\\/].*[\\/]scratch-[^\\/]*[\\/]*$/.test(cwdMain(rs) ?? '');
    const scratchF = [...folders].filter(([f, rs]) => isScratch(f, rs)).map(([f]) => f);
    for (const basis of ['total', 'fresh']) {
      const pj = await get('/api/projects' + Q({ tz: tz0, basis }));
      const val = (rs: R[]): number => sumOf(rs, basis === 'total' ? 'total' : 'fresh');
      eq(pj.all.value, val(recs), `projects all.value (${basis})`);
      eq(pj.all.requests, recs.length, 'projects all.requests');
      const nonScratch = [...folders.keys()].filter((f) => !scratchF.includes(f));
      const top = pj.projects as any[];
      // 顶层条目：非 scratch 文件夹(有记录) + (scratch 组)；空文件夹由 folderKeys 补入，故 >=
      eq(top.filter((p) => !p.isScratchGroup && !p.isScratch).length >= nonScratch.length, true, '顶层非 scratch 项目数 >= 有记录文件夹数');
      eq(top.reduce((a, p) => a + p.value, 0), val(recs), `Σ顶层项目 value = all (${basis})`);
      for (const [f, rs] of folders) {
        if (scratchF.includes(f)) continue;
        const item = top.find((p) => p.id === f);
        if (!item) {
          eq('missing', f, `项目 ${f.slice(0, 30)}`);
          continue;
        }
        const main = cwdMain(rs);
        eq([item.value, item.requests, item.path ?? null, item.displayName], [val(rs), rs.length, main ?? null, main ? main.split(/[\\/]+/).filter(Boolean).pop() : f], `项目 ${f.slice(0, 30)}`);
        // sparkline
        const np = lp(o.now, tz0);
        const spark = new Array(30).fill(0);
        for (const r of rs) {
          const d = lp(r.ts, tz0).date;
          const back = Math.round((Date.parse(np.date) - Date.parse(d)) / 86400000);
          if (back >= 0 && back < 30) spark[29 - back] += val([r]);
        }
        eq(item.sparkline, spark, `项目 ${f.slice(0, 30)} sparkline`);
        eq(item.lastActiveTs, Math.max(...rs.map((r) => r.ts)), `项目 ${f.slice(0, 30)} lastActiveTs`);
        eq(item.activeToday, rs.some((r) => lp(r.ts, tz0).date === np.date), `项目 ${f.slice(0, 30)} activeToday`);
      }
      if (scratchF.length) {
        const g = top.find((p) => p.isScratchGroup);
        eq(!!g, true, 'scratch 组存在');
        if (g) {
          eq(g.children.length, scratchF.length, 'scratch children 数');
          eq(g.value, val(scratchF.flatMap((f) => folders.get(f)!)), 'scratch 组 value');
          eq(g.children.reduce((a: number, c: any) => a + c.value, 0), g.value, 'scratch children 之和');
        }
      }
    }
    // 排序：total 降序、name、recent、today 都返回相同的集合
    for (const sort of ['total', 'recent', 'name', 'today']) {
      const pj = await get('/api/projects' + Q({ tz: tz0, sort }));
      const top = pj.projects as any[];
      if (sort === 'total') eq(top.every((p, i) => i === 0 || top[i - 1].value >= p.value), true, 'sort=total 降序');
      if (sort === 'recent') eq(top.every((p, i) => i === 0 || (top[i - 1].lastActiveTs ?? -1) >= (p.lastActiveTs ?? -1)), true, 'sort=recent 降序');
      if (sort === 'today') eq(top.every((p, i) => i === 0 || top[i - 1].todayValue >= p.todayValue), true, 'sort=today 降序');
      eq(pj.projects.length, (await get('/api/projects' + Q({ tz: tz0 }))).projects.length, `sort=${sort} 条目数不变`);
    }
  }
  return res;
}

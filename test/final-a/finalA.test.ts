/**
 * 统一测试 A（数据 / 接口 / 成本）的补缺口测试。
 * 全部期望值由本文件自己的"原始 JSONL 朴素解析 + 手算"得出，不调用被测的成本 / 聚合代码。
 * 数据：fixture 副本 + 一个追加文件（含 1 条 speed=fast 的 claude-opus-5 记录与 1 条未计价模型 claude-mystery-9 记录）。
 * 价格：固定表 输入 1 / 输出 5 / 5m 写 2 / 1h 写 3 / 读 0.1（USD/M）；固定 TV_NOW = 2026-10-20T12:00:00Z，时区 Asia/Shanghai。
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, getJson, putJson } from '../apiHelpers.ts';
import type { TestApp } from '../apiHelpers.ts';
import { FIXTURE_ROOT, makeTmpDir, rmDir } from '../helpers.ts';
import { naiveView } from '../naiveView.ts';

const NOW = Date.parse('2026-10-20T12:00:00.000Z');
const TZ = 'Asia/Shanghai';
// 未计价案例：claude- 前缀且价格不完整（非 claude- 前缀的名字现在一律视为本地 / 非 Anthropic 模型，不再算未计价）
const UNPRICED = { pattern: 'claude-mystery-9', match: 'exact', inputUsdPerM: null, outputUsdPerM: 5, cacheWrite5mUsdPerM: 2, cacheWrite1hUsdPerM: 3, cacheReadUsdPerM: 0.1 };
const FLAT = { inputUsdPerM: 1, outputUsdPerM: 5, cacheWrite5mUsdPerM: 2, cacheWrite1hUsdPerM: 3, cacheReadUsdPerM: 0.1 };
const LOCAL_MODELS = new Set(['C:\\Users\\x\\Models\\Qwen3-35B-A3B-Q4_K_M.gguf', 'qwen/qwen3-coder-next']);

interface Rec {
  key: string;
  model: string;
  speed: string;
  input: number;
  output: number;
  read: number;
  cc: number;
  cc5: number;
  cc1h: number;
  ts: number;
  folder: string;
}

function listJsonl(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) out.push(p);
    }
  };
  walk(root);
  return out.sort();
}

/** 独立朴素解析：按 message.id（无则 requestId）去重，各字段取最大值，时间取最小。 */
function rawRecords(root: string): Rec[] {
  const m = new Map<string, Rec>();
  let anon = 0;
  for (const f of listJsonl(root)) {
    const folder = path.relative(root, f).split(path.sep)[0]!;
    const buf = fs.readFileSync(f);
    const nl = buf.lastIndexOf(10);
    if (nl < 0) continue;
    for (const line of buf.subarray(0, nl + 1).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      let o: any;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (o?.type !== 'assistant' || o.message?.model === '<synthetic>') continue;
      const ts = Date.parse(o.timestamp);
      if (Number.isNaN(ts)) continue;
      const u = o.message.usage ?? {};
      const cc = u.cache_creation ?? {};
      const n = (x: unknown): number => (typeof x === 'number' && x > 0 ? x : 0);
      const cc5 = n(cc.ephemeral_5m_input_tokens);
      const cc1h = n(cc.ephemeral_1h_input_tokens);
      const ccTotal = typeof u.cache_creation_input_tokens === 'number' ? n(u.cache_creation_input_tokens) : cc5 + cc1h;
      const key = o.message.id ? `m:${o.message.id}` : o.requestId ? `r:${o.requestId}` : `a:${anon++}`;
      const cur = m.get(key);
      const r: Rec = { key, model: o.message.model, speed: u.speed ?? 'standard', input: n(u.input_tokens), output: n(u.output_tokens), read: n(u.cache_read_input_tokens), cc: ccTotal, cc5, cc1h, ts, folder };
      if (!cur) m.set(key, r);
      else {
        cur.input = Math.max(cur.input, r.input);
        cur.output = Math.max(cur.output, r.output);
        cur.read = Math.max(cur.read, r.read);
        cur.cc = Math.max(cur.cc, r.cc);
        cur.cc5 = Math.max(cur.cc5, r.cc5);
        cur.cc1h = Math.max(cur.cc1h, r.cc1h);
        cur.ts = Math.min(cur.ts, r.ts);
      }
    }
  }
  return [...m.values()];
}

const total = (r: Rec): number => r.input + r.output + r.read + r.cc;

/** 手算单条等价 API 成本；null = 未计价；本地 = 0。 */
function cost(r: Rec, fastMult: number | null): number | null {
  if (LOCAL_MODELS.has(r.model)) return 0;
  if (r.model === 'claude-mystery-9') return null;
  const unknown = Math.max(0, r.cc - r.cc5 - r.cc1h);
  let c = (r.input * 1 + r.output * 5 + (r.cc5 + unknown) * 2 + r.cc1h * 3 + r.read * 0.1) / 1e6;
  if (r.speed === 'fast' && fastMult !== null) c *= fastMult;
  return c;
}

const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const localDay = (ts: number): string => dayFmt.format(new Date(ts));
const dim = (day: string): number => new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7), 0)).getUTCDate();
function* eachDay(from: string, to: string): Generator<string> {
  let t = Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10));
  const end = Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10));
  for (; t <= end; t += 86400000) yield new Date(t).toISOString().slice(0, 10);
}
const close = (a: number | null | undefined, b: number, eps = 2e-6, msg = ''): void => {
  expect(a, msg).not.toBeNull();
  expect(Math.abs((a as number) - b), `${msg} actual=${a} expected=${b}`).toBeLessThan(eps);
};

const EXTRA_FAST = {
  type: 'assistant', isSidechain: false, uuid: '00000000-0000-4000-8000-0000000fa001', timestamp: '2026-10-15T04:00:00.000Z', cwd: 'D:\\Work\\alpha', sessionId: 'fafafafa-0000-4000-8000-000000000001', userType: 'external',
  message: { model: 'claude-opus-5', id: 'msg_final_a_fast', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1000, output_tokens: 400, cache_read_input_tokens: 5000, cache_creation_input_tokens: 3000, cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 2000 }, speed: 'fast' } },
  requestId: 'req_final_a_fast',
};
const EXTRA_UNPRICED = {
  ...EXTRA_FAST, uuid: '00000000-0000-4000-8000-0000000fa002', timestamp: '2026-10-15T04:05:00.000Z',
  message: { model: 'claude-mystery-9', id: 'msg_final_a_grok', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 2000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, speed: 'standard' } },
  requestId: 'req_final_a_grok',
};

let root: string;
let t: TestApp;
let recs: Rec[];

beforeAll(async () => {
  const tmp = makeTmpDir('tv-finalA-');
  root = path.join(tmp, 'projects');
  fs.cpSync(FIXTURE_ROOT, root, { recursive: true });
  fs.writeFileSync(path.join(root, 'D--Work-alpha', 'zz-final-a.jsonl'), `${JSON.stringify(EXTRA_FAST)}\n${JSON.stringify(EXTRA_UNPRICED)}\n`);
  recs = rawRecords(root);
  t = await startApp({ dataRoot: root });
  const r = await putJson(t.base, '/api/prices', {
    rules: [
      { pattern: 'claude-*', match: 'glob', ...FLAT }, UNPRICED,
      { pattern: 'claude-opus-5', match: 'exact', ...FLAT, fastMultiplier: 2 },
    ],
  });
  expect(r.status).toBe(200);
});
afterAll(async () => {
  await t.close();
  rmDir(path.dirname(root));
});

describe('3/5 接口对账与去重（fixture 副本）', () => {
  it('summary 总量 / 请求数 = 原始朴素解析；Total - Fresh = 缓存读；拆分之和 = 总量', async () => {
    const s = (await getJson(t.base, '/api/summary?range=all')).body.summary;
    const tot = recs.reduce((a, r) => a + total(r), 0);
    const read = recs.reduce((a, r) => a + r.read, 0);
    expect(s.total).toBe(tot);
    expect(s.requests).toBe(recs.length);
    expect(s.total - s.fresh).toBe(read);
    expect(s.input + s.cacheWrite + s.cacheRead + s.output).toBe(s.total);
    const f = (await getJson(t.base, '/api/summary?range=all&basis=fresh')).body.summary;
    expect(f.value).toBe(tot - read);
    for (const g of ['hour', 'day', 'week', 'month']) {
      for (const split of ['none', 'tokenType', 'model', 'project']) {
        const b = (await getJson(t.base, `/api/timeseries?range=all&granularity=${g}&split=${split}&tz=${TZ}`)).body;
        const sum = b.points.reduce((a: number, p: any) => a + p.value, 0);
        expect(sum, `${g}/${split}`).toBe(tot);
        if (split !== 'none') {
          const ss = b.series.reduce((a: number, x: any) => a + x.values.reduce((p: number, q: number) => p + q, 0), 0);
          expect(ss, `${g}/${split} series`).toBe(tot);
        }
      }
    }
    // 项目分组之和 = 合计；每个项目文件夹总量与原始解析一致
    const pr = (await getJson(t.base, '/api/projects')).body;
    expect(pr.projects.reduce((a: number, p: any) => a + p.total, 0)).toBe(pr.all.total);
    expect(pr.all.total).toBe(tot);
    const alpha = recs.filter((r) => r.folder === 'D--Work-alpha').reduce((a, r) => a + total(r), 0);
    expect(pr.projects.find((p: any) => p.id === 'D--Work-alpha').total).toBe(alpha);
    // 模型分析
    const ms = (await getJson(t.base, '/api/analysis/models?range=all')).body;
    const rows = ms.models ?? ms.rows ?? ms.items;
    expect(Array.isArray(rows)).toBe(true);
    const names = rows.map((x: any) => x.key ?? x.model ?? x.id);
    expect(names.join('|')).not.toContain('<synthetic>');
    const local = rows.filter((x: any) => x.isLocal ?? x.local);
    expect(local.length).toBe(2);
    const tokens = rows.reduce((a: number, x: any) => a + (x.total ?? x.tokens ?? x.value), 0);
    expect(tokens).toBe(tot);
  });

  it('去重 / synthetic / 损坏行：质量面板与原始计数一致', async () => {
    const nv = naiveView(root);
    const q = (await getJson(t.base, '/api/analysis/quality?range=all')).body;
    expect(q.uniqueMessages).toBe(nv.unique);
    expect(q.duplicatesDropped).toBe(nv.dupDropped);
    expect(q.crossFileDuplicates).toBe(nv.crossFile);
    expect(q.syntheticExcluded).toBe(nv.synthetic);
    expect(q.corruptLines).toBe(nv.corrupt);
    expect(q.emptyFiles).toBe(nv.empty);
    expect(nv.crossFile).toBeGreaterThan(0);
    expect(nv.synthetic).toBeGreaterThan(0);
    expect(nv.corrupt).toBeGreaterThan(0);
  });
});

describe('6 成本·等价 API（固定价格表手算）', () => {
  it('总额 / 某模型 / 某项目 / fast 乘数 / 本地 0 / 未计价', async () => {
    // 手算 fast 记录本身：(1000*1 + 400*5 + 1000*2 + 2000*3 + 5000*0.1)/1e6 = 0.0115，fast ×2 = 0.023
    const fastRec = recs.find((r) => r.key === 'm:msg_final_a_fast')!;
    close(cost(fastRec, 2), 0.023, 1e-12, 'fast 手算常量');
    const expTotal = recs.reduce((a, r) => a + (cost(r, 2) ?? 0), 0);
    const c = (await getJson(t.base, '/api/cost/summary?range=all')).body;
    close(c.api.totalUsd, expTotal, 2e-6, '总额');
    expect(c.api.fastPremiumApplied).toBe(true);
    // 未计价
    expect(c.api.unpricedModels).toEqual(['claude-mystery-9']);
    expect(c.api.unpricedTokens).toBe(2100);
    // 某模型：opus-5（含 fast 记录）
    const opus5 = recs.filter((r) => r.model === 'claude-opus-5').reduce((a, r) => a + (cost(r, 2) ?? 0), 0);
    close(c.byModel.find((m: any) => m.id === 'claude-opus-5').cost.apiUsd, opus5, 2e-6, 'opus-5');
    // 某项目：alpha（含两条追加记录）
    const alpha = recs.filter((r) => r.folder === 'D--Work-alpha').reduce((a, r) => a + (cost(r, 2) ?? 0), 0);
    close(c.byProject.find((p: any) => p.id === 'D--Work-alpha').cost.apiUsd, alpha, 2e-6, 'alpha');
    const grok = c.byModel.find((m: any) => m.id === 'claude-mystery-9');
    expect(grok.cost.apiUsd).toBeNull(); // 未计价绝不当 0
    expect(grok.cost.unpricedModels).toContain('claude-mystery-9');
    // 本地模型 = 0 且不计未计价
    for (const m of c.byModel.filter((x: any) => x.local)) {
      expect(m.cost.unpricedTokens).toBe(0);
      expect(m.cost.apiUsd === null || m.cost.apiUsd === 0).toBe(true);
    }
    // 分组之和 = 总额
    close(c.byModel.reduce((a: number, m: any) => a + (m.cost.apiUsd ?? 0), 0), expTotal, 2e-6, 'Σ模型');
    close(c.byProject.reduce((a: number, m: any) => a + (m.cost.apiUsd ?? 0), 0), expTotal, 2e-6, 'Σ项目');
    const bt = c.api.byType;
    close(bt.input + bt.output + bt.cacheWrite + bt.cacheRead, c.api.totalUsd, 2e-6, 'byType 之和');
    close(bt.input, recs.reduce((a, r) => a + (cost(r, 2) === 0 || cost(r, 2) === null ? 0 : (r.input * (r.speed === 'fast' ? 2 : 1)) / 1e6), 0), 2e-6, 'byType.input');
  });

  it('fast 未配置乘数：不计溢价且计数', async () => {
    const r = await putJson(t.base, '/api/prices', { rules: [{ pattern: 'claude-*', match: 'glob', ...FLAT }, UNPRICED] });
    expect(r.status).toBe(200);
    const expTotal = recs.reduce((a, x) => a + (cost(x, null) ?? 0), 0);
    const c = (await getJson(t.base, '/api/cost/summary?range=all')).body;
    close(c.api.totalUsd, expTotal, 2e-6, '无 fast 溢价总额');
    expect(c.api.fastPremiumApplied).toBe(false);
    expect(c.api.fastUnconfiguredRecords).toBe(1);
    // 恢复
    await putJson(t.base, '/api/prices', { rules: [{ pattern: 'claude-*', match: 'glob', ...FLAT }, UNPRICED, { pattern: 'claude-opus-5', match: 'exact', ...FLAT, fastMultiplier: 2 }] });
  });
});

describe('7 成本·订阅摊销与回本（Max 5x / $100）', () => {
  const FEE = 100;
  it('未设置订阅方案 → null / configured=false', async () => {
    const c = (await getJson(t.base, '/api/cost/summary?range=all')).body;
    expect(c.subscription.configured).toBe(false);
    expect(c.subscription.totalUsd).toBeNull();
    expect(c.subscription.idleUsd).toBeNull();
    const p = (await getJson(t.base, '/api/subscription/payback')).body;
    expect(p.configured).toBe(false);
    expect(p.multipleMtd).toBeNull();
    expect(p.savingsUsd).toBeNull();
    expect(p.projected.multiple).toBeNull();
    const sm = (await getJson(t.base, '/api/summary?range=all')).body.summary;
    expect(sm.cost.subUsd).toBeNull();
  });

  it('摊销守恒与手算', async () => {
    const r = await putJson(t.base, '/api/settings', { subscription: { plan: 'max5x', monthlyFeeUsd: FEE } });
    expect(r.status).toBe(200);
    const today = localDay(NOW);
    const costOf = (x: Rec): number => cost(x, 2) ?? 0;
    // 日 × 项目 / 模型 成本
    const dayTotal = new Map<string, number>();
    const dayProj = new Map<string, Map<string, number>>();
    const dayModel = new Map<string, Map<string, number>>();
    for (const x of recs) {
      const d = localDay(x.ts);
      const c = costOf(x);
      dayTotal.set(d, (dayTotal.get(d) ?? 0) + c);
      const bump = (mm: Map<string, Map<string, number>>, k: string): void => {
        if (!mm.has(d)) mm.set(d, new Map());
        mm.get(d)!.set(k, (mm.get(d)!.get(k) ?? 0) + c);
      };
      bump(dayProj, x.folder);
      bump(dayModel, x.model);
    }
    const days = recs.map((x) => localDay(x.ts)).sort();
    const first = days[0]!;
    let feeSum = 0;
    let subTotal = 0;
    let idle = 0;
    const projSub = new Map<string, number>();
    const modelSub = new Map<string, number>();
    for (const d of eachDay(first, today)) {
      const fee = FEE / dim(d);
      feeSum += fee;
      const C = dayTotal.get(d) ?? 0;
      if (C > 0) {
        subTotal += fee;
        for (const [k, v] of dayProj.get(d)!) projSub.set(k, (projSub.get(k) ?? 0) + (fee * v) / C);
        for (const [k, v] of dayModel.get(d)!) modelSub.set(k, (modelSub.get(k) ?? 0) + (fee * v) / C);
      } else idle += fee;
    }
    const c = (await getJson(t.base, '/api/cost/summary?range=all')).body;
    expect(c.subscription.configured).toBe(true);
    close(c.subscription.feeSumUsd, feeSum, 1e-4, '范围日订阅费之和');
    close(c.subscription.totalUsd, subTotal, 1e-4, 'subUsd');
    close(c.subscription.idleUsd, idle, 1e-4, 'idleUsd');
    close(c.subscription.totalUsd + c.subscription.idleUsd, feeSum, 1e-4, 'sub+idle=Σ日费');
    const apiTot = recs.reduce((a, x) => a + costOf(x), 0);
    close(c.subscription.multiple, apiTot / (subTotal + idle), 1e-3, '回本倍数(范围)');
    // 各条目 sub 之和 = 总 sub；alpha / opus-5 手算
    close(c.byProject.reduce((a: number, p: any) => a + (p.cost.subUsd ?? 0), 0), subTotal, 1e-4, 'Σ项目 sub');
    close(c.byModel.reduce((a: number, p: any) => a + (p.cost.subUsd ?? 0), 0), subTotal, 1e-4, 'Σ模型 sub');
    close(c.byProject.find((p: any) => p.id === 'D--Work-alpha').cost.subUsd, projSub.get('D--Work-alpha')!, 1e-4, 'alpha sub');
    close(c.byModel.find((p: any) => p.id === 'claude-opus-5').cost.subUsd, modelSub.get('claude-opus-5')!, 1e-4, 'opus-5 sub');
    // 每个有用量日：当天日订阅费 = 日 daily 数组 feeUsd，且导出日行 cost_sub_usd = 日费
    const exp = await fetch(`${t.base}/api/export?kind=daily&format=csv&range=all`);
    const lines = (await exp.text()).split('\r\n').filter((l) => l && !l.startsWith('# '));
    const head = lines[0]!.split(',');
    const iD = head.indexOf('date');
    const iS = head.indexOf('cost_sub_usd');
    let sumRows = 0;
    for (const l of lines.slice(1)) {
      const f = l.split(',');
      const d = f[iD]!;
      const C = dayTotal.get(d) ?? 0;
      const sub = f[iS] === '' ? 0 : Number(f[iS]);
      sumRows += sub;
      if (d <= today) close(sub, C > 0 ? FEE / dim(d) : 0, 2e-6, `日行 ${d}`);
      else expect(sub, `晚于今天的日 ${d}`).toBe(0);
    }
    close(sumRows, subTotal, 1e-4, '导出日行 Σ sub');
    for (const day of c.daily) {
      if (day.date <= today) close(day.feeUsd, FEE / dim(day.date), 2e-6, `daily ${day.date}`);
    }
  });

  it('回本卡：multipleMtd / savingsUsd / projected / paidBack=false；调低月费后 paidBack', async () => {
    const mtd = recs.filter((x) => x.ts <= NOW && localDay(x.ts).startsWith('2026-10')).reduce((a, x) => a + (cost(x, 2) ?? 0), 0);
    const elapsed = Number(localDay(NOW).slice(8, 10));
    const p = (await getJson(t.base, '/api/subscription/payback')).body;
    expect(p.configured).toBe(true);
    expect(p.month).toBe('2026-10');
    expect(p.elapsedDays).toBe(elapsed);
    expect(p.daysInMonth).toBe(31);
    close(p.apiUsdMtd, mtd, 2e-6, 'apiUsdMtd');
    close(p.monthlyFeeUsd, 100, 1e-9);
    close(p.proratedFeeUsd, (100 * elapsed) / 31, 1e-4, 'proratedFeeUsd');
    close(p.multipleMtd, mtd / 100, 1e-4, 'multipleMtd');
    expect(p.savingsUsd).toBe(0);
    expect(p.paidBack).toBe(false);
    close(p.projected.apiUsd, (mtd / elapsed) * 31, 1e-4, 'projected.apiUsd');
    close(p.projected.multiple, ((mtd / elapsed) * 31) / 100, 1e-4, 'projected.multiple');
    expect(p.partial).toBe(true); // fixture 副本里有未计价的 claude-mystery-9（10-15）
    // 月费 $0.1 → 已回本
    await putJson(t.base, '/api/settings', { subscription: { plan: 'custom', monthlyFeeUsd: 0.1 } });
    const q = (await getJson(t.base, '/api/subscription/payback')).body;
    expect(q.paidBack).toBe(true);
    close(q.savingsUsd, mtd - 0.1, 2e-6, 'savings');
    close(q.multipleMtd, mtd / 0.1, 1e-3, 'multiple(0.1)');
    await putJson(t.base, '/api/settings', { subscription: { plan: 'max5x', monthlyFeeUsd: 100 } });
  });
});

describe('9/10 隐藏项目与导出', () => {
  const MARKERS = ['SECRET_BODY_MARKER', 'this tail must never', 'be stored', 'keep going'];
  const exportKinds = ['daily', 'model', 'session'];

  async function exportSum(kind: string, q = ''): Promise<{ sum: number; raw: Buffer; text: string }> {
    const r = await fetch(`${t.base}/api/export?kind=${kind}&format=csv&range=all${q}`);
    const raw = Buffer.from(await r.arrayBuffer());
    const text = raw.toString('utf8');
    const lines = text.replace(/^﻿/, '').split('\r\n').filter((l) => l);
    const head = lines[1]!.split(',');
    const i = head.indexOf('total_tokens');
    let sum = 0;
    for (const l of lines.slice(2)) sum += Number(l.split(',')[i]);
    return { sum, raw, text };
  }

  it('导出：BOM / 第一行 # 说明 / 第二行列名 / 含成本两列 / 各行求和 = 界面累计 / 无正文', async () => {
    const sm = (await getJson(t.base, '/api/summary?range=all')).body.summary;
    for (const kind of exportKinds) {
      const { sum, raw, text } = await exportSum(kind);
      expect([raw[0], raw[1], raw[2]], `${kind} BOM`).toEqual([0xef, 0xbb, 0xbf]);
      const lines = text.replace(/^﻿/, '').split('\r\n');
      expect(lines[0]!.startsWith('# '), `${kind} 首行`).toBe(true);
      expect(lines[1]!.startsWith('#')).toBe(false);
      expect(lines[1]).toContain('cost_api_usd');
      expect(lines[1]).toContain('cost_sub_usd');
      expect(sum, `${kind} Σ total_tokens`).toBe(sm.total);
      for (const m of MARKERS) expect(text, `${kind} 含 ${m}`).not.toContain(m);
      expect(text).not.toContain('Please refactor');
      const j = await getJson(t.base, `/api/export?kind=${kind}&format=json&range=all`);
      const js = JSON.stringify(j.body);
      for (const m of MARKERS) expect(js).not.toContain(m);
      expect(js).not.toContain('Please refactor');
      const rows = j.body.rows;
      expect(rows.reduce((a: number, r: any) => a + r.total_tokens, 0)).toBe(sm.total);
    }
  });

  it('全部 API 响应不含正文尾部标记；标题只在会话接口里出现且 ≤ 40 字', async () => {
    const paths = ['/api/summary?range=all', '/api/projects', '/api/sessions?range=all', '/api/cost/summary?range=all', '/api/analysis/models?range=all', '/api/analysis/projects?range=all', '/api/analysis/sessions-top?range=all', '/api/analysis/tools?range=all', '/api/analysis/quality?range=all', '/api/heatmap?range=all', '/api/settings', '/api/prices'];
    const sess = (await getJson(t.base, '/api/sessions?range=all')).body.rows;
    paths.push(...sess.map((s: any) => `/api/sessions/${s.id}`));
    for (const p of paths) {
      const r = await fetch(t.base + p);
      const text = await r.text();
      expect(r.status, p).toBeLessThan(500);
      for (const m of MARKERS) expect(text, `${p} 含 ${m}`).not.toContain(m);
    }
    const a1 = sess.find((s: any) => s.id.startsWith('a1a1a1a1'));
    expect(a1.title.length).toBeLessThanOrEqual(41);
  });

  it('隐藏项目：summary 降幅 = 项目总量；分组之和 = 合计；成本 / 运行时长 / 导出同步；恢复后还原', async () => {
    const base = async (): Promise<any> => {
      const sm = (await getJson(t.base, '/api/summary?range=all')).body.summary;
      const pr = (await getJson(t.base, '/api/projects')).body;
      const c = (await getJson(t.base, '/api/cost/summary?range=all')).body;
      return { sm, pr, c };
    };
    const b0 = await base();
    const alphaTotal = recs.filter((r) => r.folder === 'D--Work-alpha').reduce((a, r) => a + total(r), 0);
    const alphaCost = recs.filter((r) => r.folder === 'D--Work-alpha').reduce((a, r) => a + (cost(r, 2) ?? 0), 0);
    const r = await putJson(t.base, '/api/project-overrides', { id: 'D--Work-alpha', hidden: true });
    expect(r.status).toBe(200);
    const b1 = await base();
    expect(b0.sm.total - b1.sm.total).toBe(alphaTotal);
    expect(b1.pr.all.total).toBe(b1.sm.total);
    expect(b1.pr.projects.reduce((a: number, p: any) => a + p.total, 0)).toBe(b1.sm.total);
    expect(b1.pr.projects.find((p: any) => p.id === 'D--Work-alpha')).toBeUndefined();
    expect(b1.pr.hiddenCount ?? b1.pr.hidden?.length).toBe(1);
    close(b0.c.api.totalUsd - b1.c.api.totalUsd, alphaCost, 2e-6, '成本降幅 = alpha 成本');
    close(b1.c.byProject.reduce((a: number, p: any) => a + (p.cost.apiUsd ?? 0), 0), b1.c.api.totalUsd, 2e-6, '项目成本之和');
    expect(b1.sm.activeMs).toBeLessThan(b0.sm.activeMs);
    expect(b1.sm.activeMsSum).toBeLessThan(b0.sm.activeMsSum);
    // 时间曲线（按项目拆分）总和 = 合计
    for (const g of ['day', 'month']) {
      const ts = (await getJson(t.base, `/api/timeseries?range=all&granularity=${g}&split=project&tz=${TZ}`)).body;
      expect(ts.points.reduce((a: number, p: any) => a + p.value, 0)).toBe(b1.sm.total);
      expect(ts.series.reduce((a: number, s: any) => a + s.values.reduce((x: number, y: number) => x + y, 0), 0)).toBe(b1.sm.total);
    }
    for (const kind of exportKinds) expect((await exportSum(kind)).sum, `隐藏后导出 ${kind}`).toBe(b1.sm.total);
    const sess = (await getJson(t.base, '/api/sessions?range=all')).body;
    expect(sess.rows.some((x: any) => x.projectKey === 'D--Work-alpha')).toBe(false);
    expect(sess.sumValue).toBe(b1.sm.total);
    // 恢复
    const u = await fetch(`${t.base}/api/project-overrides/unhide-all`, { method: 'POST' });
    expect(u.status).toBe(200);
    const b2 = await base();
    expect(b2.sm).toEqual(b0.sm);
    expect(b2.pr.all.total).toBe(b0.pr.all.total);
    close(b2.c.api.totalUsd, b0.c.api.totalUsd, 1e-9);
  });
});

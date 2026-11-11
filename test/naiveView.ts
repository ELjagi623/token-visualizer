/**
 * 测试者自写的"朴素全量视图"：逐文件读到最后一个换行、逐行 JSON.parse、Map 按 message.id(无则 requestId) 取各字段最大值，
 * 按（首个带时间戳的行时间, 路径）定所有权。不 import src/ 下的任何代码，也不用开发者的测试辅助。
 */
import fs from 'node:fs';
import path from 'node:path';

export interface NaiveMsg {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  thinking: number;
  ts: number;
  owner: string;
  session: string | undefined;
  nFiles: number;
  model: string;
  cwd: string | undefined;
  sidechain: boolean;
  /** 所有权文件所属的项目文件夹 */
  folder: string;
}

export interface NaiveView {
  files: number;
  linesRead: number;
  assistantRows: number;
  synthetic: number;
  corrupt: number;
  empty: number;
  missingId: number;
  unique: number;
  dupDropped: number;
  crossFile: number;
  totals: { input: number; cacheWrite: number; cacheRead: number; output: number; thinking: number };
  /** 有 id 的消息（key = `m:<id>` 或 `r:<requestId>`） */
  msgs: Map<string, NaiveMsg>;
  noIdCount: number;
  /** 无任何 id 的行（每行一条，不去重） */
  noId: NaiveMsg[];
}

function listJsonl(root: string): string[] {
  const out: string[] = [];
  for (const proj of fs.readdirSync(root, { withFileTypes: true })) {
    if (!proj.isDirectory()) continue;
    for (const e of fs.readdirSync(path.join(root, proj.name), { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith('.jsonl')) out.push(`${proj.name}/${e.name}`);
      else if (e.isDirectory()) {
        const sd = path.join(root, proj.name, e.name, 'subagents');
        if (fs.existsSync(sd)) for (const s of fs.readdirSync(sd)) if (s.endsWith('.jsonl')) out.push(`${proj.name}/${e.name}/subagents/${s}`);
      }
    }
  }
  return out.sort();
}

export function naiveView(root: string): NaiveView {
  const nz = (x: unknown): number => (typeof x === 'number' && x > 0 ? x : 0);
  const per: Array<{ rel: string; first: number | null; rows: Array<{ key: string | null; f: number[]; ts: number; session: string | undefined; model: string; cwd: string | undefined }> }> = [];
  const v: NaiveView = {
    files: 0, linesRead: 0, assistantRows: 0, synthetic: 0, corrupt: 0, empty: 0, missingId: 0, unique: 0, dupDropped: 0, crossFile: 0,
    totals: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, thinking: 0 }, msgs: new Map(), noIdCount: 0, noId: [],
  };
  for (const rel of listJsonl(root)) {
    const buf = fs.readFileSync(path.join(root, ...rel.split('/')));
    v.files++;
    if (buf.length === 0) v.empty++;
    const lastNl = buf.lastIndexOf(10);
    const text = lastNl < 0 ? '' : buf.subarray(0, lastNl + 1).toString('utf8').replace(/^﻿/, '');
    let first: number | null = null;
    const rows: Array<{ key: string | null; f: number[]; ts: number; session: string | undefined; model: string; cwd: string | undefined }> = [];
    const parts = rel.split('/');
    const fallbackSession = parts.length >= 4 && parts[2] === 'subagents' ? parts[1]! : parts[parts.length - 1]!.replace(/[.]jsonl$/, '');
    for (let line of text.split('\n')) {
      line = line.replace(/\r$/, '');
      if (line.trim() === '') continue;
      v.linesRead++;
      let o: any;
      try {
        o = JSON.parse(line);
      } catch {
        v.corrupt++;
        continue;
      }
      if (first === null && o && typeof o.timestamp === 'string' && !Number.isNaN(Date.parse(o.timestamp))) first = Date.parse(o.timestamp);
      if (!o || o.type !== 'assistant') continue;
      v.assistantRows++;
      const m = o.message ?? {};
      if (m.model === '<synthetic>') {
        v.synthetic++;
        continue;
      }
      const ts = Date.parse(o.timestamp);
      if (Number.isNaN(ts)) continue;
      const u = m.usage ?? {};
      const cc = u.cache_creation ?? {};
      const cw = typeof u.cache_creation_input_tokens === 'number' ? nz(u.cache_creation_input_tokens) : nz(cc.ephemeral_5m_input_tokens) + nz(cc.ephemeral_1h_input_tokens);
      const key = m.id ? `m:${m.id}` : o.requestId ? `r:${o.requestId}` : null;
      if (key === null) v.missingId++;
      rows.push({ key, f: [nz(u.input_tokens), cw, nz(u.cache_read_input_tokens), nz(u.output_tokens), nz(u.output_tokens_details?.thinking_tokens)], ts, session: o.sessionId ?? fallbackSession, model: m.model ?? 'unknown', cwd: o.cwd });
    }
    per.push({ rel, first, rows });
  }
  per.sort((a, b) => {
    const ta = a.first ?? Infinity;
    const tb = b.first ?? Infinity;
    if (ta !== tb) return ta < tb ? -1 : 1;
    return a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0;
  });
  const files = new Map<string, Set<string>>();
  for (const f of per) {
    for (const r of f.rows) {
      if (r.key === null) {
        v.noIdCount++;
        v.noId.push({ input: r.f[0]!, cacheWrite: r.f[1]!, cacheRead: r.f[2]!, output: r.f[3]!, thinking: r.f[4]!, ts: r.ts, owner: f.rel, session: r.session, nFiles: 1, model: r.model, cwd: r.cwd, sidechain: f.rel.includes('/subagents/'), folder: f.rel.split('/')[0]! });
        v.totals.input += r.f[0]!;
        v.totals.cacheWrite += r.f[1]!;
        v.totals.cacheRead += r.f[2]!;
        v.totals.output += r.f[3]!;
        v.totals.thinking += r.f[4]!;
        continue;
      }
      let a = v.msgs.get(r.key);
      if (!a) {
        a = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, thinking: 0, ts: r.ts, owner: f.rel, session: r.session, nFiles: 0, model: r.model, cwd: r.cwd, sidechain: f.rel.includes('/subagents/'), folder: f.rel.split('/')[0]! };
        v.msgs.set(r.key, a);
        files.set(r.key, new Set());
      } else v.dupDropped++;
      files.get(r.key)!.add(f.rel);
      a.input = Math.max(a.input, r.f[0]!);
      a.cacheWrite = Math.max(a.cacheWrite, r.f[1]!);
      a.cacheRead = Math.max(a.cacheRead, r.f[2]!);
      a.output = Math.max(a.output, r.f[3]!);
      a.thinking = Math.max(a.thinking, r.f[4]!);
      a.ts = Math.min(a.ts, r.ts);
    }
  }
  for (const [k, a] of v.msgs) {
    a.nFiles = files.get(k)!.size;
    if (a.nFiles > 1) v.crossFile++;
    v.totals.input += a.input;
    v.totals.cacheWrite += a.cacheWrite;
    v.totals.cacheRead += a.cacheRead;
    v.totals.output += a.output;
    v.totals.thinking += a.thinking;
  }
  v.unique = v.msgs.size + v.noIdCount;
  return v;
}

/** 把 store 视图（records + stats）与朴素视图比较，返回差异描述（空 = 一致）。 */
export function diffAgainstNaive(
  view: { records: Array<{ messageId: string; requestId?: string; input: number; cacheWrite: number; cacheRead: number; output: number; thinking: number; ts: number; sourceFile: string; sessionId: string }>; stats: Record<string, any> },
  n: NaiveView,
): string[] {
  const d: string[] = [];
  const s = view.stats;
  const chk = (name: string, a: unknown, b: unknown): void => {
    if (a !== b) d.push(`${name}: store=${String(a)} naive=${String(b)}`);
  };
  chk('filesParsed', s.filesParsed, n.files);
  chk('linesRead', s.linesRead, n.linesRead);
  chk('assistantRows', s.assistantRows, n.assistantRows);
  chk('syntheticExcluded', s.syntheticExcluded, n.synthetic);
  chk('corruptLines', s.corruptLines, n.corrupt);
  chk('emptyFiles', s.emptyFiles, n.empty);
  chk('missingId', s.missingId, n.missingId);
  chk('uniqueMessages', s.uniqueMessages, n.unique);
  chk('records.length', view.records.length, n.unique);
  chk('duplicatesDropped', s.duplicatesDropped, n.dupDropped);
  chk('crossFileDuplicates', s.crossFileDuplicates, n.crossFile);
  const t = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, thinking: 0 };
  for (const r of view.records) {
    t.input += r.input; t.cacheWrite += r.cacheWrite; t.cacheRead += r.cacheRead; t.output += r.output; t.thinking += r.thinking;
    const key = r.messageId.startsWith('noid:') ? null : r.requestId && !n.msgs.has(`m:${r.messageId}`) ? `r:${r.requestId}` : `m:${r.messageId}`;
    if (key === null) continue;
    let a = n.msgs.get(key);
    if (!a && r.requestId) a = n.msgs.get(`r:${r.requestId}`);
    if (!a) {
      d.push(`store has message not in naive: ${r.messageId}`);
      continue;
    }
    if (a.input !== r.input || a.cacheWrite !== r.cacheWrite || a.cacheRead !== r.cacheRead || a.output !== r.output || a.thinking !== r.thinking) d.push(`fields differ for ${r.messageId}`);
    if (a.ts !== r.ts) d.push(`ts differs for ${r.messageId}`);
    if (a.owner !== r.sourceFile) d.push(`owner differs for ${r.messageId}: store=${r.sourceFile} naive=${a.owner}`);
  }
  for (const k of Object.keys(t) as Array<keyof typeof t>) chk(`total.${k}`, t[k], n.totals[k]);
  return d.slice(0, 15);
}

/** 全部唯一记录（含无 id 行）。 */
export function naiveRecords(v: NaiveView): NaiveMsg[] {
  return [...v.msgs.values(), ...v.noId];
}

/**
 * 阶段 1 独立测试（测试工程师编写，不复用开发者的测试辅助之外的任何断言逻辑）。
 * 覆盖：只读保护 / 白名单、解析边界、半行续读、全局去重与所有权（含随机置换）、
 * 与"朴素独立实现"的交叉核对、流式内存、敏感词不泄漏、fixture 只读审计。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dedupeGlobal } from '../src/server/core/dedupe.ts';
import type { DedupeFileInput } from '../src/server/core/dedupe.ts';
import { listUsageFiles, parseDataRoot } from '../src/server/core/loadRoot.ts';
import { parseFileRange } from '../src/server/core/parser.ts';
import type { ParsedRow } from '../src/server/core/parser.ts';
import { assertWritable, createAppDataWriter, createSafeFs, SafeFsViolation } from '../src/server/core/safeFs.ts';
import { FIXTURE_ROOT, loadExpected, makeTmpDir, rmDir, snapshotDir } from './helpers.ts';

let tmp: string;
beforeAll(() => {
  tmp = makeTmpDir('tv-tester-');
});
afterAll(() => rmDir(tmp));

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
function asst(id: string | null, ts: string, usage: Record<string, unknown> | null, extra: Record<string, unknown> = {}, msgExtra: Record<string, unknown> = {}): string {
  const message: Record<string, unknown> = { model: 'claude-sonnet-5', role: 'assistant', content: [], ...msgExtra };
  if (id) message.id = id;
  if (usage) message.usage = usage;
  return JSON.stringify({ type: 'assistant', timestamp: ts, sessionId: 's1', message, ...extra });
}
const U = (input: number, output: number, cr = 0, cw = 0) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: cr, cache_creation_input_tokens: cw });

function write(rel: string, content: string | Buffer): string {
  const p = path.join(tmp, ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

// ---------------------------------------------------------------------------
// 只读保护
// ---------------------------------------------------------------------------
describe('只读保护（safeFs）', () => {
  const dataRoot = path.join(os.tmpdir(), 'tv-tester-dataroot-x');
  const appData = path.join(os.tmpdir(), 'tv-tester-appdata-x');
  const claudeHome = path.join(os.homedir(), '.claude');

  it('拒绝写入数据根及其任意深度子路径', () => {
    for (const t of [dataRoot, path.join(dataRoot, 'a.jsonl'), path.join(dataRoot, 'proj', 'sub', 'x.tmp'), dataRoot + path.sep]) {
      expect(() => assertWritable(t, appData, [dataRoot])).toThrow(SafeFsViolation);
    }
  });

  it('拒绝 ~/.claude 与 ~/.claude/projects（即使未配置为数据根）', () => {
    for (const t of [claudeHome, path.join(claudeHome, 'projects'), path.join(claudeHome, 'projects', 'x', 'a.jsonl'), path.join(claudeHome, 'settings.json')]) {
      expect(() => assertWritable(t, appData, [])).toThrow(SafeFsViolation);
    }
  });

  it('拒绝 .. 穿越、大小写变体、正反斜杠混用', () => {
    expect(() => assertWritable(path.join(appData, '..', 'tv-tester-dataroot-x', 'a'), appData, [dataRoot])).toThrow(SafeFsViolation);
    expect(() => assertWritable(path.join(dataRoot.toUpperCase(), 'a'), appData, [dataRoot])).toThrow(SafeFsViolation);
    expect(() => assertWritable(dataRoot.replaceAll('\\', '/') + '/a', appData, [dataRoot])).toThrow(SafeFsViolation);
    expect(() => assertWritable(path.join(claudeHome.toLowerCase(), 'projects', 'a'), appData, [])).toThrow(SafeFsViolation);
  });

  it('拒绝应用数据目录之外的任意路径', () => {
    expect(() => assertWritable(path.join(os.tmpdir(), 'elsewhere.txt'), appData, [dataRoot])).toThrow(SafeFsViolation);
    expect(() => assertWritable('..\\..\\evil.txt', appData, [dataRoot])).toThrow(SafeFsViolation);
  });

  it('应用数据目录本身位于数据根内时，一切写入都被拒绝', () => {
    const inside = path.join(dataRoot, 'appdata');
    expect(() => assertWritable('cache.json', inside, [dataRoot])).toThrow(SafeFsViolation);
  });

  it('允许写应用数据目录内的相对/绝对路径', () => {
    expect(() => assertWritable('cache/x.json.gz', appData, [dataRoot])).not.toThrow();
    expect(() => assertWritable(path.join(appData, 'settings.json'), appData, [dataRoot])).not.toThrow();
  });

  it('真实写入被拒绝：writeFile/atomicWriteFile/mkdirp/remove 对数据根内路径抛错，且磁盘上什么都没出现', async () => {
    const root = path.join(tmp, 'ro-root');
    const app = path.join(tmp, 'ro-app');
    fs.mkdirSync(path.join(root, 'proj'), { recursive: true });
    fs.writeFileSync(path.join(root, 'proj', 'keep.jsonl'), 'x\n');
    const before = JSON.stringify(snapshotDir(root));
    const w = createAppDataWriter({ appDataDir: app, protectedRoots: () => [root] });
    await expect(w.writeFile(path.join(root, 'new.txt'), 'x')).rejects.toBeInstanceOf(SafeFsViolation);
    await expect(w.atomicWriteFile(path.join(root, 'proj', 'keep.jsonl'), 'overwritten')).rejects.toBeInstanceOf(SafeFsViolation);
    await expect(w.mkdirp(path.join(root, 'newdir'))).rejects.toBeInstanceOf(SafeFsViolation);
    await expect(w.remove(path.join(root, 'proj'))).rejects.toBeInstanceOf(SafeFsViolation);
    await expect(w.writeFile(path.join('..', 'ro-root', 'proj', 'keep.jsonl'), 'x')).rejects.toBeInstanceOf(SafeFsViolation);
    expect(JSON.stringify(snapshotDir(root))).toBe(before);
    expect(fs.readFileSync(path.join(root, 'proj', 'keep.jsonl'), 'utf8')).toBe('x\n');
    // 正常写入仍可用
    await w.atomicWriteFile('cache/c.json', '{}');
    expect(fs.readFileSync(path.join(app, 'cache', 'c.json'), 'utf8')).toBe('{}');
    // 受保护目录是函数，随设置变化：之后新增的数据根立即受保护
    let roots = [root];
    const w2 = createAppDataWriter({ appDataDir: app, protectedRoots: () => roots });
    roots = [path.join(app, 'cache')];
    await expect(w2.writeFile('cache/z.json', '1')).rejects.toBeInstanceOf(SafeFsViolation);
  });

  it('junction 绕过：应用数据目录内的 junction 指向数据根，写入被拒绝', async () => {
    const root = path.join(tmp, 'jn-root');
    const app = path.join(tmp, 'jn-app');
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(app, { recursive: true });
    try {
      fs.symlinkSync(root, path.join(app, 'link'), 'junction');
    } catch {
      return; // 无法创建 junction 的环境：跳过
    }
    const w = createAppDataWriter({ appDataDir: app, protectedRoots: () => [root] });
    await expect(w.writeFile('link/evil.txt', 'x')).rejects.toBeInstanceOf(SafeFsViolation);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('读接口白名单：只能读 *.jsonl / custom-title.json；凭据、meta、prefix 一律拒绝', async () => {
    const sfs = createSafeFs();
    for (const name of ['.credentials.json', 'agent-x.meta.json', 'agent-x.prefix.json', 'settings.json', 'notes.md', 'a.jsonl.bak', 'x.txt', 'history.jsonl.json']) {
      const p = write(`wl/${name}`, 'secret\n');
      await expect(sfs.openRead(p)).rejects.toBeInstanceOf(SafeFsViolation);
    }
    const ok = write('wl/ok.jsonl', 'a\n');
    const h = await sfs.openRead(ok);
    expect((await h.read(0, 10)).toString()).toBe('a\n');
    await h.close();
  });

  it('SafeFs 对象不暴露任何写方法', () => {
    const sfs = createSafeFs() as unknown as Record<string, unknown>;
    expect(Object.keys(sfs).sort()).toEqual(['bytesRead', 'openRead', 'opens', 'readdir', 'stat']);
  });

  it('openRead 是只读打开：对返回句柄不能写（句柄上没有 write）', async () => {
    const sfs = createSafeFs();
    const p = write('ro/h.jsonl', 'abc\n');
    const h = (await sfs.openRead(p)) as unknown as Record<string, unknown>;
    expect(Object.keys(h).sort()).toEqual(['close', 'read', 'size']);
    await (h.close as () => Promise<void>)();
  });
});

// ---------------------------------------------------------------------------
// 解析边界
// ---------------------------------------------------------------------------
describe('解析边界', () => {
  it('预过滤相关：type 在行尾 / 带空格 / 缩进 / 嵌套文本里含 "type":"assistant" 的 user 行', async () => {
    const lines = [
      '{"message":{"id":"m1","model":"claude-x","usage":{"input_tokens":1,"output_tokens":2}},"timestamp":"2026-01-01T00:00:00Z","type":"assistant"}',
      '{ "type" : "assistant" , "timestamp" : "2026-01-01T00:00:01Z", "message" : { "id" : "m2", "model":"claude-x", "usage": {"input_tokens": 3} } }',
      // user 行，正文里含有 "type":"assistant" 字样 —— 不能被算作 assistant
      JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:00:02Z', message: { content: 'hello "type":"assistant" {"id":"fake"}' } }),
      // assistant 行，但 type 字段以 unicode 转义写出
      '{"\\u0074ype":"assistant","timestamp":"2026-01-01T00:00:03Z","message":{"id":"m3","model":"claude-x","usage":{"output_tokens":9}}}',
    ];
    const p = write('edge/prefilter.jsonl', lines.join('\n') + '\n');
    const r = await parseFileRange(p);
    expect(r.rows.map((x) => x.messageId)).toEqual(['m1', 'm2', 'm3']);
    expect(r.stats.assistantRows).toBe(3);
    expect(r.stats.typeCounts).toEqual({ assistant: 3, user: 1 });
    expect(r.stats.corruptLines).toBe(0);
  });

  it('数值字段异常：字符串/负数/null/缺失 -> 0；不抛错；缺 usage 记入 missingUsage', async () => {
    const lines = [
      asst('a', '2026-01-01T00:00:00Z', { input_tokens: '12', output_tokens: -5, cache_read_input_tokens: null, cache_creation_input_tokens: 'x' }),
      asst('b', '2026-01-01T00:00:01Z', null),
      asst('c', '2026-01-01T00:00:02Z', { cache_creation: { ephemeral_5m_input_tokens: 7, ephemeral_1h_input_tokens: 3 } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T00:00:03Z', message: 'not-an-object' }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T00:00:04Z' }),
      JSON.stringify({ type: 'assistant', timestamp: 'not a date', message: { id: 'bad-ts', usage: U(1, 1) } }),
      '[1,2,3]',
      'null',
      '42',
      '"str"',
    ];
    const p = write('edge/numeric.jsonl', lines.join('\n') + '\n');
    const r = await parseFileRange(p);
    const by = new Map(r.rows.map((x) => [x.messageId, x]));
    expect([by.get('a')!.input, by.get('a')!.output, by.get('a')!.cacheRead, by.get('a')!.cacheWrite]).toEqual([0, 0, 0, 0]);
    expect(by.get('b')!.input + by.get('b')!.output).toBe(0);
    expect(by.get('c')!.cacheWrite).toBe(10); // 回退为 5m+1h
    expect(r.stats.missingUsage).toBeGreaterThanOrEqual(1);
    expect(r.stats.missingTimestamp).toBe(1); // 'not a date' 行
    expect(r.stats.corruptLines).toBe(0);
    expect(r.stats.linesRead).toBe(lines.length);
  });

  it('<synthetic>（即使 usage 非零）只计入 syntheticExcluded，不出现在 rows', async () => {
    const p = write('edge/syn.jsonl', [asst('s1', '2026-01-01T00:00:00Z', U(100, 100), {}, { model: '<synthetic>' }), asst('r1', '2026-01-01T00:00:01Z', U(1, 1))].join('\n') + '\n');
    const r = await parseFileRange(p);
    expect(r.stats.syntheticExcluded).toBe(1);
    expect(r.rows.map((x) => x.messageId)).toEqual(['r1']);
    expect(r.stats.assistantRows).toBe(2);
  });

  it('本地模型名原样保留（路径型含反斜杠、org/name 型）', async () => {
    const p = write(
      'edge/local.jsonl',
      [
        asst('l1', '2026-01-01T00:00:00Z', U(1, 1), {}, { model: 'C:\\Users\\x\\Models\\Qwen3-35B-A3B-Q4_K_M.gguf' }),
        asst('l2', '2026-01-01T00:00:01Z', U(1, 1), {}, { model: 'qwen/qwen3-coder-next' }),
      ].join('\n') + '\n',
    );
    const r = await parseFileRange(p);
    expect(r.rows.map((x) => x.model)).toEqual(['C:\\Users\\x\\Models\\Qwen3-35B-A3B-Q4_K_M.gguf', 'qwen/qwen3-coder-next']);
  });

  it('损坏行：截断 JSON、纯文本、空对象前缀、二进制垃圾、仅空白行（后者不计）', async () => {
    const good = asst('g', '2026-01-01T00:00:00Z', U(1, 1));
    const content = Buffer.concat([
      Buffer.from(good + '\n'),
      Buffer.from('{"type":"assistant","message":{"id":"trunc","usage":{"input_tok\n'),
      Buffer.from('plain text line\n'),
      Buffer.from([0xff, 0xfe, 0x00, 0x41, 0x0a]),
      Buffer.from('   \t  \n'),
      Buffer.from('\n'),
      Buffer.from('{"a":1}}\n'),
      Buffer.from(good.replace('"g"', '"g2"') + '\n'),
    ]);
    const p = write('edge/corrupt.jsonl', content);
    const r = await parseFileRange(p);
    expect(r.stats.corruptLines).toBe(4);
    expect(r.rows.map((x) => x.messageId)).toEqual(['g', 'g2']);
  });

  it('BOM + CRLF：首行 BOM 被去掉，\\r 不进入 JSON', async () => {
    const body = [asst('c1', '2026-01-01T00:00:00Z', U(1, 1)), asst('c2', '2026-01-01T00:00:01Z', U(2, 2))].join('\r\n') + '\r\n';
    const p = write('edge/crlf.jsonl', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body)]));
    const r = await parseFileRange(p);
    expect(r.stats.corruptLines).toBe(0);
    expect(r.rows.map((x) => x.messageId)).toEqual(['c1', 'c2']);
  });

  it('typeCounts 不会被 __proto__ / 超长 / 缺失 type 污染', async () => {
    const p = write(
      'edge/types.jsonl',
      ['{"type":"__proto__"}', '{"type":"constructor"}', '{"type":"toString"}', '{"no":"type"}', JSON.stringify({ type: 'x'.repeat(500) })].join('\n') + '\n',
    );
    const r = await parseFileRange(p);
    expect(r.stats.corruptLines).toBe(0);
    expect(Object.keys(r.stats.typeCounts).length).toBe(5);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(r.stats.typeCounts)).toBe(Object.prototype);
    expect(Object.values(r.stats.typeCounts).reduce((a, b) => a + b, 0)).toBe(5);
  });

  it('tool_use 只取 name：input 中的内容绝不出现在输出里；同 block id 在重复行里只计一次', async () => {
    const mk = (extra: unknown[]) =>
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-01-01T00:00:00Z',
        message: { id: 'tm', model: 'claude-x', usage: U(1, 1), content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'LEAK_ME_1' } }, ...extra] },
      });
    const p = write('edge/tools.jsonl', [mk([]), mk([]), mk([{ type: 'tool_use', id: 'tu2', name: 'Read', input: { f: 'LEAK_ME_2' } }, { type: 'tool_use', name: 'NoId', input: {} }])].join('\n') + '\n');
    const res = await parseDataRoot(path.join(tmp, 'edge-tools-root'), {}).catch(() => null);
    expect(res).toBeNull(); // 目录不存在应当抛错而不是静默
    const r = await parseFileRange(p);
    expect(JSON.stringify(r)).not.toContain('LEAK_ME');
    const d = dedupeGlobal([{ path: 'p/x.jsonl', projectKey: 'p', firstTs: 0, defaultSessionId: 'x', isSubagentFile: false, rows: r.rows }]);
    expect(d.records).toHaveLength(1);
    expect(d.records[0]!.tools).toEqual({ Bash: 1, NoId: 1, Read: 1 });
  });

  it('不同块大小（含 1 字节）解析结果完全一致，含跨块的中文多字节字符', async () => {
    const lines = [];
    for (let i = 0; i < 12; i++) lines.push(asst('m' + i, `2026-01-01T00:00:${String(i).padStart(2, '0')}Z`, U(i, i * 2), { cwd: 'C:\\用户\\王测试\\项目' + i }));
    lines.splice(5, 0, 'bad {');
    const p = write('edge/chunks.jsonl', lines.join('\n') + '\n');
    const ref = await parseFileRange(p, { chunkSize: 1 << 20 });
    for (const cs of [1, 2, 3, 5, 13, 100, 257]) {
      const r = await parseFileRange(p, { chunkSize: cs });
      expect(r.rows).toEqual(ref.rows);
      expect(r.stats).toEqual(ref.stats);
      expect(r.consumedUntilOffset).toBe(ref.consumedUntilOffset);
    }
  });
});

// ---------------------------------------------------------------------------
// 半行 / 偏移
// ---------------------------------------------------------------------------
describe('半行与偏移区间', () => {
  it('追加无换行半行 -> consumedUntilOffset 停在半行之前；补全后续读 == 一次读完（rows 与 stats 之和）', async () => {
    const complete = [asst('h1', '2026-01-01T00:00:00Z', U(1, 1)), 'garbage', asst('h2', '2026-01-01T00:00:01Z', U(2, 2))].join('\n') + '\n';
    const tail = asst('h3', '2026-01-01T00:00:02Z', U(3, 3), { cwd: 'C:\\王' });
    const p = path.join(tmp, 'half.jsonl');
    fs.writeFileSync(p, complete);
    const r0 = await parseFileRange(p);
    expect(r0.consumedUntilOffset).toBe(Buffer.byteLength(complete));
    expect(r0.pendingBytes).toBe(0);

    // 追加半行（切在中文字符中间）
    const tailBuf = Buffer.from(tail);
    const cut = tailBuf.indexOf(Buffer.from('王')) + 1; // 在多字节字符中间
    fs.appendFileSync(p, tailBuf.subarray(0, cut));
    const r1 = await parseFileRange(p);
    expect(r1.consumedUntilOffset).toBe(Buffer.byteLength(complete));
    expect(r1.pendingBytes).toBe(cut);
    expect(r1.rows.map((x) => x.messageId)).toEqual(['h1', 'h2']);
    expect(r1.stats.corruptLines).toBe(1); // 只有 garbage，半行不算损坏

    // 再追加一部分，仍无换行
    fs.appendFileSync(p, tailBuf.subarray(cut, cut + 5));
    const r1b = await parseFileRange(p);
    expect(r1b.consumedUntilOffset).toBe(Buffer.byteLength(complete));

    // 补全 + 换行，从偏移续读
    fs.appendFileSync(p, Buffer.concat([tailBuf.subarray(cut + 5), Buffer.from('\n')]));
    const r2 = await parseFileRange(p, { startOffset: r1.consumedUntilOffset });
    expect(r2.rows.map((x) => x.messageId)).toEqual(['h3']);
    expect(r2.rows[0]!.cwd).toBe('C:\\王');
    const whole = await parseFileRange(p);
    expect([...r1.rows, ...r2.rows]).toEqual(whole.rows.map((x) => x)); // offset 字段也一致
    expect(r1.stats.linesRead + r2.stats.linesRead).toBe(whole.stats.linesRead);
    expect(r1.stats.corruptLines + r2.stats.corruptLines).toBe(whole.stats.corruptLines);
    expect(r1.stats.assistantRows + r2.stats.assistantRows).toBe(whole.stats.assistantRows);
    expect(r2.consumedUntilOffset).toBe(fs.statSync(p).size);
    expect(whole.consumedUntilOffset).toBe(fs.statSync(p).size);
  });

  it('整个文件无换行 -> 消费 0 字节、无行、无损坏计数', async () => {
    const p = write('edge/nonl.jsonl', asst('x', '2026-01-01T00:00:00Z', U(1, 1)));
    const r = await parseFileRange(p);
    expect(r.consumedUntilOffset).toBe(0);
    expect(r.rows).toEqual([]);
    expect(r.stats.linesRead).toBe(0);
    expect(r.stats.corruptLines).toBe(0);
    expect(r.pendingBytes).toBe(fs.statSync(p).size);
  });

  it('endOffset 落在一行中间 -> 只消费到之前最后一个换行', async () => {
    const l1 = asst('e1', '2026-01-01T00:00:00Z', U(1, 1)) + '\n';
    const l2 = asst('e2', '2026-01-01T00:00:01Z', U(1, 1)) + '\n';
    const p = write('edge/endoff.jsonl', l1 + l2);
    const r = await parseFileRange(p, { endOffset: Buffer.byteLength(l1) + 10 });
    expect(r.consumedUntilOffset).toBe(Buffer.byteLength(l1));
    expect(r.rows.map((x) => x.messageId)).toEqual(['e1']);
    const r2 = await parseFileRange(p, { startOffset: r.consumedUntilOffset });
    expect(r2.rows.map((x) => x.messageId)).toEqual(['e2']);
  });

  it('startOffset 超过文件大小（文件被截断）不抛错、不返回记录', async () => {
    const p = write('edge/trunc.jsonl', asst('t', '2026-01-01T00:00:00Z', U(1, 1)) + '\n');
    const r = await parseFileRange(p, { startOffset: 99999 });
    expect(r.rows).toEqual([]);
    expect(r.consumedUntilOffset).toBeLessThanOrEqual(fs.statSync(p).size);
  });

  it('读取字节数只覆盖请求区间（bytesRead 计数器）', async () => {
    const lines = Array.from({ length: 50 }, (_, i) => asst('b' + i, '2026-01-01T00:00:00Z', U(1, 1))).join('\n') + '\n';
    const p = write('edge/bytes.jsonl', lines);
    const size = fs.statSync(p).size;
    const sfs = createSafeFs();
    const mid = Buffer.byteLength(lines.split('\n').slice(0, 25).join('\n') + '\n');
    const r = await parseFileRange(p, { fs: sfs, startOffset: mid });
    expect(r.rows).toHaveLength(25);
    expect(sfs.bytesRead).toBe(size - mid);
  });
});

// ---------------------------------------------------------------------------
// 去重与所有权
// ---------------------------------------------------------------------------
function row(id: string | undefined, ts: number, o: Partial<ParsedRow> = {}): ParsedRow {
  return {
    offset: 0, messageId: id, ts, model: 'claude-x', input: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, thinking: 0,
    webSearch: 0, webFetch: 0, tools: [], ...o,
  };
}
function file(p: string, firstTs: number | null, rows: ParsedRow[], extra: Partial<DedupeFileInput> = {}): DedupeFileInput {
  return { path: p, projectKey: p.split('/')[0]!, firstTs, defaultSessionId: path.basename(p, '.jsonl'), isSubagentFile: false, rows, ...extra };
}

describe('全局去重与所有权', () => {
  it('跨文件、跨项目：同一 message.id 全局只计一次；各数值字段取最大；ts 取最早', () => {
    const a = file('projA/s1.jsonl', 1000, [row('M', 1000, { input: 5, output: 10, cacheRead: 100 })]);
    const b = file('projB/s2.jsonl', 2000, [row('M', 900, { input: 7, output: 3, cacheRead: 50, cacheWrite: 9 })]);
    const d = dedupeGlobal([b, a]);
    expect(d.records).toHaveLength(1);
    const r = d.records[0]!;
    expect([r.input, r.output, r.cacheRead, r.cacheWrite]).toEqual([7, 10, 100, 9]);
    expect(r.ts).toBe(900);
    expect(d.stats).toEqual({ uniqueMessages: 1, duplicatesDropped: 1, crossFileDuplicates: 1 });
    expect(r.projectKey).toBe('projA'); // 所有权：firstTs 最早的文件
    expect(r.sourceFile).toBe('projA/s1.jsonl');
  });

  it('所有权：firstTs 并列 -> 路径字典序小者；null 视为最晚', () => {
    const mk = (p: string, t: number | null) => file(p, t, [row('M', 5, { sessionId: 'sess-' + p, cwd: 'cwd-' + p })]);
    expect(dedupeGlobal([mk('b/2.jsonl', 10), mk('a/9.jsonl', 10), mk('c/1.jsonl', 10)]).records[0]!.sourceFile).toBe('a/9.jsonl');
    expect(dedupeGlobal([mk('a/1.jsonl', null), mk('z/1.jsonl', 99)]).records[0]!.sourceFile).toBe('z/1.jsonl');
    expect(dedupeGlobal([mk('b/1.jsonl', null), mk('a/1.jsonl', null)]).records[0]!.sourceFile).toBe('a/1.jsonl');
    const r = dedupeGlobal([mk('a/1.jsonl', 20), mk('b/1.jsonl', 10)]).records[0]!;
    expect([r.sessionId, r.cwd, r.projectKey]).toEqual(['sess-b/1.jsonl', 'cwd-b/1.jsonl', 'b']);
  });

  it('随机置换输入顺序，结果逐字段完全一致（确定性）', () => {
    const files: DedupeFileInput[] = [];
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed / 0x7fffffff);
    for (let f = 0; f < 8; f++) {
      const rows: ParsedRow[] = [];
      for (let i = 0; i < 20; i++) {
        const id = 'm' + Math.floor(rnd() * 25);
        rows.push(row(id, 1000 + Math.floor(rnd() * 500), { input: Math.floor(rnd() * 50), output: Math.floor(rnd() * 50), offset: i * 100, sessionId: 's' + f, cwd: 'c' + f, stopReason: rnd() > 0.5 ? 'end_turn' : undefined }));
      }
      files.push(file(`p${f % 3}/f${f}.jsonl`, rnd() > 0.7 ? null : 1000 + Math.floor(rnd() * 3) * 100, rows));
    }
    const ref = JSON.stringify(dedupeGlobal(files));
    for (let k = 0; k < 20; k++) {
      const shuffled = [...files].sort(() => rnd() - 0.5);
      expect(JSON.stringify(dedupeGlobal(shuffled))).toBe(ref);
    }
  });

  it('stopReason 取最后一个非空；model 取首个；tools 按 block id 并集', () => {
    const f = file('p/a.jsonl', 1, [
      row('M', 1, { stopReason: 'tool_use', model: 'first', tools: [{ id: 't1', name: 'Bash' }] }),
      row('M', 2, { stopReason: undefined, model: 'later', tools: [{ id: 't1', name: 'Bash' }, { id: 't2', name: 'Read' }] }),
      row('M', 3, { stopReason: 'end_turn', tools: [{ id: 't2', name: 'Read' }, { id: 't3', name: 'Read' }] }),
      row('M', 4, { stopReason: undefined }),
    ]);
    const r = dedupeGlobal([f]).records[0]!;
    expect(r.stopReason).toBe('end_turn');
    expect(r.model).toBe('first');
    expect(r.tools).toEqual({ Bash: 1, Read: 2 });
  });

  it('无 id 退回 requestId；两者皆无不去重', () => {
    const f = file('p/a.jsonl', 1, [
      row(undefined, 1, { requestId: 'R', input: 1, offset: 0 }),
      row(undefined, 2, { requestId: 'R', input: 4, offset: 10 }),
      row(undefined, 3, { offset: 20, input: 2 }),
      row(undefined, 4, { offset: 30, input: 2 }),
    ]);
    const d = dedupeGlobal([f]);
    expect(d.stats.uniqueMessages).toBe(3);
    expect(d.stats.duplicatesDropped).toBe(1);
    expect(d.records.reduce((s, r) => s + r.input, 0)).toBe(4 + 2 + 2);
  });

  it('子代理文件：isSidechain 回退为 true、agentId 取自文件名；主文件不受影响', () => {
    const f = file('p/s/subagents/agent-abc.jsonl', 1, [row('S1', 1, { input: 3 })], { isSubagentFile: true, agentIdFromName: 'abc', defaultSessionId: 's' });
    const g = file('p/s.jsonl', 0, [row('M1', 1, { input: 3 })]);
    const d = dedupeGlobal([f, g]);
    const sub = d.records.find((r) => r.messageId === 'S1')!;
    expect(sub.isSidechain).toBe(true);
    expect(sub.agentId).toBe('abc');
    expect(sub.sessionId).toBe('s');
    expect(d.records.find((r) => r.messageId === 'M1')!.isSidechain).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fixture 端到端 + 只读审计 + 泄漏
// ---------------------------------------------------------------------------
describe('fixture 端到端', () => {
  it('解析输出与 expected.json 的统计/总量完全一致，且只读：前后 (路径,大小,mtime) 快照相同，打开过的只有 .jsonl', async () => {
    const before = JSON.stringify(snapshotDir(FIXTURE_ROOT));
    const opened = new Set<string>();
    const sfs = createSafeFs({ onRead: (p) => opened.add(p) });
    const res = await parseDataRoot(FIXTURE_ROOT, { fs: sfs });
    const e = loadExpected();
    for (const k of ['filesParsed', 'linesRead', 'assistantRows', 'uniqueMessages', 'duplicatesDropped', 'crossFileDuplicates', 'syntheticExcluded', 'corruptLines', 'emptyFiles', 'missingId']) {
      expect((res.stats as unknown as Record<string, number>)[k], k).toBe(e.stats[k]);
    }
    const sum = (f: 'input' | 'cacheWrite' | 'cacheRead' | 'output' | 'thinking') => res.records.reduce((s, r) => s + r[f], 0);
    expect(sum('input')).toBe(e.totals.input);
    expect(sum('cacheWrite')).toBe(e.totals.cacheWrite);
    expect(sum('cacheRead')).toBe(e.totals.cacheRead);
    expect(sum('output')).toBe(e.totals.output);
    expect(sum('thinking')).toBe(e.totals.thinking);
    expect(JSON.stringify(snapshotDir(FIXTURE_ROOT))).toBe(before);
    for (const p of opened) expect(p.endsWith('.jsonl'), p).toBe(true);
    // 子代理纳入；meta/prefix/custom-title 未被当作用量文件
    const files = await listUsageFiles(FIXTURE_ROOT);
    expect(files.some((f) => f.isSubagentFile)).toBe(true);
    expect(files.every((f) => f.relPath.endsWith('.jsonl'))).toBe(true);
    expect(res.records.filter((r) => r.isSidechain)).toHaveLength(e.sidechain.records);
    // 不泄漏
    const dump = JSON.stringify(res);
    for (const w of ['SECRET_BODY_MARKER', 'prefix body', 'Please refactor', 'reply text', 'echo ']) expect(dump, w).not.toContain(w);
  });

  it('usage 递增 message 取最大值；跨文件重复只计一次；归属文件符合所有权规则（对照原始文件独立计算）', async () => {
    const res = await parseDataRoot(FIXTURE_ROOT);
    const grow = res.records.filter((r) => r.messageId === 'msg_alpha_grow');
    expect(grow).toHaveLength(1);
    // 独立：扫原始文件取 max(output)
    let maxOut = 0;
    const firstTsByFile = new Map<string, number>();
    const holders = new Map<string, string[]>();
    for (const f of await listUsageFiles(FIXTURE_ROOT)) {
      const text = fs.readFileSync(f.absPath, 'utf8');
      for (const line of text.split('\n')) {
        let o: any;
        try { o = JSON.parse(line); } catch { continue; }
        if (!firstTsByFile.has(f.relPath) && o && typeof o.timestamp === 'string') firstTsByFile.set(f.relPath, Date.parse(o.timestamp));
        const id = o?.message?.id;
        if (o?.type === 'assistant' && id) {
          holders.set(id, [...new Set([...(holders.get(id) ?? []), f.relPath])]);
          if (id === 'msg_alpha_grow') maxOut = Math.max(maxOut, o.message.usage?.output_tokens ?? 0);
        }
      }
    }
    expect(grow[0]!.output).toBe(maxOut);
    expect(maxOut).toBeGreaterThan(0);
    let cross = 0;
    for (const [id, fs_] of holders) {
      if (fs_.length < 2) continue;
      cross++;
      const owner = [...fs_].sort((x, y) => (firstTsByFile.get(x)! - firstTsByFile.get(y)!) || (x < y ? -1 : 1))[0]!;
      const recs = res.records.filter((r) => r.messageId === id);
      expect(recs, id).toHaveLength(1);
      expect(recs[0]!.sourceFile, id).toBe(owner);
    }
    expect(cross).toBe(res.stats.crossFileDuplicates);
  });
});

// ---------------------------------------------------------------------------
// 与朴素独立实现在随机生成数据上交叉核对
// ---------------------------------------------------------------------------
describe('随机数据：与朴素独立实现交叉核对', () => {
  it('随机多文件/多项目/重复/损坏/synthetic 数据下，uniqueMessages/总量/重复数/跨文件数/所有权全部一致', async () => {
    const root = path.join(tmp, 'rand-root');
    let seed = 987654321;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0), seed / 0x100000000);
    const ri = (n: number) => Math.floor(rnd() * n);
    const pool = Array.from({ length: 60 }, (_, i) => ({ id: 'msg_' + i, usage: { input_tokens: ri(100), output_tokens: ri(500), cache_read_input_tokens: ri(10000), cache_creation_input_tokens: ri(2000) } }));
    const fileSpecs: string[] = [];
    for (let f = 0; f < 14; f++) {
      const proj = 'P' + ri(4);
      const rel = f % 5 === 4 ? `${proj}/sess${f}/subagents/agent-a${f}.jsonl` : `${proj}/sess${f}.jsonl`;
      fileSpecs.push(rel);
      const lines: string[] = [];
      const t0 = 1_760_000_000_000 + ri(5) * 1000; // 故意制造 firstTs 并列
      const n = ri(25);
      for (let i = 0; i < n; i++) {
        const r = rnd();
        const ts = new Date(t0 + i * 1000).toISOString();
        if (r < 0.06) lines.push('{"type":"assistant","message":{"id":"x'); // 损坏
        else if (r < 0.1) lines.push(JSON.stringify({ type: 'user', timestamp: ts, message: { content: 'hello' } }));
        else if (r < 0.15) lines.push(asst('syn' + i, ts, U(0, 0), {}, { model: '<synthetic>' }));
        else {
          const m = pool[ri(pool.length)]!;
          const grow = Math.floor(rnd() * 3); // 不同文件里同一 id 的 usage 递增/递减
          const u = { ...m.usage, output_tokens: m.usage.output_tokens + (rnd() > 0.5 ? grow * 7 : 0) };
          lines.push(asst(m.id, ts, u, { sessionId: 'sess' + f, isSidechain: rel.includes('subagents') }));
        }
      }
      let text = lines.join('\n') + (n ? '\n' : '');
      if (rnd() > 0.7) text += '{"type":"assistant","half'; // 半行
      const p = path.join(root, ...rel.split('/'));
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, text);
    }
    const res = await parseDataRoot(root);

    // 朴素实现
    const per: Array<{ rel: string; first: number | null; rows: Array<{ id: string; u: Record<string, number>; ts: number }> }> = [];
    let corrupt = 0, syn = 0, asstRows = 0;
    for (const rel of fileSpecs.slice().sort()) {
      const buf = fs.readFileSync(path.join(root, ...rel.split('/')));
      const lastNl = buf.lastIndexOf(10);
      const txt = lastNl < 0 ? '' : buf.subarray(0, lastNl + 1).toString('utf8');
      let first: number | null = null;
      const rows: Array<{ id: string; u: Record<string, number>; ts: number }> = [];
      for (const ln of txt.split('\n')) {
        if (!ln.trim()) continue;
        let o: any;
        try { o = JSON.parse(ln); } catch { corrupt++; continue; }
        if (first === null && o.timestamp) first = Date.parse(o.timestamp);
        if (o.type !== 'assistant') continue;
        asstRows++;
        if (o.message.model === '<synthetic>') { syn++; continue; }
        const u = o.message.usage;
        rows.push({ id: o.message.id, ts: Date.parse(o.timestamp), u: { i: u.input_tokens, o: u.output_tokens, r: u.cache_read_input_tokens, w: u.cache_creation_input_tokens } });
      }
      per.push({ rel, first, rows });
    }
    per.sort((a, b) => ((a.first ?? Infinity) - (b.first ?? Infinity) || (a.rel < b.rel ? -1 : 1)) as number);
    const m = new Map<string, { owner: string; files: Set<string>; i: number; o: number; r: number; w: number }>();
    let dup = 0;
    for (const f of per) {
      for (const r of f.rows) {
        const a = m.get(r.id) ?? { owner: f.rel, files: new Set<string>(), i: 0, o: 0, r: 0, w: 0 };
        if (m.has(r.id)) dup++;
        m.set(r.id, a);
        a.files.add(f.rel);
        a.i = Math.max(a.i, r.u.i!); a.o = Math.max(a.o, r.u.o!); a.r = Math.max(a.r, r.u.r!); a.w = Math.max(a.w, r.u.w!);
      }
    }
    expect(res.stats.corruptLines).toBe(corrupt);
    expect(res.stats.syntheticExcluded).toBe(syn);
    expect(res.stats.assistantRows).toBe(asstRows);
    expect(res.stats.uniqueMessages).toBe(m.size);
    expect(res.stats.duplicatesDropped).toBe(dup);
    expect(res.stats.crossFileDuplicates).toBe([...m.values()].filter((a) => a.files.size > 1).length);
    const byId = new Map(res.records.map((r) => [r.messageId, r]));
    for (const [id, a] of m) {
      const r = byId.get(id)!;
      expect([r.input, r.output, r.cacheRead, r.cacheWrite, r.sourceFile], id).toEqual([a.i, a.o, a.r, a.w, a.owner]);
    }
  });
});

// ---------------------------------------------------------------------------
// 流式：另一种文件形态（大量小行 + 重复），RSS 增量
// ---------------------------------------------------------------------------
describe('流式内存', () => {
  it('≥ 60 MB（约 20 万行小记录）onRow 流式解析时 RSS 增量 < 200 MB；累积 rows 模式同样 < 200 MB', async () => {
    const p = path.join(tmp, 'big-small-lines.jsonl');
    const fd = fs.openSync(p, 'w');
    const pad = 'x'.repeat(180);
    let wrote = 0;
    let n = 0;
    while (wrote < 60 * 1024 * 1024) {
      let chunk = '';
      for (let i = 0; i < 2000; i++, n++) {
        chunk += JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T00:00:00Z', message: { id: 'id' + (n % 50000), model: 'claude-x', usage: U(1, 2, 3, 4), content: [{ type: 'text', text: pad }] } }) + '\n';
      }
      wrote += fs.writeSync(fd, chunk);
    }
    fs.closeSync(fd);
    expect(fs.statSync(p).size).toBeGreaterThanOrEqual(60 * 1024 * 1024);
    global.gc?.();
    const base = process.memoryUsage().rss;
    let peak = base;
    const timer = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 20);
    let count = 0;
    const r = await parseFileRange(p, { onRow: () => void count++ });
    clearInterval(timer);
    peak = Math.max(peak, process.memoryUsage().rss);
    expect(count).toBe(n);
    expect(r.rows).toHaveLength(0);
    expect(r.consumedUntilOffset).toBe(fs.statSync(p).size);
    expect((peak - base) / 1048576).toBeLessThan(200);

    const base2 = process.memoryUsage().rss;
    let peak2 = base2;
    const timer2 = setInterval(() => (peak2 = Math.max(peak2, process.memoryUsage().rss)), 20);
    const r2 = await parseFileRange(p);
    clearInterval(timer2);
    peak2 = Math.max(peak2, process.memoryUsage().rss);
    expect(r2.rows).toHaveLength(n);
    expect((peak2 - base2) / 1048576).toBeLessThan(200);
  });
});

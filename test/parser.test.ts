import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseFileRange, parseWholeFile } from '../src/server/core/parser.ts';
import { createSafeFs } from '../src/server/core/safeFs.ts';
import { assistantLine, makeTmpDir, rmDir } from './helpers.ts';

let tmp: string;
beforeAll(() => {
  tmp = makeTmpDir();
});
afterAll(() => rmDir(tmp));

function write(name: string, content: string | Buffer): string {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, content);
  return p;
}

describe('parser：基础行为', () => {
  it('逐行解析 assistant，提取用量与元数据', async () => {
    const line = JSON.stringify({
      parentUuid: null,
      isSidechain: false,
      message: {
        model: 'claude-opus-5-5',
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'SECRET' },
          { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'SECRET' } },
        ],
        stop_reason: 'tool_use',
        usage: {
          input_tokens: 3,
          cache_creation_input_tokens: 10,
          cache_read_input_tokens: 20,
          output_tokens: 7,
          output_tokens_details: { thinking_tokens: 4 },
          server_tool_use: { web_search_requests: 2, web_fetch_requests: 1 },
          service_tier: 'standard',
          cache_creation: { ephemeral_1h_input_tokens: 6, ephemeral_5m_input_tokens: 4 },
          speed: 'fast',
        },
      },
      requestId: 'req_1',
      type: 'assistant',
      timestamp: '2026-10-01T12:00:00.123Z',
      entrypoint: 'cli',
      cwd: 'D:\\p',
      sessionId: 'sess',
      version: '2.1.0',
      gitBranch: 'dev',
      effort: 'high',
    });
    const p = write('basic.jsonl', `${line}\n`);
    const r = await parseWholeFile(p);
    expect(r.rows).toHaveLength(1);
    const row = r.rows[0]!;
    expect(row).toMatchObject({
      messageId: 'msg_1',
      requestId: 'req_1',
      ts: Date.parse('2026-10-01T12:00:00.123Z'),
      model: 'claude-opus-5-5',
      sessionId: 'sess',
      cwd: 'D:\\p',
      isSidechain: false,
      input: 3,
      cacheWrite: 10,
      cacheWrite5m: 4,
      cacheWrite1h: 6,
      cacheRead: 20,
      output: 7,
      thinking: 4,
      webSearch: 2,
      webFetch: 1,
      serviceTier: 'standard',
      speed: 'fast',
      effort: 'high',
      entrypoint: 'cli',
      gitBranch: 'dev',
      version: '2.1.0',
      stopReason: 'tool_use',
      tools: [{ id: 'toolu_1', name: 'Bash' }],
    });
    // 正文 / tool_use.input 不得出现在任何输出里
    expect(JSON.stringify(r)).not.toContain('SECRET');
    expect(r.stats.assistantRows).toBe(1);
    expect(r.stats.typeCounts).toEqual({ assistant: 1 });
    expect(r.consumedUntilOffset).toBe(Buffer.byteLength(`${line}\n`));
    expect(r.pendingBytes).toBe(0);
  });

  it('损坏行跳过并计数；空行忽略；未知 type 计入 typeCounts；非对象 JSON 不算损坏', async () => {
    const content = [
      '{"type":"mode","mode":"x"}',
      '{"type":"assistant","message":{"id":"msg_t","usage":{"input_tokens":9', // 截断 JSON
      'plain text line',
      '',
      '   ',
      '{"type":"brand-new-type","timestamp":"2026-10-01T00:00:00Z"}',
      '42',
      '[1,2]',
      '{"no_type":true}',
      assistantLine({ id: 'msg_ok' }),
    ].join('\n');
    const p = write('mixed.jsonl', `${content}\n`);
    const r = await parseWholeFile(p);
    expect(r.stats.corruptLines).toBe(2);
    expect(r.stats.linesRead).toBe(8); // 10 行 - 2 个空白行
    expect(r.stats.typeCounts).toEqual({ mode: 1, 'brand-new-type': 1, '(none)': 3, assistant: 1 });
    expect(r.rows.map((x) => x.messageId)).toEqual(['msg_ok']);
  });

  it('缺字段：无 usage / 无 cache_creation 细分 / 无 thinking 均按 0，且分别计数', async () => {
    const noUsage = JSON.stringify({ type: 'assistant', message: { id: 'a', model: 'm', content: [] }, timestamp: '2026-10-01T00:00:00Z' });
    const noBreakdown = JSON.stringify({
      type: 'assistant',
      message: { id: 'b', model: 'm', usage: { input_tokens: 5, cache_creation_input_tokens: 9, cache_read_input_tokens: 1, output_tokens: 2 } },
      timestamp: '2026-10-01T00:00:00Z',
    });
    const onlyBreakdown = JSON.stringify({
      type: 'assistant',
      message: { id: 'c', model: 'm', usage: { input_tokens: 5, cache_creation: { ephemeral_5m_input_tokens: 3, ephemeral_1h_input_tokens: 4 }, output_tokens: 2, output_tokens_details: { thinking_tokens: 1 } } },
      timestamp: '2026-10-01T00:00:00Z',
    });
    const weird = JSON.stringify({
      type: 'assistant',
      message: { id: 'd', usage: { input_tokens: 'abc', output_tokens: -5, cache_read_input_tokens: null } },
      timestamp: '2026-10-01T00:00:00Z',
    });
    const p = write('missing.jsonl', [noUsage, noBreakdown, onlyBreakdown, weird].join('\n') + '\n');
    const r = await parseWholeFile(p);
    const by = Object.fromEntries(r.rows.map((x) => [x.messageId, x]));
    expect(by.a).toMatchObject({ input: 0, output: 0, cacheWrite: 0, thinking: 0, model: 'm' });
    expect(by.b).toMatchObject({ input: 5, cacheWrite: 9, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 1, output: 2, thinking: 0 });
    expect(by.c).toMatchObject({ cacheWrite: 7, cacheWrite5m: 3, cacheWrite1h: 4, thinking: 1 });
    expect(by.d).toMatchObject({ input: 0, output: 0, cacheRead: 0, model: 'unknown' });
    expect(r.stats.missingUsage).toBe(1);
    expect(r.stats.missingCacheBreakdown).toBe(2); // b 与 d
    expect(r.stats.missingThinking).toBe(2); // b 与 d（c 有 thinking；a 没有 usage，只计 missingUsage）
  });

  it('<synthetic> 行不产出 row，只计数；缺时间戳的行被排除并计数；无 id 无 requestId 计 missingId', async () => {
    const syn = assistantLine({ id: 'msg_s', model: '<synthetic>' });
    const noTs = JSON.stringify({ type: 'assistant', message: { id: 'x', model: 'm', usage: { input_tokens: 1 } } });
    const badTs = JSON.stringify({ type: 'assistant', message: { id: 'y', model: 'm', usage: { input_tokens: 1 } }, timestamp: 'not a date' });
    const noId = JSON.stringify({ type: 'assistant', message: { model: 'm', usage: { input_tokens: 1 } }, timestamp: '2026-10-01T00:00:00Z' });
    const p = write('synth.jsonl', [syn, noTs, badTs, noId].join('\n') + '\n');
    const r = await parseWholeFile(p);
    expect(r.stats.assistantRows).toBe(4);
    expect(r.stats.syntheticExcluded).toBe(1);
    expect(r.stats.missingTimestamp).toBe(2);
    expect(r.stats.missingId).toBe(1);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.messageId).toBeUndefined();
  });

  it('key 顺序与空格各异的行都能解析（无子串预过滤，不漏行）', async () => {
    const base = JSON.parse(assistantLine({ id: 'msg_k' }));
    const typeFirst = JSON.stringify({ type: 'assistant', ...base });
    const spaced = JSON.stringify(base, null, 1).replace(/\n\s*/g, ' ');
    const typeLast = JSON.stringify({ ...base, type: 'assistant' });
    const lines = [typeFirst, spaced, typeLast].map((l, i) => l.replace('msg_k', `msg_k${i}`));
    const p = write('styles.jsonl', lines.join('\n') + '\n');
    const r = await parseWholeFile(p);
    expect(r.rows.map((x) => x.messageId)).toEqual(['msg_k0', 'msg_k1', 'msg_k2']);
    expect(r.stats.assistantRows).toBe(3);
  });

  it('CRLF 行尾与 UTF-8 BOM', async () => {
    const l1 = assistantLine({ id: 'msg_c1' });
    const l2 = assistantLine({ id: 'msg_c2' });
    const p = write('crlf.jsonl', `\uFEFF${l1}\r\n${l2}\r\n`);
    const r = await parseWholeFile(p);
    expect(r.rows.map((x) => x.messageId)).toEqual(['msg_c1', 'msg_c2']);
    expect(r.stats.corruptLines).toBe(0);
  });

  it('空文件：emptyFiles=1，不报错', async () => {
    const p = write('empty.jsonl', '');
    const r = await parseWholeFile(p);
    expect(r.stats.emptyFiles).toBe(1);
    expect(r.stats.filesParsed).toBe(1);
    expect(r.rows).toEqual([]);
    expect(r.consumedUntilOffset).toBe(0);
    expect(r.firstTs).toBeNull();
  });

  it('firstTs 取首个带顶层 timestamp 的行（任意 type），嵌套 timestamp 不算', async () => {
    const lines = [
      '{"type":"mode"}',
      '{"type":"file-history-snapshot","snapshot":{"timestamp":"2020-01-01T00:00:00Z"}}',
      '{"type":"user","timestamp":"2026-10-02T03:04:05.000Z"}',
      assistantLine({ id: 'm', ts: '2026-10-01T00:00:00.000Z' }),
    ];
    const r = await parseWholeFile(write('firstts.jsonl', lines.join('\n') + '\n'));
    expect(r.firstTs).toBe(Date.parse('2026-10-02T03:04:05.000Z'));
  });
});

describe('parser：半行与偏移区间', () => {
  const l1 = assistantLine({ id: 'msg_1', ts: '2026-10-01T00:00:01.000Z', input: 1 });
  const l2 = assistantLine({ id: 'msg_2', ts: '2026-10-01T00:00:02.000Z', input: 2 });
  const l3 = assistantLine({ id: 'msg_3', ts: '2026-10-01T00:00:03.000Z', input: 3, session: '会话-中文' });

  it('末尾半行不被消费；补全后从 consumedUntilOffset 续读，结果与一次性读完完全相同', async () => {
    const half = l3.slice(0, 50);
    const rest = l3.slice(50);
    const p = write('half.jsonl', `${l1}\n${l2}\n${half}`);
    const r1 = await parseFileRange(p);
    expect(r1.rows.map((x) => x.messageId)).toEqual(['msg_1', 'msg_2']);
    expect(r1.consumedUntilOffset).toBe(Buffer.byteLength(`${l1}\n${l2}\n`));
    expect(r1.pendingBytes).toBe(Buffer.byteLength(half));
    expect(r1.stats.corruptLines).toBe(0); // 半行不是损坏行
    expect(r1.stats.linesRead).toBe(2);

    // 追加剩余部分与换行
    fs.appendFileSync(p, `${rest}\n`);
    const r2 = await parseFileRange(p, { startOffset: r1.consumedUntilOffset });
    expect(r2.rows.map((x) => x.messageId)).toEqual(['msg_3']);
    expect(r2.pendingBytes).toBe(0);
    expect(r2.stats.filesParsed).toBe(0); // 续读不再计文件数

    const whole = await parseWholeFile(p);
    expect([...r1.rows, ...r2.rows]).toEqual(whole.rows);
    expect(r2.consumedUntilOffset).toBe(whole.consumedUntilOffset);
    expect(r1.stats.linesRead + r2.stats.linesRead).toBe(whole.stats.linesRead);
    expect(r1.stats.assistantRows + r2.stats.assistantRows).toBe(whole.stats.assistantRows);
  });

  it('只有半行（无任何换行）：consumedUntilOffset 仍为起点', async () => {
    const p = write('onlyhalf.jsonl', l1.slice(0, 30));
    const r = await parseFileRange(p);
    expect(r.consumedUntilOffset).toBe(0);
    expect(r.rows).toEqual([]);
    expect(r.pendingBytes).toBe(30);
  });

  it('endOffset 落在行中间：只消费到之前的最后一个换行', async () => {
    const p = write('end.jsonl', `${l1}\n${l2}\n${l3}\n`);
    const cut = Buffer.byteLength(`${l1}\n`) + 20;
    const r = await parseFileRange(p, { endOffset: cut });
    expect(r.rows.map((x) => x.messageId)).toEqual(['msg_1']);
    expect(r.consumedUntilOffset).toBe(Buffer.byteLength(`${l1}\n`));
    expect(r.pendingBytes).toBe(20);
  });

  it('startOffset 区间读取：从行首开始读后半部分', async () => {
    const p = write('start.jsonl', `${l1}\n${l2}\n${l3}\n`);
    const start = Buffer.byteLength(`${l1}\n`);
    const r = await parseFileRange(p, { startOffset: start });
    expect(r.rows.map((x) => x.messageId)).toEqual(['msg_2', 'msg_3']);
    expect(r.rows[0]!.offset).toBe(start);
    expect(r.consumedUntilOffset).toBe(Buffer.byteLength(`${l1}\n${l2}\n${l3}\n`));
  });

  it('startOffset 超过文件大小（文件被截断）：不抛错，返回空结果', async () => {
    const p = write('trunc.jsonl', `${l1}\n`);
    const r = await parseFileRange(p, { startOffset: 99999 });
    expect(r.rows).toEqual([]);
    expect(r.consumedUntilOffset).toBe(Buffer.byteLength(`${l1}\n`));
  });

  it('任意块大小（含 1 字节、切在多字节字符中间）结果都相同', async () => {
    const p = write('chunks.jsonl', `${l1}\r\n\n${l2}\n${l3}\n{"type":"user","timestamp":"2026-10-01T00:00:09Z"}\nnot json\n`);
    const ref = await parseWholeFile(p);
    expect(ref.rows).toHaveLength(3);
    for (const chunkSize of [1, 2, 3, 7, 64, 1000]) {
      const r = await parseWholeFile(p, { chunkSize });
      expect(r.rows).toEqual(ref.rows);
      expect(r.stats).toEqual(ref.stats);
      expect(r.consumedUntilOffset).toBe(ref.consumedUntilOffset);
      expect(r.firstTs).toBe(ref.firstTs);
    }
  });

  it('onRow 流式回调：不累积 rows', async () => {
    const p = write('onrow.jsonl', `${l1}\n${l2}\n`);
    const seen: string[] = [];
    const r = await parseFileRange(p, { onRow: (row) => void seen.push(row.messageId!) });
    expect(seen).toEqual(['msg_1', 'msg_2']);
    expect(r.rows).toEqual([]);
  });

  it('读取字节数 = 区间长度（只读新增字节）', async () => {
    const p = write('bytes.jsonl', `${l1}\n${l2}\n`);
    const fsx = createSafeFs();
    const r1 = await parseFileRange(p, { fs: fsx });
    expect(fsx.bytesRead).toBe(r1.fileSize);
    const addition = `${l3}\n`;
    fs.appendFileSync(p, addition);
    const before = fsx.bytesRead;
    await parseFileRange(p, { fs: fsx, startOffset: r1.consumedUntilOffset });
    expect(fsx.bytesRead - before).toBe(Buffer.byteLength(addition));
  });
});

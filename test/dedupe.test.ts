import { describe, expect, it } from 'vitest';
import { compareOwnership, dedupeGlobal } from '../src/server/core/dedupe.ts';
import type { DedupeFileInput } from '../src/server/core/dedupe.ts';
import type { ParsedRow } from '../src/server/core/parser.ts';

function row(over: Partial<ParsedRow> & { ts: number }): ParsedRow {
  return {
    offset: 0,
    model: 'claude-sonnet-5-5',
    input: 0,
    cacheWrite: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheRead: 0,
    output: 0,
    thinking: 0,
    webSearch: 0,
    webFetch: 0,
    tools: [],
    ...over,
  };
}

function file(path: string, firstTs: number | null, rows: ParsedRow[], over: Partial<DedupeFileInput> = {}): DedupeFileInput {
  return {
    path,
    projectKey: path.split('/')[0]!,
    firstTs,
    defaultSessionId: path.replace(/^.*\//, '').replace('.jsonl', ''),
    isSubagentFile: false,
    rows,
    ...over,
  };
}

describe('dedupe：同文件内合并', () => {
  it('同 id 多行：usage 各字段取最大值，ts 取最早，stopReason 取最后一个非空，tools 并集', () => {
    const f = file('p/s1.jsonl', 1, [
      row({ messageId: 'm1', ts: 300, output: 10, input: 5, thinking: 1, stopReason: undefined, tools: [{ id: 't1', name: 'Bash' }] }),
      row({ messageId: 'm1', ts: 100, output: 99, input: 5, thinking: 7, cacheRead: 50, stopReason: 'tool_use', tools: [{ id: 't2', name: 'Read' }] }),
      row({ messageId: 'm1', ts: 200, output: 40, input: 2, cacheRead: 10, webSearch: 3, stopReason: undefined, tools: [{ id: 't1', name: 'Bash' }, { id: 't2', name: 'Read' }] }),
    ]);
    const r = dedupeGlobal([f]);
    expect(r.records).toHaveLength(1);
    expect(r.records[0]).toMatchObject({ messageId: 'm1', ts: 100, input: 5, output: 99, thinking: 7, cacheRead: 50, webSearch: 3, stopReason: 'tool_use', tools: { Bash: 1, Read: 1 } });
    expect(r.stats).toEqual({ uniqueMessages: 1, duplicatesDropped: 2, crossFileDuplicates: 0 });
  });

  it('usage 递增的流式重复：结果等于最大值（即最后一行）', () => {
    const f = file('p/s1.jsonl', 1, [
      row({ messageId: 'm', ts: 1, output: 10 }),
      row({ messageId: 'm', ts: 2, output: 55 }),
      row({ messageId: 'm', ts: 3, output: 120 }),
    ]);
    expect(dedupeGlobal([f]).records[0]!.output).toBe(120);
  });

  it('无 tool block id 的 tool_use 每次出现各算一次，有 id 的按 id 去重', () => {
    const f = file('p/s1.jsonl', 1, [
      row({ messageId: 'm', ts: 1, offset: 0, tools: [{ name: 'Bash' }] }),
      row({ messageId: 'm', ts: 2, offset: 10, tools: [{ name: 'Bash' }, { id: 'x', name: 'Grep' }] }),
      row({ messageId: 'm', ts: 3, offset: 20, tools: [{ id: 'x', name: 'Grep' }] }),
    ]);
    expect(dedupeGlobal([f]).records[0]!.tools).toEqual({ Bash: 2, Grep: 1 });
  });

  it('键：优先 message.id，其次 requestId；两者皆无则不去重', () => {
    const f = file('p/s1.jsonl', 1, [
      row({ messageId: 'a', requestId: 'r1', ts: 1 }),
      row({ requestId: 'r2', ts: 2, output: 1 }),
      row({ requestId: 'r2', ts: 3, output: 2 }),
      row({ ts: 4, offset: 100, output: 5 }),
      row({ ts: 5, offset: 200, output: 5 }),
    ]);
    const r = dedupeGlobal([f]);
    expect(r.stats).toEqual({ uniqueMessages: 4, duplicatesDropped: 1, crossFileDuplicates: 0 });
    const noId = r.records.filter((x) => x.messageId.startsWith('noid:'));
    expect(noId.map((x) => x.messageId)).toEqual(['noid:p/s1.jsonl:100', 'noid:p/s1.jsonl:200']);
    expect(r.records.find((x) => x.messageId === 'r2')!.output).toBe(2);
  });
});

describe('dedupe：跨文件所有权', () => {
  const rowsFor = (id: string, cwd: string, session: string) => [row({ messageId: id, ts: 1000, output: 5, cwd, sessionId: session })];

  it('归属 firstTs 最早的文件（与传入顺序无关）', () => {
    const early = file('proj/early.jsonl', 100, rowsFor('m', 'D:\\early', 'S-early'));
    const late = file('proj/aaa-late.jsonl', 500, rowsFor('m', 'D:\\late', 'S-late'));
    for (const order of [[early, late], [late, early]]) {
      const r = dedupeGlobal(order);
      expect(r.records).toHaveLength(1);
      expect(r.records[0]).toMatchObject({ sourceFile: 'proj/early.jsonl', sessionId: 'S-early', cwd: 'D:\\early', projectKey: 'proj' });
      expect(r.stats).toEqual({ uniqueMessages: 1, duplicatesDropped: 1, crossFileDuplicates: 1 });
    }
  });

  it('firstTs 并列：按路径字典序；跨项目也成立', () => {
    const a = file('projA/z.jsonl', 100, rowsFor('m', 'D:\\a', 'Sa'));
    const b = file('projB/a.jsonl', 100, rowsFor('m', 'D:\\b', 'Sb'));
    const c = file('projA/b.jsonl', 100, rowsFor('m', 'D:\\c', 'Sc'));
    // 码元序：projA/b.jsonl < projA/z.jsonl < projB/a.jsonl
    for (const order of [[a, b, c], [c, b, a], [b, a, c]]) {
      expect(dedupeGlobal(order).records[0]!.sourceFile).toBe('projA/b.jsonl');
    }
  });

  it('firstTs 为 null 的文件排在最后', () => {
    const known = file('p/z.jsonl', 5, rowsFor('m', 'D:\\k', 'Sk'));
    const unknown = file('p/a.jsonl', null, rowsFor('m', 'D:\\u', 'Su'));
    expect(dedupeGlobal([unknown, known]).records[0]!.sourceFile).toBe('p/z.jsonl');
    expect(compareOwnership({ firstTs: null, path: 'a' }, { firstTs: 1, path: 'b' })).toBe(1);
  });

  it('所有权字段只取所有权文件内的出现；其余字段取第一个非空；ts 取全局最早；usage 取全局最大', () => {
    const owner = file('p/owner.jsonl', 1, [row({ messageId: 'm', ts: 900, output: 5, sessionId: undefined, effort: undefined, cwd: undefined })]);
    const other = file('p/other.jsonl', 2, [row({ messageId: 'm', ts: 800, output: 9, sessionId: 'S-other', cwd: 'D:\\other', effort: 'high', isSidechain: true })]);
    const rec = dedupeGlobal([other, owner]).records[0]!;
    expect(rec.sessionId).toBe('owner'); // 回退到所有权文件名，而不是 other 的 sessionId
    expect(rec.cwd).toBeUndefined();
    expect(rec.isSidechain).toBe(false);
    expect(rec.effort).toBe('high'); // 非所有权字段：第一个非空
    expect(rec.ts).toBe(800);
    expect(rec.output).toBe(9);
    expect(rec.sourceFile).toBe('p/owner.jsonl');
  });

  it('同一个 id 在同一文件内重复不算跨文件', () => {
    const f = file('p/a.jsonl', 1, [row({ messageId: 'm', ts: 1 }), row({ messageId: 'm', ts: 2 })]);
    expect(dedupeGlobal([f]).stats.crossFileDuplicates).toBe(0);
  });

  it('子代理文件：isSidechain / agentId 回退到文件信息，行内字段优先', () => {
    const f = file('p/s/subagents/agent-x1.jsonl', 1, [row({ messageId: 'm1', ts: 1 }), row({ messageId: 'm2', ts: 2, isSidechain: false, agentId: 'explicit' })], {
      isSubagentFile: true,
      defaultSessionId: 's',
      agentIdFromName: 'x1',
    });
    const r = dedupeGlobal([f]);
    expect(r.records[0]).toMatchObject({ messageId: 'm1', isSidechain: true, agentId: 'x1', sessionId: 's' });
    expect(r.records[1]).toMatchObject({ messageId: 'm2', isSidechain: false, agentId: 'explicit' });
  });

  it('结果顺序确定：按 (ts, messageId)，与文件传入顺序无关', () => {
    const a = file('p/a.jsonl', 1, [row({ messageId: 'b', ts: 10 }), row({ messageId: 'a', ts: 10 }), row({ messageId: 'c', ts: 5 })]);
    const b = file('p/b.jsonl', 2, [row({ messageId: 'd', ts: 7 })]);
    const ids1 = dedupeGlobal([a, b]).records.map((r) => r.messageId);
    const ids2 = dedupeGlobal([b, a]).records.map((r) => r.messageId);
    expect(ids1).toEqual(['c', 'd', 'a', 'b']);
    expect(ids2).toEqual(ids1);
  });
});

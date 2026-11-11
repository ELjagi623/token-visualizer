import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateFixture } from '../scripts/make-fixture.ts';
import { dedupeGlobal } from '../src/server/core/dedupe.ts';
import type { DedupeFileInput } from '../src/server/core/dedupe.ts';
import { listUsageFiles, parseDataRoot } from '../src/server/core/loadRoot.ts';
import type { ParseRootResult } from '../src/server/core/loadRoot.ts';
import { parseFileRange } from '../src/server/core/parser.ts';
import { createSafeFs, SafeFsViolation } from '../src/server/core/safeFs.ts';
import type { UsageRecord } from '../src/shared/types.ts';
import { diffTrees, FIXTURE_ROOT, loadExpected, makeTmpDir, MARKER, rmDir, snapshotDir } from './helpers.ts';
import type { Expected } from './helpers.ts';

const expected: Expected = loadExpected();
let result: ParseRootResult;
let before: ReturnType<typeof snapshotDir>;
let readPaths: string[] = [];

beforeAll(async () => {
  before = snapshotDir(FIXTURE_ROOT);
  const fsx = createSafeFs({ onRead: (p) => void readPaths.push(p) });
  result = await parseDataRoot(FIXTURE_ROOT, { fs: fsx });
});

describe('fixture：生成器确定性（验收 1）', () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach(rmDir));

  it('重复生成两次，目录逐字节一致；且与已提交的 fixture 一致', () => {
    const a = path.join(makeTmpDir('tv-fx-a-'), 'projects');
    const b = path.join(makeTmpDir('tv-fx-b-'), 'projects');
    dirs.push(path.dirname(a), path.dirname(b));
    const r1 = generateFixture(a);
    const r2 = generateFixture(b);
    expect(diffTrees(a, b)).toEqual([]);
    expect(diffTrees(a, FIXTURE_ROOT)).toEqual([]);
    expect(r1.expected).toEqual(r2.expected);
    // expected.json 与生成器当前输出一致（没有被手改 / 过期）
    expect(JSON.parse(JSON.stringify(r1.expected))).toEqual(expected);
  });
});

describe('fixture：解析 + 全局去重 对照 expected.json（验收 2）', () => {
  it('ParseStats 各项精确等于 expected', () => {
    const s = result.stats;
    const e = expected.stats;
    expect(s.filesParsed).toBe(e.filesParsed);
    expect(s.linesRead).toBe(e.linesRead);
    expect(s.assistantRows).toBe(e.assistantRows);
    expect(s.uniqueMessages).toBe(e.uniqueMessages);
    expect(s.duplicatesDropped).toBe(e.duplicatesDropped);
    expect(s.crossFileDuplicates).toBe(e.crossFileDuplicates);
    expect(s.syntheticExcluded).toBe(e.syntheticExcluded);
    expect(s.corruptLines).toBe(e.corruptLines);
    expect(s.emptyFiles).toBe(e.emptyFiles);
    expect(s.missingId).toBe(e.missingId);
    expect(s.missingTimestamp).toBe(e.missingTimestamp);
    expect(s.missingUsage).toBe(e.missingUsage);
    expect(s.missingCacheBreakdown).toBe(e.missingCacheBreakdown);
    expect(s.missingThinking).toBe(e.missingThinking);
    expect(s.typeCounts).toEqual(e.typeCounts);
    expect(result.records).toHaveLength(expected.stats.uniqueMessages);
  });

  it('各 token 字段总和等于 expected.totals', () => {
    const sum = (f: (r: UsageRecord) => number): number => result.records.reduce((a, r) => a + f(r), 0);
    const t = expected.totals;
    expect(sum((r) => r.input)).toBe(t.input);
    expect(sum((r) => r.cacheWrite)).toBe(t.cacheWrite);
    expect(sum((r) => r.cacheWrite5m)).toBe(t.cacheWrite5m);
    expect(sum((r) => r.cacheWrite1h)).toBe(t.cacheWrite1h);
    expect(sum((r) => r.cacheRead)).toBe(t.cacheRead);
    expect(sum((r) => r.output)).toBe(t.output);
    expect(sum((r) => r.thinking)).toBe(t.thinking);
    expect(sum((r) => r.webSearch)).toBe(t.webSearch);
    expect(sum((r) => r.webFetch)).toBe(t.webFetch);
    expect(sum((r) => r.input + r.cacheWrite + r.cacheRead + r.output)).toBe(t.total);
    expect(sum((r) => r.input + r.cacheWrite + r.output)).toBe(t.fresh);
  });

  it('逐条 message 与 expected.messages 完全一致（含所有权归属、stopReason、tools）', () => {
    const byId = new Map(result.records.map((r) => [r.messageId, r]));
    for (const [id, e] of Object.entries<Expected>(expected.messages)) {
      const r = byId.get(id);
      expect(r, `缺少 ${id}`).toBeDefined();
      expect(
        {
          ts: r!.ts,
          model: r!.model,
          sessionId: r!.sessionId,
          projectKey: r!.projectKey,
          cwd: r!.cwd,
          isSidechain: r!.isSidechain,
          agentId: r!.agentId ?? null,
          sourceFile: r!.sourceFile,
          stopReason: r!.stopReason ?? null,
          effort: r!.effort ?? null,
          requestId: r!.requestId ?? null,
          tools: r!.tools,
          input: r!.input,
          cacheWrite: r!.cacheWrite,
          cacheWrite5m: r!.cacheWrite5m,
          cacheWrite1h: r!.cacheWrite1h,
          cacheRead: r!.cacheRead,
          output: r!.output,
          thinking: r!.thinking,
          webSearch: r!.webSearch,
          webFetch: r!.webFetch,
          total: r!.input + r!.cacheWrite + r!.cacheRead + r!.output,
          fresh: r!.input + r!.cacheWrite + r!.output,
        },
        id,
      ).toEqual({
        ts: e.ts,
        model: e.model,
        sessionId: e.sessionId,
        projectKey: e.projectKey,
        cwd: e.cwd,
        isSidechain: e.isSidechain,
        agentId: e.agentId,
        sourceFile: e.sourceFile,
        stopReason: e.stopReason,
        effort: e.effort,
        requestId: e.requestId,
        tools: e.tools,
        input: e.input,
        cacheWrite: e.cacheWrite,
        cacheWrite5m: e.cacheWrite5m,
        cacheWrite1h: e.cacheWrite1h,
        cacheRead: e.cacheRead,
        output: e.output,
        thinking: e.thinking,
        webSearch: e.webSearch,
        webFetch: e.webFetch,
        total: e.total,
        fresh: e.fresh,
      });
    }
    // 无 id 的记录
    const noId = result.records.filter((r) => r.messageId.startsWith('noid:'));
    expect(noId).toHaveLength(expected.noIdMessages.length);
    expect(noId[0]).toMatchObject({ sourceFile: expected.noIdMessages[0].sourceFile, output: expected.noIdMessages[0].output, input: expected.noIdMessages[0].input });
    expect(result.records.length).toBe(Object.keys(expected.messages).length + expected.noIdMessages.length);
  });

  it('不会出现 <synthetic> 记录；synthetic 的 id 不在结果里', () => {
    expect(result.records.some((r) => r.model === '<synthetic>')).toBe(false);
    expect(result.records.some((r) => r.messageId === 'msg_alpha_syn')).toBe(false);
  });

  it('每个文件的 firstTs / 半行信息等于 expected.files', () => {
    const byPath = new Map(result.files.map((f) => [f.info.relPath, f]));
    for (const e of expected.files as Expected[]) {
      const f = byPath.get(e.path);
      expect(f, e.path).toBeDefined();
      expect(f!.firstTs, e.path).toBe(e.firstTs);
      expect(f!.info.size, e.path).toBe(e.sizeBytes);
      expect(f!.pendingBytes, e.path).toBe(e.pendingTailBytes);
      expect(f!.consumedUntilOffset, e.path).toBe(e.sizeBytes - e.pendingTailBytes);
    }
  });
});

describe('fixture：关键场景（验收 3）', () => {
  it('usage 递增重复的 message：各字段取最大值（= 最后一行）；流式重复只计一次', () => {
    const grow = result.records.find((r) => r.messageId === 'msg_alpha_grow')!;
    expect(grow).toMatchObject({ output: 120, thinking: 60, input: 5, cacheRead: 52000, cacheWrite: 800, webSearch: 1, stopReason: 'tool_use', tools: { Bash: 1, Read: 1 } });
    const stream = result.records.find((r) => r.messageId === 'msg_alpha_stream')!;
    expect(stream).toMatchObject({ output: 150, input: 3, stopReason: 'end_turn' });
  });

  it('跨文件重复只计一次，归属 firstTs 最早的文件；并列按路径字典序', () => {
    const stream = result.records.filter((r) => r.messageId === 'msg_alpha_stream');
    expect(stream).toHaveLength(1);
    expect(stream[0]!.sessionId).toBe('a1a1a1a1-0000-4000-8000-000000000001');
    expect(stream[0]!.sourceFile.endsWith('0001.jsonl')).toBe(true);
    // 恢复会话文件里的 sessionId 不同，但归属仍是原文件
    const tie = result.records.find((r) => r.messageId === 'msg_beta_tie')!;
    expect(tie.sourceFile).toBe('D--Work-beta/bbbbbbbb-0000-4000-8000-000000000001.jsonl');
    expect(tie.cwd).toBe('D:\\Work\\beta');
    expect(result.stats.crossFileDuplicates).toBe(3);
  });

  it('子代理 .jsonl 被纳入且 isSidechain === true；Read 工具按 block id 去重后为 2 次', () => {
    const subs = result.records.filter((r) => r.sourceFile.includes('/subagents/'));
    expect(subs.length).toBe(2);
    expect(subs.every((r) => r.isSidechain === true && r.agentId === 'a1b2c3d4' && r.sessionId === 'a1a1a1a1-0000-4000-8000-000000000001')).toBe(true);
    expect(subs.find((r) => r.messageId === 'msg_alpha_sub2')!.tools).toEqual({ Read: 2 });
    expect(result.records.filter((r) => !r.sourceFile.includes('/subagents/')).every((r) => r.isSidechain === false)).toBe(true);
  });

  it('本地模型名原样保留（归一化在阶段 2）', () => {
    const models = new Set(result.records.map((r) => r.model));
    expect(models.has('C:\\Users\\x\\Models\\Qwen3-35B-A3B-Q4_K_M.gguf')).toBe(true);
    expect(models.has('qwen/qwen3-coder-next')).toBe(true);
  });

  it('中文 cwd 正确解码；中文用户名项目的 projectKey 是有损文件夹名', () => {
    const demo = result.records.filter((r) => r.projectKey === 'C--Users-----Work-demo');
    expect(demo.length).toBeGreaterThan(0);
    expect(demo.every((r) => r.cwd === 'C:\\Users\\王测试\\Work\\demo')).toBe(true);
  });

  it('同一项目文件夹下出现 2 个不同 cwd', () => {
    const cwds = new Set(result.records.filter((r) => r.projectKey === 'D--Work-beta').map((r) => r.cwd));
    expect(cwds.size).toBe(2);
  });

  it('Scratch：3 个文件夹，cwd 形如 scratch-workspaces\\<uuid>\\<uuid>\\scratch-…', () => {
    const scratch = result.records.filter((r) => /scratch-workspaces/.test(r.projectKey));
    const folders = new Set(scratch.map((r) => r.projectKey));
    expect(folders.size).toBe(3);
    for (const r of scratch) expect(r.cwd).toMatch(/^C:\\Users\\王测试\\AppData\\Roaming\\Claude\\scratch-workspaces\\[0-9a-f-]{36}\\[0-9a-f-]{36}\\scratch-\d{4}-\d{2}-\d{2}-[0-9a-f]{6}$/);
  });

  it('时间戳覆盖：probe 记录的 ts 与声明一致', () => {
    const byId = new Map(result.records.map((r) => [r.messageId, r]));
    for (const p of expected.timeProbes as Expected[]) expect(byId.get(p.id)?.ts, p.id).toBe(p.ts);
    expect((expected.timeProbes as Expected[]).length).toBe(16);
  });

  it('纳入规则：*.meta.json / *.prefix.json / custom-title.json 不被当作用量文件', async () => {
    const infos = await listUsageFiles(FIXTURE_ROOT);
    expect(infos.every((i) => i.relPath.endsWith('.jsonl'))).toBe(true);
    expect(infos).toHaveLength(expected.stats.filesParsed);
    expect(infos.some((i) => i.relPath.includes('.meta.') || i.relPath.includes('.prefix.'))).toBe(false);
  });
});

describe('fixture：隐私与只读（验收 5、6）', () => {
  it('解析过程从未打开 meta / prefix / custom-title 文件', () => {
    expect(readPaths.length).toBeGreaterThan(0);
    for (const p of readPaths) expect(p.toLowerCase().endsWith('.jsonl'), p).toBe(true);
  });

  it('SECRET_BODY_MARKER 不出现在任何解析输出中', () => {
    const all = JSON.stringify({ records: result.records, stats: result.stats, files: result.files });
    expect(all).not.toContain(MARKER);
    expect(all).not.toContain('SECRET');
    // 同时确认 fixture 本身确实含有该标记（否则这个断言没意义）
    const raw = fs.readFileSync(path.join(FIXTURE_ROOT, 'D--Work-alpha', 'a1a1a1a1-0000-4000-8000-000000000001.jsonl'), 'utf8');
    expect(raw).toContain(MARKER);
    const meta = fs.readFileSync(path.join(FIXTURE_ROOT, 'D--Work-alpha', 'a1a1a1a1-0000-4000-8000-000000000001', 'subagents', 'agent-a1b2c3d4.meta.json'), 'utf8');
    expect(meta).toContain(MARKER);
  });

  it('safeFs 拒绝读取非白名单文件', async () => {
    const meta = path.join(FIXTURE_ROOT, 'D--Work-alpha', 'a1a1a1a1-0000-4000-8000-000000000001', 'subagents', 'agent-a1b2c3d4.meta.json');
    await expect(createSafeFs().openRead(meta)).rejects.toBeInstanceOf(SafeFsViolation);
    await expect(createSafeFs().openRead(path.join(FIXTURE_ROOT, '.credentials.json'))).rejects.toBeInstanceOf(SafeFsViolation);
  });

  it('解析前后 fixture 目录 (相对路径, 大小, mtime) 快照完全一致', () => {
    expect(snapshotDir(FIXTURE_ROOT)).toEqual(before);
  });
});

describe('fixture：增量续读等价（验收 4 的 fixture 版）', () => {
  it('把 alpha 主文件拆成两半续读，rows 与一次性读完相同', async () => {
    const p = path.join(FIXTURE_ROOT, 'D--Work-alpha', 'a1a1a1a1-0000-4000-8000-000000000001.jsonl');
    const whole = await parseFileRange(p);
    // 找一个行首作为拆分点
    const buf = fs.readFileSync(p);
    const mid = buf.indexOf(0x0a, Math.floor(buf.length / 2)) + 1;
    const r1 = await parseFileRange(p, { endOffset: mid });
    const r2 = await parseFileRange(p, { startOffset: r1.consumedUntilOffset });
    expect([...r1.rows, ...r2.rows]).toEqual(whole.rows);
    expect(r2.consumedUntilOffset).toBe(whole.consumedUntilOffset);
    expect(r1.stats.corruptLines + r2.stats.corruptLines).toBe(whole.stats.corruptLines);
  });

  it('去重结果与文件传入顺序无关', async () => {
    const infos = await listUsageFiles(FIXTURE_ROOT);
    const inputs: DedupeFileInput[] = [];
    for (const info of infos) {
      const r = await parseFileRange(info.absPath);
      inputs.push({ path: info.relPath, projectKey: info.projectKey, firstTs: r.firstTs, defaultSessionId: info.defaultSessionId, isSubagentFile: info.isSubagentFile, agentIdFromName: info.agentIdFromName, rows: r.rows });
    }
    const a = dedupeGlobal(inputs);
    const b = dedupeGlobal([...inputs].reverse());
    expect(b.records).toEqual(a.records);
    expect(a.records).toEqual(result.records);
  });
});

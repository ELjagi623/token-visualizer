import { describe, expect, it } from 'vitest';
import { buildProjectIndex, isScratchFolderName, isScratchPath, lastSegment } from '../src/server/core/projects.ts';
import type { UsageRecord } from '../src/shared/types.ts';
import { loadExpected, loadFixtureCtx } from './helpers.ts';
import type { Expected } from './helpers.ts';

const expected: Expected = loadExpected();

function rec(over: Partial<UsageRecord> & Pick<UsageRecord, 'projectKey'>): UsageRecord {
  return {
    messageId: `m${Math.random()}`,
    ts: 1,
    model: 'claude-sonnet-5-5',
    sessionId: 's',
    isSidechain: false,
    input: 0,
    cacheWrite: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheRead: 0,
    output: 0,
    thinking: 0,
    webSearch: 0,
    webFetch: 0,
    tools: {},
    sourceFile: 'x',
    ...over,
  };
}

describe('projects：fixture 上的项目列表（验收 1）', () => {
  it('Scratch 归并：顶层数 = 非 scratch 文件夹数 + 1，children 数 = scratch 文件夹数', async () => {
    const { groupedProjects } = await loadFixtureCtx();
    const folders = expected.projects as Expected[];
    const nonScratch = folders.filter((p) => !p.isScratch).length;
    const scratch = folders.filter((p) => p.isScratch).length;
    expect(scratch).toBe(expected.scratchFolderCount);
    expect(scratch).toBeGreaterThanOrEqual(3);
    expect(groupedProjects.list).toHaveLength(nonScratch + 1);
    const g = groupedProjects.byId.get('scratch')!;
    expect(g.isScratchGroup).toBe(true);
    expect(g.children).toHaveLength(scratch);
    expect(g.memberKeys).toHaveLength(scratch);
    expect(g.records).toBe(folders.filter((p) => p.isScratch).reduce((a, p) => a + p.records, 0));
    // 子项显示名取自 cwd 末级目录
    expect(g.children!.map((c) => c.displayName).sort()).toEqual(['scratch-2026-10-11-abc123', 'scratch-2026-10-12-def456', 'scratch-2026-10-13-789abc']);
  });

  it('groupScratch=false：各 scratch 目录独立列出，项目数 = 文件夹数', async () => {
    const { flatProjects } = await loadFixtureCtx();
    expect(flatProjects.list).toHaveLength(expected.projectFolderCount);
    expect(flatProjects.byId.has('scratch')).toBe(false);
    expect(flatProjects.list.filter((p) => p.isScratch)).toHaveLength(expected.scratchFolderCount);
  });

  it('显示名 / 路径取自 cwd 而不是文件夹名（中文用户名有损编码）', async () => {
    const { flatProjects } = await loadFixtureCtx();
    const demo = flatProjects.byId.get('C--Users-----Work-demo')!;
    expect(demo.displayName).toBe('demo');
    expect(demo.path).toBe('C:\\Users\\王测试\\Work\\demo');
    expect(demo.pathUnknown).toBe(false);
    expect(demo.displayName).not.toContain('-----');
  });

  it('每个文件夹的 displayName / path / cwds / 记录数 与 expected.projects 一致', async () => {
    const { flatProjects } = await loadFixtureCtx();
    for (const e of expected.projects as Expected[]) {
      const p = flatProjects.byId.get(e.projectKey)!;
      expect(p, e.projectKey).toBeDefined();
      expect(p.displayName, e.projectKey).toBe(e.displayName);
      expect(p.path, e.projectKey).toBe(e.path);
      expect(p.cwds, e.projectKey).toEqual(e.cwds);
      expect(p.records, e.projectKey).toBe(e.records);
    }
  });

  it('同一文件夹 2 个 cwd：cwds[] 列出两个，主 cwd = 记录数最多者', async () => {
    const { flatProjects } = await loadFixtureCtx();
    const beta = flatProjects.byId.get('D--Work-beta')!;
    expect(beta.cwds).toEqual(['D:\\Work\\beta', 'D:\\Work\\beta\\sub']);
    expect(beta.displayName).toBe('beta');
    expect(beta.path).toBe('D:\\Work\\beta');
  });

  it('没有任何记录的文件夹（只有空文件）：退回文件夹名并标记 pathUnknown；idOfKey / keysFor', async () => {
    const { flatProjects, groupedProjects } = await loadFixtureCtx();
    const empty = flatProjects.byId.get('D--Work-empty')!;
    expect(empty).toMatchObject({ displayName: 'D--Work-empty', pathUnknown: true, path: null, records: 0, firstTs: null });
    expect(groupedProjects.idOfKey('D--Work-alpha')).toBe('D--Work-alpha');
    const scratchKey = groupedProjects.byId.get('scratch')!.memberKeys[0]!;
    expect(groupedProjects.idOfKey(scratchKey)).toBe('scratch');
    expect(groupedProjects.keysFor('scratch')).toHaveLength(3);
    expect(groupedProjects.keysFor('nope')).toBeUndefined();
    expect(flatProjects.idOfKey(scratchKey)).toBe(scratchKey);
  });
});

describe('projects：规则细节', () => {
  it('cwd 并列时取最近出现者', () => {
    const idx = buildProjectIndex([rec({ projectKey: 'k', cwd: 'D:\\old', ts: 10 }), rec({ projectKey: 'k', cwd: 'D:\\new', ts: 20 }), rec({ projectKey: 'k', cwd: 'D:\\old', ts: 30 }), rec({ projectKey: 'k', cwd: 'D:\\new', ts: 99 })]);
    const p = idx.byId.get('k')!;
    expect(p.cwds).toEqual(['D:\\new', 'D:\\old']);
    expect(p.displayName).toBe('new');
  });

  it('无 cwd 的项目：退回文件夹名并标记 pathUnknown', () => {
    const idx = buildProjectIndex([rec({ projectKey: 'C--Users-----Foo' })]);
    expect(idx.byId.get('C--Users-----Foo')).toMatchObject({ displayName: 'C--Users-----Foo', pathUnknown: true, path: null, cwds: [] });
  });

  it('Scratch 识别：只靠 cwd、只靠文件夹名都能识别；普通路径不误判', () => {
    expect(isScratchPath('C:\\Users\\a\\AppData\\Roaming\\Claude\\scratch-workspaces\\u1\\u2\\scratch-2026-10-11-abc123')).toBe(true);
    expect(isScratchPath('C:/Users/a/AppData/Roaming/Claude/scratch-workspaces/u1/u2/scratch-2026-10-11-abc123/')).toBe(true);
    expect(isScratchPath('D:\\Work\\scratch-notes')).toBe(false);
    expect(isScratchPath('D:\\scratch-workspaces\\only-one-level')).toBe(false);
    expect(isScratchFolderName('C--Users-x-AppData-Roaming-Claude-scratch-workspaces-u1-u2-scratch-2026-10-11-abc123')).toBe(true);
    expect(isScratchFolderName('D--Work-scratch-notes')).toBe(false);
    const byCwd = buildProjectIndex([rec({ projectKey: 'weird-folder', cwd: 'C:\\x\\scratch-workspaces\\a\\b\\scratch-2026-01-01-zzzzzz' })]);
    expect(byCwd.byId.get('scratch')!.children).toHaveLength(1);
    const byName = buildProjectIndex([rec({ projectKey: 'C--a-scratch-workspaces-u1-u2-scratch-2026-10-11-abc123' })]);
    expect(byName.byId.get('scratch')!.children).toHaveLength(1);
    const none = buildProjectIndex([rec({ projectKey: 'D--Work-alpha', cwd: 'D:\\Work\\alpha' })]);
    expect(none.byId.has('scratch')).toBe(false);
    expect(none.list).toHaveLength(1);
  });

  it('lastSegment：反斜杠 / 正斜杠 / 末尾分隔符 / 盘符根', () => {
    expect(lastSegment('D:\\Work\\alpha')).toBe('alpha');
    expect(lastSegment('/home/u/proj/')).toBe('proj');
    expect(lastSegment('C:\\')).toBe('C:');
    expect(lastSegment('plain')).toBe('plain');
  });

  it('overrides：重命名 / 隐藏 / 置顶只打标记；mergeInto 并入目标（链式与环安全）', () => {
    const recs = [
      rec({ projectKey: 'a', cwd: 'D:\\a', ts: 1 }),
      rec({ projectKey: 'b', cwd: 'D:\\b', ts: 2 }),
      rec({ projectKey: 'b', cwd: 'D:\\b', ts: 3 }),
      rec({ projectKey: 'c', cwd: 'D:\\c', ts: 4 }),
    ];
    const idx = buildProjectIndex(recs, { overrides: { a: { name: '  Alpha！ ', pinned: true }, b: { hidden: true, mergeInto: 'c' }, c: { mergeInto: 'a' } } });
    // c → a，b → c → a：全部并入 a
    expect(idx.list.map((p) => p.id)).toEqual(['a']);
    const a = idx.byId.get('a')!;
    expect(a).toMatchObject({ displayName: 'Alpha！', renamed: true, pinned: true, records: 4, firstTs: 1, lastTs: 4 });
    expect([...a.memberKeys].sort()).toEqual(['a', 'b', 'c']);
    expect([...(a.mergedFrom ?? [])].sort()).toEqual(['b', 'c']);
    expect(idx.idOfKey('b')).toBe('a');
    expect(idx.keysFor('a')!.length).toBe(3);
    // 环：a→b, b→a 不会死循环，也不会把项目吞没
    const cyc = buildProjectIndex(recs.slice(0, 3), { overrides: { a: { mergeInto: 'b' }, b: { mergeInto: 'a' } } });
    expect(cyc.list.map((p) => p.id)).toEqual(['a', 'b']); // 环被忽略，两个项目都保留
    // 隐藏只是标记
    const hid = buildProjectIndex(recs, { overrides: { b: { hidden: true } } });
    expect(hid.byId.get('b')!.hidden).toBe(true);
    expect(hid.list).toHaveLength(3);
    // 目标不存在：忽略
    const miss = buildProjectIndex(recs, { overrides: { a: { mergeInto: 'zzz' } } });
    expect(miss.list).toHaveLength(3);
  });
});

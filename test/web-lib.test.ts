import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ProjectItem } from '../web/src/api/types.ts';
import { makeT, translate } from '../web/src/i18n/index.ts';
import { zh } from '../web/src/i18n/zh.ts';
import { smoothPath, sparkPaths } from '../web/src/lib/curve.ts';
import { formatBytes, formatDelta, formatExact, formatPercent, formatRelative, formatTokenParts, formatTokens } from '../web/src/lib/format.ts';
import { filterProjects, findProject, navigationOrder, projectTooltip } from '../web/src/lib/projects.ts';
import { derivePill, scanPercent } from '../web/src/lib/statusPill.ts';
import type { PillInput } from '../web/src/lib/statusPill.ts';

const WEB_SRC = path.resolve(import.meta.dirname, '..', 'web', 'src');

describe('formatTokens：千分位 + 缩写（K/M/B/T，三位有效数字）', () => {
  it('小于 1 万：千分位精确值', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(59)).toBe('59');
    expect(formatTokens(8420)).toBe('8,420');
    expect(formatTokens(9999)).toBe('9,999');
  });

  it('K / M / B / T 缩写与进位', () => {
    expect(formatTokens(10_000)).toBe('10.0 K');
    expect(formatTokens(14_208)).toBe('14.2 K');
    expect(formatTokens(100_000)).toBe('100 K');
    expect(formatTokens(999_499)).toBe('999 K');
    expect(formatTokens(999_500)).toBe('1.00 M'); // 进位到下一档，不出现 "1000 K"
    expect(formatTokens(1_420_000)).toBe('1.42 M');
    expect(formatTokens(38_640_212)).toBe('38.6 M');
    expect(formatTokens(412_000_000)).toBe('412 M');
    expect(formatTokens(1_420_000_000)).toBe('1.42 B');
    expect(formatTokens(2_300_000_000)).toBe('2.30 B');
    expect(formatTokens(3.2e12)).toBe('3.20 T');
    expect(formatTokens(9_996_000)).toBe('10.0 M'); // 9.996 → 10.0，而不是 "10.00"
  });

  it('formatTokenParts 把数字与单位分开；无值 → —', () => {
    expect(formatTokenParts(1_420_000_000)).toEqual({ num: '1.42', unit: 'B' });
    expect(formatTokenParts(881_000)).toEqual({ num: '881', unit: 'K' });
    expect(formatTokenParts(null)).toEqual({ num: '—', unit: '' });
    expect(formatTokenParts(Number.NaN)).toEqual({ num: '—', unit: '' });
    expect(formatTokenParts(Number.POSITIVE_INFINITY)).toEqual({ num: '—', unit: '' });
    expect(formatTokenParts(-38_640_212)).toEqual({ num: '-38.6', unit: 'M' });
  });

  it('formatExact 千分位精确值', () => {
    expect(formatExact(1_284_300)).toBe('1,284,300');
    expect(formatExact(0)).toBe('0');
    expect(formatExact(undefined)).toBe('—');
  });

  it('百分比 / 环比：上期为 0 显示 —，绝不出现 NaN / ∞', () => {
    expect(formatPercent(0.943)).toBe('94.3%');
    expect(formatPercent(null)).toBe('—');
    expect(formatDelta(0.12)).toEqual({ text: '▲ 12%', dir: 'up' });
    expect(formatDelta(-0.08)).toEqual({ text: '▼ 8%', dir: 'down' });
    expect(formatDelta(0)).toEqual({ text: '0%', dir: 'flat' });
    expect(formatDelta(4756.09)).toEqual({ text: '▲ 999%+', dir: 'up' });
    expect(formatDelta(9.99)).toEqual({ text: '▲ 999%', dir: 'up' });
    expect(formatDelta(null)).toEqual({ text: '—', dir: 'none' });
    expect(formatDelta(Number.POSITIVE_INFINITY).text).toBe('—');
    expect(formatDelta(Number.NaN).text).toBe('—');
  });

  it('formatBytes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(296 * 1024 * 1024)).toBe('296 MB');
    expect(formatBytes(1.5 * 1024 ** 3)).toBe('1.50 GB');
  });
});

describe('相对时间', () => {
  const t = makeT('zh');
  const now = 1_700_000_000_000;
  it('刚刚 / 分钟 / 小时 / 昨天 / 天 / 周 / 月', () => {
    expect(formatRelative(now - 5_000, now, t)).toBe('刚刚');
    expect(formatRelative(now - 5 * 60_000, now, t)).toBe('5 分钟前');
    expect(formatRelative(now - 3 * 3600_000, now, t)).toBe('3 小时前');
    expect(formatRelative(now - 30 * 3600_000, now, t)).toBe('昨天');
    expect(formatRelative(now - 3 * 86400_000, now, t)).toBe('3 天前');
    expect(formatRelative(now - 15 * 86400_000, now, t)).toBe('2 周前');
    expect(formatRelative(now - 90 * 86400_000, now, t)).toBe('3 个月前');
    expect(formatRelative(now + 60_000, now, t)).toBe('刚刚'); // 未来时间不出现负数
    expect(formatRelative(null, now, t)).toBe('—');
  });
});

describe('曲线路径', () => {
  it('平滑路径以 M 起笔、每段一个 C；单点 / 空序列不崩溃', () => {
    const d = smoothPath([
      [0, 10],
      [10, 0],
      [20, 10],
    ]);
    expect(d.startsWith('M0.0 10.0 C')).toBe(true);
    expect(d.match(/C/g)?.length).toBe(2);
    expect(smoothPath([])).toBe('');
    expect(smoothPath([[1, 2]])).toBe('M1.0 2.0');
  });

  it('sparkPaths：min-max 归一化；全相等 → 平线；空 → 空串', () => {
    expect(sparkPaths([], 84, 22, 2)).toEqual({ line: '', area: '' });
    const flat = sparkPaths([5, 5, 5], 84, 22, 2);
    expect(flat.line.startsWith('M0.0 20.0')).toBe(true); // 全相等落在底部（h - pad）
    const up = sparkPaths([0, 10], 100, 20, 2);
    expect(up.line.startsWith('M0.0 18.0')).toBe(true);
    expect(up.line.endsWith('100.0 2.0')).toBe(true);
    expect(up.area.endsWith('L100 20 L0 20 Z')).toBe(true);
    expect(sparkPaths([3], 84, 22, 2).line).toContain('L84');
  });
});

function proj(id: string, name: string, p: string | null, extra: Partial<ProjectItem> = {}): ProjectItem {
  return {
    id,
    displayName: name,
    path: p,
    cwds: p ? [p] : [],
    pathUnknown: p === null,
    isScratchGroup: false,
    isScratch: false,
    requests: 1,
    total: 10,
    fresh: 5,
    value: 10,
    sparkline: [],
    todayRequests: 0,
    todayValue: 0,
    activeToday: false,
    lastActiveTs: null,
    firstTs: null,
    ...extra,
  };
}

describe('项目栏：搜索 / 遍历顺序 / 悬浮提示', () => {
  const kids = [proj('S1', 'scratch-2026-10-11-abc', 'C:\\x\\scratch-workspaces\\a\\b\\scratch-2026-10-11-abc', { isScratch: true }), proj('S2', 'scratch-2026-10-12-def', null, { isScratch: true })];
  const list = [
    proj('C--Users-----Work-demo', 'demo', 'C:\\Users\\王测试\\Work\\demo'),
    proj('D--Work-alpha', 'alpha', 'D:\\Work\\alpha', { cwds: ['D:\\Work\\alpha', 'D:\\Work\\alpha\\sub'] }),
    proj('scratch', 'Scratch', null, { isScratchGroup: true, children: kids }),
  ];

  it('空搜索原样返回；按名称 / 路径 / id / cwd 匹配，不区分大小写', () => {
    expect(filterProjects(list, '')).toHaveLength(3);
    expect(filterProjects(list, '  ')).toHaveLength(3);
    expect(filterProjects(list, 'DEMO').map((p) => p.id)).toEqual(['C--Users-----Work-demo']);
    expect(filterProjects(list, '王测试').map((p) => p.id)).toEqual(['C--Users-----Work-demo']);
    expect(filterProjects(list, 'alpha\\sub').map((p) => p.id)).toEqual(['D--Work-alpha']);
    expect(filterProjects(list, 'nomatch')).toEqual([]);
  });

  it('Scratch 组：子项匹配时只保留匹配的子项；组自身匹配时保留全部子项', () => {
    const r = filterProjects(list, 'def');
    expect(r.map((p) => p.id)).toEqual(['scratch']);
    expect(r[0]?.children?.map((c) => c.id)).toEqual(['S2']);
    const r2 = filterProjects(list, 'scratch');
    expect(r2.find((p) => p.id === 'scratch')?.children).toHaveLength(2);
  });

  it('findProject 同时查顶层与子项', () => {
    expect(findProject(list, 'S2')?.displayName).toBe('scratch-2026-10-12-def');
    expect(findProject(list, 'D--Work-alpha')?.displayName).toBe('alpha');
    expect(findProject(list, 'nope')).toBeUndefined();
    expect(findProject(undefined, 'x')).toBeUndefined();
  });

  it('navigationOrder：all 在最前；Scratch 展开时子项紧随其后', () => {
    expect(navigationOrder(list, false)).toEqual(['all', 'C--Users-----Work-demo', 'D--Work-alpha', 'scratch']);
    expect(navigationOrder(list, true)).toEqual(['all', 'C--Users-----Work-demo', 'D--Work-alpha', 'scratch', 'S1', 'S2']);
  });

  it('projectTooltip：完整路径；多个 cwd 逐行列出；无路径退回文件夹说明', () => {
    expect(projectTooltip(list[0]!, 'fallback')).toBe('C:\\Users\\王测试\\Work\\demo');
    expect(projectTooltip(list[1]!, 'fallback')).toBe('D:\\Work\\alpha\nD:\\Work\\alpha\\sub');
    expect(projectTooltip(proj('x', 'x', null), 'fallback')).toBe('fallback');
  });
});

describe('状态胶囊状态机', () => {
  const base: PillInput = { state: 'idle', phase: 'incremental', activity: 'idle', bytesDone: 0, bytesTotal: 0, filesDone: 0, filesTotal: 0, today: 1234 };

  it('首次全量扫描 → Scanning x%（按字节，退回按文件数）', () => {
    const v = derivePill({ ...base, state: 'scanning', phase: 'full', bytesDone: 41, bytesTotal: 100 }, 'open');
    expect(v).toMatchObject({ kind: 'scanning', tone: 'blue', pulse: true, percent: 41, today: null });
    expect(scanPercent({ bytesDone: 0, bytesTotal: 0, filesDone: 47, filesTotal: 112 })).toBe(41);
    expect(scanPercent({ bytesDone: 0, bytesTotal: 0, filesDone: 0, filesTotal: 0 })).toBe(0);
    expect(scanPercent({ bytesDone: 500, bytesTotal: 100, filesDone: 0, filesTotal: 0 })).toBe(100);
  });

  it('增量扫描（每 5 秒一次）不得让胶囊变成 Scanning：沿用 activity', () => {
    const v = derivePill({ ...base, state: 'scanning', phase: 'incremental', activity: 'generating', filesTotal: 0 }, 'open');
    expect(v).toMatchObject({ kind: 'generating', tone: 'green', pulse: true, today: 1234 });
    expect(derivePill({ ...base, state: 'scanning', phase: 'incremental', activity: 'idle' }, 'open')?.kind).toBe('idle');
  });

  it('activity → Live / Active / Idle；error → Error；连接断开 → Offline；无状态 → null', () => {
    expect(derivePill({ ...base, activity: 'generating' }, 'open')?.kind).toBe('generating');
    expect(derivePill({ ...base, activity: 'active' }, 'open')).toMatchObject({ kind: 'active', tone: 'blue', pulse: false });
    expect(derivePill(base, 'open')).toMatchObject({ kind: 'idle', tone: 'idle', pulse: false });
    expect(derivePill({ ...base, state: 'error' }, 'open')).toMatchObject({ kind: 'error', tone: 'pink', today: null });
    expect(derivePill(base, 'lost')).toMatchObject({ kind: 'offline', tone: 'amber' });
    expect(derivePill(null, 'connecting')).toBeNull();
  });
});

describe('i18n', () => {
  it('占位符插值；英文复数（单数 / 复数）', () => {
    expect(translate('zh', 'sidebar.allSub', { n: 7 })).toBe('7 个项目');
    expect(translate('en', 'time.minutesAgo', { n: 5 })).toBe('5 minutes ago');
    expect(translate('en', 'time.minutesAgo', { n: 1 })).toBe('1 minute ago');
    expect(translate('en', 'sidebar.allSub', { n: 1 })).toBe('1 project');
    expect(translate('en', 'sidebar.allSub', { n: 7 })).toBe('7 projects');
    expect(makeT('zh')('overview.subtitleOne', { sessions: 3, days: 2 })).toBe('3 个会话 · 活跃 2 天');
  });
});

// ---------------------------------------------------------------------------
// 静态审计：组件里不得硬编码中文字面量；源码里不得有外链
// ---------------------------------------------------------------------------

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n');
}

describe('前端源码审计', () => {
  const files = walk(WEB_SRC).filter((f) => /\.(tsx?|css)$/.test(f));

  it('除字典文件外，组件与逻辑代码里没有中文字面量（界面文案一律走 t()）', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const rel = path.relative(WEB_SRC, f).replaceAll('\\', '/');
      if (/^i18n\/(zh|en)[A-Z]?\.ts$/.test(rel)) continue; // 字典文件（zh / en，各分本体 / B / C 三份）
      const code = stripComments(fs.readFileSync(f, 'utf8'));
      if (/[\u3400-\u9fff\uff00-\uffef]/.test(code)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it('web/src、web/index.html、web/public 中没有外链（命名空间 URI 除外）', () => {
    const roots = [WEB_SRC, path.resolve(WEB_SRC, '..', 'public'), path.resolve(WEB_SRC, '..', 'index.html')];
    const bad: string[] = [];
    for (const r of roots) {
      const list = fs.statSync(r).isDirectory() ? walk(r) : [r];
      for (const f of list) {
        const txt = fs.readFileSync(f, 'utf8');
        for (const m of txt.matchAll(/https?:\/\/[^\s"'`)<>]+/g)) {
          if (!/^https?:\/\/www\.w3\.org\//.test(m[0])) bad.push(`${path.relative(WEB_SRC, f)}: ${m[0]}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('web/dist（若已构建）：除命名空间 URI 外没有外链；字体只有 woff2', () => {
    const dist = path.resolve(WEB_SRC, '..', 'dist');
    if (!fs.existsSync(dist)) return;
    const bad: string[] = [];
    const fonts: string[] = [];
    for (const f of walk(dist)) {
      const ext = path.extname(f).toLowerCase();
      if (ext === '.woff' || ext === '.ttf' || ext === '.otf') fonts.push(f);
      if (!['.js', '.css', '.html', '.svg', '.json'].includes(ext)) continue;
      const txt = fs.readFileSync(f, 'utf8');
      for (const m of txt.matchAll(/https?:\/\/[^\s"'`)<>\\]+/g)) {
        if (!/^https?:\/\/www\.w3\.org\//.test(m[0])) bad.push(`${path.relative(dist, f)}: ${m[0]}`);
      }
    }
    expect(bad).toEqual([]);
    expect(fonts).toEqual([]);
  });
});

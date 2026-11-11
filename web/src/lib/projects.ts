import type { ProjectItem } from '../api/types.ts';

/** 项目是否匹配搜索词（名称 / 路径 / id / 全部 cwd，不区分大小写）。 */
export function projectMatches(p: ProjectItem, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (needle === '') return true;
  return [p.displayName, p.path ?? '', p.id, ...p.cwds].some((x) => x.toLowerCase().includes(needle));
}

/**
 * 按搜索词过滤项目列表：Scratch 组自身匹配则保留全部子项，否则只保留匹配的子项（无匹配子项则整组隐藏）。
 * 与服务端 /api/projects?q= 的语义一致（侧栏在客户端过滤，输入时无需等待网络）。
 */
export function filterProjects(list: readonly ProjectItem[], q: string): ProjectItem[] {
  if (q.trim() === '') return [...list];
  const out: ProjectItem[] = [];
  for (const p of list) {
    if (p.children) {
      const groupMatch = projectMatches(p, q);
      const kids = groupMatch ? p.children : p.children.filter((c) => projectMatches(c, q));
      if (!groupMatch && kids.length === 0) continue;
      out.push({ ...p, children: kids });
    } else if (projectMatches(p, q)) out.push(p);
  }
  return out;
}

/** 在顶层与子项中按 id 查找。 */
export function findProject(list: readonly ProjectItem[] | undefined, id: string): ProjectItem | undefined {
  if (!list) return undefined;
  for (const p of list) {
    if (p.id === id) return p;
    const c = p.children?.find((x) => x.id === id);
    if (c) return c;
  }
  return undefined;
}

/** 键盘 ↑/↓ 的遍历顺序：all、各项目；Scratch 展开时其子项紧随其后。 */
export function navigationOrder(list: readonly ProjectItem[], expandedScratch: boolean): string[] {
  const ids = ['all'];
  for (const p of list) {
    ids.push(p.id);
    if (p.children && expandedScratch) for (const c of p.children) ids.push(c.id);
  }
  return ids;
}

/** 悬浮提示：完整路径（多个工作目录时逐行列出）。 */
export function projectTooltip(p: ProjectItem, fallbackFolder: string): string {
  const paths = [...(p.path ? [p.path] : []), ...p.cwds.filter((c) => c !== p.path)];
  return paths.length > 0 ? paths.join('\n') : fallbackFolder;
}

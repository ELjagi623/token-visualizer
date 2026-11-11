import { useBasis, useStore } from '../state/store.ts';
import type { ProjectsPayload } from './types.ts';
import { useApi } from './useApi.ts';

/** 项目列表（侧栏与页头共用同一份缓存）。排序在服务端完成，搜索在客户端过滤。 */
export function useProjects() {
  const sort = useStore((s) => s.sort);
  const basis = useBasis();
  return useApi<ProjectsPayload>(`/api/projects?sort=${sort}&basis=${basis}`);
}

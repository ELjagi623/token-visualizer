/**
 * 项目覆盖规则（重命名 / 隐藏 / 置顶）：存应用数据目录 project-overrides.json，绝不改动源数据。
 *
 * 键 = 项目文件夹 key（projectKey）；`scratch` 表示整个 Scratch 组（可置顶 / 隐藏，不可重命名）。
 * 隐藏的项目：其记录整体从聚合上下文里剔除（见 app.ts getCtx），因此"全部项目"合计、按项目分组、汇总、时间序列等
 * 一致地不再包含它，分组之和 = 合计。
 */
import type { AppDataWriter } from './core/safeFs.ts';
import { L } from './i18n.ts';

export interface OverrideEntry {
  name?: string;
  hidden?: boolean;
  pinned?: boolean;
}

export type OverrideMap = Record<string, OverrideEntry>;

export const OVERRIDES_FILE = 'project-overrides.json';
export const SCRATCH_ID = 'scratch';
const MAX_NAME = 80;
const MAX_ENTRIES = 5000;

export class OverrideError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = 'OverrideError';
    this.field = field;
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function cleanName(v: unknown, field: string): string {
  if (typeof v !== 'string') throw new OverrideError(field, '名称必须是文本');
  const t = v.trim();
  if (t.length === 0 || t.length > MAX_NAME) throw new OverrideError(field, L(`名称必须是 1–${MAX_NAME} 个字符`, `Name must be 1–${MAX_NAME} characters`));
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(t)) throw new OverrideError(field, L('名称不能包含控制字符', 'Name cannot contain control characters'));
  return t;
}

/** 规范化一条覆盖项：只保留有效的非默认字段（hidden / pinned 为 false 时省略）。 */
export function normalizeEntry(raw: unknown, field: string): OverrideEntry {
  if (!isObj(raw)) throw new OverrideError(field, '覆盖规则必须是对象');
  const out: OverrideEntry = {};
  for (const k of Object.keys(raw)) {
    if (k !== 'name' && k !== 'hidden' && k !== 'pinned') throw new OverrideError(`${field}.${k}`, `未知的字段：${k}`);
  }
  if (raw.name !== undefined && raw.name !== null) out.name = cleanName(raw.name, `${field}.name`);
  if (raw.hidden !== undefined) {
    if (typeof raw.hidden !== 'boolean') throw new OverrideError(`${field}.hidden`, 'hidden 必须是布尔值');
    if (raw.hidden) out.hidden = true;
  }
  if (raw.pinned !== undefined) {
    if (typeof raw.pinned !== 'boolean') throw new OverrideError(`${field}.pinned`, 'pinned 必须是布尔值');
    if (raw.pinned) out.pinned = true;
  }
  return out;
}

export class OverridesStore {
  private map: OverrideMap = {};
  /** 每次修改 +1（用于聚合上下文 / 响应缓存失效） */
  version = 0;
  warnings: string[] = [];
  private readonly writer: AppDataWriter;

  constructor(writer: AppDataWriter) {
    this.writer = writer;
  }

  async load(): Promise<void> {
    let buf: Buffer | null = null;
    try {
      buf = await this.writer.readFile(OVERRIDES_FILE);
    } catch (e) {
      this.warnings.push(L(`读取项目覆盖规则失败，已忽略：${(e as Error).message}`, `Could not read project overrides; ignored: ${(e as Error).message}`));
      return;
    }
    if (buf === null) return;
    try {
      const parsed = JSON.parse(buf.toString('utf8')) as unknown;
      const src = isObj(parsed) && isObj(parsed.overrides) ? parsed.overrides : {};
      const next: OverrideMap = {};
      for (const [k, v] of Object.entries(src)) {
        try {
          const e = normalizeEntry(v, k);
          if (Object.keys(e).length > 0) next[k] = e;
        } catch {
          this.warnings.push(L('项目覆盖规则中有一条无效，已忽略', 'An invalid project override was ignored'));
        }
      }
      this.map = next;
    } catch {
      this.warnings.push(L('项目覆盖规则文件已损坏，已忽略（下次保存时会覆盖）', 'The project overrides file is corrupted and was ignored (it will be overwritten on the next save)'));
    }
  }

  get(): OverrideMap {
    return structuredClone(this.map);
  }

  hiddenIds(): string[] {
    return Object.entries(this.map)
      .filter(([, v]) => v.hidden)
      .map(([k]) => k)
      .sort();
  }

  /**
   * 更新一个项目的覆盖项（部分更新）：`name: null` 清除重命名；`hidden: false` / `pinned: false` 清除对应标记。
   * isKnownId 由调用方提供（id 必须是现有项目文件夹或 scratch）。
   */
  async patch(id: string, patch: unknown, isKnownId: (id: string) => boolean): Promise<OverrideEntry> {
    if (typeof id !== 'string' || id.length === 0 || id.length > 600) throw new OverrideError('id', 'id 必须是项目 id');
    if (!isKnownId(id)) throw new OverrideError('id', L(`未知的项目：${id}`, `Unknown project: ${id}`));
    if (!isObj(patch)) throw new OverrideError('', '请求体必须是 JSON 对象');
    for (const k of Object.keys(patch)) if (k !== 'id' && k !== 'name' && k !== 'hidden' && k !== 'pinned') throw new OverrideError(k, `未知的字段：${k}`);
    if (id === SCRATCH_ID && patch.name !== undefined && patch.name !== null) throw new OverrideError('name', L('Scratch 组不能重命名', 'The Scratch group cannot be renamed'));
    const cur: OverrideEntry = { ...(this.map[id] ?? {}) };
    if ('name' in patch) {
      if (patch.name === null || patch.name === '') delete cur.name;
      else cur.name = cleanName(patch.name, 'name');
    }
    if ('hidden' in patch) {
      if (typeof patch.hidden !== 'boolean') throw new OverrideError('hidden', 'hidden 必须是布尔值');
      if (patch.hidden) cur.hidden = true;
      else delete cur.hidden;
    }
    if ('pinned' in patch) {
      if (typeof patch.pinned !== 'boolean') throw new OverrideError('pinned', 'pinned 必须是布尔值');
      if (patch.pinned) cur.pinned = true;
      else delete cur.pinned;
    }
    const next: OverrideMap = { ...this.map };
    if (Object.keys(cur).length === 0) delete next[id];
    else next[id] = cur;
    if (Object.keys(next).length > MAX_ENTRIES) throw new OverrideError('', L('覆盖规则过多', 'Too many override rules'));
    await this.writer.atomicWriteFile(OVERRIDES_FILE, `${JSON.stringify({ schema: 1, overrides: next }, null, 2)}\n`);
    this.map = next;
    this.version++;
    return { ...cur };
  }

  /** 恢复全部隐藏项目（保留重命名 / 置顶）。 */
  async unhideAll(): Promise<number> {
    const ids = this.hiddenIds();
    if (ids.length === 0) return 0;
    const next: OverrideMap = {};
    for (const [k, v] of Object.entries(this.map)) {
      const { hidden: _h, ...rest } = v;
      if (Object.keys(rest).length > 0) next[k] = rest;
    }
    await this.writer.atomicWriteFile(OVERRIDES_FILE, `${JSON.stringify({ schema: 1, overrides: next }, null, 2)}\n`);
    this.map = next;
    this.version++;
    return ids.length;
  }
}

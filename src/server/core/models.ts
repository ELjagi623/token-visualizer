/**
 * 模型名归一化。
 *
 * - `claude-opus-* / claude-sonnet-* / claude-haiku-*`（含 `-5`、`-5-5`、`-4-8`、带日期后缀等别名）→ 对应 family；
 *   默认按**原始名**分别统计（`id` = 原始名），`display` 是友好名（如 `Sonnet 5.5`）；
 * - 路径型（含路径分隔符的 `.gguf` 文件、`C:\...\x.gguf`）→ 取文件名、去 `.gguf`，量化后缀（`-Q4_K_M` 等）默认去除；本地；
 * - `org/name` 形（如 `qwen/qwen3-coder-next`）→ 本地，`display` 保持 `org/name`；
 * - 未知名 → family `other`，原样显示，不崩溃。
 */

export type ModelFamily = 'opus' | 'sonnet' | 'haiku' | 'local' | 'other';

export interface NormalizedModel {
  /** 原始名（去重 / 分组的键）。 */
  id: string;
  /** 用于显示的名称。 */
  display: string;
  family: ModelFamily;
  isLocal: boolean;
  /** 仅本地路径型：保留量化后缀的完整名（如 `Qwen3-35B-A3B-Q4_K_M`），供"显示量化后缀"选项使用。 */
  variant?: string;
}

export interface NormalizeOptions {
  /** 本地模型是否去掉量化后缀，默认 true。 */
  stripQuant?: boolean;
}

const FAMILY_LABEL: Record<ModelFamily, string> = {
  opus: 'Opus',
  sonnet: 'Sonnet',
  haiku: 'Haiku',
  local: 'Local',
  other: 'Other',
};

export function familyLabel(f: ModelFamily): string {
  return FAMILY_LABEL[f];
}

const QUANT_SUFFIX = /[-_.](?:i?q\d+(?:_[a-z0-9]+)*|f16|f32|bf16|fp16|fp8)$/i;

function stripQuantSuffix(name: string): string {
  let out = name;
  // 可能叠加（如 `-Q4_K_M-GGUF`）：循环剥离，但最多 2 次
  for (let i = 0; i < 2; i++) {
    const next = out.replace(/[-_.]gguf$/i, '').replace(QUANT_SUFFIX, '');
    if (next === out || next.length === 0) break;
    out = next;
  }
  return out;
}

function baseName(p: string): string {
  const parts = p.split(/[\\/]+/).filter((s) => s.length > 0);
  return parts.length > 0 ? parts[parts.length - 1]! : p;
}

function claudeDisplay(raw: string): string | undefined {
  const lower = raw.toLowerCase();
  // 新式：claude-<family>-<major>[-<minor>][-<date>]
  let m = /^claude-(opus|sonnet|haiku)-(\d{1,2})(?:-(\d{1,2}))?(?:-\d{6,8})?(?:\[.*\])?$/.exec(lower);
  if (m) return `${cap(m[1]!)} ${m[2]}${m[3] !== undefined ? `.${m[3]}` : ''}`;
  // 旧式：claude-<major>[-<minor>]-<family>[-<date>]
  m = /^claude-(\d{1,2})(?:-(\d{1,2}))?-(opus|sonnet|haiku)(?:-\d{6,8})?(?:\[.*\])?$/.exec(lower);
  if (m) return `${cap(m[3]!)} ${m[1]}${m[2] !== undefined ? `.${m[2]}` : ''}`;
  return undefined;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function normalizeModel(raw: string, options: NormalizeOptions = {}): NormalizedModel {
  const stripQuant = options.stripQuant ?? true;
  const id = typeof raw === 'string' ? raw : '';
  const trimmed = id.trim();
  if (trimmed.length === 0) return { id, display: 'unknown', family: 'other', isLocal: false };

  const lower = trimmed.toLowerCase();
  const fam = /^claude-(?:\d{1,2}(?:-\d{1,2})?-)?(opus|sonnet|haiku)\b/.exec(lower);
  if (fam && !/[\\/]/.test(trimmed)) {
    return { id, display: claudeDisplay(trimmed) ?? trimmed, family: fam[1] as ModelFamily, isLocal: false };
  }

  const hasBackslash = trimmed.includes('\\');
  const slashCount = (trimmed.match(/\//g) ?? []).length;
  const isGguf = lower.endsWith('.gguf');
  const looksLikePath = hasBackslash || slashCount >= 2 || /^[a-z]:/i.test(trimmed) || isGguf;
  if (looksLikePath) {
    let name = baseName(trimmed).replace(/\.gguf$/i, '');
    if (name.length === 0) name = trimmed;
    const stripped = stripQuantSuffix(name);
    return {
      id,
      display: stripQuant ? stripped : name,
      family: 'local',
      isLocal: true,
      ...(stripped !== name ? { variant: name } : {}),
    };
  }
  if (slashCount === 1) {
    // org/name（如 qwen/qwen3-coder-next）
    return { id, display: trimmed, family: 'local', isLocal: true };
  }
  if (lower === '<synthetic>') return { id, display: '<synthetic>', family: 'other', isLocal: false };
  if (lower === 'unknown') return { id, display: trimmed, family: 'other', isLocal: false };
  // 非 claude- 前缀的模型名（如 qwen3-coder-next-uncensored-heretic.i1、grok-4.7、gpt-4o、别名 sonnet）不是 Anthropic 的计费模型：
  // 一律视为本地 / 非 Anthropic 模型——成本不适用，显示"本地"，不进入"未计价"与成本占比。以 claude- 开头但无法识别的名字仍归 other（价格缺失时提示未计价）。
  if (!lower.startsWith('claude-')) return { id, display: trimmed, family: 'local', isLocal: true };
  return { id, display: trimmed, family: 'other', isLocal: false };
}

export interface ModelGroup {
  /** 分组键：不合并时 = 原始模型名；按家族合并时 = family。 */
  key: string;
  display: string;
  family: ModelFamily;
  isLocal: boolean;
}

/**
 * 分组函数：mergeFamilies = false → 每个原始名一组；true → 按家族（Opus / Sonnet / Haiku / 本地 / 其它）合并。
 * 家族合并只改变分组，不改变总量。
 */
export function modelGroupOf(raw: string, mergeFamilies: boolean, options: NormalizeOptions = {}): ModelGroup {
  const n = normalizeModel(raw, options);
  if (!mergeFamilies) return { key: n.id, display: n.display, family: n.family, isLocal: n.isLocal };
  return { key: n.family, display: familyLabel(n.family), family: n.family, isLocal: n.family === 'local' };
}

import { describe, expect, it } from 'vitest';
import { familyLabel, modelGroupOf, normalizeModel } from '../src/server/core/models.ts';

describe('normalizeModel', () => {
  it('路径型 gguf：display 为文件名去扩展名与量化后缀，isLocal=true，variant 保留量化后缀', () => {
    const n = normalizeModel('C:\\Users\\x\\Models\\Qwen3-35B-A3B-Q4_K_M.gguf');
    expect(n).toMatchObject({ display: 'Qwen3-35B-A3B', family: 'local', isLocal: true, variant: 'Qwen3-35B-A3B-Q4_K_M' });
    expect(n.id).toBe('C:\\Users\\x\\Models\\Qwen3-35B-A3B-Q4_K_M.gguf');
    // 选项：保留量化后缀
    expect(normalizeModel('C:\\Users\\x\\Models\\Qwen3-35B-A3B-Q4_K_M.gguf', { stripQuant: false }).display).toBe('Qwen3-35B-A3B-Q4_K_M');
  });

  it('各种量化后缀与路径写法', () => {
    expect(normalizeModel('/home/u/models/llama-3.1-8b-instruct.Q8_0.gguf').display).toBe('llama-3.1-8b-instruct');
    expect(normalizeModel('D:/m/Mistral-7B-IQ4_XS.gguf').display).toBe('Mistral-7B');
    expect(normalizeModel('D:\\m\\foo-bf16.gguf').display).toBe('foo');
    expect(normalizeModel('model.gguf')).toMatchObject({ display: 'model', isLocal: true });
    expect(normalizeModel('C:\\m\\plain-name').display).toBe('plain-name');
    // 不含量化后缀的名字不被误剥
    expect(normalizeModel('D:\\m\\Qwen3-Coder-30B.gguf').display).toBe('Qwen3-Coder-30B');
  });

  it('org/name 形（qwen/qwen3-coder-next）→ 本地，display 保持原样', () => {
    expect(normalizeModel('qwen/qwen3-coder-next')).toMatchObject({ display: 'qwen/qwen3-coder-next', family: 'local', isLocal: true });
  });

  it('claude 家族：含别名 / 日期后缀；默认按原始名区分，display 是友好名', () => {
    expect(normalizeModel('claude-sonnet-5-5')).toMatchObject({ display: 'Sonnet 5.5', family: 'sonnet', isLocal: false });
    expect(normalizeModel('claude-sonnet-5')).toMatchObject({ display: 'Sonnet 5', family: 'sonnet' });
    expect(normalizeModel('claude-opus-5-5')).toMatchObject({ display: 'Opus 5.5', family: 'opus' });
    expect(normalizeModel('claude-opus-5').display).toBe('Opus 5');
    expect(normalizeModel('claude-opus-4-8').display).toBe('Opus 4.8');
    expect(normalizeModel('claude-haiku-4-5-20251001')).toMatchObject({ display: 'Haiku 4.5', family: 'haiku' });
    expect(normalizeModel('claude-opus-4-20250514')).toMatchObject({ display: 'Opus 4', family: 'opus' });
    expect(normalizeModel('claude-3-5-sonnet-20241022')).toMatchObject({ display: 'Sonnet 3.5', family: 'sonnet' });
    expect(normalizeModel('claude-sonnet-5-5[1m]')).toMatchObject({ family: 'sonnet' });
    expect(normalizeModel('Claude-Sonnet-5-5').family).toBe('sonnet');
    // id 永远是原始名：不同别名各自是各自的分组键
    expect(normalizeModel('claude-sonnet-5').id).not.toBe(normalizeModel('claude-sonnet-5-5').id);
  });

  it('未知 / 空 / 怪异名字不崩溃，归 other', () => {
    // 非 claude- 前缀（无路径）一律视为本地 / 非 Anthropic 模型
    expect(normalizeModel('gpt-4o')).toMatchObject({ display: 'gpt-4o', family: 'local', isLocal: true });
    expect(normalizeModel('qwen3-coder-next-uncensored-heretic.i1')).toMatchObject({ family: 'local', isLocal: true });
    expect(normalizeModel('qwen/qwen3-coder-next')).toMatchObject({ family: 'local', isLocal: true });
    expect(normalizeModel('C:\m\Qwen3-Q4_K_M.gguf')).toMatchObject({ family: 'local', isLocal: true });
    expect(normalizeModel('')).toMatchObject({ display: 'unknown', family: 'other' });
    expect(normalizeModel('   ')).toMatchObject({ family: 'other' });
    expect(normalizeModel('unknown')).toMatchObject({ family: 'other' });
    expect(normalizeModel('claude-mystery-9')).toMatchObject({ family: 'other', isLocal: false });
    expect(normalizeModel('<synthetic>')).toMatchObject({ family: 'other', display: '<synthetic>' });
    expect(() => normalizeModel(undefined as unknown as string)).not.toThrow();
    expect(() => normalizeModel('\\\\')).not.toThrow();
    expect(() => normalizeModel('/')).not.toThrow();
    expect(() => normalizeModel('.gguf')).not.toThrow();
  });
});

describe('modelGroupOf', () => {
  it('不合并：键 = 原始名；合并：键 = 家族', () => {
    expect(modelGroupOf('claude-sonnet-5-5', false).key).toBe('claude-sonnet-5-5');
    expect(modelGroupOf('claude-sonnet-5-5', true)).toMatchObject({ key: 'sonnet', display: 'Sonnet', family: 'sonnet' });
    expect(modelGroupOf('claude-sonnet-5', true).key).toBe(modelGroupOf('claude-sonnet-5-5', true).key);
    expect(modelGroupOf('qwen/qwen3-coder-next', true)).toMatchObject({ key: 'local', isLocal: true });
    expect(modelGroupOf('C:\\a\\b.gguf', true).key).toBe('local');
    expect(modelGroupOf('gpt-4o', true).key).toBe('local');
    expect(modelGroupOf('claude-mystery-9', true).key).toBe('other');
    expect(familyLabel('local')).toBe('Local');
  });
});

/**
 * 设置保存：一处出口。PUT /api/settings → 成功后把返回的设置写回全局 store（版本号变化会让各页面的 useApi 自动重取），
 * 并在一个小 store 里记录"已保存 / 保存失败"，由设置页页头的 <SaveStatus /> 以 aria-live 展示。
 */
import { create } from 'zustand';
import { api } from '../../api/client.ts';
import { apiSend } from '../../api/clientC.ts';
import type { SettingsPayload } from '../../api/types.ts';
import { adoptLanguage, useStore } from '../../state/store.ts';

export type SaveKind = 'idle' | 'saving' | 'saved' | 'error';

interface SaveState {
  kind: SaveKind;
  message: string;
  at: number;
  set: (kind: SaveKind, message?: string) => void;
}

export const useSaveStatus = create<SaveState>((set) => ({
  kind: 'idle',
  message: '',
  at: 0,
  set: (kind, message = '') => set({ kind, message, at: Date.now() }),
}));

/** 从服务端重新读取设置并写回 store。 */
export async function reloadSettings(): Promise<SettingsPayload> {
  const p = await api.settings();
  useStore.setState({ settings: p, settingsVersion: p.version });
  adoptLanguage(p.settings.language);
  return p;
}

/** 保存设置补丁；成功返回新设置，失败返回 null（错误已记录在 useSaveStatus 里，field 供行内提示）。 */
export async function saveSettings(patch: Record<string, unknown>): Promise<{ ok: true; payload: SettingsPayload } | { ok: false; message: string }> {
  const st = useSaveStatus.getState();
  st.set('saving');
  try {
    const payload = await apiSend<SettingsPayload>('PUT', '/api/settings', patch);
    useStore.setState({ settings: payload, settingsVersion: payload.version });
    adoptLanguage(payload.settings.language);
    st.set('saved');
    return { ok: true, payload };
  } catch (e) {
    const message = (e as Error).message || 'error';
    st.set('error', message);
    return { ok: false, message };
  }
}

/** 通用的"写操作 + 记录状态"。 */
export async function runAction<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
  const st = useSaveStatus.getState();
  st.set('saving');
  try {
    const value = await fn();
    st.set('saved');
    return { ok: true, value };
  } catch (e) {
    const message = (e as Error).message || 'error';
    st.set('error', message);
    return { ok: false, message };
  }
}

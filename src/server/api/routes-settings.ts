/**
 * 路由：设置相关（数据根检测、时区列表）与项目管理（重命名 / 隐藏 / 置顶）。
 * 在 app.ts 里用 `registerSettingsRoutes(deps)` 一行注册。
 */
import type http from 'node:http';
import path from 'node:path';
import { listUsageFiles } from '../core/loadRoot.ts';
import type { SafeFs } from '../core/safeFs.ts';
import { systemTimeZone } from '../systemTz.ts';
import type { HiddenItem } from '../projectContext.ts';
import { isKnownProjectId } from '../projectContext.ts';
import type { AppContext } from '../projectContext.ts';
import type { OverridesStore } from '../overrides.ts';
import { assertDataRootCompatible, SettingsError, validateDataRoot } from '../settings.ts';
import { badRequest } from './errors.ts';
import { readJsonBody, requireJson } from './security.ts';
import { rejectUnknown } from './params.ts';
import { L } from '../i18n.ts';

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => void | Promise<void>;

export interface SettingsRouteDeps {
  route: (path: string, method: string, h: Handler, autoHead?: boolean) => void;
  sendJson: (res: http.ServerResponse, status: number, body: string, extra?: Record<string, string>) => void;
  fs: SafeFs;
  appDataDir: string;
  overrides: OverridesStore;
  getCtx: () => AppContext;
  /** 价格 / 覆盖规则变化后：清响应缓存 + 通知前端重取 */
  changed: () => void;
}

export function overridesPayload(overrides: OverridesStore, hidden: HiddenItem[]): unknown {
  return { overrides: overrides.get(), hidden, hiddenCount: hidden.length, version: overrides.version, warnings: overrides.warnings };
}

export function registerSettingsRoutes(d: SettingsRouteDeps): void {
  const { route, sendJson } = d;

  // 检测数据根：只读目录，不改任何设置；非法路径返回 ok:false + 中文原因（200）
  route('/api/settings/validate-root', 'POST', async (req, res) => {
    requireJson(req);
    const body = await readJsonBody(req);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw badRequest('INVALID_BODY', '请求体必须是 JSON 对象');
    for (const k of Object.keys(body)) if (k !== 'path') throw badRequest('INVALID_BODY', `未知的字段：${k}`);
    const p = (body as { path?: unknown }).path;
    if (typeof p !== 'string' || p.trim().length === 0 || p.length > 1000 || p.includes('\0')) throw badRequest('INVALID_BODY', 'path 必须是非空路径文本');
    if (!path.isAbsolute(p.trim())) {
      sendJson(res, 200, JSON.stringify({ ok: false, message: L('请填写绝对路径（例如 C:\\Users\\你\\.claude\\projects）', 'Enter an absolute path (for example C:\\Users\\you\\.claude\\projects)') }));
      return;
    }
    try {
      const abs = await validateDataRoot(d.fs, p.trim());
      assertDataRootCompatible(abs, d.appDataDir);
      const files = await listUsageFiles(abs, d.fs);
      const folders = new Set(files.map((f) => f.projectKey));
      sendJson(res, 200, JSON.stringify({ ok: true, path: abs, projectFolders: folders.size, sessionFiles: files.length }));
    } catch (e) {
      if (e instanceof SettingsError) sendJson(res, 200, JSON.stringify({ ok: false, message: e.message }));
      else sendJson(res, 200, JSON.stringify({ ok: false, message: L(`无法读取该目录：${(e as Error).message}`, `Cannot read this folder: ${(e as Error).message}`) }));
    }
  });

  route('/api/timezones', 'GET', (_req, res, url) => {
    rejectUnknown(url.searchParams, []);
    let zones: string[] = [];
    try {
      zones = (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf('timeZone');
    } catch {
      zones = [];
    }
    if (!zones.includes('UTC')) zones = ['UTC', ...zones];
    sendJson(res, 200, JSON.stringify({ system: systemTimeZone(), timezones: zones }));
  });

  route('/api/project-overrides', 'GET', (_req, res, url) => {
    rejectUnknown(url.searchParams, []);
    sendJson(res, 200, JSON.stringify(overridesPayload(d.overrides, d.getCtx().hidden)));
  });
  route('/api/project-overrides', 'PUT', async (req, res) => {
    requireJson(req);
    const body = await readJsonBody(req);
    const id = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as { id?: unknown }).id : undefined;
    if (typeof id !== 'string') throw badRequest('INVALID_BODY', '请求体需要 id（项目 id）');
    await d.overrides.patch(id, body, (x) => isKnownProjectId(d.getCtx(), x));
    d.changed();
    sendJson(res, 200, JSON.stringify(overridesPayload(d.overrides, d.getCtx().hidden)));
  });
  route('/api/project-overrides/unhide-all', 'POST', async (_req, res) => {
    await d.overrides.unhideAll();
    d.changed();
    sendJson(res, 200, JSON.stringify(overridesPayload(d.overrides, d.getCtx().hidden)));
  });
}

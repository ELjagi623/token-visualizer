/**
 * Electron 主进程：在进程内直接启动现有的本地服务（src/server），再用一个独立窗口加载它的地址。
 *
 *   npm run app      开发：构建后以独立窗口运行
 *   npm run dist     打包 Windows 安装包 / 免安装版
 *
 * 与命令行版（npm start / start.cmd）共用同一份设置与缓存（%APPDATA%\TokenVisualizer），数据根仍然只读。
 * 环境变量（与命令行版一致）：TV_PORT 起始端口、TV_DATA_ROOT 数据根、TV_APPDATA_DIR 应用数据目录。
 *
 * 注意：窗口必须加载服务自己的 http://127.0.0.1:<端口>——服务会校验 Host / Origin，
 * 前端的 localStorage 偏好也按来源（含端口）隔离，所以端口要尽量稳定（默认 47821，被占用才顺延）。
 */
import { app, BrowserWindow, dialog, Menu, session, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { createApp, DEFAULT_PORT } from '../src/server/app.ts';
import type { App } from '../src/server/app.ts';
import { defaultAppDataDir, defaultDataRoot } from '../src/server/core/paths.ts';

const APP_NAME = 'Token Visualizer';

/** 窗口位置 / 大小的持久化（只存在 Electron 自己的 userData 目录里，不碰设置与缓存文件）。 */
interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  maximized: boolean;
}

const DEFAULT_STATE: WindowState = { width: 1280, height: 820, maximized: false };

function stateFile(): string {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function loadState(): WindowState {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(), 'utf8')) as Partial<WindowState>;
    const ok = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
    if (!ok(raw.width) || !ok(raw.height) || raw.width < 600 || raw.height < 400) return DEFAULT_STATE;
    return { width: raw.width, height: raw.height, x: ok(raw.x) ? raw.x : undefined, y: ok(raw.y) ? raw.y : undefined, maximized: raw.maximized === true };
  } catch {
    return DEFAULT_STATE;
  }
}

function saveState(win: BrowserWindow): void {
  try {
    const maximized = win.isMaximized();
    const b = maximized ? win.getNormalBounds() : win.getBounds();
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
    fs.writeFileSync(stateFile(), JSON.stringify({ width: b.width, height: b.height, x: b.x, y: b.y, maximized }));
  } catch {
    // 记不住窗口大小不影响使用
  }
}

/** 前端构建目录：打包后在 resources/web；开发时在项目的 web/dist。 */
function resolveWebDir(): string {
  return app.isPackaged ? path.join(process.resourcesPath, 'web') : path.resolve(__dirname, '..', 'web', 'dist');
}

function resolveIcon(): string | undefined {
  const p = app.isPackaged ? path.join(process.resourcesPath, 'icon.png') : path.resolve(__dirname, '..', 'desktop', 'icon.png');
  return fs.existsSync(p) ? p : undefined;
}

// 把 Electron 自己的缓存（Cache / GPUCache / Local Storage 等）放进应用数据目录下的 electron 子目录：
// 和命令行版共用同一个 %APPDATA%\TokenVisualizer，但不和 settings.json / 缓存文件混在一起。必须在 ready 之前设置。
const appDataDir = defaultAppDataDir();
app.setPath('userData', path.join(appDataDir, 'electron'));
app.setAppUserModelId('com.tokenvisualizer.app');

let server: App | null = null;
let mainWindow: BrowserWindow | null = null;
let quitting = false;

function isInternal(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

function openExternalSafe(url: string): void {
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') void shell.openExternal(u.toString());
  } catch {
    // 非法地址：忽略
  }
}

function createWindow(url: string): BrowserWindow {
  const st = loadState();
  const origin = new URL(url).origin;
  const win = new BrowserWindow({
    width: st.width,
    height: st.height,
    x: st.x,
    y: st.y,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: APP_NAME,
    icon: resolveIcon(),
    backgroundColor: '#14181b',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });

  win.once('ready-to-show', () => {
    if (st.maximized) win.maximize();
    win.show();
  });

  // 只允许在本服务的来源内导航；其它链接交给系统浏览器
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (!isInternal(target, origin)) openExternalSafe(target);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, target) => {
    if (!isInternal(target, origin)) {
      e.preventDefault();
      openExternalSafe(target);
    }
  });

  // 没有菜单栏时保留最常用的几个快捷键：刷新、开发者工具
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const ctrl = input.control || input.meta;
    if (input.key === 'F5' || (ctrl && input.key.toLowerCase() === 'r')) {
      e.preventDefault();
      win.webContents.reload();
    } else if (input.key === 'F12' || (ctrl && input.shift && input.key.toLowerCase() === 'i')) {
      e.preventDefault();
      win.webContents.toggleDevTools();
    }
  });

  win.on('close', () => saveState(win));
  win.on('closed', () => {
    mainWindow = null;
  });

  void win.loadURL(url);
  return win;
}

async function boot(): Promise<void> {
  const portRaw = process.env.TV_PORT;
  const port = portRaw !== undefined && portRaw !== '' && Number.isInteger(Number(portRaw)) ? Number(portRaw) : DEFAULT_PORT;
  try {
    server = await createApp({ dataRoot: defaultDataRoot(), appDataDir, port, webDir: resolveWebDir() });
  } catch (e) {
    dialog.showErrorBox(`${APP_NAME} 启动失败`, `无法启动本地服务：${(e as Error).message}`);
    app.exit(1);
    return;
  }
  if (server.port !== port && port !== 0) console.log(`端口 ${port} 已被占用，改用 ${server.port}（界面偏好可能需要重新设置）。`);

  // 本应用不需要任何浏览器权限（摄像头 / 定位 / 通知等）
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  Menu.setApplicationMenu(null);
  mainWindow = createWindow(server.url);
}

if (!app.requestSingleInstanceLock()) {
  // 已经有一个实例在运行：它会收到 second-instance 并把窗口拉到前台
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.on('window-all-closed', () => app.quit());

  // 退出前先关掉本地服务（释放端口、停止文件监听）
  app.on('before-quit', (e) => {
    if (quitting || server === null) return;
    e.preventDefault();
    quitting = true;
    const s = server;
    server = null;
    setTimeout(() => app.exit(0), 3000).unref();
    void s
      .close()
      .catch(() => undefined)
      .finally(() => app.exit(0));
  });

  void app.whenReady().then(boot);
}

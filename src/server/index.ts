/**
 * 服务入口：`npm start` / 双击 start.cmd。
 *
 *   node src/server/index.ts [--no-open] [--port <n>]
 *
 * 环境变量：
 *   TV_PORT          起始端口（默认 47821，被占用则向后顺延）
 *   TV_DATA_ROOT     数据根目录（默认 ~/.claude/projects；设置页里的 dataRoot 优先）
 *   TV_APPDATA_DIR   应用数据目录（缓存、设置；默认 %APPDATA%\TokenVisualizer）
 *   TV_NOW           固定"当前时间"（ISO 字符串或毫秒数，仅测试用）
 *   TV_NO_OPEN=1     等价于 --no-open
 *
 * 数据根只读；缓存与设置只写应用数据目录。
 */
import { spawn } from 'node:child_process';
import { createApp, DEFAULT_PORT } from './app.ts';
import { defaultAppDataDir, defaultDataRoot } from './core/paths.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function parseNow(v: string | undefined): (() => number) | undefined {
  if (v === undefined || v === '') return undefined;
  const ms = /^\d+$/.test(v) ? Number(v) : Date.parse(v);
  if (!Number.isFinite(ms)) {
    console.error(`环境变量 TV_NOW 不是有效的时间：${v}`);
    process.exit(2);
  }
  return () => ms;
}

function openBrowser(url: string): void {
  try {
    if (process.platform === 'win32') {
      // start 的第一个带引号参数是窗口标题，所以给一个空标题；URL 只含 ASCII
      spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    // 打不开浏览器不影响服务
  }
}

const noOpen = process.argv.includes('--no-open') || process.env.TV_NO_OPEN === '1';
const portRaw = arg('--port') ?? process.env.TV_PORT;
const port = portRaw === undefined || portRaw === '' ? DEFAULT_PORT : Number(portRaw);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`端口号不合法：${String(portRaw)}（应为 0–65535 的整数）`);
  process.exit(2);
}

const dataRoot = defaultDataRoot();
const appDataDir = defaultAppDataDir();

console.log('Token Visualizer');
console.log(`数据根（只读）：${dataRoot}`);
console.log(`应用数据目录：${appDataDir}`);

let app;
try {
  app = await createApp({ dataRoot, appDataDir, port, now: parseNow(process.env.TV_NOW) });
} catch (e) {
  console.error(`启动失败：${(e as Error).message}`);
  process.exit(1);
}

if (app.port !== port && port !== 0) console.log(`端口 ${port} 已被占用，改用 ${app.port}。`);
// 一次写出，保证地址与"关闭窗口即退出"提示同时到达（管道另一端不会只读到一半）
console.log(`
  已启动：${app.url}
  关闭此窗口（或按 Ctrl+C）即退出。
`);

// 数据根不可读时在控制台给出原因（双击 start.cmd 的用户只看得到这个窗口）；恢复后再提示一次
let lastSettled = '';
const report = (state: string, lastError?: string): void => {
  if (state === 'scanning') return;
  if (state === 'error' && lastSettled !== 'error') console.warn(`提示：${lastError ?? '数据根目录不可读'}`);
  else if (state === 'idle' && lastSettled === 'error') console.log('数据根目录已恢复可读取，已开始统计。');
  lastSettled = state;
};
app.store.onChange((e) => report(e.status.state, e.status.lastError));
{
  const st = app.store.getStatus();
  report(st.state, st.lastError);
}

if (!noOpen) openBrowser(app.url);

let stopping = false;
const stop = (): void => {
  if (stopping) return;
  stopping = true;
  void app.close().finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
process.on('SIGBREAK', stop);

/**
 * 桌面 APP 冒烟测试：用 Playwright 启动真正的 Electron 窗口（隔离的应用数据目录 + 夹具数据），检查
 *   1. 窗口正常出现、加载的是本服务的 127.0.0.1 地址、页面渲染出内容；
 *   2. 渲染进程里没有 Node 能力（沙箱 / 隔离生效）；
 *   3. 第二次启动会被单实例锁挡住（立即退出，不另起服务）；
 *   4. 关闭窗口后本地服务端口被释放。
 *
 *   npm run build && npm run build:desktop && node scripts/desktop-smoke.mjs [截图输出路径]
 *
 * 设置环境变量 TV_DESKTOP_EXE=<打包后的 exe 路径>（如 release/win-unpacked/Token Visualizer.exe）可改为测试打包产物；
 * 此时会把 PATH 里的 Node.js 目录去掉，验证应用不依赖本机安装的 Node。
 */
import { _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const main = path.join(root, 'dist-desktop', 'main.cjs');
const shot = process.argv[2];
const PORT = 47993;

const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-desktop-smoke-'));
const env = {
  ...process.env,
  TV_APPDATA_DIR: appData,
  TV_DATA_ROOT: path.join(root, 'test', 'fixtures', 'projects'),
  TV_PORT: String(PORT),
  TV_NOW: undefined,
};
delete env.TV_NOW;

const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`${ok ? '通过' : '失败'}  ${name}${extra ? `  ${extra}` : ''}`);
};

const portOpen = (port) =>
  new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.once('error', () => resolve(false));
  });

let code = 0;
const exe = process.env.TV_DESKTOP_EXE;
if (exe) {
  const nodeDir = path.dirname(process.execPath).toLowerCase();
  env.PATH = (process.env.PATH ?? '').split(path.delimiter).filter((p) => p.toLowerCase() !== nodeDir && !/nodejs/i.test(p)).join(path.delimiter);
  console.log(`测试打包产物：${exe}（PATH 中已去掉 Node.js）`);
}
const launchOpts = exe ? { executablePath: exe, args: [], env } : { args: [main], env };
const app = await electron.launch(launchOpts);
try {
  const win = await app.firstWindow();
  await win.waitForSelector('[data-testid="content"][data-ready="true"]', { timeout: 30_000 });

  check('窗口加载的是本地服务地址', win.url().startsWith(`http://127.0.0.1:${PORT}/`), win.url());
  check('窗口标题', (await win.title()).includes('Token Visualizer'), await win.title());
  check('页面渲染出总览内容', (await win.locator('[data-testid="page-title"]').count()) > 0);

  const node = await win.evaluate(() => ({ require: typeof window.require, process: typeof window.process }));
  check('渲染进程里没有 Node 能力', node.require === 'undefined' && node.process === 'undefined', JSON.stringify(node));

  const status = await win.evaluate(async () => (await fetch('/api/status')).status);
  check('API 可访问', status === 200, String(status));

  if (shot) {
    fs.mkdirSync(path.dirname(shot), { recursive: true });
    await win.screenshot({ path: shot });
    console.log(`截图：${shot}`);
  }

  // 单实例：第二个进程应当立即退出
  const second = await electron.launch(launchOpts).catch(() => null);
  if (second) {
    const exited = await Promise.race([new Promise((r) => second.process().once('exit', () => r(true))), new Promise((r) => setTimeout(() => r(false), 10_000))]);
    check('第二次启动被单实例锁挡住（立即退出）', exited === true);
    if (!exited) await second.close().catch(() => undefined);
  } else {
    check('第二次启动被单实例锁挡住（立即退出）', true, '（启动被拒绝）');
  }
  check('服务仍然在运行（没有被第二个实例干扰）', await portOpen(PORT));
} catch (e) {
  console.error(e);
  code = 1;
} finally {
  await app.close().catch(() => undefined);
}

// 关闭窗口 / 退出后端口应被释放
await new Promise((r) => setTimeout(r, 1500));
check('退出后端口已释放', !(await portOpen(PORT)));
fs.rmSync(appData, { recursive: true, force: true });

if (code !== 0 || results.includes(false)) process.exit(1);
console.log('桌面 APP 冒烟测试全部通过');

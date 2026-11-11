import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FIXTURE_ROOT, makeTmpDir, rmDir } from './helpers.ts';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';

interface Run {
  child: ChildProcess;
  out: () => string;
  err: () => string;
  exited: Promise<number | null>;
}

function runCmd(startCmd: string, args: string[], env: Record<string, string | undefined>, cwd?: string): Run {
  let out = '';
  let err = '';
  // /s /c "..."：保留整条命令行的引号，路径含空格 / 中文时也安全
  const child = spawn('cmd.exe', ['/d', '/s', '/c', `""${startCmd}" ${args.join(' ')}"`], {
    windowsVerbatimArguments: true,
    env: { ...process.env, ...env },
    cwd,
    windowsHide: true,
  });
  child.stdout!.on('data', (d: Buffer) => (out += d.toString('utf8')));
  child.stderr!.on('data', (d: Buffer) => (err += d.toString('utf8')));
  const exited = new Promise<number | null>((resolve) => child.on('close', (c) => resolve(c)));
  return { child, out: () => out, err: () => err, exited };
}

function killTree(child: ChildProcess): void {
  if (child.pid) {
    try {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      // 已退出
    }
  }
}

async function waitForUrl(run: Run, ms = 15000): Promise<string> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const m = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(run.out());
    if (m) return m[0];
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`没有等到服务地址，输出：${run.out()}${run.err()}`);
}

const baseEnv = (appData: string): Record<string, string> => ({ TV_DATA_ROOT: FIXTURE_ROOT, TV_APPDATA_DIR: appData, TV_PORT: '0', TV_NO_PAUSE: '1', TV_NO_OPEN: '1' });

describe.skipIf(!isWin)('start.cmd（双击启动，验收 8）', () => {
  it('cmd /c start.cmd 拉起服务：打印访问地址与"关闭窗口即退出"，API 可访问', async () => {
    const tmp = makeTmpDir('tv-start-');
    const run = runCmd(path.join(repo, 'start.cmd'), ['--no-open'], baseEnv(path.join(tmp, 'app')), repo);
    try {
      const url = await waitForUrl(run);
      expect(run.out()).toContain('已启动');
      expect(run.out()).toContain('关闭此窗口');
      expect(run.out()).toContain(FIXTURE_ROOT);
      const r = await fetch(`${url}api/status`);
      expect(r.status).toBe(200);
      expect(((await r.json()) as { state: string }).state).toMatch(/idle|scanning/);
      expect((await fetch(url)).status).toBe(200); // 没有 web/dist 时是中文提示页
    } finally {
      killTree(run.child);
      await run.exited;
      rmDir(tmp);
    }
  }, 60_000);

  it('端口被占用时自动顺延，并在窗口里提示', async () => {
    const net = await import('node:net');
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()));
    const busy = (blocker.address() as import('node:net').AddressInfo).port;
    const tmp = makeTmpDir('tv-start-');
    const run = runCmd(path.join(repo, 'start.cmd'), ['--no-open'], { ...baseEnv(path.join(tmp, 'app')), TV_PORT: String(busy) }, repo);
    try {
      const url = await waitForUrl(run);
      const port = Number(/:(\d+)\//.exec(url)![1]);
      expect(port).toBeGreaterThan(busy);
      expect(run.out()).toContain(`端口 ${busy} 已被占用`);
      expect((await fetch(`${url}api/status`)).status).toBe(200);
    } finally {
      killTree(run.child);
      await run.exited;
      blocker.close();
      rmDir(tmp);
    }
  }, 60_000);

  it('路径含空格与中文时也能启动（把脚本与源码复制到 "中文 目录\\Token visualizer"）', async () => {
    const tmp = makeTmpDir('tv-start-');
    const dir = path.join(tmp, '中文 目录', 'Token visualizer');
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(repo, 'start.cmd'), path.join(dir, 'start.cmd'));
    fs.copyFileSync(path.join(repo, 'package.json'), path.join(dir, 'package.json'));
    fs.cpSync(path.join(repo, 'src'), path.join(dir, 'src'), { recursive: true });
    const run = runCmd(path.join(dir, 'start.cmd'), ['--no-open'], baseEnv(path.join(tmp, '应用 数据')), tmp);
    try {
      const url = await waitForUrl(run);
      expect((await fetch(`${url}api/status`)).status).toBe(200);
      expect(run.out()).toContain('已启动');
      expect(run.out()).toContain('应用 数据');
    } finally {
      killTree(run.child);
      await run.exited;
      rmDir(tmp);
    }
  }, 60_000);

  it('没有安装 Node.js：给出中文引导并以非 0 退出', async () => {
    const run = runCmd(path.join(repo, 'start.cmd'), [], { TV_NO_PAUSE: '1', PATH: path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32') }, repo);
    const code = await run.exited;
    expect(code).toBe(1);
    expect(run.out()).toContain('没有检测到 Node.js');
    expect(run.out()).toContain('nodejs.org');
    expect(run.out()).toContain('22.18');
  }, 30_000);

  it('Node 版本过低：给出中文提示（用 TV_MIN_NODE 模拟）', async () => {
    const run = runCmd(path.join(repo, 'start.cmd'), [], { TV_NO_PAUSE: '1', TV_MIN_NODE: '99.1', TV_NO_OPEN: '1' }, repo);
    const code = await run.exited;
    expect(code).toBe(1);
    expect(run.out()).toContain('版本过低');
    expect(run.out()).toContain('99.1');
    expect(run.out()).toContain('当前版本');
  }, 30_000);

  it('start.cmd 是纯 ASCII + CRLF（cmd.exe 解析多字节文本会错位），中文提示在 scripts/messages/*.txt；start.ps1 带 UTF-8 BOM', () => {
    const cmd = fs.readFileSync(path.join(repo, 'start.cmd'));
    const text = cmd.toString('latin1');
    expect(text.includes(String.fromCharCode(13, 10))).toBe(true);
    expect(text.split(String.fromCharCode(13, 10)).join('').includes(String.fromCharCode(10))).toBe(false); // 没有裸 LF
    expect([...cmd].every((b) => b < 128)).toBe(true);
    for (const f of ['no-node.txt', 'old-node.txt', 'exit-error.txt']) {
      const txt = fs.readFileSync(path.join(repo, 'scripts', 'messages', f), 'utf8');
      expect(/[一-鿿]/.test(txt), f).toBe(true);
    }
    const ps1 = fs.readFileSync(path.join(repo, 'start.ps1'));
    expect([ps1[0], ps1[1], ps1[2]]).toEqual([0xef, 0xbb, 0xbf]);
  });

  it('start.ps1 同样能启动服务（PowerShell）', async () => {
    const tmp = makeTmpDir('tv-start-');
    let out = '';
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(repo, 'start.ps1'), '--no-open'], {
      env: { ...process.env, ...baseEnv(path.join(tmp, 'app')) },
      windowsHide: true,
    });
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    const exited = new Promise<void>((r) => child.on('close', () => r()));
    try {
      const t0 = Date.now();
      let url = '';
      while (Date.now() - t0 < 20000 && !url) {
        const m = /http:\/\/127\.0\.0\.1:\d+\//.exec(out);
        if (m) url = m[0];
        else await new Promise((r) => setTimeout(r, 100));
      }
      expect(url, out).not.toBe('');
      expect((await fetch(`${url}api/status`)).status).toBe(200);
    } finally {
      killTree(child);
      await exited;
      rmDir(tmp);
    }
  }, 60_000);
});

describe('npm start / node src/server/index.ts（跨平台）', () => {
  it('--no-open 启动：打印地址；非法端口 / 非法 TV_NOW 给出中文错误并非 0 退出', async () => {
    const tmp = makeTmpDir('tv-start-');
    try {
      const bad = spawn(process.execPath, ['src/server/index.ts', '--no-open', '--port', 'abc'], { cwd: repo, env: { ...process.env, ...baseEnv(path.join(tmp, 'a')) } });
      let e1 = '';
      bad.stderr.on('data', (d: Buffer) => (e1 += d.toString()));
      expect(await new Promise((r) => bad.on('close', r))).toBe(2);
      expect(e1).toContain('端口号不合法');
      const bad2 = spawn(process.execPath, ['src/server/index.ts', '--no-open'], { cwd: repo, env: { ...process.env, ...baseEnv(path.join(tmp, 'a')), TV_NOW: 'not-a-date' } });
      let e2 = '';
      bad2.stderr.on('data', (d: Buffer) => (e2 += d.toString()));
      expect(await new Promise((r) => bad2.on('close', r))).toBe(2);
      expect(e2).toContain('TV_NOW');
    } finally {
      rmDir(tmp);
    }
  }, 30_000);

  it('TV_NOW 固定当前时间：/api/status 的 serverNow 与 today 按它计算', async () => {
    const tmp = makeTmpDir('tv-start-');
    let out = '';
    const child = spawn(process.execPath, ['src/server/index.ts', '--no-open'], { cwd: repo, env: { ...process.env, ...baseEnv(path.join(tmp, 'a')), TV_NOW: '2026-10-20T12:00:00Z' } });
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    try {
      const t0 = Date.now();
      let url = '';
      while (Date.now() - t0 < 15000 && !url) {
        const m = /http:\/\/127\.0\.0\.1:\d+\//.exec(out);
        if (m) url = m[0];
        else await new Promise((r) => setTimeout(r, 50));
      }
      expect(url).not.toBe('');
      const s = (await (await fetch(`${url}api/status`)).json()) as { serverNow: number };
      expect(s.serverNow).toBe(Date.parse('2026-10-20T12:00:00Z'));
    } finally {
      child.kill();
      await new Promise((r) => child.on('close', r));
      rmDir(tmp);
    }
  }, 30_000);
});

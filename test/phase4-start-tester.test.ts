/**
 * 阶段 4 启动相关独立测试（测试工程师编写）：npm start 等价入口、端口顺延、TV_PORT、监听地址（netstat）、
 * start.cmd / start.ps1（Node 缺失 / 过旧的中文提示、ASCII+CRLF、含空格与中文与特殊字符的路径）。
 * Windows 专用用例在其它平台自动跳过。
 */
import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FIXTURE_ROOT, makeTmpDir, rmDir } from './helpers.ts';

const PROJECT = path.resolve(path.dirname(FIXTURE_ROOT), '..', '..');
const WIN = process.platform === 'win32';
const bases: string[] = [];
const children = new Set<ChildProcess>();
afterAll(() => {
  for (const c of children) killTree(c);
  for (const b of bases) rmDir(b);
});

function killTree(c: ChildProcess): void {
  if (c.pid === undefined || c.exitCode !== null) return;
  try {
    if (WIN) execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
    else c.kill('SIGKILL');
  } catch {
    /* 已退出 */
  }
}

interface Running {
  child: ChildProcess;
  out: () => string;
  url: Promise<string>;
  exited: Promise<number | null>;
}
function run(cmd: string, args: string[], env: Record<string, string | undefined>, opts: { verbatim?: boolean; cwd?: string } = {}): Running {
  const child = spawn(cmd, args, { env: { ...process.env, ...env } as NodeJS.ProcessEnv, windowsVerbatimArguments: opts.verbatim, windowsHide: true, cwd: opts.cwd });
  children.add(child);
  let out = '';
  const chunks: Buffer[] = [];
  const onData = (d: Buffer): void => {
    chunks.push(d);
    out = Buffer.concat(chunks).toString('utf8');
  };
  child.stdout!.on('data', onData);
  child.stderr!.on('data', onData);
  const url = new Promise<string>((resolve, reject) => {
    const t = setInterval(() => {
      const m = /(http:\/\/127\.0\.0\.1:\d+\/)/.exec(out);
      if (m) {
        clearInterval(t);
        resolve(m[1]!);
      }
    }, 50);
    child.on('exit', () => {
      clearInterval(t);
      reject(new Error('进程在打印地址前退出：\n' + out));
    });
    setTimeout(() => {
      clearInterval(t);
      reject(new Error('等待启动超时：\n' + out));
    }, 20_000).unref();
  });
  url.catch(() => undefined);
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  return { child, out: () => out, url, exited };
}

function tmpWorld(): { base: string; root: string; app: string } {
  const base = makeTmpDir('tv-p4s-');
  bases.push(base);
  const root = path.join(base, 'projects');
  fs.cpSync(FIXTURE_ROOT, root, { recursive: true });
  return { base, root, app: path.join(base, 'app data') };
}
function listenersOnPort(port: number): string[] {
  const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' });
  return out
    .split(/\r?\n/)
    .filter((l) => /LISTENING/.test(l))
    .map((l) => l.trim().split(/\s+/)[1]!)
    .filter((addr) => addr.endsWith(':' + port));
}
async function reachableViaOtherAddresses(port: number): Promise<string[]> {
  const bad: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.internal || ni.family !== 'IPv4') continue;
      const ok = await new Promise<boolean>((resolve) => {
        const sock = net.connect({ host: ni.address, port });
        sock.setTimeout(1500, () => {
          sock.destroy();
          resolve(false);
        });
        sock.on('connect', () => {
          sock.destroy();
          resolve(true);
        });
        sock.on('error', () => resolve(false));
      });
      if (ok) bad.push(ni.address);
    }
  }
  return bad;
}
async function waitUntil(cond: () => boolean | Promise<boolean>, ms = 15_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await cond()) return true;
    await new Promise((x) => setTimeout(x, 50));
  }
  return false;
}
const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });

describe('npm start 等价入口（node src/server/index.ts）', () => {
  it('--no-open 启动：打印地址与"关闭此窗口"；API 200；netstat 显示只监听 127.0.0.1:<port>', async () => {
    const w = tmpWorld();
    const port = await freePort();
    const r = run(process.execPath, [path.join(PROJECT, 'src', 'server', 'index.ts'), '--no-open'], { TV_DATA_ROOT: w.root, TV_APPDATA_DIR: w.app, TV_PORT: String(port) });
    const url = await r.url;
    expect(url).toBe(`http://127.0.0.1:${port}/`);
    expect(r.out()).toContain('关闭此窗口');
    const st = (await (await fetch(url + 'api/status')).json()) as any;
    expect(st.state === 'idle' || st.state === 'scanning').toBe(true);
    if (WIN) {
      // netstat 若列出该端口，则只能是 127.0.0.1（本机环境的 netstat 可能不列出回环监听，此时靠连通性探测）
      const l = listenersOnPort(port);
      for (const addr of l) expect(addr, 'netstat 监听地址').toBe('127.0.0.1:' + port);
    }
    expect(await reachableViaOtherAddresses(port)).toEqual([]);
    expect((await fetch(url + 'api/projects')).status).toBe(200);
    // 应用数据目录在 TV_APPDATA_DIR，数据根未被写
    expect(await waitUntil(() => fs.existsSync(path.join(w.app, 'cache', 'usage-cache.json.gz')))).toBe(true);
    expect(fs.readdirSync(w.root).sort()).toEqual(fs.readdirSync(FIXTURE_ROOT).sort());
    killTree(r.child);
  }, 40_000);

  it('端口被占用时顺延（含被 0.0.0.0 占用的情形）并提示；--port 与 TV_PORT 生效', async () => {
    const w = tmpWorld();
    const port = await freePort();
    const blocker1 = net.createServer().listen(port, '0.0.0.0'); // 其它程序绑在所有地址上
    await new Promise((r) => blocker1.once('listening', r));
    const a = run(process.execPath, [path.join(PROJECT, 'src', 'server', 'index.ts'), '--no-open'], { TV_DATA_ROOT: w.root, TV_APPDATA_DIR: w.app, TV_PORT: String(port) });
    const urlA = await a.url;
    expect(urlA).not.toBe(`http://127.0.0.1:${port}/`);
    const portA = Number(/:(\d+)\//.exec(urlA)![1]);
    expect(portA).toBeGreaterThan(port);
    expect(a.out()).toMatch(new RegExp(`端口 ${port} 已被占用`));
    // 第二个实例：同一起始端口，继续顺延
    const b = run(process.execPath, [path.join(PROJECT, 'src', 'server', 'index.ts'), '--no-open'], { TV_DATA_ROOT: w.root, TV_APPDATA_DIR: path.join(w.base, 'app2'), TV_PORT: String(port) });
    const urlB = await b.url;
    expect(urlB).not.toBe(urlA);
    // 只断言“与 A 不同、仍在起始端口之后”。不能断言 portB > portA：并行跑其它用例时，A 探测期间某个端口可能被别的
    // 随机端口临时占用而被 A 跳过，B 启动时该端口已释放，于是 portB 可以小于 portA（阶段 5 开发者观察到的偶发失败）。
    const portB = Number(/:(\d+)\//.exec(urlB)![1]);
    expect(portB).not.toBe(portA);
    expect(portB).toBeGreaterThan(port);
    expect((await fetch(urlB + 'api/status')).status).toBe(200);
    // --port 参数
    const p3 = await freePort();
    const c = run(process.execPath, [path.join(PROJECT, 'src', 'server', 'index.ts'), '--no-open', '--port', String(p3)], { TV_DATA_ROOT: w.root, TV_APPDATA_DIR: path.join(w.base, 'app3') });
    expect(await c.url).toBe(`http://127.0.0.1:${p3}/`);
    for (const x of [a, b, c]) killTree(x.child);
    blocker1.close();
  }, 60_000);

  it('非法 TV_PORT / TV_NOW → 退出码 2 与中文提示，不启动', async () => {
    const w = tmpWorld();
    for (const [env, re] of [
      [{ TV_PORT: 'abc' }, /端口号不合法/],
      [{ TV_PORT: '70000' }, /端口号不合法/],
      [{ TV_PORT: '-1' }, /端口号不合法/],
      [{ TV_PORT: '1.5' }, /端口号不合法/],
      [{ TV_NOW: 'not-a-time' }, /TV_NOW/],
    ] as Array<[Record<string, string>, RegExp]>) {
      const r = run(process.execPath, [path.join(PROJECT, 'src', 'server', 'index.ts'), '--no-open'], { TV_DATA_ROOT: w.root, TV_APPDATA_DIR: w.app, ...env });
      expect(await r.exited, JSON.stringify(env)).toBe(2);
      expect(r.out()).toMatch(re);
    }
  }, 30_000);

  it('TV_NOW 固定当前时间：/api/status.serverNow 为该值；数据根不存在也能启动并提示', async () => {
    const w = tmpWorld();
    const r = run(process.execPath, [path.join(PROJECT, 'src', 'server', 'index.ts'), '--no-open'], { TV_DATA_ROOT: path.join(w.base, 'no-such-root'), TV_APPDATA_DIR: w.app, TV_PORT: String(await freePort()), TV_NOW: '2026-10-20T12:00:00Z' });
    const url = await r.url;
    await waitUntil(async () => ((await (await fetch(url + 'api/status')).json()) as any).state === 'error');
    const st = (await (await fetch(url + 'api/status')).json()) as any;
    expect(st.serverNow).toBe(Date.parse('2026-10-20T12:00:00Z'));
    expect(st.state).toBe('error');
    expect(st.lastError).toMatch(/数据根目录不存在/);
    // 注意：启动日志里没有数据根错误提示（扫描在后台进行，错误只体现在 /api/status）——行为记录，不判失败
    killTree(r.child);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// start.cmd / start.ps1（Windows）
// ---------------------------------------------------------------------------
function copyProject(dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(path.join(PROJECT, 'src'), path.join(dest, 'src'), { recursive: true });
  fs.cpSync(path.join(PROJECT, 'scripts', 'messages'), path.join(dest, 'scripts', 'messages'), { recursive: true });
  for (const f of ['start.cmd', 'start.ps1', 'package.json']) fs.copyFileSync(path.join(PROJECT, f), path.join(dest, f));
}
const SYSTEM32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
function cmdRun(script: string, args: string, env: Record<string, string | undefined>): Running {
  return run(path.join(SYSTEM32, 'cmd.exe'), ['/d', '/s', '/c', `""${script}" ${args}"`], { TV_NO_PAUSE: '1', TV_NO_OPEN: '1', ...env }, { verbatim: true });
}

describe.runIf(WIN)('start.cmd / start.ps1', () => {
  it('脚本文件：start.cmd 为纯 ASCII + CRLF；start.ps1 带 UTF-8 BOM；中文提示文本是合法 UTF-8 且无替换符', () => {
    const cmd = fs.readFileSync(path.join(PROJECT, 'start.cmd'));
    expect([...cmd].every((b) => b < 128)).toBe(true);
    const text = cmd.toString('latin1');
    expect(text.split('\n').length).toBeGreaterThan(10);
    expect(text.split('\n').slice(0, -1).every((l) => l.endsWith('\r'))).toBe(true); // 每个 LF 前都是 CR
    expect(text.replace(/\r\n/g, '').includes('\n')).toBe(false);
    const ps1 = fs.readFileSync(path.join(PROJECT, 'start.ps1'));
    expect([...ps1.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    for (const f of fs.readdirSync(path.join(PROJECT, 'scripts', 'messages'))) {
      const b = fs.readFileSync(path.join(PROJECT, 'scripts', 'messages', f));
      const s = b.toString('utf8');
      expect(s.includes('\uFFFD'), f).toBe(false);
      expect(/[\u4e00-\u9fa5]/.test(s), f).toBe(true);
    }
  });

  it('Node 缺失（PATH 里没有 node）：中文引导（含下载地址、22.18），退出码 1，不乱码', async () => {
    const dest = path.join(makeTmpDirTracked(), 'Token visualizer');
    copyProject(dest);
    const r = cmdRun(path.join(dest, 'start.cmd'), '--no-open', { PATH: SYSTEM32 });
    const code = await r.exited;
    expect(code).toBe(1);
    expect(r.out()).toContain('没有检测到 Node.js');
    expect(r.out()).toContain('22.18');
    expect(r.out()).toContain('nodejs.org');
    expect(r.out()).not.toMatch(/\uFFFD/);
    expect(r.out()).not.toMatch(/is not recognized|不是内部或外部命令/);
  }, 30_000);

  it('Node 过旧（TV_MIN_NODE=99.1 模拟）：中文"版本过低"提示并显示当前版本与所需版本，退出码 1', async () => {
    const dest = path.join(makeTmpDirTracked(), 'Token visualizer');
    copyProject(dest);
    const r = cmdRun(path.join(dest, 'start.cmd'), '--no-open', { TV_MIN_NODE: '99.1' });
    expect(await r.exited).toBe(1);
    expect(r.out()).toContain('版本过低');
    expect(r.out()).toContain(`当前版本：${process.versions.node}`);
    expect(r.out()).toContain('需要 99.1 或更高');
    expect(r.out()).not.toMatch(/\uFFFD/);
  }, 30_000);

  it('Node 版本比较：22.18 边界（需要 = 当前）放行；主版本更高放行；次版本更低拒绝', async () => {
    const dest = path.join(makeTmpDirTracked(), 'Token visualizer');
    copyProject(dest);
    const [maj, min] = process.versions.node.split('.').map(Number) as [number, number];
    const w = tmpWorld();
    const port = await freePort();
    const ok = cmdRun(path.join(dest, 'start.cmd'), '--no-open', { TV_MIN_NODE: `${maj}.${min}`, TV_DATA_ROOT: w.root, TV_APPDATA_DIR: w.app, TV_PORT: String(port) });
    expect(await ok.url).toBe(`http://127.0.0.1:${port}/`);
    killTree(ok.child);
    const tooNew = cmdRun(path.join(dest, 'start.cmd'), '--no-open', { TV_MIN_NODE: `${maj}.${min + 1}` });
    expect(await tooNew.exited).toBe(1);
    expect(tooNew.out()).toContain('版本过低');
  }, 40_000);

  it.each([
    ['含空格与中文', '中文 目录 test\\Token visualizer'],
    ['含 & 与括号', 'a & b (c)\\Token visualizer'],
    ['含 ^ 与单引号', "x^y 'q'\\Token visualizer"],
  ])('路径%s：start.cmd 能启动、地址正确、API 可访问、应用数据目录含空格也可用', async (_name, rel) => {
    const dest = path.join(makeTmpDirTracked(), rel);
    copyProject(dest);
    const w = tmpWorld();
    const port = await freePort();
    const r = cmdRun(path.join(dest, 'start.cmd'), '--no-open', { TV_DATA_ROOT: w.root, TV_APPDATA_DIR: w.app, TV_PORT: String(port) });
    const url = await r.url;
    expect(url).toBe(`http://127.0.0.1:${port}/`);
    expect(r.out()).toContain('关闭此窗口');
    expect((await fetch(url + 'api/status')).status).toBe(200);
    // 首次扫描在后台进行（无缓存时），等它结束再核对项目数（并行跑整套测试时扫描可能晚于地址打印）
    let proj: any = null;
    for (let i = 0; i < 200; i++) {
      const st = (await (await fetch(url + 'api/status')).json()) as any;
      if (st.state === 'idle') break;
      await new Promise((x) => setTimeout(x, 50));
    }
    proj = (await (await fetch(url + 'api/projects')).json()) as any;
    expect(proj.folderCount).toBe(9);
    killTree(r.child);
  }, 40_000);

  it('start.cmd：端口被占用时顺延；服务出错退出时给出中文提示与非 0 退出码（不卡在 pause）', async () => {
    const dest = path.join(makeTmpDirTracked(), 'Token visualizer');
    copyProject(dest);
    const w = tmpWorld();
    const port = await freePort();
    const blocker = net.createServer().listen(port, '127.0.0.1');
    await new Promise((x) => blocker.once('listening', x));
    const r = cmdRun(path.join(dest, 'start.cmd'), '--no-open', { TV_DATA_ROOT: w.root, TV_APPDATA_DIR: w.app, TV_PORT: String(port) });
    const url = await r.url;
    expect(url).not.toBe(`http://127.0.0.1:${port}/`);
    expect(r.out()).toContain(`端口 ${port} 已被占用`);
    killTree(r.child);
    blocker.close();
    const bad = cmdRun(path.join(dest, 'start.cmd'), '--no-open', { TV_DATA_ROOT: w.root, TV_APPDATA_DIR: w.app, TV_PORT: 'abc' });
    const code = await bad.exited;
    expect(code).toBe(2);
    expect(bad.out()).toContain('端口号不合法');
    expect(bad.out()).toContain('服务已退出');
  }, 60_000);

  it('start.ps1：同样可启动（含空格与中文路径），Node 过旧时给出中文提示', async () => {
    const dest = path.join(makeTmpDirTracked(), '中文 目录 ps\\Token visualizer');
    copyProject(dest);
    const w = tmpWorld();
    const port = await freePort();
    const ps = path.join(SYSTEM32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (!fs.existsSync(ps)) return;
    const r = run(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(dest, 'start.ps1'), '--no-open'], { TV_NO_PAUSE: '1', TV_NO_OPEN: '1', TV_DATA_ROOT: w.root, TV_APPDATA_DIR: w.app, TV_PORT: String(port) });
    expect(await r.url).toBe(`http://127.0.0.1:${port}/`);
    killTree(r.child);
    const old = run(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(dest, 'start.ps1')], { TV_NO_PAUSE: '1', TV_MIN_NODE: '99.1' });
    expect(await old.exited).toBe(1);
    expect(old.out()).toContain('版本过低');
  }, 60_000);
});

function makeTmpDirTracked(): string {
  const d = makeTmpDir('tv-p4c-');
  bases.push(d);
  return d;
}

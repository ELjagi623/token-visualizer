/**
 * E2E 辅助：把 fixture 复制到临时目录并启动真实的 `node src/server/index.ts`（--no-open），返回地址。
 * 数据根 / 应用数据目录都在系统临时目录；结束时关闭进程并清理。
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
export const FIXTURE_PROJECTS = path.join(ROOT, 'test', 'fixtures', 'projects');

export interface TestServer {
  url: string;
  port: number;
  dataRoot: string;
  appData: string;
  proc: ChildProcess;
  log: () => string;
  stop: () => Promise<void>;
}

export interface StartOptions {
  /** 复制 fixture 到临时数据根（默认 true）；false = 空目录 */
  withFixture?: boolean;
  /** 额外环境变量（如 TV_NOW、TV_DATA_ROOT 覆盖） */
  env?: Record<string, string>;
  /** 预置的应用数据目录内容（如 settings.json） */
  settingsJson?: unknown | ((ctx: { base: string; appData: string; dataRoot: string }) => unknown);
}

export async function startServer(opts: StartOptions = {}): Promise<TestServer> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-e2e-'));
  const dataRoot = path.join(base, 'projects');
  const appData = path.join(base, 'appdata');
  fs.mkdirSync(appData, { recursive: true });
  if (opts.withFixture === false) fs.mkdirSync(dataRoot, { recursive: true });
  else fs.cpSync(FIXTURE_PROJECTS, dataRoot, { recursive: true });
  if (opts.settingsJson !== undefined) {
    const v = typeof opts.settingsJson === 'function' ? (opts.settingsJson as (c: { base: string; appData: string; dataRoot: string }) => unknown)({ base, appData, dataRoot }) : opts.settingsJson;
    fs.writeFileSync(path.join(appData, 'settings.json'), JSON.stringify(v));
  }

  const proc = spawn(process.execPath, ['src/server/index.ts', '--no-open'], {
    cwd: ROOT,
    env: { ...process.env, TV_DATA_ROOT: dataRoot, TV_APPDATA_DIR: appData, TV_PORT: '0', TV_NO_OPEN: '1', ...opts.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let out = '';
  proc.stdout?.on('data', (d: Buffer) => (out += d.toString('utf8')));
  proc.stderr?.on('data', (d: Buffer) => (out += d.toString('utf8')));

  const url = await new Promise<string>((resolve, reject) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      const m = /(http:\/\/127\.0\.0\.1:\d+\/)/.exec(out);
      if (m) {
        clearInterval(timer);
        resolve(m[1]!);
      } else if (Date.now() - t0 > 20_000 || proc.exitCode !== null) {
        clearInterval(timer);
        reject(new Error(`服务没有启动：\n${out}`));
      }
    }, 50);
  });
  const port = Number(new URL(url).port);

  const stop = async (): Promise<void> => {
    if (proc.exitCode === null) {
      proc.kill();
      await new Promise<void>((r) => {
        proc.once('exit', () => r());
        setTimeout(r, 3000);
      });
    }
    fs.rmSync(base, { recursive: true, force: true });
  };
  return { url, port, dataRoot, appData, proc, log: () => out, stop };
}

export async function waitForIdle(url: string, timeoutMs = 15_000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    try {
      const s = (await (await fetch(`${url}api/status`)).json()) as { state: string; lastScanAt: number | null };
      if (s.state === 'idle' && s.lastScanAt !== null) return;
    } catch {
      // 继续等
    }
    if (Date.now() - t0 > timeoutMs) throw new Error('等待服务扫描完成超时');
    await new Promise((r) => setTimeout(r, 50));
  }
}

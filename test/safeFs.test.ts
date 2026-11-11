import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultAppDataDir, defaultDataRoot } from '../src/server/core/paths.ts';
import { assertWritable, claudeHomeDir, createAppDataWriter, createSafeFs, SafeFsViolation } from '../src/server/core/safeFs.ts';
import { FIXTURE_ROOT, makeTmpDir, rmDir, snapshotDir } from './helpers.ts';

let appData: string;
let dataRoot: string;
beforeAll(() => {
  appData = makeTmpDir('tv-appdata-');
  dataRoot = makeTmpDir('tv-dataroot-');
  fs.writeFileSync(path.join(dataRoot, 'keep.txt'), 'x');
});
afterAll(() => {
  rmDir(appData);
  rmDir(dataRoot);
});

describe('safeFs 写接口：拒绝写入数据根（验收 6）', () => {
  const writer = () => createAppDataWriter({ appDataDir: appData, protectedRoots: () => [dataRoot, FIXTURE_ROOT] });

  it('可以写应用数据目录内（相对 / 绝对路径、原子写、删除）', async () => {
    const w = writer();
    await w.writeFile('settings.json', '{"a":1}');
    await w.atomicWriteFile('cache/v1.json', '{"b":2}');
    expect(fs.readFileSync(path.join(appData, 'cache', 'v1.json'), 'utf8')).toBe('{"b":2}');
    await w.writeFile(path.join(appData, 'abs.txt'), 'ok');
    await w.remove('abs.txt');
    expect(fs.existsSync(path.join(appData, 'abs.txt'))).toBe(false);
    // 原子写不留临时文件
    expect(fs.readdirSync(path.join(appData, 'cache'))).toEqual(['v1.json']);
  });

  it('拒绝写入数据根内的任何路径', async () => {
    const w = writer();
    const targets = [path.join(dataRoot, 'new.txt'), path.join(dataRoot, 'sub', 'deep.json'), path.join(FIXTURE_ROOT, 'D--Work-alpha', 'x.jsonl'), dataRoot];
    for (const t of targets) {
      await expect(w.writeFile(t, 'boom')).rejects.toMatchObject({ code: 'WRITE_INSIDE_PROTECTED' });
      await expect(w.atomicWriteFile(t, 'boom')).rejects.toBeInstanceOf(SafeFsViolation);
      await expect(w.mkdirp(t)).rejects.toBeInstanceOf(SafeFsViolation);
      await expect(w.remove(t)).rejects.toBeInstanceOf(SafeFsViolation);
    }
    expect(fs.existsSync(path.join(dataRoot, 'new.txt'))).toBe(false);
    expect(fs.existsSync(path.join(dataRoot, 'sub'))).toBe(false);
    expect(fs.readFileSync(path.join(dataRoot, 'keep.txt'), 'utf8')).toBe('x'); // remove 没有生效
  });

  it('拒绝应用数据目录之外的路径（含 .. 穿越）', async () => {
    const w = writer();
    await expect(w.writeFile('../escape.txt', 'x')).rejects.toMatchObject({ code: 'WRITE_OUTSIDE_APPDATA' });
    await expect(w.writeFile(path.join(os.tmpdir(), 'tv-outside.txt'), 'x')).rejects.toMatchObject({ code: 'WRITE_OUTSIDE_APPDATA' });
  });

  it('应用数据目录位于数据根之内时，一律拒绝', () => {
    const nested = path.join(dataRoot, 'appdata');
    expect(() => assertWritable('a.json', nested, [dataRoot])).toThrow(SafeFsViolation);
  });

  it('~/.claude 永远受保护，即使调用方没把它列进 protectedRoots', () => {
    const claude = claudeHomeDir();
    expect(() => assertWritable(path.join(claude, 'projects', 'x.jsonl'), appData, [])).toThrow(/受保护/);
    expect(() => assertWritable(path.join(claude, 'settings.json'), appData, [])).toThrow(SafeFsViolation);
  });

  it('大小写不同的数据根路径（Windows）也被识别', () => {
    if (process.platform !== 'win32') return;
    expect(() => assertWritable(path.join(dataRoot.toUpperCase(), 'x.txt'), appData, [dataRoot])).toThrow(SafeFsViolation);
  });

  it('通过 junction / 符号链接绕过也被拒绝', async () => {
    const link = path.join(appData, 'sneaky-link');
    try {
      fs.symlinkSync(dataRoot, link, 'junction');
    } catch {
      return; // 无法创建链接的环境：跳过
    }
    const w = writer();
    await expect(w.writeFile('sneaky-link/evil.txt', 'x')).rejects.toBeInstanceOf(SafeFsViolation);
    expect(fs.existsSync(path.join(dataRoot, 'evil.txt'))).toBe(false);
    fs.rmSync(link, { force: true, recursive: false });
  });
});

describe('safeFs 读接口', () => {
  it('只暴露只读方法', () => {
    const keys = Object.keys(createSafeFs()).sort();
    expect(keys).toEqual(['bytesRead', 'opens', 'openRead', 'readdir', 'stat'].sort());
  });

  it('读取不改变 fixture 目录快照', async () => {
    const before = snapshotDir(FIXTURE_ROOT);
    const fsx = createSafeFs();
    const p = path.join(FIXTURE_ROOT, 'D--Work-alpha', 'a1a1a1a1-0000-4000-8000-000000000001.jsonl');
    const h = await fsx.openRead(p);
    await h.read(0, 100);
    await h.close();
    await fsx.readdir(FIXTURE_ROOT);
    await fsx.stat(p);
    expect(snapshotDir(FIXTURE_ROOT)).toEqual(before);
  });

  it('read 返回实际读到的字节（越界读返回更短 / 空）', async () => {
    const f = path.join(dataRoot, 'r.jsonl');
    fs.writeFileSync(f, 'hello');
    const h = await createSafeFs().openRead(f);
    expect(h.size).toBe(5);
    expect((await h.read(2, 100)).toString()).toBe('llo');
    expect((await h.read(10, 5)).length).toBe(0);
    await h.close();
  });
});

describe('paths 默认值', () => {
  it('环境变量覆盖优先；缺省值指向 ~/.claude/projects 与 %APPDATA%/TokenVisualizer', () => {
    expect(defaultDataRoot({ TV_DATA_ROOT: FIXTURE_ROOT })).toBe(path.resolve(FIXTURE_ROOT));
    expect(defaultDataRoot({})).toBe(path.join(os.homedir(), '.claude', 'projects'));
    expect(defaultAppDataDir({ TV_APPDATA_DIR: appData })).toBe(path.resolve(appData));
    expect(defaultAppDataDir({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' })).toBe(path.join('C:\\Users\\u\\AppData\\Roaming', 'TokenVisualizer'));
  });
});

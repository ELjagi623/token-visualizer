/**
 * 审计钩子（仅供 `npm run acceptance` 使用，产品代码从不加载它）。
 *
 *   node --import scripts/audit-hook.mjs src/server/index.ts
 *
 * 在服务进程启动前给 node:fs / net / dns / http(s) / fetch / child_process 打补丁，把以下事件
 * 以 JSON 行追加到 TV_AUDIT_LOG 指向的文件（用补丁前保存的原始 appendFileSync，自身不触发审计）：
 *   { k: 'write',   fn, path }            任何写入 / 创建 / 删除 / 重命名类文件操作（含以写模式 open）
 *   { k: 'read',    fn, path }            以只读方式打开 / 读取 / 列目录 / stat 的文件系统路径
 *   { k: 'connect', host, port }          出站 TCP 连接
 *   { k: 'dns',     host }                DNS 解析
 *   { k: 'fetch' | 'http', url | host }   fetch / http(s).request 调用
 *   { k: 'spawn',   cmd }                 子进程
 * 验收脚本据此断言：写入只发生在应用数据目录内、读取数据根只打开 *.jsonl / custom-title.json、没有任何非回环的出站连接。
 */
import fs from 'node:fs';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import cp from 'node:child_process';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';

const LOG = process.env.TV_AUDIT_LOG;
// 补丁前就打开日志文件描述符；之后只用 writeSync(fd)（不在补丁范围内），避免审计自身被审计而递归
const logFd = LOG ? fs.openSync(LOG, 'a') : -1;
const writeRaw = fs.writeSync.bind(fs);

function log(rec) {
  if (logFd < 0) return;
  try {
    writeRaw(logFd, `${JSON.stringify(rec)}\n`);
  } catch {
    // 审计自身出错不能影响被审计进程
  }
}

function asPath(p) {
  if (typeof p === 'string') return path.resolve(p);
  if (p instanceof URL) return p.protocol === 'file:' ? path.resolve(decodeURIComponent(p.pathname.replace(/^\//, ''))) : null;
  if (Buffer.isBuffer(p)) return path.resolve(p.toString('utf8'));
  return null;
}

const { O_WRONLY, O_RDWR, O_CREAT, O_TRUNC, O_APPEND } = fs.constants;

function flagsWrite(flags) {
  if (flags === undefined || flags === null) return false;
  if (typeof flags === 'number') return (flags & (O_WRONLY | O_RDWR | O_CREAT | O_TRUNC | O_APPEND)) !== 0;
  const s = String(flags);
  return s !== 'r' && s !== 'rs' && s !== 'sr' ? /[wa+x]/.test(s) : false;
}

// 一律是"写"的操作；paths 取哪些参数下标
const WRITE_OPS = {
  writeFile: [0],
  appendFile: [0],
  rename: [0, 1],
  mkdir: [0],
  mkdtemp: [0],
  rm: [0],
  rmdir: [0],
  unlink: [0],
  copyFile: [0, 1],
  cp: [0, 1],
  truncate: [0],
  symlink: [1],
  link: [1],
  chmod: [0],
  chown: [0],
  utimes: [0],
  lutimes: [0],
};
const READ_OPS = { readFile: [0], readdir: [0], opendir: [0], stat: [0], lstat: [0], readlink: [0], realpath: [0], access: [0], exists: [0] };

function wrap(target, name, kind, idx, base) {
  const orig = target[name];
  if (typeof orig !== 'function') return;
  target[name] = function patched(...a) {
    for (const i of idx) {
      const p = asPath(a[i]);
      if (p) log({ k: kind, fn: base ?? name, path: p });
    }
    return orig.apply(this, a);
  };
  // 保留 promisify 自定义符号等
  Object.defineProperty(target[name], 'name', { value: name });
  for (const sym of Object.getOwnPropertySymbols(orig)) target[name][sym] = orig[sym];
}

for (const [op, idx] of Object.entries(WRITE_OPS)) {
  wrap(fs, op, 'write', idx);
  wrap(fs, `${op}Sync`, 'write', idx, op);
  wrap(fs.promises, op, 'write', idx);
}
for (const [op, idx] of Object.entries(READ_OPS)) {
  wrap(fs, op, 'read', idx);
  wrap(fs, `${op}Sync`, 'read', idx, op);
  wrap(fs.promises, op, 'read', idx);
}

function wrapOpen(target, name, flagsIdx, base) {
  const orig = target[name];
  if (typeof orig !== 'function') return;
  target[name] = function patched(...a) {
    const p = asPath(a[0]);
    if (p) {
      const f = a[flagsIdx];
      log({ k: flagsWrite(typeof f === 'function' ? undefined : f) ? 'write' : 'read', fn: base ?? name, path: p });
    }
    return orig.apply(this, a);
  };
}
wrapOpen(fs, 'open', 1);
wrapOpen(fs, 'openSync', 1, 'open');
wrapOpen(fs.promises, 'open', 1);

for (const [name, kind] of [['createWriteStream', 'write'], ['createReadStream', 'read']]) {
  const orig = fs[name];
  fs[name] = function patched(p, ...rest) {
    const ap = asPath(p);
    if (ap) log({ k: kind, fn: name, path: ap });
    return orig.call(this, p, ...rest);
  };
}

// ---- 网络 ----
function hostOf(a) {
  // net.connect() 内部把 [options, cb] 归一化成数组再传给 socket.connect()
  const o = Array.isArray(a[0]) ? a[0][0] : a[0];
  if (o && typeof o === 'object' && !Array.isArray(o)) {
    if (o.path) return { host: `unix:${o.path}`, port: 0 };
    return { host: String(o.host ?? 'localhost'), port: Number(o.port ?? 0) };
  }
  if (typeof o === 'number' || (typeof o === 'string' && /^\d+$/.test(o))) return { host: typeof a[1] === 'string' ? a[1] : 'localhost', port: Number(o) };
  return { host: `pipe:${String(o)}`, port: 0 };
}
const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function patched(...a) {
  const h = hostOf(a);
  log({ k: 'connect', host: h.host, port: h.port });
  return origConnect.apply(this, a);
};

for (const name of ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny']) {
  const orig = dns[name];
  if (typeof orig === 'function') {
    dns[name] = function patched(host, ...rest) {
      log({ k: 'dns', host: String(host) });
      return orig.call(this, host, ...rest);
    };
  }
  const po = dns.promises?.[name];
  if (typeof po === 'function') {
    dns.promises[name] = function patched(host, ...rest) {
      log({ k: 'dns', host: String(host) });
      return po.call(this, host, ...rest);
    };
  }
}

for (const [mod, label] of [[http, 'http'], [https, 'https']]) {
  for (const name of ['request', 'get']) {
    const orig = mod[name];
    mod[name] = function patched(a0, ...rest) {
      let host = '';
      if (typeof a0 === 'string') host = a0;
      else if (a0 instanceof URL) host = a0.href;
      else if (a0 && typeof a0 === 'object') host = `${a0.protocol ?? `${label}:`}//${a0.hostname ?? a0.host ?? 'localhost'}:${a0.port ?? ''}`;
      log({ k: 'http', host });
      return orig.call(this, a0, ...rest);
    };
  }
}

if (typeof globalThis.fetch === 'function') {
  const origFetch = globalThis.fetch;
  globalThis.fetch = function patched(input, ...rest) {
    log({ k: 'fetch', url: typeof input === 'string' ? input : input instanceof URL ? input.href : (input?.url ?? String(input)) });
    return origFetch.call(this, input, ...rest);
  };
}

for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  const orig = cp[name];
  cp[name] = function patched(cmd, ...rest) {
    log({ k: 'spawn', cmd: String(cmd) });
    return orig.call(this, cmd, ...rest);
  };
}

syncBuiltinESMExports();
log({ k: 'ready', pid: process.pid });

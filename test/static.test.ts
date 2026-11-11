import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PLACEHOLDER_HTML, safeSegments } from '../src/server/api/static.ts';
import { rawRequest, startApp } from './apiHelpers.ts';
import type { TestApp } from './apiHelpers.ts';
import { makeTmpDir, rmDir } from './helpers.ts';

describe('静态托管：web/dist 存在', () => {
  let base: string;
  let web: string;
  let outside: string;
  let t: TestApp;
  let linked = false;

  beforeAll(async () => {
    base = makeTmpDir('tv-static-');
    web = path.join(base, 'web', 'dist');
    outside = path.join(base, 'outside');
    fs.mkdirSync(path.join(web, 'assets'), { recursive: true });
    fs.mkdirSync(path.join(web, 'sub', 'dir'), { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(web, 'index.html'), '<!doctype html><title>APP-INDEX</title>');
    fs.writeFileSync(path.join(web, 'assets', 'app-abc123.js'), 'console.log("app")');
    fs.writeFileSync(path.join(web, 'assets', 'app-abc123.css'), 'body{}');
    fs.writeFileSync(path.join(web, 'assets', 'font.woff2'), Buffer.from([0, 1, 2, 3]));
    fs.writeFileSync(path.join(web, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    fs.writeFileSync(path.join(web, 'sub', 'dir', 'file.txt'), 'nested');
    fs.writeFileSync(path.join(web, '.hidden'), 'hidden');
    fs.writeFileSync(path.join(base, 'secret.txt'), 'TOP-SECRET-OUTSIDE');
    fs.writeFileSync(path.join(base, 'web', 'sibling.txt'), 'TOP-SECRET-SIBLING');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOP-SECRET-LINKED');
    try {
      fs.symlinkSync(outside, path.join(web, 'link'), 'junction');
      linked = true;
    } catch {
      linked = false;
    }
    t = await startApp({ webDir: web, settings: {} });
  });
  afterAll(async () => {
    await t.close();
    rmDir(base);
  });

  it('根路径与 index.html：no-cache；SPA 回退（无扩展名的未知路径返回 index.html）', async () => {
    for (const p of ['/', '/index.html', '/sessions/abc-123', '/analysis', '/settings/']) {
      const r = await rawRequest(t.port, { path: p, headers: {} });
      expect(r.status, p).toBe(200);
      expect(r.body, p).toContain('APP-INDEX');
      expect(r.headers['content-type'], p).toContain('text/html');
      expect(r.headers['cache-control'], p).toBe('no-cache');
    }
  });

  it('资源：正确的 Content-Type；/assets/ 下 immutable，其它 1 小时；ETag / 304；HEAD', async () => {
    const js = await rawRequest(t.port, { path: '/assets/app-abc123.js', headers: {} });
    expect(js.status).toBe(200);
    expect(js.headers['content-type']).toContain('text/javascript');
    expect(js.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(js.body).toBe('console.log("app")');
    expect((await rawRequest(t.port, { path: '/assets/app-abc123.css', headers: {} })).headers['content-type']).toContain('text/css');
    expect((await rawRequest(t.port, { path: '/assets/font.woff2', headers: {} })).headers['content-type']).toBe('font/woff2');
    const svg = await rawRequest(t.port, { path: '/favicon.svg', headers: {} });
    expect(svg.headers['content-type']).toBe('image/svg+xml');
    expect(svg.headers['cache-control']).toBe('public, max-age=3600');
    expect((await rawRequest(t.port, { path: '/sub/dir/file.txt', headers: {} })).body).toBe('nested');
    const etag = js.headers.etag as string;
    expect(etag).toBeTruthy();
    const nm = await rawRequest(t.port, { path: '/assets/app-abc123.js', headers: { 'If-None-Match': etag } });
    expect(nm.status).toBe(304);
    expect(nm.body).toBe('');
    const head = await rawRequest(t.port, { method: 'HEAD', path: '/assets/app-abc123.js', headers: {} });
    expect(head.status).toBe(200);
    expect(head.body).toBe('');
    expect(head.headers['content-length']).toBe(String('console.log("app")'.length));
    // 安全头
    expect(js.headers['x-content-type-options']).toBe('nosniff');
    expect(js.headers['content-security-policy']).toContain("default-src 'self'");
    expect(js.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('缺失的资源（带扩展名）返回 404，而不是 index.html；点文件 404；非 GET 405', async () => {
    for (const p of ['/assets/missing.js', '/nope.png', '/.hidden', '/assets/.hidden', '/sub/dir/']) {
      const r = await rawRequest(t.port, { path: p, headers: {} });
      if (p === '/sub/dir/') expect(r.status).toBe(200); // 目录 → 视作页面导航，回退 index.html
      else expect(r.status, p).toBe(404);
      expect(r.body).not.toContain('hidden');
    }
    const post = await rawRequest(t.port, { method: 'POST', path: '/', headers: { 'Content-Type': 'text/plain' }, body: 'x' });
    expect(post.status).toBe(405);
    expect(post.headers.allow).toBe('GET, HEAD');
  });

  it('路径穿越防护：各种编码的 ../、反斜杠、NUL、盘符、双重编码都读不到 web/dist 之外的文件', async () => {
    const attacks = [
      '/../secret.txt',
      '/../web/sibling.txt',
      '/..%2fsecret.txt',
      '/%2e%2e/secret.txt',
      '/%2e%2e%2fsecret.txt',
      '/%2E%2E%2Fsecret.txt',
      '/assets/../../secret.txt',
      '/assets/%2e%2e/%2e%2e/secret.txt',
      '/assets/..%2f..%2fsecret.txt',
      '/..%5csecret.txt',
      '/%5c..%5csecret.txt',
      '/..\\secret.txt',
      '/assets\\..\\..\\secret.txt',
      '/%252e%252e/secret.txt',
      '/%252e%252e%252fsecret.txt',
      '/....//secret.txt',
      '/%00',
      '/index.html%00.png',
      '/assets/app-abc123.js%00',
      '/C:/Windows/win.ini',
      '/C%3A/Windows/win.ini',
      '/..%c0%afsecret.txt',
      '/%c0%ae%c0%ae/secret.txt',
      '/./index.html/../../secret.txt',
      '/assets/..//..//secret.txt',
      `/${'..%2f'.repeat(30)}secret.txt`,
      '/..;/secret.txt',
      '/..%00/secret.txt',
      '/web/dist/../../secret.txt',
    ];
    for (const p of attacks) {
      const r = await rawRequest(t.port, { path: p, headers: {} });
      expect(r.status, p).toBeGreaterThanOrEqual(400);
      expect(r.status, p).toBeLessThan(500);
      expect(r.body, p).not.toContain('TOP-SECRET');
    }
    expect((await rawRequest(t.port, { path: '/api/status', headers: {} })).status).toBe(200); // 仍然活着
  });

  it('符号链接 / junction 指向 web/dist 之外：不跟随', async () => {
    if (!linked) return;
    const r = await rawRequest(t.port, { path: '/link/secret.txt', headers: {} });
    expect(r.status).toBe(404);
    expect(r.body).not.toContain('TOP-SECRET');
  });

  it('safeSegments 单元：解码 / 拒绝规则', () => {
    expect(safeSegments('/a/b.js')).toEqual(['a', 'b.js']);
    expect(safeSegments('/')).toEqual([]);
    expect(safeSegments('/a%20b/c')).toEqual(['a b', 'c']);
    expect(safeSegments('/../x')).toBeNull();
    expect(safeSegments('/a/./b')).toBeNull();
    expect(safeSegments('/a\\b')).toBeNull();
    expect(safeSegments('/%2e%2e/x')).toBeNull();
    expect(safeSegments('/x%00')).toBeNull();
    expect(safeSegments('/.env')).toBeNull();
    expect(safeSegments('/c:/x')).toBeNull();
    expect(() => safeSegments('/%E0%A4%A')).toThrow();
  });

  it('API 路径不会被静态托管吞掉；未知 /api/* 是 JSON 404', async () => {
    const r = await rawRequest(t.port, { path: '/api/does-not-exist', headers: {} });
    expect(r.status).toBe(404);
    expect(JSON.parse(r.body).error.code).toBe('NOT_FOUND');
    expect(r.body).not.toContain('APP-INDEX');
  });
});

describe('静态托管：web/dist 不存在 / 没有 index.html', () => {
  it('导航请求返回中文提示页（说明需要 npm run build），资源 404，API 照常', async () => {
    const base = makeTmpDir('tv-static-none-');
    try {
      for (const webDir of [path.join(base, 'no-such-dist'), (() => { const d = path.join(base, 'empty-dist'); fs.mkdirSync(d); return d; })()]) {
        const t = await startApp({ webDir, settings: {} });
        for (const p of ['/', '/sessions/x']) {
          const r = await rawRequest(t.port, { path: p, headers: {} });
          expect(r.status, p).toBe(200);
          expect(r.headers['content-type']).toContain('text/html');
          expect(r.body).toBe(PLACEHOLDER_HTML);
          expect(r.body).toContain('npm run build');
          expect(r.body).toContain('前端界面尚未构建');
        }
        expect((await rawRequest(t.port, { path: '/assets/app.js', headers: {} })).status).toBe(404);
        expect((await rawRequest(t.port, { path: '/api/status', headers: {} })).status).toBe(200);
        // 提示页不含外链
        expect(PLACEHOLDER_HTML).not.toMatch(/https?:\/\//);
        await t.close();
      }
    } finally {
      rmDir(base);
    }
  });
});

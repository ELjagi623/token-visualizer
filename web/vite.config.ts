import path from 'node:path';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const here = import.meta.dirname;

/**
 * @fontsource 的 CSS 同时引用 woff2 与 woff 两种格式；所有现代浏览器都支持 woff2，
 * 只保留 woff2 可让 dist 体积减半（Noto Sans SC 分片很多）。
 */
function fontsourceWoff2Only(): Plugin {
  return {
    name: 'tv-fontsource-woff2-only',
    enforce: 'pre',
    transform(code, id) {
      const clean = id.split('?')[0] ?? id;
      if (!clean.includes('@fontsource') || !clean.endsWith('.css')) return null;
      return { code: code.replace(/,\s*url\([^)]*\.woff\)\s*format\('woff'\)/g, ''), map: null };
    },
  };
}

/**
 * React 生产包里有一条"错误解码器"外链（只出现在报错文案里，运行时从不请求）。
 * 为满足"产物中除命名空间 URI 外无任何外链"的审计，把它改成站内相对路径。
 */
function stripReactDecoderUrl(): Plugin {
  return {
    name: 'tv-strip-react-decoder-url',
    apply: 'build',
    renderChunk(code) {
      const out = code.replaceAll('https://reactjs.org/docs/error-decoder.html?invariant=', '/error-decoder?invariant=');
      return out === code ? null : { code: out, map: null };
    },
  };
}

// 开发代理：服务端会校验 Host / Origin，所以改写成目标地址（端口取 TV_PORT，默认 47821）
const apiPort = process.env.TV_PORT ?? '47821';
const apiTarget = `http://127.0.0.1:${apiPort}`;

export default defineConfig({
  root: here,
  base: '/',
  plugins: [fontsourceWoff2Only(), stripReactDecoderUrl(), react()],
  build: {
    outDir: path.resolve(here, 'dist'),
    emptyOutDir: true,
    sourcemap: false,
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 900,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
        headers: { Origin: apiTarget },
      },
    },
  },
});

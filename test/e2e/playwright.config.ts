import path from 'node:path';
import { defineConfig } from '@playwright/test';

/**
 * E2E：用系统已装的 Edge（channel: msedge，不下载浏览器）。
 * 每个 spec 自己启动服务（见 server.ts），所以这里不配置 webServer。
 * 运行前需要先 `npm run build`（服务托管 web/dist）。
 */
export default defineConfig({
  testDir: path.resolve(import.meta.dirname),
  testMatch: '**/*.spec.ts',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  outputDir: path.resolve(import.meta.dirname, '..', '..', 'test-results'),
  use: {
    channel: 'msedge',
    headless: true,
    viewport: { width: 1440, height: 1000 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  },
});

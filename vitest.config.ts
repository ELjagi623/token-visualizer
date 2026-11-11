import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // 既有的服务端 / 接口用例按中文文案断言；默认语言是英文，这里用 TV_LANG 让它们仍以中文运行（默认英文另有专门用例）
    env: { TV_LANG: 'zh' },
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});

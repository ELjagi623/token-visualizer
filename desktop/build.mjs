/**
 * 把 Electron 主进程（desktop/main.ts）连同整个本地服务（src/server，含 .ts 与 json 数据）
 * 打成一个 CommonJS 文件：dist-desktop/main.cjs。
 *
 * 这样应用里不需要 Node.js，也不需要携带 node_modules：服务端运行时本来就零第三方依赖，
 * esbuild 只在构建时使用。
 */
import { build } from 'esbuild';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

await build({
  entryPoints: [path.join(root, 'desktop', 'main.ts')],
  outfile: path.join(root, 'dist-desktop', 'main.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  sourcemap: false,
  minify: false,
  legalComments: 'none',
  logLevel: 'info',
  // src/server/app.ts 里用 import.meta.url 推算默认前端目录；CJS 里没有它，用 __filename 的 file URL 代替
  define: { 'import.meta.url': '__importMetaUrl' },
  banner: { js: "const __importMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
});

console.log('已生成 dist-desktop/main.cjs');

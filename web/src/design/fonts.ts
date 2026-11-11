/**
 * 字体本地打包（运行时零外网请求）：
 *  - Outfit（拉丁字母与数字，首选）：400 / 500 / 600 / 700
 *  - Noto Sans SC（中文回退，按 unicode-range 分片，只下载用到的分片）：400 / 500 / 600
 * woff 格式由 vite.config.ts 的插件剔除，只保留 woff2。
 */
import '@fontsource/outfit/latin-400.css';
import '@fontsource/outfit/latin-500.css';
import '@fontsource/outfit/latin-600.css';
import '@fontsource/outfit/latin-700.css';
import '@fontsource/noto-sans-sc/400.css';
import '@fontsource/noto-sans-sc/500.css';
import '@fontsource/noto-sans-sc/600.css';

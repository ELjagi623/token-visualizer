/** 数据根与应用数据目录的默认值 / 环境变量覆盖。 */
import os from 'node:os';
import path from 'node:path';

type Env = Record<string, string | undefined>;

/** 数据根：环境变量 TV_DATA_ROOT 优先，否则 `~/.claude/projects`。 */
export function defaultDataRoot(env: Env = process.env): string {
  const o = env.TV_DATA_ROOT;
  if (o && o.trim()) return path.resolve(o);
  return path.join(os.homedir(), '.claude', 'projects');
}

/** 应用数据目录：环境变量 TV_APPDATA_DIR 优先，否则 `%APPDATA%/TokenVisualizer`。 */
export function defaultAppDataDir(env: Env = process.env): string {
  const o = env.TV_APPDATA_DIR;
  if (o && o.trim()) return path.resolve(o);
  const base = env.APPDATA && env.APPDATA.trim() ? env.APPDATA : path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(base, 'TokenVisualizer');
}

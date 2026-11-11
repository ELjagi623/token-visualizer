/**
 * 服务端会显示在界面上的文案（设置校验错误、警告、成本提示等）的双语支持。
 * 做法很轻：`L(中文, 英文)` 按"当前服务端语言"返回其中一个。当前语言跟随设置里的 language：
 * SettingsStore 在读取 / 更新设置时调用 setServerLang。默认英文。
 *
 * 不改 API 形状（保留 code / field），只让 message 文本随语言变化。启动时已生成并保留的警告
 * （如损坏的设置文件）在重启前不会换语言，属已知小限制。
 */
export type ServerLang = 'zh' | 'en';

// 初值：环境变量 TV_LANG=zh → 中文，否则英文（与 defaultSettings 一致；读取设置后以设置里的 language 为准）
let current: ServerLang = process.env.TV_LANG === 'zh' ? 'zh' : 'en';

export function setServerLang(lang: ServerLang): void {
  current = lang;
}

export function getServerLang(): ServerLang {
  return current;
}

/** 按当前服务端语言选择文案。 */
export function L(zh: string, en: string): string {
  return current === 'zh' ? zh : en;
}

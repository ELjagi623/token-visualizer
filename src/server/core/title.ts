/**
 * 会话标题的规整与"首条真人消息"标题提取。
 *
 * 隐私：标题只在解析阶段从首条真人消息里截取前 ≤ 40 个字符，原文不保存、不落盘、不写日志；
 * 仅用于本机界面显示，导出文件不得包含这种派生标题。
 */
export const MAX_TITLE_CHARS = 40;

/** 规整标题：折叠空白、去掉控制字符、截到 ≤ 40 个字符。空则返回 null。 */
export function cleanTitle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const s = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (s.length === 0) return null;
  return Array.from(s).slice(0, MAX_TITLE_CHARS).join('');
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 从一条 user 行里取"真人输入"的文本前 40 字。
 * 跳过：isMeta / 子代理（isSidechain）行、以 `<` 开头的系统注入文本（如 <command-name>、<local-command-caveat>）。
 */
export function titleFromUserRow(o: Record<string, unknown>): string | null {
  if (o.isMeta === true || o.isSidechain === true) return null;
  const message = isObj(o.message) ? o.message : undefined;
  if (!message) return null;
  const c = message.content;
  let text: string | undefined;
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) {
    for (const b of c) {
      if (isObj(b) && b.type === 'text' && typeof b.text === 'string') {
        text = b.text;
        break;
      }
    }
  }
  if (text === undefined) return null;
  const head = text.slice(0, 400).trimStart(); // 先截断再处理：不对超长正文做任何完整操作
  if (head.startsWith('<')) return null;
  return cleanTitle(head);
}

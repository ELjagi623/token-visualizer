import { enA } from './enA.ts';
import { enB } from './enB.ts';
import { enC } from './enC.ts';
import type { Dict } from './zh.ts';

/**
 * 英文字典（默认语言）。类型是 Dict（= 中文字典的全部键），缺任何一条 tsc 都会报错，不再静默回退中文。
 * 分三个文件，与中文字典一一对应：enA ↔ zh.ts 自身的键、enB ↔ zhB.ts、enC ↔ zhC.ts。
 * 复数写法："{n} project|{n} projects"（n === 1 取前者）。
 */
export const en: Dict = { ...enA, ...enB, ...enC };

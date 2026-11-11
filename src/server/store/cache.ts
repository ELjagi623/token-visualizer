/**
 * 缓存：把每个文件的解析状态（含去重前的 assistant 行）落盘到应用数据目录。
 *
 * 格式：gzip 压缩的 NDJSON（每行一个 JSON）：
 *   {"t":"head", schemaVersion, dataRoot, savedAt, files, titleFiles}
 *   {"t":"file", ...FileState 去掉 rows, rowCount}      后跟若干
 *   {"t":"rows", rows:[...≤2000 行]}                    （属于前一个 file）
 *   {"t":"title", ...TitleFileState}
 *   {"t":"end", files, titleFiles}
 * 之所以分行 / 分批：序列化与反序列化都可以分片让出事件循环，大缓存也不会长时间阻塞。
 *
 * 安全：只存用量与元数据（含 ≤ 40 字符的会话标题）；不存对话正文。
 * 写入：经 AppDataWriter.atomicWriteFile（先写临时文件再 rename；且断言不在数据根内）。
 * 容错：损坏 / 截断 / schemaVersion 不符 / 数据根不同 → 丢弃（返回原因），由调用方全量重建，不崩溃。
 */
import path from 'node:path';
import { Readable } from 'node:stream';
import zlib from 'node:zlib';
import type { ParseStats } from '../../shared/types.ts';
import { emptyParseStats } from '../../shared/types.ts';
import type { ParsedRow } from '../core/parser.ts';
import type { AppDataWriter } from '../core/safeFs.ts';
import type { FileState, TitleFileState } from './types.ts';

/** 缓存格式 / 解析语义版本。改动 FileState、ParsedRow 字段或解析规则时必须 +1。 */
export const CACHE_SCHEMA_VERSION = 2; // 2：FileState 增加 title / activity / lastEventTs
export const CACHE_FILE = 'cache/usage-cache.json.gz';
const ROWS_PER_LINE = 2000;

export interface CacheSnapshot {
  dataRoot: string;
  files: FileState[];
  titleFiles: TitleFileState[];
}

export type CacheLoadResult = { ok: true; snapshot: CacheSnapshot; bytes: number } | { ok: false; reason: string };

/** 数据根的比较键（Windows 下大小写不敏感）。 */
export function rootIdentity(root: string): string {
  const r = path.resolve(root);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

async function* serialize(snap: CacheSnapshot, savedAt: number): AsyncGenerator<string> {
  yield `${JSON.stringify({ t: 'head', schemaVersion: CACHE_SCHEMA_VERSION, dataRoot: rootIdentity(snap.dataRoot), savedAt, files: snap.files.length, titleFiles: snap.titleFiles.length })}\n`;
  for (const f of snap.files) {
    const { rows, ...meta } = f;
    yield `${JSON.stringify({ t: 'file', ...meta, rowCount: rows.length })}\n`;
    for (let i = 0; i < rows.length; i += ROWS_PER_LINE) {
      yield `${JSON.stringify({ t: 'rows', rows: rows.slice(i, i + ROWS_PER_LINE) })}\n`;
      await tick(); // 分片让出
    }
  }
  for (const t of snap.titleFiles) yield `${JSON.stringify({ t: 'title', ...t })}\n`;
  yield `${JSON.stringify({ t: 'end', files: snap.files.length, titleFiles: snap.titleFiles.length })}\n`;
}

/** 保存缓存，返回写入的字节数。 */
export async function saveCache(writer: AppDataWriter, snap: CacheSnapshot, savedAt: number): Promise<number> {
  const gzip = zlib.createGzip({ level: 4 });
  const chunks: Buffer[] = [];
  const done = new Promise<void>((resolve, reject) => {
    gzip.on('data', (c: Buffer) => chunks.push(c));
    gzip.on('end', resolve);
    gzip.on('error', reject);
  });
  Readable.from(serialize(snap, savedAt), { objectMode: false, encoding: 'utf8' }).pipe(gzip);
  await done;
  const data = Buffer.concat(chunks);
  await writer.atomicWriteFile(CACHE_FILE, data);
  return data.length;
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function validRow(r: unknown): r is ParsedRow {
  if (typeof r !== 'object' || r === null) return false;
  const o = r as Record<string, unknown>;
  return isNum(o.ts) && isNum(o.offset) && typeof o.model === 'string' && isNum(o.input) && isNum(o.output) && isNum(o.cacheRead) && isNum(o.cacheWrite) && Array.isArray(o.tools);
}

function validStats(s: unknown): s is ParseStats {
  if (typeof s !== 'object' || s === null) return false;
  const o = s as Record<string, unknown>;
  for (const k of Object.keys(emptyParseStats())) {
    if (k === 'typeCounts') {
      if (typeof o.typeCounts !== 'object' || o.typeCounts === null) return false;
    } else if (!isNum(o[k])) return false;
  }
  return true;
}

function validFileMeta(m: Record<string, unknown>): boolean {
  return (
    typeof m.relPath === 'string' &&
    typeof m.projectKey === 'string' &&
    typeof m.isSubagentFile === 'boolean' &&
    typeof m.defaultSessionId === 'string' &&
    isNum(m.size) &&
    isNum(m.mtimeMs) &&
    isNum(m.offset) &&
    isNum(m.headLen) &&
    typeof m.headHash === 'string' &&
    isNum(m.tailLen) &&
    typeof m.tailHash === 'string' &&
    (m.firstTs === null || isNum(m.firstTs)) &&
    isNum(m.rowCount) &&
    (m.title === null || typeof m.title === 'string') &&
    Array.isArray(m.activity) &&
    m.activity.every(isNum) &&
    (m.lastEventTs === null || isNum(m.lastEventTs)) &&
    validStats(m.stats)
  );
}

/** 读取并校验缓存；任何问题都返回 {ok:false, reason}，不抛异常。 */
export async function loadCache(writer: AppDataWriter, expectedRoot: string): Promise<CacheLoadResult> {
  let raw: Buffer | null;
  try {
    raw = await writer.readFile(CACHE_FILE);
  } catch (e) {
    return { ok: false, reason: `读取失败：${(e as Error).message}` };
  }
  if (raw === null) return { ok: false, reason: 'missing' };
  const gz = raw;
  let text: string;
  try {
    const out = await new Promise<Buffer>((resolve, reject) => zlib.gunzip(gz, (err, o) => (err ? reject(err) : resolve(o))));
    text = out.toString('utf8');
  } catch {
    return { ok: false, reason: '缓存文件损坏（解压失败）' };
  }
  try {
    const files: FileState[] = [];
    const titleFiles: TitleFileState[] = [];
    let head: Record<string, unknown> | null = null;
    let end: Record<string, unknown> | null = null;
    let cur: { state: FileState; want: number } | null = null;
    const closeCur = (): boolean => {
      if (cur && cur.state.rows.length !== cur.want) return false;
      cur = null;
      return true;
    };
    let pos = 0;
    let n = 0;
    while (pos < text.length) {
      let nl = text.indexOf('\n', pos);
      if (nl < 0) nl = text.length;
      const line = text.slice(pos, nl);
      pos = nl + 1;
      if (line.length === 0) continue;
      const o = JSON.parse(line) as Record<string, unknown>;
      switch (o.t) {
        case 'head':
          if (o.schemaVersion !== CACHE_SCHEMA_VERSION) return { ok: false, reason: `缓存版本不符（${String(o.schemaVersion)} ≠ ${CACHE_SCHEMA_VERSION}）` };
          head = o;
          break;
        case 'file': {
          if (!closeCur() || !validFileMeta(o)) return { ok: false, reason: '缓存内容不合法（file）' };
          const { t: _t, rowCount, ...meta } = o;
          void _t;
          const state = { ...(meta as unknown as Omit<FileState, 'rows'>), rows: [] as ParsedRow[] };
          files.push(state);
          cur = { state, want: rowCount as number };
          break;
        }
        case 'rows': {
          const rows = o.rows;
          if (!cur || !Array.isArray(rows) || !rows.every(validRow)) return { ok: false, reason: '缓存内容不合法（rows）' };
          for (const r of rows as ParsedRow[]) cur.state.rows.push(r);
          break;
        }
        case 'title':
          if (!closeCur() || typeof o.relPath !== 'string' || typeof o.sessionId !== 'string' || !isNum(o.size) || !isNum(o.mtimeMs) || !(o.title === null || typeof o.title === 'string')) {
            return { ok: false, reason: '缓存内容不合法（title）' };
          }
          titleFiles.push({ relPath: o.relPath, sessionId: o.sessionId, size: o.size, mtimeMs: o.mtimeMs, title: o.title });
          break;
        case 'end':
          if (!closeCur()) return { ok: false, reason: '缓存内容不合法（行数不符）' };
          end = o;
          break;
        default:
          return { ok: false, reason: '缓存内容不合法（未知记录）' };
      }
      if (++n % 500 === 0) await tick();
    }
    if (!head || !end) return { ok: false, reason: '缓存文件不完整（缺少首尾记录）' };
    if (head.schemaVersion !== CACHE_SCHEMA_VERSION) return { ok: false, reason: `缓存版本不符（${String(head.schemaVersion)} ≠ ${CACHE_SCHEMA_VERSION}）` };
    if (head.dataRoot !== rootIdentity(expectedRoot)) return { ok: false, reason: '缓存对应的数据根目录不同' };
    if (end.files !== files.length || end.titleFiles !== titleFiles.length || head.files !== files.length || head.titleFiles !== titleFiles.length) {
      return { ok: false, reason: '缓存文件不完整（数量不符）' };
    }
    return { ok: true, snapshot: { dataRoot: expectedRoot, files, titleFiles }, bytes: gz.length };
  } catch {
    return { ok: false, reason: '缓存文件损坏（内容无法解析）' };
  }
}

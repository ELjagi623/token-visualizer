/**
 * 确定性合成 fixture 生成器。
 *
 * 用法：`npm run fixture`（写入 test/fixtures/projects/ 与 test/fixtures/expected.json）。
 *       `node scripts/make-fixture.ts --out <目录>` 写到别处（不写 expected.json）。
 *
 * 设计要点：
 * - 完全确定：无随机数、无当前时间；文件内容、目录结构、mtime 都固定，重复运行逐字节一致。
 * - expected.json 的所有数值都由下面的"声明式规格"直接推出（逐条声明的 message 用量求和、
 *   逐次声明的行数计数），**不 import 任何解析器 / 去重代码**。
 * - 覆盖 PRD 3.3 / PLAN 阶段 1 列出的 12 类数据陷阱。
 *
 * 术语：一个"逻辑 message"= 一个 message.id（或仅 requestId）；
 *       一次"出现（emission）"= 它在某个文件里被写成的连续若干行（流式 block）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MARK = 'SECRET_BODY_MARKER';
const FIXED_MTIME = new Date('2026-11-01T00:00:00.000Z');

// ---------------------------------------------------------------------------
// 声明式规格的类型
// ---------------------------------------------------------------------------

interface Usage {
  input: number;
  cw: number; // cache_creation_input_tokens
  cw5m: number;
  cw1h: number;
  cr: number;
  out: number;
  think: number;
  ws: number;
  wf: number;
}

function U(input: number, cw: number, cw5m: number, cw1h: number, cr: number, out: number, think: number, ws = 0, wf = 0): Usage {
  return { input, cw, cw5m, cw1h, cr, out, think, ws, wf };
}

interface Msg {
  /** 逻辑键：有 message.id 用 id；仅 requestId 用 requestId；皆无用 `noid:<n>`。 */
  key: string;
  id?: string;
  req?: string;
  model: string;
  iso: string;
  usage: Usage | null;
  omitBreakdown?: boolean;
  omitThinking?: boolean;
  tools?: string[];
  synthetic?: boolean;
  /** 各行 stop_reason（长度不足的行取 null）。 */
  stops?: Array<string | null>;
  effort?: string;
  /** 所有权文件（相对路径）——人工声明，用来对照被测代码的所有权规则。 */
  owner: string;
}

interface Emission {
  file: string;
  msg: Msg;
  rows: number;
}

interface FileCtx {
  rel: string;
  projectKey: string;
  sessionId: string;
  cwd: string;
  version: string;
  gitBranch: string;
  entrypoint: string;
  isSub: boolean;
  agentId?: string;
  crlf?: boolean;
  bom?: boolean;
}

type Style = 'compact' | 'typeFirst' | 'spaced';

// ---------------------------------------------------------------------------
// 构建器
// ---------------------------------------------------------------------------

class Fixture {
  files = new Map<string, FileBuilder>();
  extraFiles = new Map<string, string>(); // 非用量文件（custom-title / meta / prefix …）
  emissions: Emission[] = [];
  uuidCounter = 0;
  nextUuid(): string {
    this.uuidCounter++;
    return `00000000-0000-4000-8000-${this.uuidCounter.toString(16).padStart(12, '0')}`;
  }
  file(ctx: FileCtx): FileBuilder {
    const f = new FileBuilder(this, ctx);
    this.files.set(ctx.rel, f);
    return f;
  }
  extra(rel: string, content: string): void {
    this.extraFiles.set(rel, content);
  }
}

class FileBuilder {
  lines: string[] = [];
  tailText = '';
  validTypes: string[] = [];
  corrupt = 0;
  firstTs: number | null = null;
  prevUuid: string | null = null;
  readonly fx: Fixture;
  readonly ctx: FileCtx;
  constructor(fx: Fixture, ctx: FileCtx) {
    this.fx = fx;
    this.ctx = ctx;
  }

  private pushValid(obj: Record<string, unknown>, style: Style = 'compact'): void {
    let o = obj;
    if (style === 'typeFirst') {
      const { type, ...rest } = obj;
      o = { type, ...rest };
    }
    let s = JSON.stringify(o);
    if (style === 'spaced') s = JSON.stringify(o, null, 1).replace(/\n\s*/g, ' ');
    this.lines.push(s);
    this.validTypes.push(String(obj.type));
    const ts = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : NaN;
    if (this.firstTs === null && Number.isFinite(ts)) this.firstTs = ts;
  }

  /** 任意非 assistant 的合法 JSON 行。 */
  raw(obj: Record<string, unknown>): this {
    this.pushValid(obj);
    return this;
  }

  /** 损坏行（不是合法 JSON），带换行结尾。 */
  corruptLine(text: string): this {
    this.lines.push(text);
    this.corrupt++;
    return this;
  }

  /** 文件末尾没有换行的半行。 */
  tail(text: string): this {
    this.tailText = text;
    return this;
  }

  user(iso: string, text: string): this {
    this.pushValid({
      parentUuid: this.prevUuid,
      isSidechain: this.ctx.isSub,
      type: 'user',
      message: { role: 'user', content: text },
      uuid: this.nextUuid(),
      timestamp: iso,
      userType: 'external',
      entrypoint: this.ctx.entrypoint,
      cwd: this.ctx.cwd,
      sessionId: this.ctx.sessionId,
      version: this.ctx.version,
      gitBranch: this.ctx.gitBranch,
    });
    return this;
  }

  private nextUuid(): string {
    const u = this.fx.nextUuid();
    this.prevUuid = u;
    return u;
  }

  /** 写入一个逻辑 message 的 rows 行。 */
  msg(m: Msg, opts: { rows?: number; growing?: boolean; fullEachRow?: boolean; style?: Style } = {}): this {
    const rows = opts.rows ?? 1;
    this.fx.emissions.push({ file: this.ctx.rel, msg: m, rows });
    const baseMs = Date.parse(m.iso);
    const blocks = contentBlocks(m);
    if (!opts.fullEachRow && rows < blocks.length) throw new Error(`fixture 规格错误：${m.key} 有 ${blocks.length} 个 content block 但只写 ${rows} 行（会漏掉 block）`);
    for (let k = 0; k < rows; k++) {
      const ts = new Date(baseMs + k * 200).toISOString();
      const content = opts.fullEachRow ? blocks : [blocks[k % blocks.length]!];
      const message: Record<string, unknown> = {
        model: m.model,
        ...(m.id ? { id: m.id } : {}),
        type: 'message',
        role: 'assistant',
        content,
        stop_reason: m.stops?.[k] ?? null,
        stop_sequence: null,
      };
      if (m.usage) message.usage = usageJson(m, k, rows, !!opts.growing);
      const line: Record<string, unknown> = {
        parentUuid: this.prevUuid,
        isSidechain: this.ctx.isSub,
        ...(this.ctx.agentId ? { agentId: this.ctx.agentId } : {}),
        message,
        ...(m.req ? { requestId: m.req } : {}),
        type: 'assistant',
        uuid: this.nextUuid(),
        timestamp: ts,
        userType: 'external',
        entrypoint: this.ctx.entrypoint,
        cwd: this.ctx.cwd,
        sessionId: this.ctx.sessionId,
        version: this.ctx.version,
        gitBranch: this.ctx.gitBranch,
        ...(m.effort ? { effort: m.effort } : {}),
      };
      this.pushValid(line, opts.style ?? 'compact');
    }
    return this;
  }
}

function contentBlocks(m: Msg): Array<Record<string, unknown>> {
  if (m.tools && m.tools.length > 0) {
    const bs: Array<Record<string, unknown>> = [];
    if (m.usage && m.usage.think > 0) bs.push({ type: 'thinking', thinking: `thinking about ${MARK}`, signature: 'sig' });
    m.tools.forEach((name, i) => {
      bs.push({ type: 'tool_use', id: `toolu_${m.key}_${i}`, name, input: { command: `echo ${MARK}` }, caller: { type: 'direct' } });
    });
    return bs;
  }
  return [{ type: 'text', text: `reply text ${MARK}` }];
}

function usageJson(m: Msg, k: number, rows: number, growing: boolean): Record<string, unknown> {
  const u = m.usage!;
  const last = k === rows - 1;
  const scale = (v: number): number => (growing && !last ? Math.max(0, Math.floor((v * (k + 1)) / rows)) : v);
  const out: Record<string, unknown> = {
    input_tokens: u.input,
    cache_creation_input_tokens: u.cw,
    cache_read_input_tokens: u.cr,
    output_tokens: scale(u.out),
  };
  if (!m.omitThinking) out.output_tokens_details = { thinking_tokens: scale(u.think) };
  out.server_tool_use = { web_search_requests: u.ws, web_fetch_requests: u.wf };
  out.service_tier = 'standard';
  if (!m.omitBreakdown) out.cache_creation = { ephemeral_1h_input_tokens: u.cw1h, ephemeral_5m_input_tokens: u.cw5m };
  out.speed = 'standard';
  return out;
}

// ---------------------------------------------------------------------------
// 声明式规格：具体的项目 / 文件 / message
// ---------------------------------------------------------------------------

function buildSpec(): Fixture {
  const fx = new Fixture();
  const VERSION = '2.1.266';

  const ctx = (o: Partial<FileCtx> & Pick<FileCtx, 'rel' | 'projectKey' | 'sessionId' | 'cwd'>): FileCtx => ({
    version: VERSION,
    gitBranch: 'main',
    entrypoint: 'cli',
    isSub: false,
    ...o,
  });

  // ---------------- 项目 alpha：去重 / synthetic / 损坏 / 缺字段 / 子代理 / 跨文件重复 ----------------
  const ALPHA = 'D--Work-alpha';
  const ALPHA_CWD = 'D:\\Work\\alpha';
  const A1 = 'a1a1a1a1-0000-4000-8000-000000000001';
  const A2 = 'a1a1a1a1-0000-4000-8000-000000000002';
  const A1_FILE = `${ALPHA}/${A1}.jsonl`;
  const A2_FILE = `${ALPHA}/${A2}.jsonl`;
  const A1_SUB = `${ALPHA}/${A1}/subagents/agent-a1b2c3d4.jsonl`;

  const mStream: Msg = {
    key: 'msg_alpha_stream',
    id: 'msg_alpha_stream',
    req: 'req_alpha_stream',
    model: 'claude-sonnet-5-5',
    iso: '2026-10-05T01:00:05.000Z',
    usage: U(3, 1200, 200, 1000, 40000, 150, 90),
    stops: [null, null, 'end_turn', null], // "取最后一个非空"
    effort: 'high',
    owner: A1_FILE,
  };
  const mGrow: Msg = {
    key: 'msg_alpha_grow',
    id: 'msg_alpha_grow',
    req: 'req_alpha_grow',
    model: 'claude-opus-5-5',
    iso: '2026-10-05T01:01:00.000Z',
    usage: U(5, 800, 800, 0, 52000, 120, 60, 1, 0),
    tools: ['Bash', 'Read'],
    stops: [null, null, 'tool_use'],
    effort: 'xhigh',
    owner: A1_FILE,
  };
  const mSyn: Msg = {
    key: 'msg_alpha_syn',
    id: 'msg_alpha_syn',
    model: '<synthetic>',
    iso: '2026-10-05T01:02:00.000Z',
    usage: U(0, 0, 0, 0, 0, 0, 0),
    synthetic: true,
    owner: A1_FILE,
  };
  const mNoBreak: Msg = {
    key: 'msg_alpha_nobreak',
    id: 'msg_alpha_nobreak',
    req: 'req_alpha_nobreak',
    model: 'claude-sonnet-5',
    iso: '2026-10-05T01:03:00.000Z',
    usage: U(10, 300, 0, 0, 9000, 70, 0),
    omitBreakdown: true,
    omitThinking: true,
    owner: A1_FILE,
  };
  const mNoUsage: Msg = {
    key: 'msg_alpha_nousage',
    id: 'msg_alpha_nousage',
    req: 'req_alpha_nousage',
    model: 'claude-sonnet-5-5',
    iso: '2026-10-05T01:04:00.000Z',
    usage: null,
    owner: A1_FILE,
  };
  const mReqOnly: Msg = {
    key: 'req_alpha_only',
    req: 'req_alpha_only',
    model: 'claude-sonnet-5',
    iso: '2026-10-05T01:05:00.000Z',
    usage: U(2, 0, 0, 0, 0, 11, 0),
    owner: A1_FILE,
  };
  const mNoId: Msg = {
    key: 'noid:1',
    model: 'claude-sonnet-5',
    iso: '2026-10-05T01:06:00.000Z',
    usage: U(1, 0, 0, 0, 0, 5, 0),
    owner: A1_FILE,
  };
  const mStyle1: Msg = {
    key: 'msg_alpha_style1',
    id: 'msg_alpha_style1',
    req: 'req_alpha_style1',
    model: 'claude-haiku-4-5',
    iso: '2026-10-05T01:07:00.000Z',
    usage: U(4, 100, 100, 0, 1000, 33, 0),
    owner: A1_FILE,
  };
  const mStyle2: Msg = {
    key: 'msg_alpha_style2',
    id: 'msg_alpha_style2',
    req: 'req_alpha_style2',
    model: 'claude-haiku-4-5',
    iso: '2026-10-05T01:08:00.000Z',
    usage: U(6, 0, 0, 0, 2000, 44, 5),
    owner: A1_FILE,
  };

  const a1 = fx.file(ctx({ rel: A1_FILE, projectKey: ALPHA, sessionId: A1, cwd: ALPHA_CWD }));
  a1.raw({ type: 'mode', mode: 'normal', sessionId: A1 });
  a1.raw({ type: 'file-history-snapshot', messageId: 'snap-1', snapshot: { messageId: 'snap-1', trackedFileBackups: {}, timestamp: '2026-10-04T23:59:00.000Z' }, isSnapshotUpdate: false });
  // 首条带顶层 timestamp 的行是这条 user 行：firstTs = 2026-10-05T01:00:00Z
  a1.user('2026-10-05T01:00:00.000Z', `Please refactor the parser module and keep going ${MARK} this tail must never be stored`);
  a1.msg(mStream, { rows: 4 });
  a1.raw({ type: 'system', subtype: 'info', content: 'system note', timestamp: '2026-10-05T01:00:30.000Z', sessionId: A1 });
  a1.msg(mGrow, { rows: 3, growing: true });
  a1.corruptLine('{"type":"assistant","message":{"id":"msg_truncated","model":"claude-sonnet-5","usage":{"input_tokens":9');
  a1.corruptLine('this is not json at all');
  a1.raw({ type: 'future-type-xyz', timestamp: '2026-10-05T01:01:30.000Z', whatever: true });
  a1.msg(mSyn, { rows: 2 });
  a1.msg(mNoBreak);
  a1.msg(mNoUsage);
  a1.msg(mReqOnly, { rows: 2 });
  a1.msg(mNoId);
  a1.msg(mStyle1, { style: 'typeFirst' });
  a1.msg(mStyle2, { style: 'spaced' });
  a1.raw({ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-10-05T01:09:00.000Z', sessionId: A1 });
  // 末尾半行（没有换行符）：解析器必须不消费它，也不算损坏行
  a1.tail('{"parentUuid":null,"isSidechain":false,"type":"assistant","message":{"id":"msg_alpha_tail","model":"claude-sonnet-5","usage":{"input_tokens":77,');
  fx.extra(`${ALPHA}/${A1}/custom-title.json`, `${JSON.stringify({ customTitle: 'Refactor the parser' })}\n`);

  // 子代理
  const SUB_AGENT = 'a1b2c3d4';
  const mSub1: Msg = {
    key: 'msg_alpha_sub1',
    id: 'msg_alpha_sub1',
    req: 'req_alpha_sub1',
    model: 'claude-sonnet-5-5',
    iso: '2026-10-05T01:02:10.000Z',
    usage: U(2, 500, 0, 500, 20000, 80, 20),
    tools: ['Grep'],
    owner: A1_SUB,
  };
  const mSub2: Msg = {
    key: 'msg_alpha_sub2',
    id: 'msg_alpha_sub2',
    req: 'req_alpha_sub2',
    model: 'claude-haiku-4-5',
    iso: '2026-10-05T01:02:30.000Z',
    usage: U(7, 0, 0, 0, 3000, 60, 0),
    tools: ['Read', 'Read'],
    owner: A1_SUB,
  };
  const sub = fx.file(ctx({ rel: A1_SUB, projectKey: ALPHA, sessionId: A1, cwd: ALPHA_CWD, isSub: true, agentId: SUB_AGENT }));
  sub.user('2026-10-05T01:02:05.000Z', `Explore the code base ${MARK} subagent prompt body`);
  sub.msg(mSub1, { rows: 2 });
  sub.msg(mSub2, { rows: 2, fullEachRow: true }); // 每行都含全部 block：按 block id 去重后 Read 仍是 2 次
  fx.extra(`${ALPHA}/${A1}/subagents/agent-a1b2c3d4.meta.json`, `${JSON.stringify({ agentType: 'Explore', description: `body ${MARK}` })}\n`);
  fx.extra(`${ALPHA}/${A1}/subagents/agent-a1b2c3d4.prefix.json`, `${JSON.stringify({ prefix: `prefix body ${MARK}` })}\n`);

  // 恢复会话：复制 mStream / mGrow 的全部行（同 id，sessionId 是新的），再追加自己的新消息
  const mA2Own1: Msg = {
    key: 'msg_alpha_a2own1',
    id: 'msg_alpha_a2own1',
    req: 'req_alpha_a2own1',
    model: 'claude-opus-5-5',
    iso: '2026-10-06T09:00:30.000Z',
    usage: U(6, 2400, 0, 2400, 61000, 310, 120),
    tools: ['Edit'],
    owner: A2_FILE,
  };
  const mA2Own2: Msg = {
    key: 'msg_alpha_a2own2',
    id: 'msg_alpha_a2own2',
    req: 'req_alpha_a2own2',
    model: 'claude-sonnet-5-5',
    iso: '2026-10-06T09:02:00.000Z',
    usage: U(2, 15000, 15000, 0, 700, 25, 0),
    owner: A2_FILE,
  };
  const a2 = fx.file(ctx({ rel: A2_FILE, projectKey: ALPHA, sessionId: A2, cwd: ALPHA_CWD }));
  a2.raw({ type: 'mode', mode: 'normal', sessionId: A2 });
  a2.user('2026-10-06T09:00:00.000Z', 'Resume the previous session');
  a2.msg(mStream, { rows: 4 });
  a2.msg(mGrow, { rows: 3, growing: true });
  a2.msg(mA2Own1, { rows: 2, growing: true });
  a2.msg(mA2Own2);

  // ---------------- 项目 beta：同一文件夹 2 个不同 cwd；所有权并列 / 路径字典序 ----------------
  const BETA = 'D--Work-beta';
  const B0 = 'bbbbbbbb-0000-4000-8000-000000000000';
  const B1 = 'bbbbbbbb-0000-4000-8000-000000000001';
  const B2 = 'bbbbbbbb-0000-4000-8000-000000000002';
  const B0_FILE = `${BETA}/${B0}.jsonl`;
  const B1_FILE = `${BETA}/${B1}.jsonl`;
  const B2_FILE = `${BETA}/${B2}.jsonl`;
  const tie: Msg = {
    key: 'msg_beta_tie',
    id: 'msg_beta_tie',
    req: 'req_beta_tie',
    model: 'claude-opus-5',
    iso: '2026-10-10T02:00:10.000Z',
    usage: U(8, 400, 400, 0, 12000, 90, 30),
    // B1 与 B2 的 firstTs 相同 → 按路径字典序取 B1；B0 路径最小但 firstTs 更晚 → 不该拥有
    owner: B1_FILE,
  };
  const mB1: Msg = { key: 'msg_beta_b1', id: 'msg_beta_b1', req: 'req_beta_b1', model: 'claude-opus-5', iso: '2026-10-10T02:01:00.000Z', usage: U(1, 100, 0, 100, 5000, 40, 0), owner: B1_FILE };
  const mB1b: Msg = { key: 'msg_beta_b1b', id: 'msg_beta_b1b', req: 'req_beta_b1b', model: 'claude-opus-5', iso: '2026-10-10T02:02:00.000Z', usage: U(1, 50, 0, 50, 6000, 41, 0), owner: B1_FILE };
  const mB2: Msg = { key: 'msg_beta_b2', id: 'msg_beta_b2', req: 'req_beta_b2', model: 'claude-sonnet-5', iso: '2026-10-10T02:01:30.000Z', usage: U(2, 0, 0, 0, 7000, 42, 0), owner: B2_FILE };
  const mB0: Msg = { key: 'msg_beta_b0', id: 'msg_beta_b0', req: 'req_beta_b0', model: 'claude-sonnet-5', iso: '2026-10-10T03:00:10.000Z', usage: U(3, 0, 0, 0, 8000, 43, 0), owner: B0_FILE };
  const mB0b: Msg = { key: 'msg_beta_b0b', id: 'msg_beta_b0b', req: 'req_beta_b0b', model: 'claude-sonnet-5', iso: '2026-10-10T03:01:10.000Z', usage: U(3, 0, 0, 0, 9000, 44, 0), owner: B0_FILE };

  const b1 = fx.file(ctx({ rel: B1_FILE, projectKey: BETA, sessionId: B1, cwd: 'D:\\Work\\beta' }));
  b1.user('2026-10-10T02:00:00.000Z', 'beta one');
  b1.msg(tie).msg(mB1).msg(mB1b);
  const b2 = fx.file(ctx({ rel: B2_FILE, projectKey: BETA, sessionId: B2, cwd: 'D:\\Work\\beta\\sub' }));
  b2.user('2026-10-10T02:00:00.000Z', 'beta two');
  b2.msg(tie).msg(mB2);
  const b0 = fx.file(ctx({ rel: B0_FILE, projectKey: BETA, sessionId: B0, cwd: 'D:\\Work\\beta' }));
  b0.user('2026-10-10T03:00:00.000Z', 'beta zero');
  b0.msg(tie).msg(mB0).msg(mB0b);

  // ---------------- 项目 demo：中文用户名（有损文件夹名）+ 本地模型 + 常规时间序列 ----------------
  const DEMO = 'C--Users-----Work-demo';
  const DEMO_CWD = 'C:\\Users\\王测试\\Work\\demo';
  const D1 = 'dddddddd-0000-4000-8000-000000000001';
  const D1_FILE = `${DEMO}/${D1}.jsonl`;
  const d1 = fx.file(ctx({ rel: D1_FILE, projectKey: DEMO, sessionId: D1, cwd: DEMO_CWD, entrypoint: 'claude-desktop' }));
  d1.user('2026-10-08T03:00:00.000Z', 'demo start');
  const mLocalPath: Msg = {
    key: 'msg_demo_gguf',
    id: 'msg_demo_gguf',
    req: 'req_demo_gguf',
    model: 'C:\\Users\\x\\Models\\Qwen3-35B-A3B-Q4_K_M.gguf',
    iso: '2026-10-08T03:01:00.000Z',
    usage: U(1200, 0, 0, 0, 0, 300, 0),
    omitBreakdown: true,
    omitThinking: true,
    owner: D1_FILE,
  };
  const mLocalOrg: Msg = {
    key: 'msg_demo_qwen',
    id: 'msg_demo_qwen',
    req: 'req_demo_qwen',
    model: 'qwen/qwen3-coder-next',
    iso: '2026-10-08T03:02:00.000Z',
    usage: U(900, 0, 0, 0, 0, 210, 0),
    omitBreakdown: true,
    omitThinking: true,
    owner: D1_FILE,
  };
  d1.msg(mLocalPath, { rows: 2 }).msg(mLocalOrg);
  // 常规序列：每天一条，轮换三个云端模型
  const rotation = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-4-5'];
  for (let i = 0; i < 12; i++) {
    const day = 9 + i * 3; // 2026-10-09, 12, 15 … 跨月到 11 月
    const date = new Date(Date.UTC(2026, 9, day, 6 + (i % 5), 10, 0));
    const m: Msg = {
      key: `msg_demo_reg${i}`,
      id: `msg_demo_reg${i}`,
      req: `req_demo_reg${i}`,
      model: rotation[i % 3]!,
      iso: date.toISOString(),
      usage: U(2 + i, 1000 * (i + 1), i % 2 === 0 ? 1000 * (i + 1) : 0, i % 2 === 0 ? 0 : 1000 * (i + 1), 20000 + 3000 * i, 100 + 17 * i, (i % 3) * 40, i === 4 ? 2 : 0, i === 5 ? 1 : 0),
      tools: i % 2 === 0 ? ['Bash'] : i % 4 === 1 ? ['Read', 'Edit'] : undefined,
      owner: D1_FILE,
    };
    d1.msg(m, { rows: 1 + (i % 3), fullEachRow: !!m.tools });
  }

  // ---------------- 项目 timeprobe：时间戳覆盖（日 / 周 / 月 / DST / 非整点偏移） ----------------
  const TP = 'D--Work-timeprobe';
  const T1 = 'tttttttt-0000-4000-8000-000000000001';
  const T1_FILE = `${TP}/${T1}.jsonl`;
  const t1 = fx.file(ctx({ rel: T1_FILE, projectKey: TP, sessionId: T1, cwd: 'D:\\Work\\timeprobe' }));
  // [id, ISO] —— 各时区的本地日期由下方 PROBE_LOCAL 手工列出
  const probeList: Array<[string, string]> = [
    ['tp_ny_spring_a', '2026-03-08T06:59:59.000Z'],
    ['tp_ny_spring_b', '2026-03-08T07:00:00.000Z'],
    ['tp_month_a', '2026-09-30T15:59:59.000Z'],
    ['tp_month_b', '2026-09-30T16:00:00.000Z'],
    ['tp_sh_day_a', '2026-10-10T15:59:59.000Z'],
    ['tp_sh_day_b', '2026-10-10T16:00:00.000Z'],
    ['tp_ist_a', '2026-10-10T18:29:59.000Z'],
    ['tp_ist_b', '2026-10-10T18:30:00.000Z'],
    ['tp_week_a', '2026-10-11T15:59:59.000Z'],
    ['tp_week_b', '2026-10-11T16:00:00.000Z'],
    ['tp_utc_month_a', '2026-10-31T23:59:59.000Z'],
    ['tp_utc_month_b', '2026-11-01T00:00:00.000Z'],
    ['tp_ny_fall_a', '2026-11-01T05:30:00.000Z'],
    ['tp_ny_fall_b', '2026-11-01T06:30:00.000Z'],
    ['tp_ny_fall_c', '2026-11-02T04:59:59.000Z'],
    ['tp_ny_fall_d', '2026-11-02T05:00:00.000Z'],
  ];
  probeList.forEach(([id, iso], i) => {
    const m: Msg = { key: `msg_${id}`, id: `msg_${id}`, req: `req_${id}`, model: 'claude-sonnet-5-5', iso, usage: U(1, 10, 10, 0, 100 + i, 20 + i, 0), owner: T1_FILE };
    t1.msg(m);
  });

  // ---------------- Scratch 项目 ×3（桌面版临时对话） ----------------
  const scratchDefs = [
    { u1: '11111111-aaaa-4aaa-8aaa-111111111111', u2: '22222222-bbbb-4bbb-8bbb-222222222222', tag: 'scratch-2026-10-11-abc123', sid: 'cccccccc-1111-4111-8111-000000000001', iso: '2026-10-11T08:00:00.000Z' },
    { u1: '33333333-aaaa-4aaa-8aaa-333333333333', u2: '44444444-bbbb-4bbb-8bbb-444444444444', tag: 'scratch-2026-10-12-def456', sid: 'cccccccc-2222-4222-8222-000000000002', iso: '2026-10-12T08:00:00.000Z' },
    { u1: '55555555-aaaa-4aaa-8aaa-555555555555', u2: '66666666-bbbb-4bbb-8bbb-666666666666', tag: 'scratch-2026-10-13-789abc', sid: 'cccccccc-3333-4333-8333-000000000003', iso: '2026-10-13T08:00:00.000Z' },
  ];
  scratchDefs.forEach((s, i) => {
    const folder = `C--Users-x-AppData-Roaming-Claude-scratch-workspaces-${s.u1}-${s.u2}-${s.tag}`;
    const cwd = `C:\\Users\\王测试\\AppData\\Roaming\\Claude\\scratch-workspaces\\${s.u1}\\${s.u2}\\${s.tag}`;
    const rel = `${folder}/${s.sid}.jsonl`;
    const f = fx.file(ctx({ rel, projectKey: folder, sessionId: s.sid, cwd, entrypoint: 'claude-desktop' }));
    f.user(s.iso, `scratch chat ${i}`);
    for (let j = 0; j < 2 + i; j++) {
      const iso = new Date(Date.parse(s.iso) + (j + 1) * 60_000).toISOString();
      f.msg({ key: `msg_scratch${i}_${j}`, id: `msg_scratch${i}_${j}`, req: `req_scratch${i}_${j}`, model: 'claude-sonnet-5-5', iso, usage: U(3, 500 * (j + 1), 0, 500 * (j + 1), 9000 + 100 * j, 60 + 5 * i, 10 * j), owner: rel });
    }
  });

  // ---------------- 空文件 ----------------
  const EMPTY = 'D--Work-empty';
  fx.file(ctx({ rel: `${EMPTY}/eeeeeeee-0000-4000-8000-000000000001.jsonl`, projectKey: EMPTY, sessionId: 'eeeeeeee-0000-4000-8000-000000000001', cwd: 'D:\\Work\\empty' }));
  fx.file(ctx({ rel: `${EMPTY}/eeeeeeee-0000-4000-8000-000000000002.jsonl`, projectKey: EMPTY, sessionId: 'eeeeeeee-0000-4000-8000-000000000002', cwd: 'D:\\Work\\empty' }));

  // ---------------- CRLF + BOM ----------------
  const CRLF = 'D--Work-crlf';
  const C1 = 'cccccccc-0000-4000-8000-000000000001';
  const C1_FILE = `${CRLF}/${C1}.jsonl`;
  const c1 = fx.file(ctx({ rel: C1_FILE, projectKey: CRLF, sessionId: C1, cwd: 'D:\\Work\\crlf', crlf: true, bom: true }));
  c1.raw({ type: 'mode', mode: 'normal', sessionId: C1 });
  c1.user('2026-10-20T10:00:00.000Z', 'crlf file');
  c1.msg({ key: 'msg_crlf_1', id: 'msg_crlf_1', req: 'req_crlf_1', model: 'claude-sonnet-5-5', iso: '2026-10-20T10:00:05.000Z', usage: U(5, 200, 0, 200, 3000, 50, 10), owner: C1_FILE });
  c1.msg({ key: 'msg_crlf_2', id: 'msg_crlf_2', req: 'req_crlf_2', model: 'claude-opus-5-5', iso: '2026-10-20T10:01:05.000Z', usage: U(5, 0, 0, 0, 4000, 70, 0), owner: C1_FILE });

  return fx;
}

/** 各 probe 在各时区的本地日期（手工推算，独立于任何时间库）。 */
const PROBE_LOCAL: Record<string, Record<string, string>> = {
  tp_ny_spring_a: { UTC: '2026-03-08', 'Asia/Shanghai': '2026-03-08', 'America/New_York': '2026-03-08', 'Asia/Kolkata': '2026-03-08' },
  tp_ny_spring_b: { UTC: '2026-03-08', 'Asia/Shanghai': '2026-03-08', 'America/New_York': '2026-03-08', 'Asia/Kolkata': '2026-03-08' },
  tp_month_a: { UTC: '2026-09-30', 'Asia/Shanghai': '2026-09-30', 'America/New_York': '2026-09-30', 'Asia/Kolkata': '2026-09-30' },
  tp_month_b: { UTC: '2026-09-30', 'Asia/Shanghai': '2026-10-01', 'America/New_York': '2026-09-30', 'Asia/Kolkata': '2026-09-30' },
  tp_sh_day_a: { UTC: '2026-10-10', 'Asia/Shanghai': '2026-10-10', 'America/New_York': '2026-10-10', 'Asia/Kolkata': '2026-10-10' },
  tp_sh_day_b: { UTC: '2026-10-10', 'Asia/Shanghai': '2026-10-11', 'America/New_York': '2026-10-10', 'Asia/Kolkata': '2026-10-10' },
  tp_ist_a: { UTC: '2026-10-10', 'Asia/Shanghai': '2026-10-11', 'America/New_York': '2026-10-10', 'Asia/Kolkata': '2026-10-10' },
  tp_ist_b: { UTC: '2026-10-10', 'Asia/Shanghai': '2026-10-11', 'America/New_York': '2026-10-10', 'Asia/Kolkata': '2026-10-11' },
  tp_week_a: { UTC: '2026-10-11', 'Asia/Shanghai': '2026-10-11', 'America/New_York': '2026-10-11', 'Asia/Kolkata': '2026-10-11' },
  tp_week_b: { UTC: '2026-10-11', 'Asia/Shanghai': '2026-10-12', 'America/New_York': '2026-10-11', 'Asia/Kolkata': '2026-10-11' },
  tp_utc_month_a: { UTC: '2026-10-31', 'Asia/Shanghai': '2026-11-01', 'America/New_York': '2026-10-31', 'Asia/Kolkata': '2026-11-01' },
  tp_utc_month_b: { UTC: '2026-11-01', 'Asia/Shanghai': '2026-11-01', 'America/New_York': '2026-10-31', 'Asia/Kolkata': '2026-11-01' },
  tp_ny_fall_a: { UTC: '2026-11-01', 'Asia/Shanghai': '2026-11-01', 'America/New_York': '2026-11-01', 'Asia/Kolkata': '2026-11-01' },
  tp_ny_fall_b: { UTC: '2026-11-01', 'Asia/Shanghai': '2026-11-01', 'America/New_York': '2026-11-01', 'Asia/Kolkata': '2026-11-01' },
  tp_ny_fall_c: { UTC: '2026-11-02', 'Asia/Shanghai': '2026-11-02', 'America/New_York': '2026-11-01', 'Asia/Kolkata': '2026-11-02' },
  tp_ny_fall_d: { UTC: '2026-11-02', 'Asia/Shanghai': '2026-11-02', 'America/New_York': '2026-11-02', 'Asia/Kolkata': '2026-11-02' },
};

// ---------------------------------------------------------------------------
// 由规格推出 expected.json（只对声明的数据做加法 / 计数）
// ---------------------------------------------------------------------------

const ZERO = (): Usage => U(0, 0, 0, 0, 0, 0, 0, 0, 0);

function addUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    cw: a.cw + b.cw,
    cw5m: a.cw5m + b.cw5m,
    cw1h: a.cw1h + b.cw1h,
    cr: a.cr + b.cr,
    out: a.out + b.out,
    think: a.think + b.think,
    ws: a.ws + b.ws,
    wf: a.wf + b.wf,
  };
}

function totalsJson(u: Usage): Record<string, number> {
  return {
    input: u.input,
    cacheWrite: u.cw,
    cacheWrite5m: u.cw5m,
    cacheWrite1h: u.cw1h,
    cacheRead: u.cr,
    output: u.out,
    thinking: u.think,
    webSearch: u.ws,
    webFetch: u.wf,
    total: u.input + u.cw + u.cr + u.out,
    fresh: u.input + u.cw + u.out,
  };
}

function lastSegment(p: string): string {
  const parts = p.split('\\').filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function deriveExpected(fx: Fixture): Record<string, unknown> {
  // --- 逻辑 message 去重集合（按声明） ---
  const unique = new Map<string, Msg>();
  const filesOfKey = new Map<string, Set<string>>();
  const rowsOfKey = new Map<string, number>();
  let assistantRows = 0;
  let syntheticExcluded = 0;
  let missingId = 0;
  let missingUsage = 0;
  let missingCacheBreakdown = 0;
  let missingThinking = 0;
  let noIdRecords = 0;

  for (const e of fx.emissions) {
    assistantRows += e.rows;
    const m = e.msg;
    if (m.synthetic) {
      syntheticExcluded += e.rows;
      continue;
    }
    if (m.usage === null) missingUsage += e.rows;
    else {
      if (m.omitBreakdown) missingCacheBreakdown += e.rows;
      if (m.omitThinking) missingThinking += e.rows;
    }
    if (!m.id && !m.req) {
      missingId += e.rows;
      noIdRecords += e.rows;
      continue;
    }
    unique.set(m.key, m);
    if (!filesOfKey.has(m.key)) filesOfKey.set(m.key, new Set());
    filesOfKey.get(m.key)!.add(e.file);
    rowsOfKey.set(m.key, (rowsOfKey.get(m.key) ?? 0) + e.rows);
  }
  // 无 id 的行各自独立成记录：把它们也放进列表（key 唯一化）
  const noIdMsgs: Msg[] = [];
  for (const e of fx.emissions) {
    if (!e.msg.synthetic && !e.msg.id && !e.msg.req) for (let r = 0; r < e.rows; r++) noIdMsgs.push({ ...e.msg, key: `${e.msg.key}#${r}` });
  }

  const keyedRows = [...rowsOfKey.values()].reduce((a, b) => a + b, 0);
  const crossFileDuplicates = [...filesOfKey.values()].filter((s) => s.size > 1).length;

  // --- 文件级统计 ---
  let linesRead = 0;
  let corruptLines = 0;
  let emptyFiles = 0;
  const typeCounts: Record<string, number> = {};
  const fileInfos: Array<Record<string, unknown>> = [];
  const sortedFiles = [...fx.files.values()].sort((a, b) => (a.ctx.rel < b.ctx.rel ? -1 : 1));
  for (const f of sortedFiles) {
    linesRead += f.lines.length;
    corruptLines += f.corrupt;
    if (f.lines.length === 0 && f.tailText === '') emptyFiles++;
    for (const t of f.validTypes) typeCounts[t] = (typeCounts[t] ?? 0) + 1;
    const content = renderFile(f);
    fileInfos.push({
      path: f.ctx.rel,
      sizeBytes: Buffer.byteLength(content, 'utf8'),
      firstTs: f.firstTs,
      pendingTailBytes: Buffer.byteLength(f.tailText, 'utf8'),
      isSubagent: f.ctx.isSub,
      lines: f.lines.length,
    });
  }

  // --- 逐 message 期望 ---
  const allMsgs: Msg[] = [...unique.values(), ...noIdMsgs];
  allMsgs.sort((a, b) => (Date.parse(a.iso) !== Date.parse(b.iso) ? Date.parse(a.iso) - Date.parse(b.iso) : a.key < b.key ? -1 : 1));
  let totals = ZERO();
  const messages: Record<string, unknown> = {};
  const noIdMessages: Array<Record<string, unknown>> = [];
  const byProject = new Map<string, { records: number; usage: Usage; cwdCounts: Map<string, number> }>();
  const bySession = new Map<string, { records: number; usage: Usage; sidechainRecords: number }>();
  const byModel = new Map<string, { records: number; usage: Usage }>();
  const sidechain = { records: 0, usage: ZERO() };
  const toolCounts: Record<string, number> = {};

  for (const m of allMsgs) {
    const u = m.usage ?? ZERO();
    totals = addUsage(totals, u);
    const owner = fx.files.get(m.owner)!;
    const mu = m.omitBreakdown ? { ...u, cw5m: 0, cw1h: 0 } : u;
    const tools: Record<string, number> = {};
    for (const t of m.tools ?? []) tools[t] = (tools[t] ?? 0) + 1;
    for (const [t, n] of Object.entries(tools)) toolCounts[t] = (toolCounts[t] ?? 0) + n;
    const lastStop = [...(m.stops ?? [])].reverse().find((s) => s) ?? undefined;
    const isKeyed = !!(m.id || m.req);
    const entry = {
      key: m.key,
      ts: Date.parse(m.iso),
      model: m.model,
      sessionId: owner.ctx.sessionId,
      projectKey: owner.ctx.projectKey,
      cwd: owner.ctx.cwd,
      isSidechain: owner.ctx.isSub,
      agentId: owner.ctx.agentId ?? null,
      sourceFile: m.owner,
      stopReason: lastStop ?? null,
      effort: m.effort ?? null,
      requestId: m.req ?? null,
      tools,
      ...totalsJson(mu),
    };
    if (isKeyed) messages[m.id ?? m.req!] = entry;
    else noIdMessages.push(entry);
    const p = byProject.get(owner.ctx.projectKey) ?? { records: 0, usage: ZERO(), cwdCounts: new Map() };
    p.records++;
    p.usage = addUsage(p.usage, u);
    p.cwdCounts.set(owner.ctx.cwd, (p.cwdCounts.get(owner.ctx.cwd) ?? 0) + 1);
    byProject.set(owner.ctx.projectKey, p);
    const s = bySession.get(owner.ctx.sessionId) ?? { records: 0, usage: ZERO(), sidechainRecords: 0 };
    s.records++;
    s.usage = addUsage(s.usage, u);
    if (owner.ctx.isSub) s.sidechainRecords++;
    bySession.set(owner.ctx.sessionId, s);
    const md = byModel.get(m.model) ?? { records: 0, usage: ZERO() };
    md.records++;
    md.usage = addUsage(md.usage, u);
    byModel.set(m.model, md);
    if (owner.ctx.isSub) {
      sidechain.records++;
      sidechain.usage = addUsage(sidechain.usage, u);
    }
  }

  // --- 项目期望（供阶段 2/4 使用） ---
  const projectKeys = [...new Set(sortedFiles.map((f) => f.ctx.projectKey))].sort();
  const projects = projectKeys.map((pk) => {
    const p = byProject.get(pk);
    const cwds = p ? [...p.cwdCounts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)) : [];
    const mainCwd = cwds[0]?.[0] ?? null;
    return {
      projectKey: pk,
      records: p?.records ?? 0,
      total: p ? totalsJson(p.usage).total : 0,
      cwds: cwds.map(([c]) => c),
      displayName: mainCwd ? lastSegment(mainCwd) : pk,
      path: mainCwd,
      isScratch: /scratch-workspaces/.test(pk),
    };
  });

  const scratchFolders = projects.filter((p) => p.isScratch).length;

  const sessions: Record<string, unknown> = {};
  for (const [sid, s] of [...bySession.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    sessions[sid] = { records: s.records, sidechainRecords: s.sidechainRecords, ...totalsJson(s.usage) };
  }
  const models: Record<string, unknown> = {};
  for (const [name, v] of [...byModel.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    models[name] = { records: v.records, ...totalsJson(v.usage) };
  }

  const sortedTypeCounts = Object.fromEntries(Object.entries(typeCounts).sort((a, b) => (a[0] < b[0] ? -1 : 1)));

  return {
    note: '由 scripts/make-fixture.ts 的声明式规格推出；不是被测代码的输出。请勿手改，重新运行 `npm run fixture`。',
    stats: {
      filesParsed: sortedFiles.length,
      linesRead,
      assistantRows,
      uniqueMessages: unique.size + noIdRecords,
      duplicatesDropped: keyedRows - unique.size,
      crossFileDuplicates,
      syntheticExcluded,
      corruptLines,
      emptyFiles,
      missingId,
      typeCounts: sortedTypeCounts,
      missingTimestamp: 0,
      missingUsage,
      missingCacheBreakdown,
      missingThinking,
    },
    totals: totalsJson(totals),
    tools: Object.fromEntries(Object.entries(toolCounts).sort((a, b) => (a[0] < b[0] ? -1 : 1))),
    sidechain: { records: sidechain.records, ...totalsJson(sidechain.usage) },
    projects,
    projectFolderCount: projectKeys.length,
    scratchFolderCount: scratchFolders,
    sessions,
    models,
    files: fileInfos,
    timeProbes: probeListFromMessages(allMsgs),
    phase2: derivePhase2(allMsgs),
    messages,
    noIdMessages,
  };
}

// ---------------------------------------------------------------------------
// 阶段 2 期望：按本地日汇总、固定"当前时间"下的 今日 / 昨日 / 本周 / 本月
// （纯算术：固定偏移 + 2026 年美东 DST 窗口；不使用 Intl / 时区库）
// ---------------------------------------------------------------------------

const NY_DST_START = Date.UTC(2026, 2, 8, 7, 0, 0); // 2026-03-08 02:00 EST → 03:00 EDT
const NY_DST_END = Date.UTC(2026, 10, 1, 6, 0, 0); // 2026-11-01 02:00 EDT → 01:00 EST

function tzOffsetMinutes(tz: string, tsMs: number): number {
  switch (tz) {
    case 'UTC':
      return 0;
    case 'Asia/Shanghai':
      return 480;
    case 'Asia/Kolkata':
      return 330;
    case 'America/New_York':
      return tsMs >= NY_DST_START && tsMs < NY_DST_END ? -240 : -300;
    default:
      throw new Error(`fixture 生成器不支持时区 ${tz}`);
  }
}

function localDateOf(tsMs: number, tz: string): string {
  return new Date(tsMs + tzOffsetMinutes(tz, tsMs) * 60_000).toISOString().slice(0, 10);
}

function addDaysStr(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

function derivePhase2(msgs: Msg[]): Record<string, unknown> {
  const tzs = ['UTC', 'Asia/Shanghai', 'America/New_York', 'Asia/Kolkata'];
  type Day = { requests: number; total: number; fresh: number };
  const daily: Record<string, Record<string, Day>> = {};
  for (const tz of tzs) {
    const m: Record<string, Day> = {};
    for (const msg of msgs) {
      const u = msg.usage ?? ZERO();
      const d = localDateOf(Date.parse(msg.iso), tz);
      const e = (m[d] ??= { requests: 0, total: 0, fresh: 0 });
      e.requests++;
      e.total += u.input + u.cw + u.cr + u.out;
      e.fresh += u.input + u.cw + u.out;
    }
    daily[tz] = Object.fromEntries(Object.entries(m).sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  }
  const sumRange = (tz: string, from: string, to: string): Record<string, unknown> => {
    const t: Day = { requests: 0, total: 0, fresh: 0 };
    for (const [d, v] of Object.entries(daily[tz]!)) {
      if (d >= from && d <= to) {
        t.requests += v.requests;
        t.total += v.total;
        t.fresh += v.fresh;
      }
    }
    return { from, to, ...t };
  };
  const cases = [
    { name: 'shanghai-tue-monday-start', nowIso: '2026-10-20T12:00:00.000Z', tz: 'Asia/Shanghai', weekStart: 'monday' },
    { name: 'shanghai-tue-sunday-start', nowIso: '2026-10-20T12:00:00.000Z', tz: 'Asia/Shanghai', weekStart: 'sunday' },
    { name: 'shanghai-just-after-midnight', nowIso: '2026-10-11T16:30:00.000Z', tz: 'Asia/Shanghai', weekStart: 'monday' },
    { name: 'newyork-dst-end-sunday-start', nowIso: '2026-11-01T12:00:00.000Z', tz: 'America/New_York', weekStart: 'sunday' },
    { name: 'newyork-dst-end-monday-start', nowIso: '2026-11-01T12:00:00.000Z', tz: 'America/New_York', weekStart: 'monday' },
    { name: 'utc-month-start', nowIso: '2026-11-01T00:00:00.000Z', tz: 'UTC', weekStart: 'monday' },
  ];
  const nowCases = cases.map((c) => {
    const today = localDateOf(Date.parse(c.nowIso), c.tz);
    const wd = new Date(`${today}T00:00:00Z`).getUTCDay(); // 0 = 周日
    const back = c.weekStart === 'monday' ? (wd + 6) % 7 : wd;
    const weekFrom = addDaysStr(today, -back);
    const y = Number(today.slice(0, 4));
    const mo = Number(today.slice(5, 7));
    const monthFrom = `${today.slice(0, 7)}-01`;
    const monthTo = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
    const prevMonthTo = addDaysStr(monthFrom, -1);
    const prevMonthFrom = `${prevMonthTo.slice(0, 7)}-01`;
    return {
      ...c,
      localToday: today,
      today: sumRange(c.tz, today, today),
      yesterday: sumRange(c.tz, addDaysStr(today, -1), addDaysStr(today, -1)),
      thisWeek: sumRange(c.tz, weekFrom, addDaysStr(weekFrom, 6)),
      prevWeek: sumRange(c.tz, addDaysStr(weekFrom, -7), addDaysStr(weekFrom, -1)),
      thisMonth: sumRange(c.tz, monthFrom, monthTo),
      prevMonth: sumRange(c.tz, prevMonthFrom, prevMonthTo),
    };
  });
  return { dailyTotals: daily, nowCases };
}

function probeListFromMessages(msgs: Msg[]): Array<Record<string, unknown>> {
  return msgs
    .filter((m) => m.key.startsWith('msg_tp_'))
    .map((m) => ({ id: m.id, iso: m.iso, ts: Date.parse(m.iso), localDate: PROBE_LOCAL[m.key.replace(/^msg_/, '')] }));
}

// ---------------------------------------------------------------------------
// 写盘
// ---------------------------------------------------------------------------

function renderFile(f: FileBuilder): string {
  const eol = f.ctx.crlf ? '\r\n' : '\n';
  const body = f.lines.map((l) => l + eol).join('');
  return (f.ctx.bom ? '\uFEFF' : '') + body + f.tailText;
}

/** 目录里的文件集合与内容是否已经与规格完全一致（用于"内容不变则不重写"）。 */
function treeMatches(fx: Fixture, outDir: string): boolean {
  if (!fs.existsSync(outDir)) return false;
  const want = new Map<string, string>();
  for (const f of fx.files.values()) want.set(f.ctx.rel, renderFile(f));
  for (const [rel, content] of fx.extraFiles) want.set(rel, content);
  const have: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else have.push(path.relative(outDir, abs).split(path.sep).join('/'));
    }
  };
  walk(outDir);
  if (have.length !== want.size) return false;
  for (const rel of have) {
    const w = want.get(rel);
    if (w === undefined) return false;
    if (fs.readFileSync(path.join(outDir, ...rel.split('/')), 'utf8') !== w) return false;
  }
  return true;
}

function writeTree(fx: Fixture, outDir: string): void {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const all: Array<[string, string]> = [];
  for (const f of fx.files.values()) all.push([f.ctx.rel, renderFile(f)]);
  for (const [rel, content] of fx.extraFiles) all.push([rel, content]);
  all.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const dirs = new Set<string>();
  for (const [rel, content] of all) {
    const abs = path.join(outDir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
    fs.utimesSync(abs, FIXED_MTIME, FIXED_MTIME);
    let d = path.dirname(abs);
    while (d.length > outDir.length) {
      dirs.add(d);
      d = path.dirname(d);
    }
  }
  for (const d of dirs) fs.utimesSync(d, FIXED_MTIME, FIXED_MTIME);
  fs.utimesSync(outDir, FIXED_MTIME, FIXED_MTIME);
}

export interface GenerateResult {
  expected: Record<string, unknown>;
}

/** 生成 fixture 目录；如给出 expectedPath 则同时写 expected.json。 */
export function generateFixture(outDir: string, expectedPath?: string): GenerateResult {
  const fx = buildSpec();
  if (!treeMatches(fx, outDir)) writeTree(fx, outDir); // 内容没变就不动磁盘
  const expected = deriveExpected(fx);
  if (expectedPath) {
    const text = `${JSON.stringify(expected, null, 2)}\n`;
    const same = fs.existsSync(expectedPath) && fs.readFileSync(expectedPath, 'utf8') === text;
    if (!same) {
      fs.mkdirSync(path.dirname(expectedPath), { recursive: true });
      fs.writeFileSync(expectedPath, text, 'utf8');
    }
  }
  return { expected };
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(here, '..');
  const outIdx = process.argv.indexOf('--out');
  if (outIdx >= 0 && process.argv[outIdx + 1]) {
    const out = path.resolve(process.argv[outIdx + 1]!);
    generateFixture(out);
    console.log(`fixture 已写入 ${out}（未写 expected.json）`);
  } else {
    const out = path.join(root, 'test', 'fixtures', 'projects');
    const exp = path.join(root, 'test', 'fixtures', 'expected.json');
    const { expected } = generateFixture(out, exp);
    const s = expected.stats as Record<string, unknown>;
    console.log(`fixture 已写入 ${out}`);
    console.log(`expected.json：uniqueMessages=${s.uniqueMessages} duplicatesDropped=${s.duplicatesDropped} crossFileDuplicates=${s.crossFileDuplicates}`);
  }
}

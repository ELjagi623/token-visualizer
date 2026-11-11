/**
 * SSE 广播中心。
 *
 * 事件：
 *   status       完整状态（进度、dataVersion、usageState、今日总量…），随 store 状态 / 数据变化推送
 *   dataVersion  {dataVersion}，仅在版本号变化时推送（注意：版本变化不保证数字一定变，前端应按需重取）
 *   settings     {version}，设置被修改时推送
 * 另有：连接建立时的初始快照、15 秒一次的心跳注释行（`: ping`）、`retry: 2000`（断线后 2 秒自动重连）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

export const MAX_SSE_CLIENTS = 100;
const MAX_BUFFERED = 1024 * 1024;

export class SseHub {
  /** 客户端 → 它已经收到的最新 dataVersion（每个客户端各自记录，新连接不会影响别人） */
  private readonly clients = new Map<ServerResponse, number>();
  private nextId = 1;
  private timer: NodeJS.Timeout | null = null;
  private readonly heartbeatMs: number;

  constructor(heartbeatMs = 15_000) {
    this.heartbeatMs = heartbeatMs;
  }

  get size(): number {
    return this.clients.size;
  }

  get full(): boolean {
    return this.clients.size >= MAX_SSE_CLIENTS;
  }

  /** 接入一个客户端；initial 为连接建立时先发的 [event, data] 列表。 */
  add(req: IncomingMessage, res: ServerResponse, baseHeaders: Record<string, string>, initial: Array<[string, unknown]>): void {
    res.writeHead(200, {
      ...baseHeaders,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    this.clients.set(res, -1);
    const drop = (): void => {
      this.clients.delete(res);
      if (this.clients.size === 0) this.stopTimer();
    };
    req.on('close', drop);
    res.on('close', drop);
    res.on('error', drop);
    for (const [ev, data] of initial) {
      this.send(res, ev, data);
      // 初始快照里的 dataVersion 就是该客户端已知的版本：之后只有真正变化才再推
      if (ev === 'dataVersion') this.clients.set(res, (data as { dataVersion: number }).dataVersion);
    }
    this.startTimer();
  }

  private send(res: ServerResponse, event: string, data: unknown): void {
    if (res.destroyed || res.writableEnded) return;
    if (res.writableLength > MAX_BUFFERED) {
      res.destroy(); // 慢客户端：直接断开，由它自动重连
      this.clients.delete(res);
      return;
    }
    res.write(`id: ${this.nextId++}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  broadcast(event: string, data: unknown): void {
    for (const c of [...this.clients.keys()]) this.send(c, event, data);
  }

  /** 广播状态；对每个客户端，仅当 dataVersion 与它已知的不同才另发 dataVersion 事件。 */
  broadcastStatus(status: { dataVersion: number }): void {
    for (const [c, known] of [...this.clients.entries()]) {
      this.send(c, 'status', status);
      if (known !== status.dataVersion && this.clients.has(c)) {
        this.clients.set(c, status.dataVersion);
        this.send(c, 'dataVersion', { dataVersion: status.dataVersion });
      }
    }
  }

  private startTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      for (const c of [...this.clients.keys()]) {
        if (!c.destroyed && !c.writableEnded) c.write(': ping\n\n');
      }
    }, this.heartbeatMs);
    this.timer.unref?.();
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  closeAll(): void {
    this.stopTimer();
    for (const c of [...this.clients.keys()]) {
      try {
        c.end();
      } catch {
        // ignore
      }
    }
    this.clients.clear();
  }
}

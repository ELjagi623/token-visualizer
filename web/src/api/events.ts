/**
 * SSE 订阅（/api/events）：断线自动重连（指数退避，上限 10 秒）。
 *
 * 浏览器的 EventSource 在网络抖动时会自己重连；但服务端被关掉再起（连接被拒 / 非 200）时
 * readyState 会变成 CLOSED 且不再重试，所以这里在 CLOSED 时自己重建连接。
 */
import type { StatusPayload } from './types.ts';

export interface EventHandlers {
  onStatus: (s: StatusPayload) => void;
  onSettings: (version: number) => void;
  onOpen: () => void;
  onLost: () => void;
}

export function startEvents(h: EventHandlers): () => void {
  let es: EventSource | null = null;
  let stopped = false;
  let retryMs = 1000;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const connect = (): void => {
    if (stopped) return;
    es = new EventSource('/api/events');
    es.addEventListener('open', () => {
      retryMs = 1000;
      h.onOpen();
    });
    es.addEventListener('status', (e) => {
      try {
        h.onStatus(JSON.parse((e as MessageEvent<string>).data) as StatusPayload);
      } catch {
        // 忽略畸形事件
      }
    });
    es.addEventListener('settings', (e) => {
      try {
        const v = (JSON.parse((e as MessageEvent<string>).data) as { version?: number }).version;
        if (typeof v === 'number') h.onSettings(v);
      } catch {
        // 忽略
      }
    });
    es.addEventListener('error', () => {
      h.onLost();
      if (es && es.readyState === EventSource.CLOSED) {
        es.close();
        es = null;
        if (!stopped) {
          timer = setTimeout(connect, retryMs);
          retryMs = Math.min(retryMs * 2, 10_000);
        }
      }
    });
  };

  connect();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    es?.close();
    es = null;
  };
}

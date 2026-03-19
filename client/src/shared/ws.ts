// client/src/shared/ws.ts
import { WS_URL } from "./api";

type Msg = { type: string; payload?: any };
type Handler = (msg: Msg) => void;

class RealtimeClient {
  private ws: WebSocket | null = null;
  private handlers = new Set<Handler>();

  private reconnectTimer: any = null;
  private shouldReconnect = true;
  private openedOnce = false;

  // ✅ message queue (fix “send dropped”)
  private queue: string[] = [];
  private MAX_QUEUE = 80;

  // ✅ backoff
  private retry = 0;

  // ✅ simple debug toggle (enable with localStorage.setItem("ld_ws_debug","1"))
  private debugEnabled() {
    try {
      return localStorage.getItem("ld_ws_debug") === "1";
    } catch {
      return false;
    }
  }
  private log(...args: any[]) {
    if (this.debugEnabled()) console.log(...args);
  }

  connect() {
    // already connecting/connected
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    this.shouldReconnect = true;

    const ws = new WebSocket(WS_URL);
    this.ws = ws;

    ws.onopen = () => {
      this.openedOnce = true;
      this.retry = 0;
      this.log("[WS] OPEN", WS_URL);
      this.emit({ type: "CONNECTED" });

      // optional ping
      try {
        ws.send(JSON.stringify({ type: "PING", payload: { t: Date.now() } }));
      } catch {}

      // ✅ flush queued messages
      this.flushQueue();
    };

    ws.onmessage = (ev) => {
      let msg: Msg | null = null;
      try {
        msg = JSON.parse(String(ev.data || ""));
      } catch {
        return;
      }
      if (msg && typeof msg.type === "string") {
        this.log("[WS] RECV", msg);
        this.emit(msg);
      }
    };

    ws.onerror = (e) => {
      this.log("[WS] ERROR", e);
      // let onclose handle reconnect
    };

    ws.onclose = (e) => {
      this.log("[WS] CLOSE", { code: e.code, reason: e.reason });
      this.emit({ type: "DISCONNECTED" });
      this.ws = null;

      if (!this.shouldReconnect) return;

      // ✅ exponential backoff (cap)
      const delay = Math.min(2500, 500 + this.retry * 250);
      this.retry = Math.min(this.retry + 1, 8);

      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    };
  }

  disconnect() {
    this.shouldReconnect = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;

    try {
      this.ws?.close();
    } catch {}
    this.ws = null;
  }

  on(fn: Handler) {
    this.handlers.add(fn);
    return () => this.handlers.delete(fn);
  }

  send(type: string, payload?: any) {
    const msg: Msg = { type, payload };
    const s = JSON.stringify(msg);

    // ✅ ensure connect (best effort)
    if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
      this.connect();
    }

    // ✅ if not open -> queue (NO DROP)
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.log("[WS] QUEUE", msg);
      this.enqueue(s);
      return;
    }

    try {
      this.log("[WS] SEND", msg);
      this.ws.send(s);
    } catch {
      // if send fails, queue it and let reconnect flush it
      this.enqueue(s);
      try {
        this.ws?.close();
      } catch {}
    }
  }

  private enqueue(s: string) {
    this.queue.push(s);
    if (this.queue.length > this.MAX_QUEUE) {
      // keep newest
      this.queue.splice(0, this.queue.length - this.MAX_QUEUE);
    }
  }

  private flushQueue() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (!this.queue.length) return;

    const items = this.queue.splice(0, this.queue.length);
    this.log("[WS] FLUSH", items.length);

    for (const s of items) {
      try {
        this.ws.send(s);
      } catch {
        // put back and stop
        this.queue.unshift(s);
        break;
      }
    }
  }

  private emit(msg: Msg) {
    for (const h of this.handlers) h(msg);
  }
}

export const realtime = new RealtimeClient();
/**
 * WebSocket transport (client half) — built on `ws`. One WebSocket message ==
 * one logical frame (WS already delimits messages; nothing above needs more).
 *
 * Frames are sent as **text**. This is not cosmetic: plow's channel protocol is
 * text end to end — the server reads every frame with starlette's
 * `receive_text()`, which raises on a binary frame and drops the socket before
 * the handshake completes. We sent binary here and the Mac could not connect to
 * the real relay at all, while every local test passed because the stand-in
 * decoded the bytes either way.
 *
 * TLS is the ordinary system CA store: this Mac dials a public relay endpoint
 * with a real certificate. The SPKI-pinning seam went with the self-signed
 * broker it existed for.
 */
import { WebSocket } from "ws";
import { Connection, ConnectionDialer, RPCError } from "./transport.js";

export class WebSocketConnection implements Connection {
  onLine: ((line: Buffer) => void) | null = null;
  onClose: (() => void) | null = null;

  private started = false;
  private closed = false;
  private queued: Buffer[] = [];

  constructor(private readonly ws: WebSocket) {
    ws.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      const buf = Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.isBuffer(data)
          ? data
          : Buffer.from(data);
      if (buf.length === 0) return;
      if (this.started) this.onLine?.(buf);
      else this.queued.push(buf);
    });
    ws.on("close", () => this.handleClosed());
    ws.on("error", () => this.handleClosed());
  }

  startReading(): void {
    this.started = true;
    const backlog = this.queued;
    this.queued = [];
    for (const line of backlog) this.onLine?.(line);
  }

  sendLine(data: Buffer): void {
    if (this.closed) return;
    // TEXT, not binary — see the header comment. `ws` encodes the buffer as a
    // text frame when `binary` is false.
    this.ws.send(data, { binary: false });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // Graceful close so a just-queued frame flushes before the socket drops.
    try {
      this.ws.close();
    } catch {
      this.ws.terminate();
    }
    this.onClose?.();
  }

  private handleClosed(): void {
    if (this.closed) return;
    this.closed = true;
    this.ws.terminate();
    this.onClose?.();
  }
}

export class WebSocketDialer implements ConnectionDialer {
  constructor(
    public readonly url: string,
    public readonly timeoutSeconds = 15,
  ) {}

  connect(): Promise<Connection> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);

      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          ws.terminate();
          reject(new RPCError("websocket connect timed out"));
        }
      }, this.timeoutSeconds * 1000);
      timer.unref?.();

      ws.once("open", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(new WebSocketConnection(ws));
      });
      ws.once("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new RPCError(`websocket connect failed: ${err.message}`));
      });
    });
  }
}

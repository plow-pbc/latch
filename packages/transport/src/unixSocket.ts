/**
 * Unix-domain-socket transport with newline-delimited framing — twin of
 * DomoTransport/UnixSocket.swift.
 */
import fs from "node:fs";
import net from "node:net";
import { Connection, ConnectionDialer, ConnectionListener } from "./transport.js";

export class SocketConnection implements Connection {
  onLine: ((line: Buffer) => void) | null = null;
  onClose: (() => void) | null = null;
  /** Server-owned close hook (in addition to onClose). */
  onCloseInternal: (() => void) | null = null;

  private buffer = Buffer.alloc(0);
  private started = false;
  private closed = false;

  constructor(private readonly socket: net.Socket) {
    socket.pause();
    socket.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drain();
    });
    const closeOnce = () => this.handleClosed();
    socket.on("close", closeOnce);
    socket.on("error", () => socket.destroy());
  }

  startReading(): void {
    this.started = true;
    this.socket.resume();
    this.drain();
  }

  private drain(): void {
    if (!this.started) return;
    let idx: number;
    while ((idx = this.buffer.indexOf(0x0a)) !== -1) {
      const line = this.buffer.subarray(0, idx);
      this.buffer = this.buffer.subarray(idx + 1);
      if (line.length > 0) this.onLine?.(Buffer.from(line));
    }
  }

  sendLine(data: Buffer): void {
    if (this.closed) return;
    this.socket.write(Buffer.concat([data, Buffer.from([0x0a])]));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
    this.onClose?.();
    this.onCloseInternal?.();
  }

  private handleClosed(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose?.();
    this.onCloseInternal?.();
  }
}

export class SocketServer implements ConnectionListener {
  onConnection: ((conn: Connection) => void) | null = null;
  private readonly server: net.Server;
  private readonly connections = new Set<SocketConnection>();

  constructor(public readonly path: string) {
    try {
      fs.unlinkSync(path);
    } catch {
      /* not present */
    }
    this.server = net.createServer((socket) => {
      const conn = new SocketConnection(socket);
      this.connections.add(conn);
      conn.onCloseInternal = () => this.connections.delete(conn);
      this.onConnection?.(conn);
      conn.startReading();
    });
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.path, () => {
        this.server.removeListener("error", reject);
        try {
          fs.chmodSync(this.path, 0o600);
        } catch {
          /* best effort, matches Swift */
        }
        resolve();
      });
    });
  }

  stop(): void {
    this.server.close();
    for (const conn of [...this.connections]) conn.close();
    try {
      fs.unlinkSync(this.path);
    } catch {
      /* already gone */
    }
  }
}

export class UnixSocketDialer implements ConnectionDialer {
  constructor(public readonly path: string) {}

  connect(): Promise<Connection> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(this.path);
      socket.once("connect", () => resolve(new SocketConnection(socket)));
      socket.once("error", (err) => reject(err));
    });
  }
}

/**
 * WebSocket transport — twin of DomoTransport/WebSocketConnection.swift,
 * built on `ws`. One WebSocket message == one logical line (WS already
 * delimits messages; LineRPC needs nothing more).
 *
 * TLS posture mirrors the Swift stack:
 *   - ws://                  plain, no TLS
 *   - wss:// without trust   validated against the system CA store (+hostname)
 *   - wss:// with trust      validated by the PeerTrustEvaluator INSTEAD of
 *                            the CA store (self-signed + SPKI pin / TOFU).
 *                            Verified during the TLS handshake — a bad pin
 *                            fails the dial; nothing is ever sent.
 */
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { WebSocket, WebSocketServer } from "ws";
import { Connection, ConnectionDialer, ConnectionListener, RPCError } from "./transport.js";
import { PeerTrustEvaluator } from "./security.js";

export class WebSocketConnection implements Connection {
  onLine: ((line: Buffer) => void) | null = null;
  onClose: (() => void) | null = null;
  onCloseInternal: (() => void) | null = null;

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
    this.ws.send(data, { binary: true });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // Graceful close so a just-queued frame (e.g. domo-auth-error) flushes
    // before the connection drops — mirrors the Swift close-frame ordering.
    try {
      this.ws.close();
    } catch {
      this.ws.terminate();
    }
    this.onClose?.();
    this.onCloseInternal?.();
  }

  private handleClosed(): void {
    if (this.closed) return;
    this.closed = true;
    this.ws.terminate();
    this.onClose?.();
    this.onCloseInternal?.();
  }
}

export class WebSocketDialer implements ConnectionDialer {
  constructor(
    public readonly url: string,
    public readonly trust: PeerTrustEvaluator | null = null,
    public readonly timeoutSeconds = 15,
  ) {}

  connect(): Promise<Connection> {
    return new Promise((resolve, reject) => {
      const secure = this.url.startsWith("wss://");
      const trust = this.trust;
      const options: { [k: string]: unknown } = {};
      if (secure && trust) {
        // Evaluator replaces the CA store: disable default validation and run
        // the evaluator against the peer chain during the TLS handshake.
        options.rejectUnauthorized = false;
        options.checkServerIdentity = () => undefined; // pin replaces hostname check
      }
      const ws = new WebSocket(this.url, options);

      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          ws.terminate();
          reject(new RPCError("websocket connect timed out"));
        }
      }, this.timeoutSeconds * 1000);
      timer.unref?.();

      if (secure && trust) {
        // 'upgrade' fires with the HTTP response before 'open'; the TLS socket
        // carries the peer chain. Fail closed before any frame is sent.
        ws.on("upgrade", (res) => {
          const socket = res.socket as tls.TLSSocket;
          const chain: Buffer[] = [];
          let cert = socket.getPeerCertificate(true);
          const seen = new Set<string>();
          while (cert && Object.keys(cert).length > 0) {
            const der = cert.raw;
            if (!der) break;
            const fp = der.toString("base64");
            if (seen.has(fp)) break; // self-signed chains self-reference
            seen.add(fp);
            chain.push(der);
            const issuer = (cert as unknown as { issuerCertificate?: tls.PeerCertificate }).issuerCertificate;
            if (!issuer || issuer === (cert as unknown)) break;
            cert = issuer as tls.DetailedPeerCertificate;
          }
          if (!trust.evaluate(chain)) {
            settled = true;
            clearTimeout(timer);
            ws.terminate();
            reject(new RPCError("websocket connect failed: certificate pin mismatch"));
          }
        });
      }

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

export interface TLSServerIdentity {
  /** PKCS#12 bundle (cert + key), as domo-broker --tls-p12 provides. */
  pfxPath?: string;
  passphrase?: string;
  /** Or PEM parts, for test certs. */
  certPath?: string;
  keyPath?: string;
}

export class WebSocketListener implements ConnectionListener {
  onConnection: ((conn: Connection) => void) | null = null;
  private readonly server: http.Server | https.Server;
  private readonly wss: WebSocketServer;
  private readonly connections = new Set<WebSocketConnection>();
  private boundPort: number | null = null;

  constructor(
    public readonly port: number,
    identity: TLSServerIdentity | null = null,
  ) {
    if (identity) {
      const tlsOptions: https.ServerOptions = identity.pfxPath
        ? { pfx: fs.readFileSync(identity.pfxPath), passphrase: identity.passphrase }
        : { cert: fs.readFileSync(identity.certPath!), key: fs.readFileSync(identity.keyPath!) };
      this.server = https.createServer(tlsOptions);
    } else {
      this.server = http.createServer();
    }
    this.wss = new WebSocketServer({ server: this.server });
    this.wss.on("connection", (ws) => {
      const conn = new WebSocketConnection(ws);
      this.connections.add(conn);
      conn.onCloseInternal = () => this.connections.delete(conn);
      this.onConnection?.(conn);
      conn.startReading();
    });
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, () => {
        this.server.removeListener("error", reject);
        const addr = this.server.address();
        this.boundPort = typeof addr === "object" && addr !== null ? addr.port : this.port;
        resolve();
      });
    });
  }

  /** The actual bound port (useful when constructed with port 0 in tests). */
  get actualPort(): number | null {
    return this.boundPort;
  }

  stop(): void {
    this.wss.close();
    this.server.close();
    for (const conn of [...this.connections]) conn.close();
  }
}

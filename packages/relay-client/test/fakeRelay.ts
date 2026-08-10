/**
 * A stand-in for the Plow relay's device leg, built strictly to the design's
 * wire contract so this repo can be tested end to end before the relay exists.
 *
 * It is deliberately faithful rather than convenient: it speaks plow's real
 * channel handshake (challenge → auth → `auth.ok` → `ready`), checks the
 * credential, answers `ping` with `pong`, mints its own `rid` per request, and
 * correlates the reply by that `rid`. What it does NOT do is stand in for the
 * relay's own logic — routing, scopes, the pending map — because none of that
 * is this repo's to verify.
 *
 * The `agentCall` method is the agent-facing half: it takes the HTTP request an
 * MCP client would POST to `/v1/relay/devices/{uid}/mcp` and returns what that
 * client would get back.
 */
import { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import {
  FRAME_REQUEST,
  FRAME_RESPONSE,
  RelayFrameAuth,
  RelayResponseFrame,
  stripHopByHop,
} from "@domo/relay-client";

export interface TunnelledResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface FakeRelayOptions {
  /** The credential the device must present. */
  expectCredential: string;
  /** Advertised heartbeat cadence, as plow's `auth.ok` does. */
  pingIntervalMs?: number;
}

export class FakeRelay {
  private readonly wss: WebSocketServer;
  private device: WebSocket | null = null;
  private nextRid = 1;
  private readonly pending = new Map<
    string,
    { resolve: (r: TunnelledResponse) => void; reject: (e: Error) => void }
  >();

  /** Every frame the device sent, for assertions. */
  readonly received: Record<string, unknown>[] = [];
  /** Resolves once a device has completed the handshake. */
  private onlineResolvers: (() => void)[] = [];
  deviceOnline = false;
  /** The client kind the device registered under. */
  clientKind: string | null = null;
  authFailures = 0;

  private constructor(
    wss: WebSocketServer,
    private readonly options: FakeRelayOptions,
  ) {
    this.wss = wss;
    this.wss.on("connection", (ws) => this.handleDevice(ws));
  }

  static async start(options: FakeRelayOptions): Promise<FakeRelay> {
    const wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => wss.on("listening", () => resolve()));
    return new FakeRelay(wss, options);
  }

  get url(): string {
    return `ws://127.0.0.1:${(this.wss.address() as AddressInfo).port}/v1/relay/ws`;
  }

  private handleDevice(ws: WebSocket): void {
    let authed = false;
    // Plow opens with the challenge; the credential is never on the upgrade.
    ws.send(JSON.stringify({ type: "auth.challenge" }));

    ws.on("message", (data: Buffer) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
      } catch {
        return;
      }
      this.received.push(msg);

      if (msg.type === "auth") {
        if (msg.token !== this.options.expectCredential) {
          this.authFailures += 1;
          ws.send(JSON.stringify({ type: "auth.error", reason: "Invalid credential" }));
          ws.close(4001, "auth_failed");
          return;
        }
        this.clientKind = typeof msg.client_kind === "string" ? msg.client_kind : null;
        authed = true;
        ws.send(
          JSON.stringify({
            type: "auth.ok",
            ping_interval_ms: this.options.pingIntervalMs ?? 15_000,
          }),
        );
        return;
      }

      if (!authed) return;

      if (msg.type === "ready") {
        this.device = ws;
        this.deviceOnline = true;
        for (const r of this.onlineResolvers.splice(0)) r();
        return;
      }

      if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
        return;
      }

      if (msg.type === FRAME_RESPONSE) {
        const frame = msg as unknown as RelayResponseFrame;
        const waiter = this.pending.get(frame.rid);
        if (!waiter) return; // an unknown rid is never answered on faith
        this.pending.delete(frame.rid);
        waiter.resolve({
          status: frame.status,
          headers: frame.headers ?? {},
          body: frame.body ?? "",
        });
      }
    });

    ws.on("close", () => {
      if (this.device === ws) {
        this.device = null;
        this.deviceOnline = false;
      }
    });
  }

  /** Wait until a device has completed the handshake. */
  waitForDevice(timeoutMs = 5_000): Promise<void> {
    if (this.deviceOnline) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("device never came online")), timeoutMs);
      this.onlineResolvers.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /**
   * The agent-facing leg: forward one HTTP exchange to the Mac and return its
   * answer. Mirrors the relay's rules — a relay-minted `rid`, `Authorization`
   * and hop-by-hop headers stripped, path and query forwarded as sent, and the
   * body never parsed.
   */
  agentCall(
    request: {
      method?: string;
      path: string;
      headers?: Record<string, string>;
      body?: string | null;
    },
    auth: RelayFrameAuth,
    timeoutMs = 10_000,
  ): Promise<TunnelledResponse> {
    const device = this.device;
    if (!device) return Promise.reject(new Error("device offline"));
    const rid = `rid-${this.nextRid++}`;
    const headers = stripHopByHop(request.headers ?? {});
    delete headers.authorization;
    delete headers.Authorization;

    return new Promise<TunnelledResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(rid);
        reject(new Error(`timed out waiting for ${rid}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(rid, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject,
      });
      device.send(
        JSON.stringify({
          type: FRAME_REQUEST,
          rid,
          method: request.method ?? "POST",
          path: request.path,
          headers,
          body: request.body ?? null,
          auth,
        }),
      );
    });
  }

  /** Drop the live device socket without stopping the relay — a restart. */
  dropDevice(): void {
    this.device?.terminate();
    this.device = null;
    this.deviceOnline = false;
  }

  async stop(): Promise<void> {
    for (const client of this.wss.clients) client.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}

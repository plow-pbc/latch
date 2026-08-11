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
 *
 * **It must be as STRICT as the real server, not merely as capable.** An
 * earlier version decoded every frame with `toString("utf8")` regardless of
 * opcode, so it happily accepted the binary frames we were sending — while the
 * real relay reads with starlette's `receive_text()` and dropped the socket
 * before the handshake finished. Every test here passed and the Mac could not
 * connect to anything. Tolerance in a stand-in is not neutral; it manufactures
 * false confidence. The strictness below mirrors
 * `api/plow/relay/ws.py` `_authenticate` and its receive loop.
 */
import { Server as HttpServer } from "node:http";
import { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";

/**
 * INDEPENDENT IMPLEMENTATION — deliberately duplicated, never imported.
 *
 * This file must be a second reading of the wire contract, not a mirror of the
 * client's. If it imported the client's constants and header logic, then a
 * client that renamed a frame type or broke its header handling would drag the
 * fake along with it and every integration test would stay green: it would be
 * testing that the client agrees with itself.
 *
 * So the three strings below are literals, transcribed from the design's wire
 * contract, and the header handling below is written from RFC 9110 rather than
 * borrowed. If these ever disagree with `src/wire.ts`, that disagreement IS the
 * test result.
 */
const WIRE_FRAME_REQUEST = "relay.request";
const WIRE_FRAME_RESPONSE = "relay.response";
const WIRE_CLIENT_KIND = "relay-device";

/** RFC 9110 hop-by-hop, plus content-length because each hop re-frames the
 * body. `Host` is end-to-end and is forwarded, not stripped. */
const WIRE_NOT_FORWARDED = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
];

function relayStripHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(headers ?? {})) {
    if (!WIRE_NOT_FORWARDED.includes(key.toLowerCase())) out[key] = headers[key];
  }
  return out;
}

/** The agent identity the relay asserts. Never carries the credential. */
export interface RelayFrameAuth {
  agent_id: string;
  agent_name?: string;
  scopes?: string[];
  user_uid?: string;
}

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
  /**
   * Attach to an existing HTTP server instead of taking a port of its own.
   *
   * Against real Plow the socket and the HTTP API share one origin — which is
   * what `relaySocketUrl` expresses — so anything driving the whole app has to
   * serve both from one port or the app will dial somewhere the stub is not.
   */
  server?: HttpServer;
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
  /** Set when the device registered under a kind this relay does not expect. */
  unexpectedClientKind: string | null = null;
  authFailures = 0;
  /** Why the last handshake was refused. */
  lastRejection: string | null = null;
  /** Binary frames received — the real server cannot read these at all. */
  binaryFramesSeen = 0;
  /** Frame types seen after auth that this relay has no use for. */
  readonly unknownFrameTypes: string[] = [];
  /** The account uid announced in auth.ok. */
  readonly accountUid = "0876d2e6-a3b0-4c1d-9ab9-0673d17d73d9";

  private constructor(
    wss: WebSocketServer,
    private readonly options: FakeRelayOptions,
  ) {
    this.wss = wss;
    this.wss.on("connection", (ws) => this.handleDevice(ws));
  }

  static async start(options: FakeRelayOptions): Promise<FakeRelay> {
    if (options.server) {
      // Already listening; `listening` will never fire again for us.
      return new FakeRelay(new WebSocketServer({ server: options.server }), options);
    }
    const wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => wss.on("listening", () => resolve()));
    return new FakeRelay(wss, options);
  }

  get url(): string {
    return `ws://127.0.0.1:${this.port}/v1/relay/ws`;
  }

  private get port(): number {
    const address = this.options.server ? this.options.server.address() : this.wss.address();
    return (address as AddressInfo).port;
  }

  /** What an agent addressed to reach this relay — forwarded as `Host`. */
  get authority(): string {
    return `127.0.0.1:${this.port}`;
  }

  /** Mirrors `_reject`: auth.error then close 4001, never echoing the token. */
  private reject(ws: WebSocket, reason: string): void {
    this.authFailures += 1;
    this.lastRejection = reason;
    ws.send(JSON.stringify({ type: "auth.error", reason }));
    ws.close(4001, "auth_failed");
  }

  private handleDevice(ws: WebSocket): void {
    let authed = false;
    // Plow opens with the challenge; the credential is never on the upgrade.
    ws.send(JSON.stringify({ type: "auth.challenge" }));

    ws.on("message", (data: Buffer, isBinary: boolean) => {
      // STRICTNESS 1: text frames only. starlette's receive_text() raises on a
      // binary frame and the socket dies mid-handshake — which is exactly what
      // the real relay did to us while this file was decoding bytes blindly.
      if (isBinary) {
        this.binaryFramesSeen += 1;
        ws.terminate();
        return;
      }

      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
      } catch {
        // STRICTNESS 2: unparseable auth frame is fatal, not ignored.
        if (!authed) this.reject(ws, "Invalid JSON");
        return;
      }
      this.received.push(msg);

      // STRICTNESS 3: a non-object payload is refused.
      if (!authed && (typeof msg !== "object" || msg === null || Array.isArray(msg))) {
        this.reject(ws, "Invalid auth payload");
        return;
      }
      // STRICTNESS 4: the FIRST frame must be `auth`; anything else is fatal
      // rather than silently skipped until an auth frame turns up.
      if (!authed && msg.type !== "auth") {
        this.reject(ws, "Expected auth message");
        return;
      }

      if (msg.type === "auth") {
        if (msg.token !== this.options.expectCredential) {
          this.reject(ws, "Invalid credential");
          return;
        }
        this.clientKind = typeof msg.client_kind === "string" ? msg.client_kind : null;
        if (this.clientKind !== WIRE_CLIENT_KIND) this.unexpectedClientKind = this.clientKind;
        authed = true;
        // The real auth.ok carries the account uid.
        ws.send(
          JSON.stringify({
            type: "auth.ok",
            account_id: this.accountUid,
            ping_interval_ms: this.options.pingIntervalMs ?? 15_000,
          }),
        );
        // The device is registered at auth.ok — the real relay registers here,
        // not on any follow-up frame. An earlier version waited for a `ready`
        // frame, which our wire contract does not have.
        this.device = ws;
        this.deviceOnline = true;
        for (const r of this.onlineResolvers.splice(0)) r();
        return;
      }

      if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
        return;
      }

      if (msg.type === WIRE_FRAME_RESPONSE) {
        const frame = msg as unknown as {
          rid: string;
          status: number;
          headers: Record<string, string>;
          body: string;
        };
        const waiter = this.pending.get(frame.rid);
        if (!waiter) return; // an unknown rid is never answered on faith
        this.pending.delete(frame.rid);
        waiter.resolve({
          status: frame.status,
          headers: frame.headers ?? {},
          body: frame.body ?? "",
        });
        return;
      }

      // Tolerated by the real relay, but recorded: it logs these as
      // relay_ws_unknown_frame_type, and a frame nobody reads is noise on the
      // wire that one side is wrong about.
      if (msg.type !== "ping") this.unknownFrameTypes.push(String(msg.type));
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
    const headers = relayStripHeaders(request.headers ?? {});
    // The relay strips the agent's credential; the Mac must never see it.
    delete headers.authorization;
    delete headers.Authorization;
    // …and forwards the authority the agent addressed, which is the relay's.
    headers.host = this.authority;

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
          type: WIRE_FRAME_REQUEST,
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

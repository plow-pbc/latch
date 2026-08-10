/**
 * The outbound relay client: this Mac dials the Plow relay and serves the MCP
 * requests the relay tunnels down the socket.
 *
 * The Mac dials *out* because it is behind NAT and often asleep. It holds one
 * WebSocket; agents reach it by POSTing to the relay, which forwards each
 * exchange down this socket and returns the answer.
 *
 * The credential travels in the post-challenge `auth` frame, as every existing
 * plow channel client does — never in an `Authorization` header on the upgrade
 * and **never in the URL**. That rule is absolute: credentials in URLs leaked
 * into stored MCP registrations, terminal output, logs and shell history in the
 * prototype. Nothing in this file ever writes the credential anywhere but that
 * one frame.
 */
import { Connection, ConnectionDialer, WebSocketDialer } from "@domo/transport";
import { RelayAuth } from "@domo/mcp-server";
import {
  FRAME_RESPONSE,
  HEARTBEAT_INTERVAL_MS,
  isRequestFrame,
  RELAY_CLIENT_KIND,
  RelayRequestFrame,
  RelayResponseFrame,
  stripHopByHop,
} from "./wire.js";

/** Serves one tunnelled HTTP exchange — chunk 7's MCP handler. */
export type ServeRequest = (request: Request, auth?: RelayAuth) => Promise<Response>;

export interface RelayClientOptions {
  /** The relay's device endpoint, e.g. `wss://api.plow.co/v1/relay/ws`. */
  url: string;
  /** A `relay:device` key. Sent only in the auth frame; never logged. */
  credential: string;
  /** Where a tunnelled request goes. */
  serve: ServeRequest;
  onStatusChange?: (connected: boolean) => void;
  /** Diagnostics. Never receives the credential — see `redact`. */
  log?: (message: string) => void;
  /** Injectable for tests. */
  dial?: (url: string) => ConnectionDialer;
  random?: () => number;
}

const MAX_BACKOFF_MS = 30_000;
const BASE_BACKOFF_MS = 500;

export class RelayClient {
  private conn: Connection | null = null;
  private connected = false;
  private running = false;
  private attempt = 0;
  private heartbeat: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS;
  /** Requests being served right now, so shutdown can wait for them. */
  private readonly inFlight = new Set<Promise<void>>();

  constructor(private readonly options: RelayClientOptions) {}

  get isConnected(): boolean {
    return this.connected;
  }

  /**
   * Strip the credential out of anything on its way to a log or an error.
   *
   * Defence in depth: nothing here should ever put the credential in a string
   * in the first place, but a `ws` error message can quote the frame it failed
   * to send, and an error thrown from a dependency is not ours to audit.
   */
  private redact(text: string): string {
    const credential = this.options.credential;
    if (!credential) return text;
    return text.split(credential).join("[redacted]");
  }

  private say(message: string): void {
    this.options.log?.(this.redact(message));
  }

  /**
   * Why a dial failed. Without this, a Mac that can never connect logs only
   * "reconnecting in 121ms" forever and whoever debugs it has nothing to go on.
   * Redacted like everything else — a failure string is exactly where a
   * credential must not appear.
   */
  private sayFailure(error: unknown): void {
    this.say(`connect failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  /** Start dialling. Returns once the first attempt has been made; the client
   * keeps reconnecting on its own after that. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.attempt = 0;
    await this.connectOnce().catch((error: unknown) => {
      this.sayFailure(error);
      this.scheduleReconnect();
    });
  }

  /** Stop reconnecting and drop the socket. Waits for in-flight requests so a
   * shutdown never strands an agent mid-call. */
  async stop(): Promise<void> {
    this.running = false;
    this.clearTimers();
    this.conn?.close();
    this.conn = null;
    this.setConnected(false);
    await Promise.allSettled([...this.inFlight]);
  }

  private setConnected(value: boolean): void {
    if (this.connected === value) return;
    this.connected = value;
    this.options.onStatusChange?.(value);
  }

  private clearTimers(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.heartbeat = null;
    this.reconnectTimer = null;
  }

  private dialer(): ConnectionDialer {
    return this.options.dial
      ? this.options.dial(this.options.url)
      : new WebSocketDialer(this.options.url);
  }

  private async connectOnce(): Promise<void> {
    this.say(`connecting to ${this.options.url}`);
    const conn = await this.dialer().connect();
    this.conn = conn;

    conn.onLine = (line) => this.onFrame(conn, line);
    conn.onClose = () => this.onClose();
    conn.startReading();
  }

  private send(conn: Connection, frame: unknown): void {
    conn.sendLine(Buffer.from(JSON.stringify(frame), "utf8"));
  }

  private onFrame(conn: Connection, line: Buffer): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line.toString("utf8")) as Record<string, unknown>;
    } catch {
      this.say("ignoring a frame that is not JSON");
      return;
    }

    switch (msg.type) {
      case "auth.challenge":
        // The one and only place the credential is written to the wire.
        this.send(conn, {
          type: "auth",
          token: this.options.credential,
          client_kind: RELAY_CLIENT_KIND,
        });
        return;

      case "auth.ok": {
        // No `ready` frame. Plow's agent-runtime client sends one for its own
        // channel's reasons; our wire contract has no such frame and the relay
        // logs it as an unknown type. Least code: do not send what nobody reads.
        this.attempt = 0;
        // Honour the server's cadence, but never drift above ours: the relay's
        // staleness gate is twice the interval, so a slower heartbeat makes
        // calls start failing after 30s of quiet.
        const advertised = msg.ping_interval_ms;
        this.heartbeatIntervalMs =
          typeof advertised === "number" && advertised > 0
            ? Math.min(advertised, HEARTBEAT_INTERVAL_MS)
            : HEARTBEAT_INTERVAL_MS;
        this.startHeartbeat(conn);
        this.setConnected(true);
        this.say("authenticated");
        return;
      }

      case "auth.error":
        // `reason` is the relay's text. Redacted anyway — an error string is
        // exactly where a credential must never appear.
        this.say(`relay rejected the credential: ${String(msg.reason ?? "")}`);
        conn.close();
        return;

      case "ping":
        this.send(conn, { type: "pong" });
        return;

      case "pong":
        return;

      default:
        break;
    }

    if (isRequestFrame(msg)) {
      // Deliberately NOT awaited. Serving a request can take the whole call
      // budget, and awaiting here would stall the heartbeat — after two missed
      // beats the relay treats this socket as stale and every call fails.
      const task = this.serveRequest(conn, msg).finally(() => this.inFlight.delete(task));
      this.inFlight.add(task);
      return;
    }

    this.say(`ignoring unknown frame type ${String(msg.type)}`);
  }

  private async serveRequest(conn: Connection, frame: RelayRequestFrame): Promise<void> {
    let response: RelayResponseFrame;
    try {
      const headers = new Headers();
      for (const [key, value] of Object.entries(stripHopByHop(frame.headers ?? {}))) {
        headers.set(key, value);
      }
      // The authority the agent actually addressed — the relay's — forwarded
      // through, not invented. `Host` is end-to-end, and anything on this side
      // that validates it (now or later) must see what really arrived rather
      // than a placeholder that would always pass. Falls back only when the
      // relay sent no Host at all.
      const authority = headers.get("host") || "mac.local";
      // The path and query the agent actually sent, served as sent — the
      // prototype rewrote the path to /mcp and dropped the query.
      //
      // The scheme is `http` because this hop is not itself TLS: the relay
      // terminated the agent's HTTPS and forwarded the exchange down the
      // WebSocket. Nothing here switches on the scheme; the authority is the
      // part that carries meaning.
      const request = new Request(`http://${authority}${frame.path || "/"}`, {
        method: frame.method || "POST",
        headers,
        body: frame.body ?? undefined,
      });
      const served = await this.options.serve(request, frame.auth);
      response = {
        type: FRAME_RESPONSE,
        rid: frame.rid,
        status: served.status,
        headers: stripHopByHop(Object.fromEntries(served.headers)),
        body: await served.text(),
      };
    } catch (error: unknown) {
      // Answer the rid regardless. Dropping it would leave the agent waiting
      // for the relay's timeout with no idea anything went wrong.
      const message = this.redact(error instanceof Error ? error.message : String(error));
      this.say(`failed to serve ${frame.rid}: ${message}`);
      response = {
        type: FRAME_RESPONSE,
        rid: frame.rid,
        status: 500,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: message }),
      };
    }
    this.send(conn, response);
  }

  private startHeartbeat(conn: Connection): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      this.send(conn, { type: "ping" });
    }, this.heartbeatIntervalMs);
    this.heartbeat.unref?.();
  }

  private onClose(): void {
    this.conn = null;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.setConnected(false);
    if (!this.running) return;
    this.scheduleReconnect();
  }

  /**
   * Exponential backoff with full jitter. The jitter is the point: without it
   * every Mac that dropped when the relay restarted comes back at the same
   * instant and knocks it over again.
   */
  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer) return;
    const ceiling = Math.min(BASE_BACKOFF_MS * 2 ** this.attempt, MAX_BACKOFF_MS);
    const random = this.options.random ?? Math.random;
    const delay = Math.round(random() * ceiling);
    this.attempt += 1;
    this.say(`reconnecting in ${delay}ms (attempt ${this.attempt})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.running) return;
      void this.connectOnce().catch((error: unknown) => {
        this.sayFailure(error);
        this.scheduleReconnect();
      });
    }, delay);
    this.reconnectTimer.unref?.();
  }
}

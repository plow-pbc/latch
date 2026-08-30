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
  /**
   * The credential this Mac holds — today the owner's Plow login session.
   *
   * The socket asks for one thing: a scope covering `relay:device`, which a
   * session's wildcard satisfies (`check_scope` in plow's `auth.py`). The
   * device is registered before this socket opens, and the relay binds the
   * connection to that stable installation identity. Sent only in the auth
   * frame; never logged.
   */
  credential: string;
  /** Stable installation identity registered with Plow before this socket opens. */
  deviceId: string;
  /** Preparation that must succeed before each dial; failures use the same backoff. */
  beforeConnect?: () => Promise<void>;
  /** Where a tunnelled request goes. */
  serve: ServeRequest;
  onStatusChange?: (connected: boolean) => void;
  /**
   * The relay refused this credential. Terminal: it will not become valid by
   * waiting, so the client has stopped and the owner has to sign in again.
   */
  onAuthFailed?: () => void;
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
  /** Set when the relay refused the credential — stops all reconnection. */
  private credentialRejected = false;
  private heartbeat: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS;
  /**
   * When the relay was last heard from. A silent socket is the failure this
   * exists for: when wifi vanishes or the Mac wakes on another network, the
   * TCP connection is dead but nothing tells us — outbound frames sit in a
   * buffer and neither `close` nor `error` fires until the OS gives up minutes
   * later. Until then the app claims Connected, calls fail, and the client is
   * not reconnecting, because reconnection hangs off that same close.
   */
  private lastInboundAt = 0;
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
    this.credentialRejected = false;
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
    if (this.options.beforeConnect) {
      await this.options.beforeConnect();
      if (!this.running) return;
    }
    this.say(`connecting to ${this.options.url}`);
    const conn = await this.dialer().connect();
    // The dial can outlive a `stop()`. Sign-out drops the socket while this is
    // still in flight, and installing it here would leave an authenticated,
    // READING connection nobody owns — one that finishes the handshake and goes
    // on serving agents after the app believes it signed out, with a credential
    // it has already erased. `stop()` cannot close what it cannot see, so the
    // check belongs here, at the moment there is something to close.
    if (!this.running) {
      conn.close();
      return;
    }
    this.conn = conn;
    this.lastInboundAt = Date.now();
    // A cadence the *last* relay advertised says nothing about this socket, and
    // inheriting a short one would have the watchdog close a perfectly healthy
    // replacement whose handshake merely took longer than two of them. Back to
    // ours until this connection has advertised its own.
    this.heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS;
    // Armed here, not at `auth.ok`: a socket that opens and then goes silent
    // before the handshake completes is the same dead socket, and waiting for
    // an `auth.ok` that will never arrive would leave it sitting until the OS
    // timeout — the exact failure this whole path exists to end. The beat sends
    // nothing until we are authenticated; it only watches.
    this.startHeartbeat(conn);

    conn.onLine = (line) => this.onFrame(conn, line);
    conn.onClose = () => this.onClose();
    conn.startReading();
  }

  private send(conn: Connection, frame: unknown): void {
    conn.sendLine(Buffer.from(JSON.stringify(frame), "utf8"));
  }

  private onFrame(conn: Connection, line: Buffer): void {
    // Any frame at all proves the socket is alive — including one we go on to
    // ignore, so this is stamped before the parse can reject it.
    this.lastInboundAt = Date.now();
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
          device_id: this.options.deviceId,
        });
        return;

      case "auth.ok": {
        if (msg.device_id !== this.options.deviceId) {
          this.stopAfterAuthFailure(conn, "relay authenticated a different device");
          return;
        }
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

      case "auth.error": {
        // The relay's reason is untrusted and may echo the credential, in an
        // encoding that string replacement cannot reliably scrub.
        this.stopAfterAuthFailure(conn, "relay rejected the credential");
        return;
      }

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

  private stopAfterAuthFailure(conn: Connection, message: string): void {
    this.say(message);
    this.credentialRejected = true;
    this.running = false;
    this.clearTimers();
    conn.close();
    this.setConnected(false);
    this.options.onAuthFailed?.();
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
      // A live relay is never silent for two intervals: before the handshake
      // it is sending us the challenge, and after it answers every ping. Two
      // intervals of nothing means the socket is gone, whatever the OS still
      // believes. Closing it here
      // routes the failure down the ordinary path: `onClose` clears the status
      // and starts the backoff, so the indicator and the reconnect are right
      // for the same reason they are right on a clean drop. The check happens
      // on a beat, so a dead socket is noticed between two and three intervals
      // after the last frame.
      if (Date.now() - this.lastInboundAt >= this.heartbeatIntervalMs * 2) {
        this.say("no frame from the relay in two heartbeats; dropping the socket");
        conn.close();
        return;
      }
      // Before `auth.ok` there is nothing to ping with: the relay is mid
      // handshake and an unexpected frame is not ours to invent. The liveness
      // check above still runs, which is the point.
      if (this.connected) this.send(conn, { type: "ping" });
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
    if (this.credentialRejected || !this.running || this.reconnectTimer) return;
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

import { WebSocketServer } from "ws";
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
function relayStripHeaders(headers) {
    const out = {};
    for (const key of Object.keys(headers ?? {})) {
        if (!WIRE_NOT_FORWARDED.includes(key.toLowerCase()))
            out[key] = headers[key];
    }
    return out;
}
export class FakeRelay {
    options;
    wss;
    device = null;
    nextRid = 1;
    pending = new Map();
    /** Every frame the device sent, for assertions. */
    received = [];
    /** Resolves once a device has completed the handshake. */
    onlineResolvers = [];
    deviceOnline = false;
    /** The client kind the device registered under. */
    clientKind = null;
    /** Set when the device registered under a kind this relay does not expect. */
    unexpectedClientKind = null;
    authFailures = 0;
    /** Why the last handshake was refused. */
    lastRejection = null;
    /** Binary frames received — the real server cannot read these at all. */
    binaryFramesSeen = 0;
    /** Frame types seen after auth that this relay has no use for. */
    unknownFrameTypes = [];
    /** The account uid announced in auth.ok. */
    accountUid = "0876d2e6-a3b0-4c1d-9ab9-0673d17d73d9";
    constructor(wss, options) {
        this.options = options;
        this.wss = wss;
        this.wss.on("connection", (ws) => this.handleDevice(ws));
    }
    static async start(options) {
        if (options.server) {
            // Already listening; `listening` will never fire again for us.
            return new FakeRelay(new WebSocketServer({ server: options.server }), options);
        }
        const wss = new WebSocketServer({ port: 0 });
        await new Promise((resolve) => wss.on("listening", () => resolve()));
        return new FakeRelay(wss, options);
    }
    get url() {
        return `ws://127.0.0.1:${this.port}/v1/relay/ws`;
    }
    get port() {
        const address = this.options.server ? this.options.server.address() : this.wss.address();
        return address.port;
    }
    /** What an agent addressed to reach this relay — forwarded as `Host`. */
    get authority() {
        return `127.0.0.1:${this.port}`;
    }
    /** Mirrors `_reject`: auth.error then close 4001, never echoing the token. */
    reject(ws, reason) {
        this.authFailures += 1;
        this.lastRejection = reason;
        ws.send(JSON.stringify({ type: "auth.error", reason }));
        ws.close(4001, "auth_failed");
    }
    handleDevice(ws) {
        let authed = false;
        // Plow opens with the challenge; the credential is never on the upgrade.
        ws.send(JSON.stringify({ type: "auth.challenge" }));
        ws.on("message", (data, isBinary) => {
            // STRICTNESS 1: text frames only. starlette's receive_text() raises on a
            // binary frame and the socket dies mid-handshake — which is exactly what
            // the real relay did to us while this file was decoding bytes blindly.
            if (isBinary) {
                this.binaryFramesSeen += 1;
                ws.terminate();
                return;
            }
            let msg;
            try {
                msg = JSON.parse(data.toString("utf8"));
            }
            catch {
                // STRICTNESS 2: unparseable auth frame is fatal, not ignored.
                if (!authed)
                    this.reject(ws, "Invalid JSON");
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
                if (this.clientKind !== WIRE_CLIENT_KIND)
                    this.unexpectedClientKind = this.clientKind;
                authed = true;
                // The real auth.ok carries the account uid.
                ws.send(JSON.stringify({
                    type: "auth.ok",
                    account_id: this.accountUid,
                    ping_interval_ms: this.options.pingIntervalMs ?? 15_000,
                }));
                // The device is registered at auth.ok — the real relay registers here,
                // not on any follow-up frame. An earlier version waited for a `ready`
                // frame, which our wire contract does not have.
                this.device = ws;
                this.deviceOnline = true;
                for (const r of this.onlineResolvers.splice(0))
                    r();
                return;
            }
            if (msg.type === "ping") {
                ws.send(JSON.stringify({ type: "pong" }));
                return;
            }
            if (msg.type === WIRE_FRAME_RESPONSE) {
                const frame = msg;
                const waiter = this.pending.get(frame.rid);
                if (!waiter)
                    return; // an unknown rid is never answered on faith
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
            if (msg.type !== "ping")
                this.unknownFrameTypes.push(String(msg.type));
        });
        ws.on("close", () => {
            if (this.device === ws) {
                this.device = null;
                this.deviceOnline = false;
            }
        });
    }
    /** Wait until a device has completed the handshake. */
    waitForDevice(timeoutMs = 5_000) {
        if (this.deviceOnline)
            return Promise.resolve();
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
    agentCall(request, auth, timeoutMs = 10_000) {
        const device = this.device;
        if (!device)
            return Promise.reject(new Error("device offline"));
        const rid = `rid-${this.nextRid++}`;
        const headers = relayStripHeaders(request.headers ?? {});
        // The relay strips the agent's credential; the Mac must never see it.
        delete headers.authorization;
        delete headers.Authorization;
        // …and forwards the authority the agent addressed, which is the relay's.
        headers.host = this.authority;
        return new Promise((resolve, reject) => {
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
            device.send(JSON.stringify({
                type: WIRE_FRAME_REQUEST,
                rid,
                method: request.method ?? "POST",
                path: request.path,
                headers,
                body: request.body ?? null,
                auth,
            }));
        });
    }
    /** Drop the live device socket without stopping the relay — a restart. */
    dropDevice() {
        this.device?.terminate();
        this.device = null;
        this.deviceOnline = false;
    }
    async stop() {
        for (const client of this.wss.clients)
            client.terminate();
        await new Promise((resolve) => this.wss.close(() => resolve()));
    }
}
//# sourceMappingURL=fakeRelay.js.map
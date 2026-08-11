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
export declare class FakeRelay {
    private readonly options;
    private readonly wss;
    private device;
    private nextRid;
    private readonly pending;
    /** Every frame the device sent, for assertions. */
    readonly received: Record<string, unknown>[];
    /** Resolves once a device has completed the handshake. */
    private onlineResolvers;
    deviceOnline: boolean;
    /** The client kind the device registered under. */
    clientKind: string | null;
    /** Set when the device registered under a kind this relay does not expect. */
    unexpectedClientKind: string | null;
    authFailures: number;
    /** Why the last handshake was refused. */
    lastRejection: string | null;
    /** Binary frames received — the real server cannot read these at all. */
    binaryFramesSeen: number;
    /** Frame types seen after auth that this relay has no use for. */
    readonly unknownFrameTypes: string[];
    /** The account uid announced in auth.ok. */
    readonly accountUid = "0876d2e6-a3b0-4c1d-9ab9-0673d17d73d9";
    private constructor();
    static start(options: FakeRelayOptions): Promise<FakeRelay>;
    get url(): string;
    private get port();
    /** What an agent addressed to reach this relay — forwarded as `Host`. */
    get authority(): string;
    /** Mirrors `_reject`: auth.error then close 4001, never echoing the token. */
    private reject;
    private handleDevice;
    /** Wait until a device has completed the handshake. */
    waitForDevice(timeoutMs?: number): Promise<void>;
    /**
     * The agent-facing leg: forward one HTTP exchange to the Mac and return its
     * answer. Mirrors the relay's rules — a relay-minted `rid`, `Authorization`
     * and hop-by-hop headers stripped, path and query forwarded as sent, and the
     * body never parsed.
     */
    agentCall(request: {
        method?: string;
        path: string;
        headers?: Record<string, string>;
        body?: string | null;
    }, auth: RelayFrameAuth, timeoutMs?: number): Promise<TunnelledResponse>;
    /** Drop the live device socket without stopping the relay — a restart. */
    dropDevice(): void;
    stop(): Promise<void>;
}
//# sourceMappingURL=fakeRelay.d.ts.map
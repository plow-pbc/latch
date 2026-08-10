/**
 * The wire contract between this Mac and the Plow relay.
 *
 * Everything a relay implementation must agree with is in this one file, on
 * purpose: the relay lives in a different repository and is written by someone
 * else, so the names below are the interface, not implementation detail.
 *
 * The handshake and heartbeat are plow's existing channel protocol, not
 * anything new — challenge → auth → `auth.ok` → `ready`, then a JSON `ping`
 * every `ping_interval_ms`. That shape is fixed by
 * `api/plow/channels/ws_schemas.py` and the shared client at
 * `app/agent-runtime/channels/shared/ws-client-core.ts`, and this client
 * follows it exactly.
 *
 * **The two request/response frame `type` strings and the client kind are NOT
 * pinned by the design docs.** The design gives their fields but not their
 * names. These are our proposal, following plow's dotted convention; if the
 * relay picks different strings, this file is the only place that changes.
 */

/** Constant client kind for the device socket. The uid is the other half of
 * the registry key, so it is deliberately not embedded here. */
export const RELAY_CLIENT_KIND = "relay-device";

/** relay → Mac: one tunnelled HTTP request. */
export const FRAME_REQUEST = "relay.request";

/** Mac → relay: the answer to one `rid`. */
export const FRAME_RESPONSE = "relay.response";

/** Plow's heartbeat cadence. The relay's staleness gate is twice this, so a
 * slower heartbeat makes calls start failing after 30s of quiet. */
export const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * Hop-by-hop headers, which are per-connection and must never be tunnelled in
 * either direction. Replaying `content-length` or `transfer-encoding` from one
 * hop into another invites a mismatch between the body we actually send and
 * what the header claims.
 */
export const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

/** Drop hop-by-hop headers from a header bag, preserving everything else. */
export function stripHopByHop(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (!HOP_BY_HOP.has(key.toLowerCase())) out[key] = value;
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

export interface RelayRequestFrame {
  type: typeof FRAME_REQUEST;
  rid: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string | null;
  auth?: RelayFrameAuth;
}

export interface RelayResponseFrame {
  type: typeof FRAME_RESPONSE;
  rid: string;
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** True when `value` is shaped like a request frame we can actually serve. */
export function isRequestFrame(value: unknown): value is RelayRequestFrame {
  if (typeof value !== "object" || value === null) return false;
  const f = value as Record<string, unknown>;
  return (
    f.type === FRAME_REQUEST &&
    typeof f.rid === "string" &&
    f.rid.length > 0 &&
    typeof f.method === "string" &&
    typeof f.path === "string"
  );
}

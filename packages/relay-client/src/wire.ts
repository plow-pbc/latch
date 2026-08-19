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
 * Headers that must not be tunnelled in either direction.
 *
 * The first eight are the RFC 9110 hop-by-hop set: per-connection, meaningless
 * on the next hop. `content-length` is NOT hop-by-hop, but is dropped anyway
 * because each hop re-frames the body — replaying a length measured on another
 * hop invites a mismatch with what we actually send.
 *
 * `Host` is deliberately NOT in this set. It is end-to-end, it names the
 * authority the agent actually addressed, and dropping it would leave this Mac
 * validating a fabricated one. See `stripHopByHop` callers.
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

/**
 * The exchange deadline this contract is written against: the relay abandons a
 * tunnelled HTTP exchange 25 seconds after it forwards it.
 *
 * The relay owns this number and advertises it (see `EXCHANGE_DEADLINE_FIELD`);
 * the constant here is what a relay must advertise before this Mac will use the
 * longer deferrable budget, not something this side gets to choose.
 */
export const RELAY_EXCHANGE_DEADLINE_MS = 25_000;

/**
 * What a relay that advertises nothing is assumed to enforce. The deployed
 * relay abandoned at 20 seconds before it learned to advertise, so an absent
 * field means the old deadline — never "no deadline".
 */
export const LEGACY_EXCHANGE_DEADLINE_MS = 20_000;

/** The `auth.ok` field carrying the relay's exchange deadline, in ms. */
export const EXCHANGE_DEADLINE_FIELD = "exchange_deadline_ms";

/**
 * How long a deferrable tool may block against a 25-second exchange, measured
 * from tool callback entry — validation, path resolution and approval
 * persistence all inside it.
 */
export const DEFERRABLE_BUDGET_MS = 15_000;

/** The budget kept for a relay that does not advertise the longer deadline. */
export const LEGACY_CALL_BUDGET_MS = 8_000;

/**
 * What is reserved between the budget expiring and the agent holding the
 * answer: registering the deferred result, framing the response, and the relay
 * matching it to the waiting HTTP exchange. This Mac refuses to configure a
 * budget that leaves less than this.
 */
export const MIN_DELIVERY_MARGIN_MS = 10_000;

/**
 * The deferrable budget to run against a relay advertising `advertised`.
 *
 * Rollout is relay-first, so this has to answer for three relays: one that
 * advertises 25s or more (the long budget), one that advertises less, and one
 * that advertises nothing at all because it predates the field (the old 20s
 * deadline, and with it the old 8s budget). In every case the result is capped
 * so at least `MIN_DELIVERY_MARGIN_MS` is left for delivery — a budget that
 * eats its own delivery margin would produce handles the agent never receives.
 */
export function deferrableBudgetMs(advertised: unknown): number {
  const deadline =
    typeof advertised === "number" && Number.isFinite(advertised) && advertised > 0
      ? advertised
      : LEGACY_EXCHANGE_DEADLINE_MS;
  const wanted =
    deadline >= RELAY_EXCHANGE_DEADLINE_MS ? DEFERRABLE_BUDGET_MS : LEGACY_CALL_BUDGET_MS;
  return Math.max(0, Math.min(wanted, deadline - MIN_DELIVERY_MARGIN_MS));
}

/**
 * relay → Mac: the relay matched our response for `rid` to the HTTP exchange
 * still waiting on it.
 *
 * This is the only evidence this side ever has that a deferred handle reached
 * the agent's transport. It says nothing about a model having read it, and its
 * absence is not proof of failure — but nothing may claim an operation was
 * backgrounded without it.
 */
export const FRAME_RESPONSE_ACK = "relay.response.ack";

export interface RelayResponseAckFrame {
  type: typeof FRAME_RESPONSE_ACK;
  rid: string;
}

/** True when `value` is an acknowledgement frame naming a rid. */
export function isResponseAckFrame(value: unknown): value is RelayResponseAckFrame {
  if (typeof value !== "object" || value === null) return false;
  const f = value as Record<string, unknown>;
  return f.type === FRAME_RESPONSE_ACK && typeof f.rid === "string" && f.rid.length > 0;
}

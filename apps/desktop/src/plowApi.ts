/**
 * The Plow HTTP calls first-run setup makes — the three activation calls the
 * app leads with, the two OTP calls behind the "use a phone code instead"
 * fallback, and the two the account itself needs.
 *
 * **No credential ever appears in a thrown message, a returned message, or a
 * URL.** Tokens travel in an `Authorization` header and nowhere else. Every
 * failure here is turned into a `PlowApiError` whose `message` is written for a
 * human to read on screen — so it must stay free of secrets by construction,
 * not by a caller remembering to redact.
 */

/** One API origin, e.g. `https://api.plow.co`. Everything else derives. */
export type ApiBaseUrl = string;

export const PRODUCTION_API_BASE_URL = "https://api.plow.co";

/** Developer-only escape hatch, so retargeting does not need a rebuild. */
export const API_BASE_URL_ENV = "DOMO_API_BASE_URL";

/**
 * How long any one request may take before it is a failure.
 *
 * Every call here runs inside `Onboarding.run`, which holds a `busy` flag that
 * the screen turns into "Talking to Plow…" and a disabled button on every
 * control. A request that is accepted and then never answered — a wedged proxy,
 * a half-open socket, an endpoint that does not exist behind something that
 * still completes the TCP handshake — leaves that flag set forever, and the
 * whole window goes dead with a spinner on it. `fetch` has no default timeout,
 * so it has to be this one.
 */
export const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Which Plow this build talks to. **Baked in, never a setting.**
 *
 * A credential is only valid against the environment that minted it, so a
 * user-editable origin would mean a stored token silently becoming meaningless
 * and an auth error nobody could explain. If it cannot be changed, it cannot be
 * changed wrongly. The env var is a developer affordance, not a user setting.
 *
 * **Every build defaults to production**, including a run from source. Prod is
 * live, so pointing at it is the useful default and the one that matches what a
 * user gets; a build that quietly talked to localhost was a standing way to
 * "test" against nothing. A developer who wants another relay exports
 * `DOMO_API_BASE_URL` themselves — there is no second default to keep in step.
 */
export function resolveApiBaseUrl(opts: {
  env?: Record<string, string | undefined>;
}): ApiBaseUrl {
  const override = normalizeApiBaseUrl((opts.env ?? {})[API_BASE_URL_ENV] ?? "");
  if (override) return override;
  return PRODUCTION_API_BASE_URL;
}

/** Trim a base URL to a bare origin+path with no trailing slash. */
export function normalizeApiBaseUrl(raw: string): ApiBaseUrl {
  return (raw ?? "").trim().replace(/\/+$/, "");
}

/**
 * The device socket is the same origin with the scheme swapped and the relay
 * path appended. Derived rather than configured: two URL fields that must agree
 * is a support burden, and the relay path is fixed by the wire contract.
 */
export function relaySocketUrl(base: ApiBaseUrl): string {
  const url = new URL(normalizeApiBaseUrl(base));
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  url.pathname = url.pathname.replace(/\/+$/, "") + "/v1/relay/ws";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export type PlowApiErrorKind =
  | "network" // the API could not be reached at all
  | "unauthorized" // a wrong or expired code, or a revoked token
  | "provider_unavailable" // the SMS provider is down — the one honest OTP failure
  | "forbidden"
  | "expired" // 410: an activation code nobody completed in time
  | "http"; // anything else, reported with its status

export class PlowApiError extends Error {
  constructor(
    readonly kind: PlowApiErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "PlowApiError";
  }
}

export interface RelayInfo {
  uid: string;
  mcpUrl: string;
  deviceConnected: boolean;
}

export interface MintedCredential {
  /** Shown to the user once (agents) or stored and never shown (the device). */
  token: string;
  keyPrefix: string;
  name: string;
}

/** `AbortSignal.timeout` aborts with a `TimeoutError`; some runtimes surface it
 * as a plain `AbortError`, so both count. */
function isTimeout(error: unknown): boolean {
  const name = (error as { name?: unknown })?.name;
  return name === "TimeoutError" || name === "AbortError";
}

export interface Activation {
  /** The five characters the user texts. Shown large on screen. */
  displayCode: string;
  /** A SECRET: it is the poll credential. Never rendered, never logged. */
  activationSecret: string;
  /**
   * The pool line this activation was assigned. **Render this and nothing
   * else.** The chat is provisioned only if the code arrives *on the assigned
   * line*, so texting the right code to a number the app picked activates the
   * account and silently provisions no chat — a failure with no symptom until
   * the cloud-agent screen has nothing to point at.
   */
  sendTo: string;
}

/**
 * One HUMAN member of the provisioned chat.
 *
 * `participants[]` on the wire is discriminated — the agent participant is a
 * different shape and carries no `display_name` — so this covers `type:
 * "member"` only.
 */
export interface ActivationChatParticipant {
  displayName: string;
  /** The member's own address — a phone number, when the server has one. */
  providerKey: string | null;
}

/**
 * The chat the activation created.
 *
 * A chat has no title and no last-activity field, so what identifies it to a
 * human is the number it runs on plus its members' names. Nothing here is a
 * secret: it is the same data `GET /v1/chats` hands back, and the renderer may
 * see it.
 *
 * **The chat's top-level `provider_key` is deliberately not read.** It is the
 * provider's own thread id — "chat_5" and the like — not a phone number, and a
 * field that is never parsed is a field no screen can accidentally show as one.
 * The number lives on the agent participant's `line`.
 */
export interface ActivationChat {
  uid: string;
  /** `pending` until the member verifies; `active` after. */
  status: string;
  /** The number the chat runs on: the pool line the user texted. */
  line: string | null;
  /** Members only — the humans in the chat. */
  participants: ActivationChatParticipant[];
  createdAt: string;
}

/**
 * What a redeem poll found.
 *
 * `verified` is terminal and is read exactly once: the server hands the session
 * token to the first redeem that sees the completion, and a second redeem
 * returns `{"status":"verified"}` with the `token` key *omitted*. Re-reading can
 * therefore only lose it.
 */
export type ActivationRedeem =
  | { status: "pending" }
  | { status: "verified"; token: string | null; chat: ActivationChat | null };

/**
 * Read the chat out of a verified redeem, tolerating a server that sends less
 * than we expect.
 *
 * Defensive on purpose: this is display data on the last screen of setup, and a
 * field arriving in an unexpected shape must not throw away a sign-in that has
 * already succeeded. Anything unreadable becomes `null` — "no chat to show" —
 * never an error.
 */
export function parseActivationChat(raw: unknown): ActivationChat | null {
  if (!raw || typeof raw !== "object") return null;
  const chat = raw as Record<string, unknown>;
  const uid = typeof chat.uid === "string" ? chat.uid : "";
  if (!uid) return null;
  const all = Array.isArray(chat.participants)
    ? chat.participants.filter((p): p is Record<string, unknown> => !!p && typeof p === "object")
    : [];
  // The number the chat runs on is the AGENT participant's line, not the
  // chat's own `provider_key` — that one is the provider's thread id.
  const agent = all.find((p) => p.type === "agent");
  const line = (agent?.line ?? null) as Record<string, unknown> | null;
  const participants = all
    .filter((p) => p.type === "member")
    .map((p) => ({
      displayName: typeof p.display_name === "string" ? p.display_name : "",
      providerKey: typeof p.provider_key === "string" ? p.provider_key : null,
    }));
  return {
    uid,
    status: typeof chat.status === "string" ? chat.status : "",
    line: line && typeof line.provider_key === "string" ? line.provider_key : null,
    participants,
    createdAt: typeof chat.created_at === "string" ? chat.created_at : "",
  };
}

/** `fetch`, injectable so tests never touch the network. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class PlowApi {
  constructor(
    readonly baseUrl: ApiBaseUrl,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  /**
   * Start an activation: the server mints a code, the user texts it, and the
   * account is created from that text. Outbound, so it works for a phone number
   * that has never touched Plow and cannot be used to probe who has an account.
   *
   * `provision_chat` is what makes the account have a chat at all. Without it
   * the server falls back to the managed phone, which is not a pool line, so
   * the text activates and creates nothing — and a 1:1 sent to a pool line with
   * no chat behind it is dropped, so there is no second way in later. With it,
   * a pool line is assigned, comes back as `send_to`, and the webhook
   * provisions the chat when the code lands there.
   */
  async createActivation(name: string): Promise<Activation> {
    const data = await this.call<{ display_code: string; activation_secret: string; send_to: string }>(
      "POST",
      "/v1/auth/activate",
      {
        body: { name, provision_chat: true },
        // 503 means something else here than it does on the OTP calls. Asking
        // for a chat makes this endpoint assign a pool line, and an exhausted
        // pool answers 503 — nothing to do with the SMS provider. The shared
        // fallback would tell the user their texts are down and send them to
        // wait on the wrong thing, so this call brings its own sentence. Only
        // the fallback: a server that wrote a `detail` still wins, because it
        // knows which 503 this was and we are guessing.
        unavailableMessage: "Plow couldn't start setup right now. Try again in a minute.",
      },
    );
    return {
      displayCode: data.display_code,
      activationSecret: data.activation_secret,
      sendTo: data.send_to,
    };
  }

  /**
   * Has the text arrived yet? `410` means the code expired *without* being
   * completed — the server honours a completion that raced past the deadline,
   * so a 410 is authoritative and a local clock is not.
   *
   * The verified answer also carries the chat the activation provisioned. Like
   * the token it is read exactly once, so it is kept here rather than parsed
   * away: a second redeem cannot get it back.
   */
  async redeemActivation(activationSecret: string): Promise<ActivationRedeem> {
    const data = await this.call<{ status: string; token?: string; chat?: unknown }>(
      "POST",
      "/v1/auth/activate/redeem",
      { body: { activation_secret: activationSecret } },
    );
    if (data.status === "verified") {
      return { status: "verified", token: data.token ?? null, chat: parseActivationChat(data.chat) };
    }
    return { status: "pending" };
  }

  /**
   * Ask for a login code.
   *
   * This returns `{ok: true}` for an unknown number, an unparseable number and
   * a failed SMS send alike — deliberately, so it cannot be used to probe
   * whether an account exists. So a successful return here means "we asked",
   * never "a code was sent", and the copy on the screen has to say so.
   */
  async requestOtp(phone: string): Promise<void> {
    await this.call("POST", "/v1/auth/otp/request", { body: { phone } });
  }

  /** Exchange a code for a session token. 401 on a wrong or expired code. */
  async verifyOtp(phone: string, code: string): Promise<string> {
    const data = await this.call<{ token: string }>("POST", "/v1/auth/otp/verify", {
      body: { phone, code },
    });
    if (!data?.token) throw new PlowApiError("http", "Plow did not return a login token.");
    return data.token;
  }

  /**
   * The only way to learn which account you just logged into: verify returns a
   * token and nothing else. Also the authority on the agent endpoint — the app
   * never constructs that URL itself.
   */
  async relayInfo(token: string): Promise<RelayInfo> {
    const data = await this.call<{ uid: string; mcp_url: string; device_connected?: boolean }>(
      "GET",
      "/v1/relay/info",
      { token },
    );
    return { uid: data.uid, mcpUrl: data.mcp_url, deviceConnected: !!data.device_connected };
  }

  /**
   * Mint this Mac's credential: `relay:device` + `llm:chat`, and nothing else.
   * It holds the socket, may create agents, and — because of `llm:chat` — **it
   * can spend the account's Plow credits**: it is the bearer token on the
   * `chatCompletion` calls that fund adversarial-reviewer inference. It can
   * touch nothing else on the account.
   *
   * `revoke_calling_session` retires the session that authorised this call — the
   * activation or OTP session — in the same transaction as the mint. That
   * session carries `keys:manage` and `relay:*`, so it can mint *any* credential
   * on the account; the app has no reason to hold it past this call, and one
   * server-side revoke is the only way to be sure it is gone. It also cleans up
   * the row the login just created, which nothing else supersedes.
   */
  async mintDeviceCredential(token: string, name: string): Promise<MintedCredential> {
    const data = await this.call<{ token: string; key_prefix?: string; name?: string }>(
      "POST",
      "/v1/relay/devices",
      { token, body: { name, revoke_calling_session: true } },
    );
    return { token: data.token, keyPrefix: data.key_prefix ?? "", name: data.name ?? name };
  }

  /**
   * Ask Plow to retire THIS Mac's own credential, authenticating with the
   * credential being retired. Sign-out is the only caller.
   *
   * Best-effort by contract: the caller must clear locally whether or not this
   * succeeds. A Mac that cannot reach Plow is exactly the Mac whose owner most
   * wants the local copy gone, and the server-side route may not be deployed
   * yet — a 404 must not strand a signed-out Mac still holding a credential.
   *
   * The token rides in the `Authorization` header, as everywhere else. It is
   * never in the path, so this is not `/devices/{id}/revoke`: the server knows
   * which credential is calling.
   */
  async revokeDeviceCredential(token: string): Promise<void> {
    await this.call<unknown>("POST", "/v1/relay/devices/self/revoke", { token });
  }

  /** Mint an agent credential through the relay's own API (`relay:call` only,
   * whatever we ask for — the server decides). */
  async createAgent(token: string, name: string): Promise<MintedCredential> {
    const data = await this.call<{ token: string; key_prefix?: string; name?: string }>(
      "POST",
      "/v1/relay/agents",
      { token, body: { name } },
    );
    return { token: data.token, keyPrefix: data.key_prefix ?? "", name: data.name ?? name };
  }

  /**
   * One inference call, as `{status, body}` — **this deliberately does not go
   * through `call()`**.
   *
   * `call()` throws `PlowApiError`s whose message carries the server's `detail`
   * verbatim (see `errorFor`), which is right for onboarding, where `detail` is
   * a sentence written for the person reading it. It is wrong here: the
   * reviewer's failure reasons are shown to a human deciding whether to trust
   * an operation, and an upstream body is not text we control. So this returns
   * the status and the decoded body and lets the caller do its own mapping —
   * the reviewer keeps `plowHttpReason`, and nothing from the body reaches a
   * reason string except what that mapping deliberately extracts.
   *
   * What IS shared with `call()`: the bearer header, the bounded request, and
   * the network-error sanitation in `request()`.
   *
   * `signal` is the caller's own budget. The reviewer runs on a 30s budget and
   * passes the signal it aborts on timeout, so a call it has given up on does
   * not keep running (and keep billing) after the verdict.
   */
  async chatCompletion(
    token: string,
    body: unknown,
    opts: { signal?: AbortSignal } = {},
  ): Promise<{ status: number; body: unknown }> {
    const response = await this.request("POST", "/v1/chat/completions", {
      token,
      body,
      signal: opts.signal,
    });
    let decoded: unknown = null;
    try {
      decoded = await response.json();
    } catch {
      // A body we cannot read is not an error here — the status still carries
      // the outcome, and the caller decides what an unreadable body means.
    }
    return { status: response.status, body: decoded };
  }

  private async call<T>(
    method: string,
    path: string,
    opts: { token?: string; body?: unknown; unavailableMessage?: string } = {},
  ): Promise<T> {
    const response = await this.request(method, path, opts);

    if (!response.ok) throw await this.errorFor(response, opts.unavailableMessage);
    if (response.status === 204) return undefined as T;
    try {
      return (await response.json()) as T;
    } catch {
      throw new PlowApiError("http", "Plow returned a response we couldn't read.", response.status);
    }
  }

  /**
   * The transport every call shares: bearer auth in the header and nowhere
   * else, a bounded request, and a network failure turned into a message
   * written here rather than forwarded. Returns the response whatever its
   * status — deciding what a status *means* belongs to the caller.
   */
  private async request(
    method: string,
    path: string,
    opts: { token?: string; body?: unknown; signal?: AbortSignal } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;

    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        // No caller may wait forever. A caller that owns a budget passes its
        // own signal; everyone else gets REQUEST_TIMEOUT_MS.
        signal: opts.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      // The cause carries a hostname at most, but it is not ours to vouch for,
      // so the message is written here rather than forwarded.
      //
      // A timeout is told apart from an unreachable host because they mean
      // different things to the person reading it: one is "this address is
      // wrong or you are offline", the other is "Plow took the request and went
      // quiet". Telling someone their network is down when the server is simply
      // not answering sends them to fix the wrong thing.
      if (isTimeout(error)) {
        throw new PlowApiError("network", "Plow didn't answer in time. Try again.");
      }
      throw new PlowApiError("network", `Couldn't reach Plow at ${this.baseUrl}.`);
    }
  }

  /**
   * `unavailableMessage` replaces the 503 fallback for one call. A 503 means
   * whatever the endpoint that sent it means by it, and only the caller knows
   * that; the default reads as "the SMS provider is down" because that is what
   * it is on the OTP calls, which are most of them.
   */
  private async errorFor(response: Response, unavailableMessage?: string): Promise<PlowApiError> {
    // `detail` is the FastAPI convention. It is server-authored and never
    // echoes a request header, so it is safe to surface.
    let detail = "";
    try {
      const body = (await response.json()) as { detail?: unknown };
      if (typeof body?.detail === "string") detail = body.detail;
    } catch {
      /* a non-JSON body tells us nothing worth showing */
    }
    if (response.status === 401) return new PlowApiError("unauthorized", detail || "Not authorized.", 401);
    if (response.status === 403) return new PlowApiError("forbidden", detail || "Not permitted.", 403);
    if (response.status === 410) {
      return new PlowApiError("expired", detail || "That code has expired.", 410);
    }
    if (response.status === 503) {
      return new PlowApiError(
        "provider_unavailable",
        detail || unavailableMessage || "Plow can't send text messages right now.",
        503,
      );
    }
    return new PlowApiError("http", detail || `Plow returned ${response.status}.`, response.status);
  }
}

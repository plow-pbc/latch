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

/** `compose.yaml` publishes the local API on `${PLOW_API_PORT:-18804}`. */
export const DEVELOPMENT_API_BASE_URL = "http://localhost:18804";

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
 */
export function resolveApiBaseUrl(opts: {
  isDevBuild: boolean;
  env?: Record<string, string | undefined>;
}): ApiBaseUrl {
  const override = normalizeApiBaseUrl((opts.env ?? {})[API_BASE_URL_ENV] ?? "");
  if (override) return override;
  return opts.isDevBuild ? DEVELOPMENT_API_BASE_URL : PRODUCTION_API_BASE_URL;
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
  /** Per-environment config — the managed phone, or the assigned chat line.
   * Render what the API returned; a hardcoded number is wrong somewhere. */
  sendTo: string;
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
  | { status: "verified"; token: string | null };

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
   */
  async createActivation(name: string): Promise<Activation> {
    const data = await this.call<{ display_code: string; activation_secret: string; send_to: string }>(
      "POST",
      "/v1/auth/activate",
      { body: { name } },
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
   */
  async redeemActivation(activationSecret: string): Promise<ActivationRedeem> {
    const data = await this.call<{ status: string; token?: string }>(
      "POST",
      "/v1/auth/activate/redeem",
      { body: { activation_secret: activationSecret } },
    );
    if (data.status === "verified") return { status: "verified", token: data.token ?? null };
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
   * Mint this Mac's credential. `relay:device` and nothing else: it holds the
   * socket and may create agents, and can touch nothing else on the account.
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

  private async call<T>(
    method: string,
    path: string,
    opts: { token?: string; body?: unknown } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        // No caller may wait forever. See REQUEST_TIMEOUT_MS.
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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

    if (!response.ok) throw await this.errorFor(response);
    if (response.status === 204) return undefined as T;
    try {
      return (await response.json()) as T;
    } catch {
      throw new PlowApiError("http", "Plow returned a response we couldn't read.", response.status);
    }
  }

  private async errorFor(response: Response): Promise<PlowApiError> {
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
        detail || "Plow can't send text messages right now.",
        503,
      );
    }
    return new PlowApiError("http", detail || `Plow returned ${response.status}.`, response.status);
  }
}

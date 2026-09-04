/**
 * The Plow HTTP calls first-run setup makes — the three activation calls and
 * the two the account itself needs.
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
 * A tighter bound for the banking-fill approval check, because it runs inside a
 * NON-deferrable `fill_secret` that must answer well inside the relay's ~20-25s
 * per-exchange budget — and it is only the FIRST hop: a vault-broker round trip
 * and the browser fill still follow it, so the generic `REQUEST_TIMEOUT_MS`
 * would leave too little headroom. A yes/no from the cloud is quick; a hang
 * (network stall, plow-side outage) must fail closed here, fast, rather than
 * stall the whole tool call into a relay-level timeout.
 */
export const PAYMENT_APPROVAL_TIMEOUT_MS = 5_000;

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
  | "unauthorized" // a missing, invalid, or revoked credential
  | "provider_unavailable" // the SMS provider is down
  | "forbidden"
  | "expired" // 410: an activation code nobody completed in time
  | "http"; // anything else, reported with its status

export class PlowApiError extends Error {
  constructor(
    readonly kind: PlowApiErrorKind,
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "PlowApiError";
  }
}

export interface RelayInfo {
  uid: string;
}

export interface RelayDeviceInfo {
  mcpUrl: string;
}

export interface ConnectorAccount {
  email: string;
  isDefault: boolean;
}

export interface ConnectorsOverview {
  google: { accounts: ConnectorAccount[] };
}

/** Provider identity and display copy accepted by the cloud-agent picker. */
export interface CloudAgentProvider {
  /** Opaque server-owned value sent back to the create endpoint unchanged. */
  id: string;
  name: string;
}

export interface MintedCredential {
  /** Session id used to revoke a mint that cannot be handed to the user. */
  id: number;
  /** Shown to the user once (agents) or stored and never shown (the device). */
  token: string;
  keyPrefix: string;
  name: string;
  /** Server-authored config containing one MCP server per active Latch. */
  mcpConfig: string;
}

/** The account credential metadata returned by `GET /v1/api-keys`.
 * Main-process only: `key_prefix` and `scopes` must be projected away before
 * any row crosses the renderer bridge. */
export interface KeyInfo {
  id: number;
  key_prefix: string | null;
  name: string | null;
  scopes: string[];
  tokens_used: number;
  is_active: boolean;
  last_seen_at: string | null;
  created_at: string | null;
  assistant_uid: string | null;
  /** `self_hosted`, a cloud provider such as `exe:hermes`, or null. */
  assistant_provider: string | null;
  chat_uids: string[];
}

/** The provider of an assistant that runs on this Mac rather than in the cloud. */
export const SELF_HOSTED_PROVIDER = "self_hosted";

/**
 * Is this assistant a VM Plow runs, rather than an activated Mac?
 *
 * The distinction is what removal costs. Only `DELETE /v1/assistants/{uid}`
 * takes a cloud assistant down — revoking its credential leaves the machine
 * running and unreachable. A `self_hosted` assistant has no machine, so
 * revoking the credential is the whole removal.
 *
 * A null provider answers false: this picks a DESTRUCTIVE route, and a
 * provider this build cannot name must not fall into the half that deletes.
 */
export function isCloudAssistant(provider: string | null): boolean {
  return provider !== null && provider !== SELF_HOSTED_PROVIDER;
}

/** Parse Plow's UTC timestamp, whose wire form may omit the trailing offset. */
export function parseApiTimestamp(value: string): number {
  const timestamp = value.trim();
  const hasOffset = /(?:Z|[+-]\d{2}:\d{2})$/i.test(timestamp);
  return Date.parse(hasOffset ? timestamp : `${timestamp}Z`);
}

export interface RevokedKey {
  status: string;
  id: number;
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
   * Where the endpoint says to text this code — **render this and nothing
   * else**, verbatim.
   *
   * The managed phone, not a pool line: this request asks for no chat, so the
   * server answers with the number that takes an activation text. Nothing is
   * provisioned on it, and nobody can be told to text it afterwards to get a
   * chat — that is a pool line's job, and a pool line is reached by texting it
   * directly rather than through an activation.
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
  /** The member's own address — a phone number, when the server has one. */
  providerKey: string | null;
  /** A human-readable member name, when the provider supplied one. */
  displayName: string | null;
  /** Whether this member owns the chat. */
  isOwner: boolean;
}

/**
 * The chat the activation created.
 *
 * A chat may have its own title; otherwise its members' names identify it, with
 * phone-number handles as a last fallback. Nothing here is a secret: it is the
 * same data `GET /v1/chats` hands back, and the renderer may see it.
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
  /** A title chosen for the whole chat, when it has one. */
  displayName: string | null;
  /** The number the chat runs on: the pool line the user texted. */
  line: string | null;
  /** Stable identity of that line, independent of its number or display name. */
  lineUid: string | null;
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

/** The new-agent activation result. Its session token has no representation. */
export type ProvisionedActivationRedeem =
  | { status: "pending" }
  | {
      status: "verified";
      chat: ActivationChat | null;
      shape: {
        chat: "missing" | "invalid" | "object";
        participantTypes: Array<"agent" | "member" | "other" | "invalid">;
        agentLine: "missing" | "invalid" | "uid_missing" | "uid_string";
      };
    };

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
  const members = all.filter((p) => p.type === "member");
  const parsedMembers = members.map((participant) => {
    const displayName = typeof participant.display_name === "string"
      ? participant.display_name
      : null;
    return {
      providerKey: typeof participant.provider_key === "string" ? participant.provider_key : null,
      displayName,
      // ROLE only. A provider that labels the owner "You" was a second answer
      // to the same question, and a member who happens to be named "You" is
      // not the account holder — the server says which participant owns the
      // chat, and nothing here has to infer it.
      isOwner: participant.role === "owner",
    };
  });
  // Keep the owner-first participant order used by addressing and the numeric
  // fallback. Labels can order the same members differently without changing
  // who a message is sent to.
  const participants = [
    ...parsedMembers.filter((participant) => participant.isOwner),
    ...parsedMembers.filter((participant) => !participant.isOwner),
  ];
  return {
    uid,
    status: typeof chat.status === "string" ? chat.status : "",
    displayName: typeof chat.display_name === "string" ? chat.display_name : null,
    line: line && typeof line.provider_key === "string" ? line.provider_key : null,
    lineUid: line && typeof line.uid === "string" ? line.uid : null,
    participants,
    createdAt: typeof chat.created_at === "string" ? chat.created_at : "",
  };
}

function provisionedActivationShape(
  raw: unknown,
): Extract<ProvisionedActivationRedeem, { status: "verified" }>["shape"] {
  if (raw === undefined || raw === null) {
    return { chat: "missing", participantTypes: [], agentLine: "missing" };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { chat: "invalid", participantTypes: [], agentLine: "missing" };
  }
  const participants = Array.isArray((raw as Record<string, unknown>).participants)
    ? (raw as Record<string, unknown>).participants as unknown[]
    : [];
  const records = participants.filter(
    (participant): participant is Record<string, unknown> =>
      typeof participant === "object" && participant !== null && !Array.isArray(participant),
  );
  const participantTypes = records.map((participant) =>
    participant.type === "agent" || participant.type === "member"
      ? participant.type
      : typeof participant.type === "string" ? "other" : "invalid");
  const agent = records.find((participant) => participant.type === "agent");
  if (!agent || agent.line === undefined || agent.line === null) {
    return { chat: "object", participantTypes, agentLine: "missing" };
  }
  if (typeof agent.line !== "object" || Array.isArray(agent.line)) {
    return { chat: "object", participantTypes, agentLine: "invalid" };
  }
  return {
    chat: "object",
    participantTypes,
    agentLine: typeof (agent.line as Record<string, unknown>).uid === "string"
      ? "uid_string"
      : "uid_missing",
  };
}

function valueEchoesSecret(value: unknown, secret: string): boolean {
  if (!secret) return false;
  const needles = secret.length > 10 ? [secret, secret.slice(0, 10)] : [secret];
  if (typeof value === "string") return needles.some((needle) => value.includes(needle));
  if (Array.isArray(value)) return value.some((entry) => valueEchoesSecret(entry, secret));
  if (value && typeof value === "object") {
    return Object.values(value).some((entry) => valueEchoesSecret(entry, secret));
  }
  return false;
}

function plausibleEmail(value: unknown): value is string {
  return typeof value === "string" && /^[^\s@]{1,64}@[^\s@]{1,255}$/.test(value);
}

/** Product calls it Google; the server's historical route name is Gmail. */
const GOOGLE_CONNECTOR_ROUTE = "/v1/connectors/gmail";

/** `fetch`, injectable so tests never touch the network. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * IPC callers are runtime values no matter what TypeScript says. Refuse
 * path-shaped strings, fractions and out-of-range numbers before the id is
 * interpolated into an authenticated request URL.
 */
function apiKeyId(id: number): number {
  if (!Number.isSafeInteger(id) || id < 0) throw new PlowApiError("http", "Invalid API key id.");
  return id;
}

export class PlowApi {
  readonly baseUrl: ApiBaseUrl;

  constructor(
    baseUrl: ApiBaseUrl,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    this.baseUrl = normalizeApiBaseUrl(baseUrl);
  }

  /**
   * Start an activation: the server mints a code, the user texts it, and the
   * account is created from that text. Outbound, so it works for a phone number
   * that has never touched Plow and cannot be used to probe who has an account.
   *
   * **`{ name }` and nothing else — byte-identical to the request Plow's own
   * app makes.** `provision_chat` used to ride along, which assigned one of the
   * account's few pool lines on every sign-in: an owner already holding a chat
   * on every line had none left to give, the endpoint answered 503, and they
   * could not pair another Mac at all. Signing in is not the moment to spend a
   * scarce resource on something sign-in does not need.
   *
   * A chat on a Plow number is got by TEXTING that number — the user sends it a
   * message and Plow makes the chat — not by an activation. Nothing downstream
   * needs one from here: the redeem's `chat` is nullable, and
   * `finishWithSession` already leaves stored chat state alone when a redeem
   * carries none.
   */
  async createActivation(name: string): Promise<Activation> {
    const data = await this.call<{ display_code: string; activation_secret: string; send_to: string }>(
      "POST",
      "/v1/auth/activate",
      {
        body: { name },
      },
    );
    return {
      displayCode: data.display_code,
      activationSecret: data.activation_secret,
      sendTo: data.send_to,
    };
  }

  /** Mint a code whose verified text provisions one new line and home chat. */
  async createProvisionedActivation(): Promise<Activation> {
    const data = await this.call<{ display_code: string; activation_secret: string; send_to: string }>(
      "POST",
      "/v1/auth/activate",
      { body: { provision_chat: true } },
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
   * Redeem a new-line activation without returning its session token.
   * Only the provisioned chat and value-free shape diagnostics leave here.
   */
  async redeemProvisionedActivation(
    activationSecret: string,
  ): Promise<ProvisionedActivationRedeem> {
    const data = await this.call<{ status: string; token?: unknown; chat?: unknown }>(
      "POST",
      "/v1/auth/activate/redeem",
      { body: { activation_secret: activationSecret } },
    );
    if (data.status !== "verified") return { status: "pending" };
    const token = typeof data.token === "string" ? data.token.trim() : "";
    const shape = provisionedActivationShape(data.chat);
    const parsed = parseActivationChat(data.chat);
    return {
      status: "verified",
      chat: parsed && !valueEchoesSecret(parsed, token) ? parsed : null,
      shape,
    };
  }

  /**
   * The only way to learn which account you just logged into: verify returns a
   * token and nothing else. Also the authority on the agent endpoint — the app
   * never constructs that URL itself.
   */
  async relayInfo(token: string): Promise<RelayInfo> {
    const data = await this.call<{ uid: string }>("GET", "/v1/relay/info", { token });
    return { uid: data.uid };
  }

  async registerRelayDevice(
    token: string,
    deviceId: string,
    hostname: string,
  ): Promise<RelayDeviceInfo> {
    const data = await this.call<{
      device_id?: unknown;
      mcp_url?: unknown;
    }>("PUT", `/v1/relay/devices/${encodeURIComponent(deviceId)}`, {
      token,
      body: { hostname },
    });
    if (
      data.device_id !== deviceId || typeof data.mcp_url !== "string"
    ) {
      throw new PlowApiError("http", "Plow did not register this Mac correctly.");
    }
    return {
      mcpUrl: data.mcp_url,
    };
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

  /** List the providers accepted by the cloud-agent create endpoint.
   * Provider ids are opaque server-owned values: preserve their bytes and order. */
  async listCloudAgentProviders(token: string): Promise<CloudAgentProvider[]> {
    const data = await this.call<unknown>("GET", "/v1/assistants/providers", { token })
      .catch((error) => {
        if (error instanceof PlowApiError && error.status === 503) {
          throw new PlowApiError(
            error.kind,
            "Plow couldn't load agent types right now. Try again.",
            error.status,
            error.code,
          );
        }
        throw error;
      });
    if (!Array.isArray(data)) {
      throw new PlowApiError("http", "Plow did not return a usable cloud-agent provider list.");
    }
    return data.map((provider) => {
      const row = provider && typeof provider === "object" && !Array.isArray(provider)
        ? provider as Record<string, unknown>
        : null;
      if (
        !row ||
        typeof row.id !== "string" ||
        row.id.trim().length === 0 ||
        typeof row.name !== "string" ||
        row.name.trim().length === 0
      ) {
        throw new PlowApiError("http", "Plow did not return a usable cloud-agent provider list.");
      }
      return { id: row.id, name: row.name };
    });
  }

  /** List the Google accounts available to Gmail and Calendar. */
  async listConnectors(token: string, signal?: AbortSignal): Promise<ConnectorsOverview> {
    const data = await this.call<unknown>("GET", "/v1/connectors", {
      token,
      signal,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    const root = data && typeof data === "object" && !Array.isArray(data)
      ? data as Record<string, unknown>
      : null;
    const gmail = root?.gmail && typeof root.gmail === "object" && !Array.isArray(root.gmail)
      ? root.gmail as Record<string, unknown>
      : null;
    if (!gmail || !Array.isArray(gmail.accounts)) {
      throw new PlowApiError("http", "Plow did not return a usable connector list.");
    }

    const accounts = gmail.accounts.map((raw): ConnectorAccount => {
      const row = raw && typeof raw === "object" && !Array.isArray(raw)
        ? raw as Record<string, unknown>
        : null;
      if (
        !row ||
        !plausibleEmail(row.account) ||
        valueEchoesSecret(row.account, token) ||
        typeof row.is_default !== "boolean"
      ) {
        throw new PlowApiError("http", "Plow did not return a usable connector list.");
      }
      return {
        email: row.account,
        isDefault: row.is_default,
      };
    });
    return { google: { accounts } };
  }

  /** Mint the short-lived browser URL for one OAuth pass. Main-process only. */
  async connectorConnectUrl(token: string, signal?: AbortSignal): Promise<string> {
    const data = await this.call<unknown>("POST", `${GOOGLE_CONNECTOR_ROUTE}/connect-code`, {
      token,
      signal,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    const code = data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>).code
      : null;
    if (typeof code !== "string" || !code.trim()) {
      throw new PlowApiError("http", "Plow did not return a usable connection address.");
    }
    const url = new URL(`${this.baseUrl}${GOOGLE_CONNECTOR_ROUTE}/connect`);
    url.searchParams.set("code", code);
    return url.toString();
  }

  /** Remove exactly one account; an account-less call is never issued. */
  async disconnectConnector(
    token: string,
    account: string,
    signal?: AbortSignal,
  ): Promise<{ status: string }> {
    const email = account.trim();
    if (!plausibleEmail(email)) {
      throw new PlowApiError("http", "Choose a valid account to disconnect.");
    }
    const query = new URLSearchParams({ account: email });
    const data = await this.call<unknown>(
      "POST",
      `${GOOGLE_CONNECTOR_ROUTE}/disconnect?${query}`,
      { token, signal, timeoutMs: REQUEST_TIMEOUT_MS },
    );
    const status = data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>).status
      : null;
    if (typeof status !== "string" || !status.trim()) {
      throw new PlowApiError("http", "Plow did not return a usable disconnect result.");
    }
    return { status };
  }

  /** Select exactly one connected account as the provider default. */
  async setDefaultConnector(
    token: string,
    account: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const email = account.trim();
    if (!plausibleEmail(email)) {
      throw new PlowApiError("http", "Choose a valid default account.");
    }
    const query = new URLSearchParams({ account: email });
    await this.call<unknown>("POST", `${GOOGLE_CONNECTOR_ROUTE}/set-default?${query}`, {
      token,
      signal,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
  }

  /**
   * The provider mint: one short-lived token per connected account, for a
   * provider that fans out. The body says `all`; the route is the provider's.
   *
   * This is THE trust-boundary parse of the batch envelope, complete on
   * purpose so no future field re-opens the class. Nothing server-authored
   * crosses it verbatim except an account that parses as a plausible email
   * and the one allowlisted machine reason; every other shape — a
   * non-email account, a named-but-tokenless row, an unknown reason —
   * becomes a FIXED local degraded entry. Both arrays are parsed before the
   * empty-envelope decision, because a degraded-only envelope is a valid
   * answer ("all your accounts need re-auth"), not a failed mint; only an
   * envelope with nothing in it at all reports as a failed mint. What a zero-healthy result MEANS is the caller's call —
   * deviceAgent fails a single command loudly on it.
   */
  async mintAccountTokens(
    token: string,
    prefix: string,
    action: string,
  ): Promise<{
    accounts: { account: string; token: string; isDefault: boolean }[];
    degraded: { account: string; reason: string }[];
  }> {
    const data = await this.call<{
      data?: { accounts?: unknown; degraded?: unknown };
    }>("POST", `${prefix}${action}`, { token, body: { all: true } });
    // Bounded and shaped, not RFC-precise: the value reaches error strings,
    // audit rows and the agent, so what matters is that a credential-shaped
    // or free-text string cannot ride the account field.
    const rows = (v: unknown): Record<string, unknown>[] =>
      Array.isArray(v) ? v.map((row) => (row ?? {}) as Record<string, unknown>) : [];
    const accounts: { account: string; token: string; isDefault: boolean }[] = [];
    const degraded: { account: string; reason: string }[] = [];
    for (const { account, access_token, is_default } of rows(data.data?.accounts)) {
      if (!plausibleEmail(account)) {
        degraded.push({ account: "(unrecognized account)", reason: "malformed entry" });
        continue;
      }
      const minted = typeof access_token === "string" ? access_token.trim() : "";
      if (!minted) {
        degraded.push({ account, reason: "token refresh failed" });
        continue;
      }
      // The last field of the row: a provider token that CONTAINS the bearer
      // credential is the credential echoed back, and it must not enter a
      // child's environment as if Google minted it.
      if (minted.includes(token)) {
        degraded.push({ account, reason: "malformed entry" });
        continue;
      }
      accounts.push({ account, token: minted, isDefault: is_default === true });
    }
    for (const { account, reason } of rows(data.data?.degraded)) {
      if (!plausibleEmail(account)) {
        degraded.push({ account: "(unrecognized account)", reason: "malformed entry" });
        continue;
      }
      degraded.push({ account, reason: reason === "needs_reauth" ? reason : "token refresh failed" });
    }
    if (accounts.length === 0 && degraded.length === 0) {
      throw new PlowApiError("http", "Plow did not return a usable provider token.");
    }
    return { accounts, degraded };
  }

  /** Mint an agent credential through the relay's own API. Named with a line,
   * the server mints the assistant role on it — `relay:call`, `chats:use`,
   * `llm:chat`, `payments:request`. Without one it mints `relay:call` alone,
   * which is all an MCP-only client needs. */
  async createAgent(token: string, name: string, lineUid: string | null = null): Promise<MintedCredential> {
    const line = (lineUid ?? "").trim();
    const data = await this.call<{
      id?: unknown;
      token: string;
      key_prefix?: string;
      name?: string;
      mcp_config?: unknown;
    }>(
      "POST",
      "/v1/relay/agents",
      { token, body: line ? { name, line_uid: line } : { name } },
    );
    if (typeof data.id !== "number" || typeof data.mcp_config !== "string" || !data.mcp_config.trim()) {
      throw new PlowApiError("http", "Plow did not return an MCP configuration.");
    }
    return {
      id: data.id,
      token: data.token,
      keyPrefix: data.key_prefix ?? "",
      name: data.name ?? name,
      mcpConfig: data.mcp_config,
    };
  }

  /** List this account's credential metadata. The stored credential remains in
   * the bearer header and is never returned. */
  async listApiKeys(token: string): Promise<KeyInfo[]> {
    return this.call<KeyInfo[]>("GET", "/v1/api-keys", { token });
  }

  /** Soft-revoke one credential by its server id. */
  async revokeApiKey(token: string, id: number): Promise<RevokedKey> {
    return this.call<RevokedKey>("DELETE", `/v1/api-keys/${apiKeyId(id)}`, { token });
  }

  /**
   * Rename one credential. The name is the row's display name on the Agents
   * tab, and — for a cloud agent — the assistant's name in Plow, which is why
   * the wire field is `assistant_name`. Plow answers with the session's
   * preferences; nothing here reads them, because the roster re-read that
   * follows is the only truth the screen shows.
   */
  async renameApiKey(token: string, id: number, name: string): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) throw new PlowApiError("http", "A name is required.");
    if (trimmed.length > 200) throw new PlowApiError("http", "A name can be at most 200 characters.");
    await this.call<unknown>("PATCH", `/v1/api-keys/${apiKeyId(id)}/preferences`, {
      token,
      body: { assistant_name: trimmed },
    });
  }

  /**
   * Consume a single-use owner payment approval for a banking-credential fill:
   * `POST /v1/payment-approvals/consume {session_id, domain}` → `{approved}`,
   * authenticated with this Mac's device credential.
   *
   * SINGLE-USE by contract — a `true` here CONSUMES the approval — so the caller
   * (the browser fill gate) invokes it exactly once, at the moment of release.
   *
   * FAIL-CLOSED: this goes through `call()`, which throws on any non-2xx (no
   * approval on file, an expired one, a server error). The gate treats a throw
   * exactly like `approved: false`, so no status needs decoding here; a body
   * that omits or malforms `approved` reads as not-approved for the same reason.
   */
  async consumePaymentApproval(
    token: string,
    request: { sessionId: string; domain: string },
  ): Promise<{ approved: boolean }> {
    const data = await this.call<{ approved?: boolean }>(
      "POST",
      "/v1/payment-approvals/consume",
      {
        token,
        body: { session_id: request.sessionId, domain: request.domain },
        // Its own tighter budget, not the generic transport timeout: `fill_secret`
        // is non-deferrable and this is only its first hop. A hang fails closed.
        signal: AbortSignal.timeout(PAYMENT_APPROVAL_TIMEOUT_MS),
      },
    );
    return { approved: data?.approved === true };
  }

  /**
   * One inference call, as `{status, body}` — **this deliberately does not go
   * through `call()`**.
   *
   * `call()` throws `PlowApiError`s whose message normally carries the server's
   * credential-safe `detail` (see `errorFor`). That is right for onboarding,
   * where `detail` is a sentence written for the person reading it. It is wrong
   * here: the reviewer's failure reasons are shown to a human deciding whether
   * to trust an operation, and an upstream body is not text we control. So this
   * returns the status and the decoded body and lets the caller do its own
   * mapping — the reviewer keeps `plowHttpReason`, and nothing from the body
   * reaches a reason string except what that mapping deliberately extracts.
   *
   * What IS shared with `call()`: the bearer header, the bounded request, and
   * the network-error sanitation in `request()`.
   *
   * `signal` is the caller's own budget. The reviewer runs on its own budget and
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
    opts: { token?: string; body?: unknown; signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<T> {
    const response = await this.request(method, path, opts);

    if (!response.ok) throw await this.errorFor(response, opts.token);
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
  async request(
    method: string,
    path: string,
    opts: {
      token?: string;
      body?: unknown;
      signal?: AbortSignal;
      timeoutMs?: number;
      callerAbortIsLifecycle?: boolean;
    } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;

    // A caller-owned signal remains its whole budget unless the endpoint also
    // supplies a request timeout. Cloud-agent polling needs both: sign-out or
    // removal must cancel it, and one stuck GET must still end after 15s.
    const timeout =
      opts.timeoutMs !== undefined || !opts.signal
        ? AbortSignal.timeout(opts.timeoutMs ?? REQUEST_TIMEOUT_MS)
        : null;
    const signal =
      opts.signal && timeout
        ? AbortSignal.any([opts.signal, timeout])
        : (opts.signal ?? timeout ?? undefined);

    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal,
      });
    } catch (error) {
      // Lifecycle cancellation is not a transport failure. Only endpoints
      // whose owner can distinguish it opt into preserving the abort reason.
      if (opts.callerAbortIsLifecycle) opts.signal?.throwIfAborted();
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

  private async errorFor(response: Response, credential?: string): Promise<PlowApiError> {
    // `detail` is the FastAPI convention, and it is server-authored. On an
    // AUTHENTICATED call it is dropped outright, whatever it says: a response
    // that repeats its bearer credential must never reach the screen, and the
    // rule covers any encoding of it — a prefix, a truncation, a fragment. A
    // check for the whole token only catches the one encoding we thought of,
    // and it let the first ten characters through. Detail is therefore kept or
    // dropped solely from whether the call carried a credential. A separately
    // structured, format-checked code is retained for machine decisions and is
    // never used as display copy.
    let detail = "";
    let code: string | undefined;
    try {
      const body = (await response.json()) as { detail?: unknown; code?: unknown };
      if (typeof body?.detail === "string") detail = body.detail;
      const nestedCode = body?.detail && typeof body.detail === "object"
        ? (body.detail as { code?: unknown }).code
        : undefined;
      const rawCode = nestedCode ?? body?.code;
      if (typeof rawCode === "string" && /^[A-Z][A-Z0-9_]*$/.test(rawCode.trim())) {
        code = rawCode.trim();
      }
    } catch {
      /* a non-JSON body tells us nothing worth showing */
    }
    if (credential) detail = "";
    if (response.status === 401) return new PlowApiError("unauthorized", detail || "Not authorized.", 401, code);
    if (response.status === 403) return new PlowApiError("forbidden", detail || "Not permitted.", 403, code);
    if (response.status === 410) {
      return new PlowApiError("expired", detail || "That code has expired.", 410, code);
    }
    if (response.status === 503) {
      return new PlowApiError(
        "provider_unavailable",
        detail || "Plow can't send text messages right now.",
        503,
        code,
      );
    }
    return new PlowApiError(
      "http",
      detail || `Plow returned ${response.status}.`,
      response.status,
      code,
    );
  }
}

/**
 * THROWAWAY. Delete this file when the real endpoints land.
 *
 * It exists because two things the proper cloud-agent surface needs are not
 * deployed: `GET /v1/agents/cloud` answers 405, and a device credential has no
 * `chats:use`, so `GET /v1/chats` answers 403. Without a roster and without a
 * chat list there is no picker and no list to render — but `POST` and `DELETE
 * /v1/agents/cloud/{id}` are both live, and activation already left us one
 * chat and the number it answers on. That is enough for one button.
 *
 * So this is one card over one chat, with no picker, no roster and no polling.
 * `cloudAgentState.ts` is the real thing and is untouched by this; when the
 * endpoints deploy, that state machine renders the roster, its chat picker
 * replaces the single persisted chat, and this file and its store go away
 * whole. Nothing else imports it.
 *
 * The local record is the other reason this is temporary: an `agent_id` in a
 * file is not authority about what the account has, and the moment the list
 * endpoint exists it stops being the answer.
 */
import fs from "node:fs";
import path from "node:path";
import { CLOUD_AGENT_PROVIDER } from "./cloudAgentState.js";
import { CloudAgentResource, CreateCloudAgentRequest } from "./cloudAgents.js";
import { FetchLike, PlowApiError } from "./plowApi.js";
import { loadSettings } from "./settings.js";

/** The slice of `CloudAgentsClient` this needs — create and delete, nothing else. */
export interface ThrowawayAgentsApi {
  create(deviceCredential: string, request: CreateCloudAgentRequest): Promise<CloudAgentResource>;
  delete(deviceCredential: string, agentId: string): Promise<void>;
}

/** What the card shows once an agent exists. No session id, no URL. */
export interface ThrowawayAgentRow {
  agentId: string;
  provider: string;
  createdAt: string;
  status: string;
}

/** Where the raw wire log lands. Shown on the card so it can be found. */
export function throwawayLogPath(home: string): string {
  return path.join(home, "throwaway-agent.log");
}

/**
 * A `fetch` that writes down what went over the wire, for the API team.
 *
 * Wrapping the fetch rather than the client is what keeps this out of
 * `cloudAgents.ts`: the client already takes a `FetchLike`, so the whole
 * feature is one argument at construction and nothing to unpick later. It sees
 * every request the client makes, including the ones whose responses become a
 * friendly error — so a 503's `detail` and a 409's exact prose stay recoverable
 * after the user has been shown a sentence instead.
 *
 * **The credential never reaches this file.** The `Authorization` value is
 * recorded as its presence and nothing more, and it is scrubbed out of the URL
 * and both bodies before anything is written — this log exists to be pasted
 * into a bug report, so it is the one place a leak would travel furthest.
 */
export function throwawayLoggingFetch(home: string, inner: FetchLike = fetch): FetchLike {
  return async (url, init) => {
    const started = Date.now();
    const secret = bearerOf(init?.headers);
    const entry: Record<string, unknown> = {
      at: new Date(started).toISOString(),
      method: init?.method ?? "GET",
      url: scrub(url, secret),
      // Presence, never the value.
      authorization: secret ? "bearer present" : "none",
      requestBody: decodeBody(typeof init?.body === "string" ? init.body : null, secret),
    };
    try {
      const response = await inner(url, init);
      // `clone()` so the client still gets an unread body.
      const text = await response
        .clone()
        .text()
        .catch(() => "");
      append(home, {
        ...entry,
        status: response.status,
        responseBody: decodeBody(text, secret),
        elapsedMs: Date.now() - started,
      });
      return response;
    } catch (error) {
      append(home, {
        ...entry,
        status: null,
        error: scrub(String((error as { message?: unknown })?.message ?? error), secret),
        elapsedMs: Date.now() - started,
      });
      throw error;
    }
  };
}

function append(home: string, entry: Record<string, unknown>): void {
  try {
    const file = throwawayLogPath(home);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, JSON.stringify(entry) + "\n", { mode: 0o600 });
  } catch {
    // A log that cannot be written must not take the request down with it.
  }
}

/** The bearer token, read only so it can be kept out of everything below. */
function bearerOf(headers: HeadersInit | undefined): string {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return "";
  const value = (headers as Record<string, string>).authorization ?? "";
  return value.replace(/^Bearer\s+/i, "").trim();
}

/** JSON where it parses, the raw text where it does not — scrubbed either way. */
function decodeBody(raw: string | null, secret: string): unknown {
  if (raw === null || raw === "") return null;
  const cleaned = scrub(raw, secret);
  try {
    return JSON.parse(cleaned);
  } catch {
    return cleaned;
  }
}

/**
 * Take the credential back out of anything a server said.
 *
 * A response that echoes the token is exactly the case this guards: the file is
 * meant to be shared, so a leak here leaves the Mac entirely. The prefix match
 * catches a truncated echo — a key shown as its first characters is still the
 * first characters of a key.
 */
function scrub(text: string, secret: string): string {
  if (!secret) return text;
  let out = text.split(secret).join("[redacted]");
  if (secret.length > 10) out = out.split(secret.slice(0, 10)).join("[redacted]");
  return out;
}

export interface ThrowawayAgentState {
  /** The chat from activation — the only one this Mac knows about. */
  chatUid: string;
  chatLabel: string;
  /** The number the chat answers on, from activation's `send_to`. */
  sendTo: string | null;
  /** There is a chat to provision into and a credential to do it with. */
  ready: boolean;
  busy: boolean;
  /** The server's own `detail` where there was one — it is written for humans. */
  error: string | null;
  agent: ThrowawayAgentRow | null;
  /** Where the raw request/response log is, so it can be pasted into feedback. */
  logPath: string;
}

/**
 * What the agent plow mints will be able to do, in words.
 *
 * Derived from the scope set plow gives a chat agent by default —
 * `chats:use`, `relay:call`, `llm:chat`, scoped to the one chat — and stated
 * plainly, because the person pressing the button is the one who has to decide
 * whether that is acceptable. Nothing here is configurable: the request sends
 * no scopes, so this describes the default rather than a choice.
 */
export const THROWAWAY_AGENT_CAPABILITIES: readonly string[] = Object.freeze([
  "Reads and replies in that one chat, and no other.",
  "Can ask to run things on this Mac through the relay — every request still goes through the normal approval and sandbox rules.",
  "Can spend inference on your account.",
]);

export interface ThrowawayAgentDeps {
  agents: ThrowawayAgentsApi;
  home: string;
  onChange?: () => void;
}

/** Its own file, so ripping this out is deleting two things and no migration. */
function storePath(home: string): string {
  return path.join(home, "app/throwaway-agent.json");
}

function readStore(home: string): ThrowawayAgentRow | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(storePath(home), "utf8"));
    if (!raw || typeof raw !== "object") return null;
    const row = raw as Record<string, unknown>;
    if (typeof row.agentId !== "string" || !row.agentId) return null;
    return {
      agentId: row.agentId,
      provider: typeof row.provider === "string" ? row.provider : "",
      createdAt: typeof row.createdAt === "string" ? row.createdAt : "",
      status: typeof row.status === "string" ? row.status : "",
    };
  } catch {
    return null;
  }
}

function writeStore(home: string, row: ThrowawayAgentRow | null): void {
  const file = storePath(home);
  if (!row) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(row, null, 2) + "\n", { mode: 0o600 });
}

export class ThrowawayAgent {
  private busy = false;
  private error: string | null = null;

  constructor(private readonly deps: ThrowawayAgentDeps) {}

  state(): ThrowawayAgentState {
    const settings = loadSettings(this.deps.home);
    const chatUid = settings.provisionedChatUid.trim();
    return {
      chatUid,
      chatLabel: settings.provisionedChatLabel.trim() || chatUid,
      sendTo: settings.activationSendTo.trim() || null,
      ready: chatUid.length > 0 && settings.relayCredential.trim().length > 0,
      busy: this.busy,
      error: this.error,
      agent: readStore(this.deps.home),
      logPath: throwawayLogPath(this.deps.home),
    };
  }

  /**
   * One button. Create the agent in the chat activation left us.
   *
   * **Synchronous, and no polling.** Prod's create returns the finished
   * resource, so whatever status comes back is the status — this cannot report
   * progress and must not pretend to. It sends no scopes — plow's default for
   * a chat agent is what `THROWAWAY_AGENT_CAPABILITIES` describes — but it does
   * name the provider, because plow's default one 503s in prod.
   */
  async create(name: string): Promise<ThrowawayAgentState> {
    if (this.busy) return this.state();
    const settings = loadSettings(this.deps.home);
    const chatUid = settings.provisionedChatUid.trim();
    const credential = settings.relayCredential.trim();
    if (!chatUid) return this.fail("This Mac has no chat yet. Re-activate it to get one.");
    if (!credential) return this.fail("This Mac isn't signed in yet.");

    this.busy = true;
    this.error = null;
    this.publish();
    try {
      const trimmed = (name ?? "").trim();
      const created = await this.deps.agents.create(credential, {
        chatUid,
        provider: CLOUD_AGENT_PROVIDER,
        ...(trimmed ? { name: trimmed } : {}),
      });
      writeStore(this.deps.home, {
        agentId: created.agentId,
        provider: created.provider ?? "",
        createdAt: created.createdAt ?? "",
        status: created.status,
      });
    } catch (error) {
      this.error = messageOf(error);
    } finally {
      this.busy = false;
    }
    return this.publish();
  }

  /** Remove it, and forget it. The record only ever described one agent. */
  async remove(): Promise<ThrowawayAgentState> {
    if (this.busy) return this.state();
    const existing = readStore(this.deps.home);
    if (!existing) return this.state();
    const credential = loadSettings(this.deps.home).relayCredential.trim();
    if (!credential) return this.fail("This Mac isn't signed in yet.");

    this.busy = true;
    this.error = null;
    this.publish();
    try {
      await this.deps.agents.delete(credential, existing.agentId);
      // Only once the server agrees it is gone: a record dropped on a failed
      // delete would leave an agent nobody can see and nobody can remove.
      writeStore(this.deps.home, null);
    } catch (error) {
      this.error = messageOf(error);
    } finally {
      this.busy = false;
    }
    return this.publish();
  }

  private fail(message: string): ThrowawayAgentState {
    this.error = message;
    return this.publish();
  }

  private publish(): ThrowawayAgentState {
    this.deps.onChange?.();
    return this.state();
  }
}

function messageOf(error: unknown): string {
  // A PlowApiError's message is the server's own `detail` where there was one,
  // and fixed text otherwise. Both are safe to show and free of credentials.
  if (error instanceof PlowApiError) return error.message;
  return "Something went wrong. Try again.";
}

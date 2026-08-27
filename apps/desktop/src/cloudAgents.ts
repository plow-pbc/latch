import {
  PlowApi,
  PlowApiError,
  REQUEST_TIMEOUT_MS,
} from "./plowApi.js";

/**
 * How long a create may take.
 *
 * Longer than everything else here on purpose: prod's create is synchronous
 * and boots a VM before it answers, so the 15s every other call gets would
 * time out a request that was going to succeed. It is still nowhere near the
 * load balancer's 60s idle cut — this buys the VM its boot, not a licence to
 * block.
 */
export const CREATE_REQUEST_TIMEOUT_MS = 30_000;

export const CLOUD_AGENT_POLL_INTERVAL_MS = 2_000;

export type CloudAgentStatus =
  | "provisioning"
  | "running"
  | "failed"
  | "teardown"
  | (string & {});

/**
 * Server truth for one cloud agent. The read endpoint adds `name` and
 * `session_id` to the initial create receipt, so both are nullable while the
 * first provisioning response is on screen.
 */
export interface CloudAgentResource {
  agentId: string;
  /**
   * Every chat this agent serves, in the server's order. One agent may serve
   * several chats, and the first is where its unprompted output lands.
   */
  chatUids: string[];
  url: string | null;
  provider: string | null;
  name: string | null;
  status: CloudAgentStatus;
  failureCode?: string | null;
  failureReason: string | null;
  createdAt: string | null;
  /** Credential identity only. Never use this as the agent's identity. */
  sessionId: string | null;
}

export interface CreateCloudAgentRequest {
  /** At least one chat; the first is the agent's default destination. */
  chatUids: string[];
  name?: string;
  provider?: string | null;
  scopes?: string[];
}

export type CloudAgentTransition = (
  agent: CloudAgentResource,
) => void | Promise<void>;

type Wait = (milliseconds: number) => Promise<void>;

const defaultWait: Wait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Is this the last resource the provisioning loop needs to publish? */
export function isTerminalCloudAgent(agent: Pick<CloudAgentResource, "status">): boolean {
  return agent.status !== "provisioning";
}

/**
 * The main-process client for the cloud-agent lifecycle. Every HTTP request is
 * short and bounded; provisioning time belongs to the GET polling loop, never
 * to a long-running POST.
 */
export class CloudAgentsClient {
  constructor(
    private readonly api: PlowApi,
    private readonly wait: Wait = defaultWait,
  ) {}

  async create(
    deviceCredential: string,
    request: CreateCloudAgentRequest,
  ): Promise<CloudAgentResource> {
    const body = {
      chat_uids: normalizeChatUids(request.chatUids),
      ...(request.name === undefined ? {} : { name: request.name }),
      ...(request.provider === undefined ? {} : { provider: request.provider }),
      ...(request.scopes === undefined ? {} : { scopes: request.scopes }),
    };

    const response = await this.api.request(
      "POST",
      "/v1/agents/cloud",
      { token: deviceCredential, body, timeoutMs: CREATE_REQUEST_TIMEOUT_MS },
    );
    if (response.status === 409) {
      throw conflictError(await decodeJson(response), deviceCredential);
    }

    return this.resourceFor(response, deviceCredential);
  }

  /**
   * Replace the whole set of chats an agent serves.
   *
   * A FULL REPLACEMENT, not a patch: the server takes the list it is given and
   * the agent serves exactly that afterwards, so the caller sends every chat it
   * wants kept — an omission is a detach. Home is first, as everywhere else.
   *
   * Done when the response lands. Unlike create there is no machine to boot, so
   * there is no receipt to poll: a 200 carries the agent in its new shape and
   * that is the end of it. A 5xx is a rollback — the agent still serves what it
   * served before — and says so, because "it failed" and "it half-failed" send
   * the reader to different places.
   */
  async updateChats(
    deviceCredential: string,
    agentId: string,
    chatUids: readonly string[],
  ): Promise<CloudAgentResource> {
    const response = await this.api.request(
      "PUT",
      `/v1/agents/cloud/${encodeURIComponent(agentId)}/chats`,
      { token: deviceCredential, body: { chat_uids: normalizeChatUids(chatUids) } },
    );
    if (response.status === 409) {
      throw conflictError(await decodeJson(response), deviceCredential);
    }
    if (response.status >= 500) throw rolledBack(response.status);

    return this.resourceFor(response, deviceCredential);
  }

  async list(deviceCredential: string): Promise<CloudAgentResource[]> {
    const response = await this.api.request("GET", "/v1/agents/cloud", {
      token: deviceCredential,
    });
    if (!response.ok) throw errorFor(response.status);

    const decoded = await decodeJson(response);
    const data = Array.isArray(decoded)
      ? decoded
      : isRecord(decoded) && Array.isArray(decoded.data)
        ? decoded.data
        : null;
    if (!data) {
      throw invalidResponse(response.status);
    }
    return data.map((entry) => parseResource(entry, deviceCredential, response.status));
  }

  async delete(deviceCredential: string, agentId: string): Promise<void> {
    const response = await this.api.request(
      "DELETE",
      `/v1/agents/cloud/${encodeURIComponent(agentId)}`,
      { token: deviceCredential },
    );
    // Delete is retry-safe from the app's perspective: a record already gone
    // is the requested outcome even though the API reports it as 404.
    if (!response.ok && response.status !== 404) {
      throw errorFor(response.status);
    }
  }

  /** Continue an existing receipt until Plow leaves `provisioning`. */
  async poll(
    deviceCredential: string,
    receipt: CloudAgentResource,
    onTransition?: CloudAgentTransition,
    signal?: AbortSignal,
  ): Promise<CloudAgentResource> {
    signal?.throwIfAborted();
    let current = receipt;
    await onTransition?.(current);
    signal?.throwIfAborted();
    while (!isTerminalCloudAgent(current)) {
      await this.wait(CLOUD_AGENT_POLL_INTERVAL_MS);
      signal?.throwIfAborted();
      const response = await this.api.request(
        "GET",
        `/v1/agents/cloud/${encodeURIComponent(current.agentId)}`,
        {
          token: deviceCredential,
          signal,
          timeoutMs: REQUEST_TIMEOUT_MS,
          callerAbortIsLifecycle: true,
        },
      );
      const next = await this.resourceFor(response, deviceCredential);
      if (next.agentId !== current.agentId) continue;
      current = next;
      signal?.throwIfAborted();
      await onTransition?.(current);
      signal?.throwIfAborted();
    }
    return current;
  }

  private async resourceFor(
    response: Response,
    deviceCredential: string,
  ): Promise<CloudAgentResource> {
    if (!response.ok) throw errorFor(response.status);
    const decoded = await decodeJson(response);
    return parseResource(decoded, deviceCredential, response.status);
  }

}

async function decodeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function parseResource(
  decoded: unknown,
  deviceCredential: string,
  statusCode: number,
): CloudAgentResource {
  if (
    !isRecord(decoded) ||
    typeof decoded.agent_id !== "string" ||
    (decoded.status !== undefined && decoded.status !== null && typeof decoded.status !== "string") ||
    (decoded.created_at !== undefined && typeof decoded.created_at !== "string")
  ) {
    throw invalidResponse(statusCode);
  }

  const chatUids = readChatUids(decoded);
  if (chatUids === null) throw invalidResponse(statusCode);

  const optionalString = (value: unknown): string | null =>
    typeof value === "string" ? value : null;
  const resource: CloudAgentResource = {
    agentId: decoded.agent_id,
    chatUids,
    url: optionalString(decoded.url),
    provider: optionalString(decoded.provider),
    name: optionalString(decoded.name),
    status: typeof decoded.status === "string" ? decoded.status : "provisioning",
    failureCode: optionalString(decoded.failure_code),
    failureReason: optionalString(decoded.failure_reason),
    createdAt: optionalString(decoded.created_at),
    sessionId: optionalString(decoded.session_id),
  };

  if (
    Object.values(resource)
      .flatMap((value) => (Array.isArray(value) ? value : [value]))
      .some((value) => typeof value === "string" && echoesCredential(value, deviceCredential))
  ) {
    throw new PlowApiError("http", "Plow returned an unsafe cloud-agent response.", statusCode);
  }
  return resource;
}

/**
 * The chat grant, from either shape the API has served: `chat_uids` is the
 * multi-chat grant, and a lone `chat_uid` is the single-chat form that
 * preceded it. `null` means neither was present and well-formed — a response
 * we must not guess at.
 */
function readChatUids(decoded: Record<string, unknown>): string[] | null {
  const many = decoded.chat_uids;
  if (Array.isArray(many)) {
    if (many.length === 0 || !many.every((uid) => typeof uid === "string")) return null;
    return many as string[];
  }
  if (many !== undefined) return null;
  if (typeof decoded.chat_uid === "string") return [decoded.chat_uid];
  return null;
}

function errorFor(status: number): PlowApiError {
  if (status === 401) return new PlowApiError("unauthorized", "Not authorized.", status);
  if (status === 403) return new PlowApiError("forbidden", "Not permitted.", status);
  if (status === 503) {
    return new PlowApiError(
      "provider_unavailable",
      "Cloud-agent provisioning is unavailable right now.",
      status,
    );
  }
  return new PlowApiError("http", `Plow returned ${status}.`, status);
}

function invalidResponse(status: number): PlowApiError {
  return new PlowApiError("http", "Plow returned an invalid cloud-agent response.", status);
}

function conflictCode(decoded: unknown): string | null {
  if (!isRecord(decoded) || !isRecord(decoded.detail)) return null;
  return typeof decoded.detail.code === "string" ? decoded.detail.code : null;
}

/**
 * The server's own sentence for this conflict, if it wrote one.
 *
 * Only ever consulted for `CHAT_SET_CONFLICT`, and the reason is that this is
 * the one conflict whose useful half is a fact only the server holds: WHICH
 * agent already has the chat. Every other code is a situation we can describe
 * ourselves, and a fixed sentence is the safer thing to put on screen.
 *
 * The credential check is not a formality. Server text is the one string here
 * that we did not write, and it is about to be rendered — so a message that
 * repeats the token back is dropped for our own words instead.
 */
function conflictDetail(decoded: unknown, credential: string): string | null {
  if (!isRecord(decoded) || !isRecord(decoded.detail)) return null;
  const message = decoded.detail.message;
  if (typeof message !== "string") return null;
  const trimmed = message.trim();
  if (!trimmed || echoesCredential(trimmed, credential)) return null;
  return trimmed;
}

function conflictError(decoded: unknown, credential: string): PlowApiError {
  const messages: Record<string, string> = {
    PENDING_TEARDOWN: "This chat's cloud agent is still being removed. Remove it before trying again.",
    PROVIDER_CONFLICT: "This chat already uses a different cloud-agent provider.",
    PROVISION_IN_FLIGHT: "Cloud-agent setup is already in progress for this chat.",
    CHAT_DELETED: "That chat has been deleted.",
    OWNER_NO_ADDRESS: "Your Plow account has no address for that chat.",
    OWNER_NOT_IN_CHAT: "Your Plow account is not a member of that chat.",
    // One chat belongs to one agent, so a set that overlaps another agent's is
    // refused whole. The server names the holder; we say what to do about it.
    CHAT_SET_CONFLICT: "One of those chats already belongs to another agent.",
    AGENT_FAILED: "This agent failed to start, so its chats can't be changed. Remove it and set one up again.",
  };
  const code = conflictCode(decoded);
  if (code === "CHAT_SET_CONFLICT") {
    const named = conflictDetail(decoded, credential);
    if (named) return new PlowApiError("http", named, 409);
  }
  const message = code && Object.hasOwn(messages, code) ? messages[code] : "Plow returned 409.";
  return new PlowApiError("http", message, 409);
}

/** A PUT the server could not complete. The old set is still the live one. */
function rolledBack(status: number): PlowApiError {
  return new PlowApiError(
    "http",
    "Couldn't update the agent. Nothing changed — the old chats are still live. Try again.",
    status,
  );
}

/**
 * The chat set as it goes on the wire: trimmed, empty entries dropped, first
 * occurrence wins.
 *
 * ORDER IS MEANING here — `chat_uids[0]` is home, where the agent's unprompted
 * output lands — so this preserves it rather than sorting, and a duplicate
 * keeps its FIRST position: a set listing home twice must not have home
 * demoted by its own repeat.
 */
function normalizeChatUids(chatUids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of chatUids ?? []) {
    const uid = (raw ?? "").trim();
    if (!uid || seen.has(uid)) continue;
    seen.add(uid);
    out.push(uid);
  }
  return out;
}

function echoesCredential(text: string, credential: string): boolean {
  const secret = credential.trim();
  if (!secret) return false;
  if (text.includes(secret)) return true;
  return secret.length > 10 && text.includes(secret.slice(0, 10));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

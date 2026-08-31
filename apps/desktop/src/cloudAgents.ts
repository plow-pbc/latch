import { AgentTarget, ApiBaseUrl, PlowApi, PlowApiError, REQUEST_TIMEOUT_MS } from "./plowApi.js";

export const CLOUD_AGENT_POLL_INTERVAL_MS = 2_000;
const CLOUD_AGENT_POLL_RETRY_WINDOW_MS = 5 * 60_000;

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
  /** The first entry is the home chat used to resolve this agent's line. */
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
  lineUid: string;
  name: string;
  provider: string;
}

export type CloudAgentLineErrorCode =
  | "no_home_chat"
  | "line_occupied"
  | "agent_failed"
  | "provision_in_flight"
  | "pending_teardown"
  | "chat_deleted"
  | "provider_conflict";

export class CloudAgentLineError extends PlowApiError {
  constructor(
    readonly code: CloudAgentLineErrorCode,
    message: string,
    status = 409,
  ) {
    super("http", message, status);
    this.name = "CloudAgentLineError";
  }
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
  /**
   * Takes a resolver rather than an api, because the host is chosen per call.
   * Every method here is given an `AgentTarget` and reads BOTH the origin and
   * the bearer out of it — there is no path through this class that pairs one
   * host's URL with another host's token.
   */
  constructor(
    private readonly apiFor: (baseUrl: ApiBaseUrl) => PlowApi,
    private readonly wait: Wait = defaultWait,
  ) {}

  /**
   * One request against one target, with the bearer it used handed back.
   *
   * The whole point is the RETURN of `bearer`: it is read once here and the
   * caller filters the response against that same value. Rotation is a
   * permanent fact of a self-hosted host — a serve token can always be
   * rotated, and `liveTarget` deliberately lets a poll see the new one — so a
   * second read after the await would filter for a NEWER credential than the
   * one that authorised the call, and an echo of the old one would walk past
   * the check onto the screen. Making that structural beats asking five call
   * sites to remember it, and every endpoint added later inherits it.
   */
  private async send(
    target: AgentTarget,
    method: string,
    path: string,
    options: { body?: unknown; signal?: AbortSignal; timeoutMs?: number;
               callerAbortIsLifecycle?: boolean } = {},
  ): Promise<{ response: Response; bearer: string }> {
    const bearer = target.bearer;
    const response = await this.apiFor(target.baseUrl).request(method, path, {
      token: bearer,
      ...options,
    });
    return { response, bearer };
  }

  async create(
    target: AgentTarget,
    request: CreateCloudAgentRequest,
  ): Promise<CloudAgentResource> {
    const { response, bearer } = await this.send(target, "POST", "/v1/agents/cloud", {
      body: {
        line_uid: request.lineUid,
        provider: request.provider,
        ...(request.name.trim() ? { name: request.name } : {}),
      },
    });
    if (!response.ok) {
      await throwCloudCallError(response, request.name);
    }
    return this.resourceFor(response, bearer);
  }

  async changeLine(
    target: AgentTarget,
    agentId: string,
    lineUid: string,
  ): Promise<CloudAgentResource> {
    const { response, bearer } = await this.send(
      target,
      "PUT",
      `/v1/agents/cloud/${encodeURIComponent(agentId)}/line`,
      { body: { line_uid: lineUid } },
    );
    if (!response.ok) {
      await throwCloudCallError(response, "");
    }
    return this.resourceFor(response, bearer);
  }

  async list(target: AgentTarget): Promise<CloudAgentResource[]> {
    const { response, bearer } = await this.send(target, "GET", "/v1/agents/cloud");
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
    return data.map((entry) => parseResource(entry, bearer, response.status));
  }

  async delete(target: AgentTarget, agentId: string): Promise<void> {
    const { response } = await this.send(
      target,
      "DELETE",
      `/v1/agents/cloud/${encodeURIComponent(agentId)}`,
    );
    // Delete is retry-safe from the app's perspective: a record already gone
    // is the requested outcome even though the API reports it as 404.
    if (!response.ok && response.status !== 404) {
      throw errorFor(response.status);
    }
  }

  /** Continue an existing receipt until Plow leaves `provisioning`. */
  async poll(
    target: AgentTarget,
    receipt: CloudAgentResource,
    onTransition?: CloudAgentTransition,
    signal?: AbortSignal,
  ): Promise<CloudAgentResource> {
    signal?.throwIfAborted();
    let current = receipt;
    let retryableFailureSince: number | null = null;
    await onTransition?.(current);
    signal?.throwIfAborted();
    while (!isTerminalCloudAgent(current)) {
      await this.wait(CLOUD_AGENT_POLL_INTERVAL_MS);
      signal?.throwIfAborted();
      let next: CloudAgentResource;
      try {
        const { response, bearer } = await this.send(
          target,
          "GET",
          `/v1/agents/cloud/${encodeURIComponent(current.agentId)}`,
          { signal, timeoutMs: REQUEST_TIMEOUT_MS, callerAbortIsLifecycle: true },
        );
        next = await this.resourceFor(response, bearer);
      } catch (error) {
        signal?.throwIfAborted();
        if (isRetryablePollError(error)) {
          const failedAt = Date.now();
          retryableFailureSince ??= failedAt;
          if (failedAt - retryableFailureSince < CLOUD_AGENT_POLL_RETRY_WINDOW_MS) continue;
        }
        throw error;
      }
      retryableFailureSince = null;
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
    bearer: string,
  ): Promise<CloudAgentResource> {
    if (!response.ok) throw errorFor(response.status);
    const decoded = await decodeJson(response);
    return parseResource(decoded, bearer, response.status);
  }

}

/**
 * Worth another tick inside the retry window?
 *
 * `unauthorized` is in here for the poll ONLY, and only because the poll is
 * already established: the agent exists, and the one credential it uses can be
 * rotated underneath it. The ordinary way that happens is the owner rotating
 * `AGENT_MGR_SERVE_TOKEN` on the host FIRST and pasting it into the app second
 * — in that gap every request 401s through no fault of the agent. Failing fast
 * there strands a provisioning row with no watcher, while retrying costs a
 * bounded five minutes and then reports the same error.
 */
function isRetryablePollError(error: unknown): boolean {
  return error instanceof PlowApiError &&
    (error.kind === "network" ||
      error.kind === "unauthorized" ||
      (error.status !== undefined && error.status >= 500));
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
  bearer: string,
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
      .some((value) => typeof value === "string" && echoesCredential(value, bearer))
  ) {
    throw new PlowApiError("http", "Plow returned an unsafe cloud-agent response.", statusCode);
  }
  return resource;
}

/**
 * The chat grant, from either shape the API has served: `chat_uids` is the
 * multi-chat grant, and a lone `chat_uid` is the single-chat form that
 * preceded it. The grant is informational for line-scoped agents, so an
 * omitted or empty grant is an empty list. `null` means a present grant was
 * malformed.
 */
function readChatUids(decoded: Record<string, unknown>): string[] | null {
  const many = decoded.chat_uids;
  if (Array.isArray(many)) {
    if (!many.every((uid) => typeof uid === "string")) return null;
    return many as string[];
  }
  if (many !== undefined) return null;
  if (typeof decoded.chat_uid === "string") return [decoded.chat_uid];
  return [];
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

function responseCode(decoded: unknown): string | null {
  if (!isRecord(decoded) || !isRecord(decoded.detail)) return null;
  if (typeof decoded.detail.code !== "string") return null;
  const code = decoded.detail.code.trim().toUpperCase();
  return Object.prototype.hasOwnProperty.call(LINE_ERRORS, code) ? code : null;
}

async function throwCloudCallError(
  response: Response,
  agentName: string,
): Promise<never> {
  const decoded = await decodeJson(response);
  const code = responseCode(decoded);
  console.error(
    `[cloud-agent] request failed status=${response.status}${code ? ` code=${code}` : ""}`,
  );
  const mapped = code === null ? null : LINE_ERRORS[code];
  if (mapped) throw new CloudAgentLineError(mapped.code, mapped.message, response.status);
  if (response.status === 400 && namesRegisterCommand(decoded)) {
    throw new PlowApiError("http", unregisteredAgentMessage(agentName), 400);
  }
  throw errorFor(response.status);
}

const LINE_ERRORS: Readonly<Record<string, {
  code: CloudAgentLineErrorCode;
  message: string;
}>> = Object.freeze({
  NO_HOME_CHAT: {
    code: "no_home_chat",
    message: "Text this line once first, then try again.",
  },
  CHAT_SET_CONFLICT: {
    code: "line_occupied",
    message: "Another agent already uses that line.",
  },
  AGENT_FAILED: {
    code: "agent_failed",
    message: "This agent failed to set up. Retry or delete it before changing lines.",
  },
  PROVISION_IN_FLIGHT: {
    code: "provision_in_flight",
    message: "This agent is still setting up. Try again when it's ready.",
  },
  PENDING_TEARDOWN: {
    code: "pending_teardown",
    message: "This agent is still being removed. Try again when removal finishes.",
  },
  CHAT_DELETED: {
    code: "chat_deleted",
    message: "That line changed while Plow was updating the agent. Refresh and try again.",
  },
  PROVIDER_CONFLICT: {
    code: "provider_conflict",
    message: "Another kind of agent already uses that line.",
  },
});

export function echoesCredential(text: string, credential: string): boolean {
  const secret = credential.trim();
  if (!secret) return false;
  if (text.includes(secret)) return true;
  return secret.length > 10 && text.includes(secret.slice(0, 10));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Does this 400 mean "that name is not registered on this host"?
 *
 * A BOOLEAN, deliberately, and this is the whole shape of the fix: a
 * self-hosted host is an origin its owner typed in, so its response body is
 * untrusted text. Forwarding it could not be made safe — a bearer echoed back
 * in any reversible encoding walks straight past a literal check and onto the
 * screen, which is exactly the contract this app makes about the renderer.
 * So nothing server-authored crosses. We only ask whether the body carries
 * the marker, and write the sentence ourselves.
 */
function namesRegisterCommand(decoded: unknown): boolean {
  if (!isRecord(decoded)) return false;
  const detail = decoded.detail;
  const text = typeof detail === "string"
    ? detail
    : isRecord(detail) && typeof detail.message === "string"
      ? detail.message
      : "";
  return text.includes("agent-mgr register");
}

/**
 * The next step, written here from the name WE sent.
 *
 * `agent-mgr` refuses a name it has never been told about, because an `exe:`
 * agent unpacks an image while a local one needs a checkout on that machine.
 * Registering it is the fix, and a bare "returned 400" would hide that there
 * is one — so the sentence names the command, built from the app's own
 * request rather than from anything the host said back.
 */
function unregisteredAgentMessage(agentName: string): string {
  const name = agentName.trim();
  return name
    ? `That host has no agent named "${name}". Run \`agent-mgr register ${name} <dir>\` on it first.`
    : "That host doesn't know this agent yet. Run `agent-mgr register <name> <dir>` on it first.";
}

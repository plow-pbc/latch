import { PlowApi, PlowApiError, REQUEST_TIMEOUT_MS } from "./plowApi.js";

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
   * The line this agent follows. Older agents have no line and retain the
   * fixed chats in `chatUids` instead.
   */
  lineUid: string | null;
  /** Informational line scope for current agents; fixed threads for legacy agents. */
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
  constructor(
    private readonly api: PlowApi,
    private readonly wait: Wait = defaultWait,
  ) {}

  async create(
    deviceCredential: string,
    request: CreateCloudAgentRequest,
  ): Promise<CloudAgentResource> {
    const path = "/v1/agents/cloud";
    const response = await this.api.request("POST", path, {
      token: deviceCredential,
      body: { line_uid: request.lineUid, name: request.name },
    });
    if (!response.ok) {
      await throwCloudCallError("POST", path, response, deviceCredential);
    }
    return this.resourceFor(response, deviceCredential);
  }

  async changeLine(
    deviceCredential: string,
    agentId: string,
    lineUid: string,
  ): Promise<CloudAgentResource> {
    const path = `/v1/agents/cloud/${encodeURIComponent(agentId)}/line`;
    const response = await this.api.request(
      "PUT",
      path,
      {
        token: deviceCredential,
        body: { line_uid: lineUid },
      },
    );
    if (!response.ok) {
      await throwCloudCallError(
        "PUT",
        "/v1/agents/cloud/{agent_id}/line",
        response,
        deviceCredential,
      );
    }
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
    (decoded.line_uid !== undefined &&
      decoded.line_uid !== null &&
      typeof decoded.line_uid !== "string") ||
    (decoded.status !== undefined && decoded.status !== null && typeof decoded.status !== "string") ||
    (decoded.created_at !== undefined && typeof decoded.created_at !== "string")
  ) {
    throw invalidResponse(statusCode);
  }

  const chatUids = readChatUids(decoded);
  if (chatUids === null) throw invalidResponse(statusCode);

  const optionalString = (value: unknown): string | null =>
    typeof value === "string" ? value : null;
  const fallbackLineUid = chatUids
    .map((uid) => uid.startsWith("line:") ? uid.slice("line:".length).trim() : "")
    .find(Boolean) ?? null;
  const resource: CloudAgentResource = {
    agentId: decoded.agent_id,
    lineUid: Object.hasOwn(decoded, "line_uid")
      ? optionalString(decoded.line_uid)
      : fallbackLineUid,
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

function errorFor(status: number, detail = ""): PlowApiError {
  if (status === 401) return new PlowApiError("unauthorized", detail || "Not authorized.", status);
  if (status === 403) return new PlowApiError("forbidden", detail || "Not permitted.", status);
  if (status === 503) {
    return new PlowApiError(
      "provider_unavailable",
      detail || "Cloud-agent provisioning is unavailable right now.",
      status,
    );
  }
  return new PlowApiError("http", detail || `Plow returned ${status}.`, status);
}

function invalidResponse(status: number): PlowApiError {
  return new PlowApiError("http", "Plow returned an invalid cloud-agent response.", status);
}

function responseCode(decoded: unknown, credential: string): string | null {
  if (!isRecord(decoded) || !isRecord(decoded.detail)) return null;
  if (typeof decoded.detail.code !== "string") return null;
  const code = decoded.detail.code.trim();
  if (!/^[a-z][a-z0-9_]{0,63}$/i.test(code) || echoesCredential(code, credential)) return null;
  return code.toUpperCase();
}

function responseDetail(decoded: unknown): string | null {
  if (!isRecord(decoded)) return null;
  if (typeof decoded.detail === "string") return decoded.detail.trim() || null;
  if (!isRecord(decoded.detail) || typeof decoded.detail.message !== "string") return null;
  return decoded.detail.message.trim() || null;
}

async function throwCloudCallError(
  method: "POST" | "PUT",
  path: string,
  response: Response,
  credential: string,
): Promise<never> {
  const decoded = await decodeJson(response);
  const code = responseCode(decoded, credential);
  console.error(
    `[cloud-agent] ${method} ${path} failed status=${response.status} code=${code ?? "UNKNOWN"}`,
  );
  const mapped = code === null ? null : LINE_ERRORS[code];
  if (mapped) throw new CloudAgentLineError(mapped.code, mapped.message, response.status);
  const detail = responseDetail(decoded);
  throw errorFor(
    response.status,
    detail && !echoesCredential(detail, credential) ? detail : "",
  );
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

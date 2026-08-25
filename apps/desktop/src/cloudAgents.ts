import {
  ApiBaseUrl,
  FetchLike,
  PlowApiError,
  REQUEST_TIMEOUT_MS,
  normalizeApiBaseUrl,
} from "./plowApi.js";

export const CLOUD_AGENT_POLL_INTERVAL_MS = 2_000;

export type CloudAgentStatus = "provisioning" | "active" | "failed";

/**
 * Server truth for one cloud agent. The read endpoint adds `name` and
 * `session_id` to the initial create receipt, so both are nullable while the
 * first provisioning response is on screen.
 */
export interface CloudAgentResource {
  agentId: string;
  chatUid: string;
  url: string | null;
  provider: string | null;
  name: string | null;
  status: CloudAgentStatus;
  failureReason: string | null;
  createdAt: string;
  /** Credential identity only. Never use this as the agent's identity. */
  sessionId: string | null;
}

export interface CreateCloudAgentRequest {
  chatUid: string;
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
  return agent.status === "active" || agent.status === "failed";
}

/**
 * The main-process client for the cloud-agent lifecycle. Every HTTP request is
 * short and bounded; provisioning time belongs to the GET polling loop, never
 * to a long-running POST.
 */
export class CloudAgentsClient {
  private readonly baseUrl: ApiBaseUrl;

  constructor(
    baseUrl: ApiBaseUrl,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly wait: Wait = defaultWait,
  ) {
    this.baseUrl = normalizeApiBaseUrl(baseUrl);
  }

  async create(
    deviceCredential: string,
    request: CreateCloudAgentRequest,
  ): Promise<CloudAgentResource> {
    const body = {
      chat_uid: request.chatUid,
      ...(request.name === undefined ? {} : { name: request.name }),
      ...(request.provider === undefined ? {} : { provider: request.provider }),
      ...(request.scopes === undefined ? {} : { scopes: request.scopes }),
    };

    let response = await this.request("POST", "/v1/agents/cloud", deviceCredential, body);
    if (response.status === 409) {
      const failure = await decodeJson(response);
      const staleAgentId = recoverableAgentId(failure);
      if (!staleAgentId) throw errorFor(response.status, failure, deviceCredential);

      await this.delete(deviceCredential, staleAgentId);
      response = await this.request("POST", "/v1/agents/cloud", deviceCredential, body);
    }

    return this.resourceFor(response, deviceCredential);
  }

  async get(
    deviceCredential: string,
    agentId: string,
    signal?: AbortSignal,
  ): Promise<CloudAgentResource> {
    const response = await this.request(
      "GET",
      `/v1/agents/cloud/${encodeURIComponent(agentId)}`,
      deviceCredential,
      undefined,
      signal,
    );
    return this.resourceFor(response, deviceCredential);
  }

  async list(deviceCredential: string): Promise<CloudAgentResource[]> {
    const response = await this.request("GET", "/v1/agents/cloud", deviceCredential);
    if (!response.ok) throw errorFor(response.status, await decodeJson(response), deviceCredential);

    const decoded = await decodeJson(response);
    if (!isRecord(decoded) || !Array.isArray(decoded.data)) {
      throw invalidResponse(response.status);
    }
    return decoded.data.map((entry) => parseResource(entry, deviceCredential, response.status));
  }

  async delete(deviceCredential: string, agentId: string): Promise<void> {
    const response = await this.request(
      "DELETE",
      `/v1/agents/cloud/${encodeURIComponent(agentId)}`,
      deviceCredential,
    );
    // Delete is retry-safe from the app's perspective: a record already gone
    // is the requested outcome even though the API reports it as 404.
    if (!response.ok && response.status !== 404) {
      throw errorFor(response.status, await decodeJson(response), deviceCredential);
    }
  }

  /** Create one agent, publish its receipt, then publish every polled state. */
  async createAndPoll(
    deviceCredential: string,
    request: CreateCloudAgentRequest,
    onTransition?: CloudAgentTransition,
    signal?: AbortSignal,
  ): Promise<CloudAgentResource> {
    signal?.throwIfAborted();
    const receipt = await this.create(deviceCredential, request);
    signal?.throwIfAborted();
    return this.poll(deviceCredential, receipt, onTransition, signal);
  }

  /** Continue an existing receipt until Plow reports `active` or `failed`. */
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
      current = await this.get(deviceCredential, current.agentId, signal);
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
    const decoded = await decodeJson(response);
    if (!response.ok) throw errorFor(response.status, decoded, deviceCredential);
    return parseResource(decoded, deviceCredential, response.status);
  }

  private async request(
    method: string,
    path: string,
    deviceCredential: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: `Bearer ${deviceCredential}`,
    };
    if (body !== undefined) headers["content-type"] = "application/json";

    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: requestSignal,
      });
    } catch (error) {
      // A caller abort is lifecycle, not a Plow timeout. Preserve its reason so
      // the owner of the poll can distinguish cancellation from API failure.
      signal?.throwIfAborted();
      const name = (error as { name?: unknown })?.name;
      if (name === "TimeoutError" || name === "AbortError") {
        throw new PlowApiError("network", "Plow didn't answer in time. Try again.");
      }
      // A fetch implementation may put its entire Request, including headers,
      // in the cause. Only fixed text is allowed across this boundary.
      throw new PlowApiError("network", "Couldn't reach Plow.");
    }
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
    typeof decoded.chat_uid !== "string" ||
    (decoded.status !== "provisioning" && decoded.status !== "active" && decoded.status !== "failed") ||
    typeof decoded.created_at !== "string"
  ) {
    throw invalidResponse(statusCode);
  }

  const optionalString = (value: unknown): string | null =>
    typeof value === "string" ? value : null;
  const resource: CloudAgentResource = {
    agentId: decoded.agent_id,
    chatUid: decoded.chat_uid,
    url: optionalString(decoded.url),
    provider: optionalString(decoded.provider),
    name: optionalString(decoded.name),
    status: decoded.status,
    failureReason: optionalString(decoded.failure_reason),
    createdAt: decoded.created_at,
    sessionId: optionalString(decoded.session_id),
  };

  if (
    Object.values(resource).some(
      (value) => typeof value === "string" && echoesCredential(value, deviceCredential),
    )
  ) {
    throw new PlowApiError("http", "Plow returned an unsafe cloud-agent response.", statusCode);
  }
  return resource;
}

function errorFor(status: number, decoded: unknown, deviceCredential: string): PlowApiError {
  const detail =
    isRecord(decoded) &&
    typeof decoded.detail === "string" &&
    !echoesCredential(decoded.detail, deviceCredential)
      ? decoded.detail
      : "";
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

function recoverableAgentId(decoded: unknown): string | null {
  if (!isRecord(decoded) || typeof decoded.detail !== "string") return null;
  return (
    decoded.detail.match(
      /^This chat has an unfinished cloud agent \(([A-Za-z0-9_-]+)\)\. Delete it with DELETE \/v1\/agents\/cloud\/\1 and provision again\.$/,
    )?.[1] ?? null
  );
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

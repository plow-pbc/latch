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
  | "teardown"
  | (string & {});

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
  createdAt: string | null;
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
      chat_uid: request.chatUid,
      ...(request.name === undefined ? {} : { name: request.name }),
      ...(request.provider === undefined ? {} : { provider: request.provider }),
      ...(request.scopes === undefined ? {} : { scopes: request.scopes }),
    };

    let response = await this.api.request(
      "POST",
      "/v1/agents/cloud",
      { token: deviceCredential, body, timeoutMs: CREATE_REQUEST_TIMEOUT_MS },
    );
    if (response.status === 409) {
      const failure = await decodeJson(response);
      const staleAgentId = recoverableAgentId(failure);
      if (!staleAgentId) throw errorFor(response.status);

      try {
        await this.delete(deviceCredential, staleAgentId);
      } catch (error) {
        throw new PlowApiError(
          "http",
          `Cloud agent ${staleAgentId} could not be removed. This chat cannot be provisioned until that agent is removed.`,
          error instanceof PlowApiError ? error.status : undefined,
        );
      }
      response = await this.api.request(
        "POST",
        "/v1/agents/cloud",
        { token: deviceCredential, body, timeoutMs: CREATE_REQUEST_TIMEOUT_MS },
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
      current = await this.resourceFor(response, deviceCredential);
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
    typeof decoded.chat_uid !== "string" ||
    (decoded.status !== undefined && typeof decoded.status !== "string") ||
    (decoded.created_at !== undefined && typeof decoded.created_at !== "string")
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
    status: decoded.status ?? "running",
    failureReason: optionalString(decoded.failure_reason),
    createdAt: optionalString(decoded.created_at),
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

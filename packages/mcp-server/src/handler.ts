/**
 * The MCP server that runs on this Mac, on MCP revision 2026-07-28.
 *
 * We bind no port. The relay tunnels a whole HTTP exchange over the device
 * WebSocket, so the caller reconstructs a `Request` in memory and hands it to
 * `fetch()`. Everything protocol-shaped — 405 on GET, per-request envelope
 * validation, `-32601`, header/body agreement, argument validation — is the
 * library's job, not ours.
 *
 * Modern MCP is per-request and POST-only, so a POST-only relay endpoint is
 * sufficient: there is no session lifecycle to maintain and no GET/SSE
 * requirement. `GET` is answered `405 Method not allowed.` by the SDK, which is
 * the response we want and the one we assert on.
 */
import crypto from "node:crypto";
import {
  AuthInfo,
  createMcpHandler,
  fromJsonSchema,
  McpServer,
} from "@modelcontextprotocol/server";
import { JSONValue } from "@domo/protocol";
import { DeviceAgent } from "@domo/device-core";
import { CALL_BUDGET_MS, DeferredResults, DeniedError, Progress } from "./deferred.js";
import { AgentIdentity, TOOLS, ToolContext, toolContent } from "./tools.js";

/** The MCP revision this server speaks, and the only one it will speak. */
export const PROTOCOL_REVISION = "2026-07-28";

/**
 * The agent identity the relay asserts on each request frame (design §3.4).
 * This is deliberately NOT the SDK's `AuthInfo` — we map ours onto that rather
 * than passing it through, so the wire contract and the library's type can move
 * independently. It never carries the credential.
 */
export interface RelayAuth {
  agent_id: string;
  agent_name?: string;
  scopes?: string[];
  user_uid?: string;
}

/** Map the relay's assertion onto the SDK's typed `AuthInfo`. */
export function toAuthInfo(auth: RelayAuth): AuthInfo {
  return {
    // The relay never sends the token and we never want it; the field is
    // required by the SDK's type, so it is empty rather than absent.
    token: "",
    clientId: auth.agent_id,
    scopes: auth.scopes ?? [],
    extra: { agent_name: auth.agent_name, user_uid: auth.user_uid },
  };
}

function agentFrom(authInfo: AuthInfo | undefined): AgentIdentity | null {
  const agentId = authInfo?.clientId;
  if (!agentId) return null;
  const name = authInfo?.extra?.agent_name;
  return { agentId, agentName: typeof name === "string" ? name : undefined };
}

export interface McpServerOptions {
  /** Overridable so tests do not have to wait out the real budget. */
  budgetMs?: number;
}

export interface DomoMcpServer {
  /** Serve one HTTP exchange. `auth` is who the relay says is calling. */
  fetch(request: Request, auth?: RelayAuth): Promise<Response>;
  /** The tool names this server advertises, for logging and tests. */
  toolNames: string[];
  close(): Promise<void>;
}

/**
 * Build the MCP server around a `DeviceAgent`. One per Mac process: the
 * deferred-result store lives here, so handles survive across the individual
 * request-scoped MCP instances the SDK constructs.
 */
export function createDomoMcpServer(
  device: DeviceAgent,
  options: McpServerOptions = {},
): DomoMcpServer {
  const budgetMs = options.budgetMs ?? CALL_BUDGET_MS;
  const deferred = new DeferredResults(budgetMs);
  const sessionId = crypto.randomUUID().toUpperCase();

  const handler = createMcpHandler(
    (ctx) => {
      const server = new McpServer(
        { name: "domo", version: "0.1.0" },
        // Without this the client may open a subscriptions stream, which a
        // one-buffered-exchange-per-frame tunnel cannot carry.
        { capabilities: { tools: { listChanged: false } } },
      );
      const agent = agentFrom(ctx.authInfo);

      for (const spec of TOOLS) {
        server.registerTool(
          spec.name,
          {
            description: spec.description,
            inputSchema: fromJsonSchema(spec.inputSchema as never),
          },
          async (args: unknown) => {
            // No asserted agent means nobody authorised this call. Fail closed:
            // every handle, rule and audit entry is keyed on the agent id.
            if (!agent) {
              return {
                content: [toolContent({ error: "no authenticated agent on this request" })],
                isError: true,
              };
            }
            const toolCtx: ToolContext = {
              device,
              deferred,
              agent,
              sessionId,
              commandWaitCapMs: budgetMs,
            };
            const body = (progress: Progress) =>
              spec.run((args ?? null) as JSONValue, toolCtx, progress);
            try {
              const result = spec.deferrable
                ? await deferred.run(agent.agentId, body)
                : await body({ decided: () => {} });
              return { content: [toolContent(result)] };
            } catch (error: unknown) {
              const message = error instanceof Error ? error.message : String(error);
              return {
                content: [
                  toolContent(
                    error instanceof DeniedError
                      ? { status: "denied", reason: message }
                      : { error: message },
                  ),
                ],
                isError: true,
              };
            }
          },
        );
      }
      return server;
    },
    {
      // Nothing is deployed against this, so there is no 2025-era traffic to
      // serve. A client that cannot negotiate the modern revision should fail
      // loudly rather than fall into a legacy lane.
      legacy: "reject",
      // Streaming is deferred, so one body per exchange.
      responseMode: "json",
    },
  );

  return {
    toolNames: TOOLS.map((t) => t.name),
    fetch: (request, auth) =>
      handler.fetch(request, auth ? { authInfo: toAuthInfo(auth) } : undefined),
    close: () => handler.close(),
  };
}

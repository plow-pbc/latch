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
import { JobOwners } from "./jobs.js";
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

/**
 * The agent id is the isolation key: every handle, always-allow rule and audit
 * entry is keyed on it. So it must be a non-empty STRING and nothing else — an
 * array or an object is truthy, and would otherwise sail through as a client id
 * and reach policy and execution as a key that cannot be compared.
 */
function agentFrom(authInfo: AuthInfo | undefined): AgentIdentity | null {
  const agentId: unknown = authInfo?.clientId;
  if (typeof agentId !== "string" || agentId.trim().length === 0) return null;
  const name = authInfo?.extra?.agent_name;
  return { agentId, agentName: typeof name === "string" ? name : undefined };
}

/**
 * Methods this server refuses outright, whatever the SDK would otherwise do.
 *
 * `subscriptions/listen` is always served over SSE — `responseMode: "json"`
 * does not disable it, and `tools.listChanged: false` only discourages a client
 * from asking. A long-lived stream is exactly what a relay that buffers one
 * HTTP exchange per WebSocket frame cannot carry, and an accepted one would sit
 * open on this Mac indefinitely. Refusing is the only thing that actually
 * closes it.
 */
const REFUSED_METHODS = new Set(["subscriptions/listen"]);

function refusal(id: unknown, method: string): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: id ?? null,
      error: {
        code: -32601,
        message:
          `${method} is not supported: this server is reachable only through a relay ` +
          `that buffers one HTTP exchange per frame and cannot carry a stream.`,
      },
    }),
    { status: 400, headers: { "content-type": "application/json" } },
  );
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
  const jobs = new JobOwners();
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
            //
            // The guard is here, on the tool callback, and DELIBERATELY not on
            // `tools/list` or `server/discover`. Those two return a static
            // manifest that is identical for every agent and says nothing about
            // this Mac — no state, no user data, no side effect — and the relay
            // refuses an unauthenticated caller before anything reaches us.
            // Everything that touches this Mac or does work is a tool, and
            // every tool goes through here, `list_tools` included.
            if (!agent) {
              return {
                content: [toolContent({ error: "no authenticated agent on this request" })],
                isError: true,
              };
            }
            const toolCtx: ToolContext = {
              device,
              deferred,
              jobs,
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
    async fetch(request, auth) {
      // Modern MCP requires Mcp-Method, and the SDK rejects a request whose
      // header and body disagree — so the header is a sound place to refuse
      // from, and costs nothing on the path every real call takes.
      const method = request.headers.get("mcp-method");
      if (method !== null && REFUSED_METHODS.has(method)) {
        // Only now pay for the body, so the refusal can echo the caller's id.
        let id: unknown = null;
        try {
          id = ((await request.clone().json()) as { id?: unknown }).id ?? null;
        } catch {
          /* an unparseable body still gets a refusal, just without an id */
        }
        return refusal(id, method);
      }
      return handler.fetch(request, auth ? { authInfo: toAuthInfo(auth) } : undefined);
    },
    close: () => handler.close(),
  };
}

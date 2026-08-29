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
import { DeviceAgent, LIVE_WEB_ROUTING } from "@domo/device-core";
import { CALL_BUDGET_MS, DeferredResults, DeniedError, Progress } from "./deferred.js";
import { JobOwners } from "./jobs.js";
import {
  AgentIdentity,
  MACOS_TOOLING,
  TOOLS,
  ToolContext,
  toolBlocks,
  toolContent,
} from "./tools.js";

/** The MCP revision this server speaks, and the only one it will speak. */
export const PROTOCOL_REVISION = "2026-07-28";

/**
 * What this server is FOR, in the agent's own terms.
 *
 * The boundary is stated once here rather than thirteen times in thirteen tool
 * descriptions: these tools reach the user's real computer, the agent's own do
 * not. Tool descriptions carry a compressed version anyway, because a client
 * may drop this block — it rides `initialize` (2025 clients) and
 * `server/discover` (2026-07-28), and neither obliges a client to forward it.
 *
 * **No fallbacks, on purpose.** This used to route "general web reading" to the
 * agent's own tools, on the theory that a fetch is cheaper than a human's
 * approval. That sends "what's on the homepage of Reddit?" to a datacenter
 * address the site refuses, and the agent reports failure with nothing telling
 * it a real browser was one call away. The Reddit example stays verbatim: a
 * concrete case moves a model where a rule does not.
 *
 * **Claim only what holds.** The approval sentence ENUMERATES rather than
 * generalising, because "the user approves anything that touches their machine"
 * is false — `plow_vault` list/describe builds no intent and asks nobody. Same
 * reason the pending-handle line defers to the payload instead of describing
 * it: the handle's own `reason` says what it waits for, and a second copy in
 * prose was wrong in exactly the states that matter. An instructions block that
 * overstates its guarantee is worse than one that says less.
 *
 * `LIVE_WEB_ROUTING` and `MACOS_TOOLING` are interpolated rather than written
 * here; each has other consumers, and the rules about what may appear in them
 * (including why `osascript` may not) live on those constants.
 *
 * This is guidance to a model, never a capability claim. Nothing here widens
 * what a tool may do; the enforceable bound is the capability set the human
 * approves.
 */
export const SERVER_INSTRUCTIONS = `These tools operate the user's own Mac — their real files, their real applications, their real shell, and a real browser running there. Your own file, shell and web tools act on your workspace: a different machine, on a different network address, that the user cannot see.

Reach for these whenever the question is about the live web or about this user's world. Public pages included: ${LIVE_WEB_ROUTING} — your own fetch does none of that, and trips bot walls and consent interstitials besides. "What's on the homepage of Reddit?" is a plow_browser_open question.

Their Mac is a macOS workstation, with tooling your workspace does not have. Reach for it through plow_run_command when it fits the job: ${MACOS_TOOLING}.

Call plow_list_skills early. This Mac publishes skills — how-to guides for what it can do, specific to this user's setup in ways you cannot otherwise know — and the skill for a task beats rediscovering it.

Use your own tools for your own work: code you are writing, scratch files, and anything you do not need their machine for.

The user approves the operations these tools perform on their machine — reading and writing files, running commands, and browsing. A call may return a pending handle instead of a result; the handle's own 'reason' and 'note' say what it is waiting for. Tell the user, then poll plow_get_result. Do not re-issue the original call; that starts a second request.`;

/**
 * Who this server says it is. Exported so the copy guards in toolCopy.test.ts
 * can read these strings the same way they read every other one a model sees.
 *
 * `version` is not here — it belongs to the app, not to this constant, and is
 * merged in at construction.
 *
 * `name` went from "plow" to "plow-latch" without a migration, and that is
 * safe rather than lucky: a client namespaces tools by the name the USER gave
 * the connector, not by this field. Measured, not assumed — a live claude.ai
 * connector exposes these as `mcp__claude_ai_Plow_Latch_-_Mac_Desktop_Manager__*`
 * while this field still read "plow". So no remembered approval keys on it.
 * Check that again before renaming it a third time.
 *
 * `icons` is deliberately absent. A server reachable only through a relay has
 * no public URL to serve an icon from, so it would have to ride every
 * handshake as a data: URI — real bytes, on every initialize, for decoration.
 *
 * `description` says operations stay within the APPROVED SCOPE, not that every
 * one appears on screen. The stronger sentence was here and was false in three
 * ordinary states: a `plow_browser` command rides an already-approved session
 * and builds no intent, a stored always-allow rule is answered by the policy
 * engine without waking the delegate, and Approve mode decides without a
 * dialog. Promising a prompt that does not come is worse than promising less —
 * the same rule the instructions block above follows for the vault carve-out.
 */
export const SERVER_IDENTITY = {
  name: "plow-latch",
  title: "Plow Latch — Mac Desktop Manager",
  description:
    "Operate this person's own Mac: read and write their files, run shell and macOS " +
    "tooling, and drive a real browser on their own network. Operations stay within " +
    "the scope the owner approved.",
  websiteUrl: "https://watchmepivot.com/",
} as const;

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
    // 404, not 400. The 2026-07-28 Streamable HTTP binding is normative: "If
    // the server does not implement the requested RPC method, it MUST respond
    // with 404 Not Found and a JSON-RPC error with code -32601." The body is
    // what distinguishes this from a legacy server's bare 404, so both halves
    // matter. This answered 400 until someone read the spec.
    { status: 404, headers: { "content-type": "application/json" } },
  );
}

export interface McpServerOptions {
  /** Overridable so tests do not have to wait out the real budget. */
  budgetMs?: number;
  /**
   * The app's own version, reported in the handshake. This package cannot read
   * it — it is a library, and the version that matters is the Electron app's,
   * not this workspace's — so the app passes `app.getVersion()` in. The default
   * is deliberately not a plausible release number: a handshake reporting
   * `0.0.0-dev` in the field is a caller that forgot to pass one, which a
   * hardcoded `0.1.0` hid for as long as it existed.
   */
  version?: string;
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
  const version = options.version ?? "0.0.0-dev";
  const deferred = new DeferredResults(budgetMs);
  const jobs = new JobOwners();
  const sessionId = crypto.randomUUID().toUpperCase();

  const handler = createMcpHandler(
    (ctx) => {
      const server = new McpServer(
        // `description` is the one field MCP has for "what is this server
        // FOR", and a client that drops the instructions block still gets it.
        { ...SERVER_IDENTITY, version },
        {
          // Without this the client may open a subscriptions stream, which a
          // one-buffered-exchange-per-frame tunnel cannot carry.
          capabilities: { tools: { listChanged: false } },
          instructions: SERVER_INSTRUCTIONS,
        },
      );
      const agent = agentFrom(ctx.authInfo);

      for (const spec of TOOLS) {
        server.registerTool(
          spec.name,
          {
            title: spec.title,
            description: spec.description,
            // Display and routing hints only — see ToolHints in tools.ts. The
            // bound is the approved capability set, computed from arguments.
            annotations: spec.annotations,
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
            // every tool goes through here, `plow_list_skills` included.
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
              // Most results are one text block; a screenshot expands into an
              // image + text block via `__mcpContent`.
              return { content: toolBlocks(result) };
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
      // DNS-rebinding validation is DELIBERATELY NOT CONFIGURED.
      //
      // The SDK offers `validateHostHeader` / `validateOriginHeader` and their
      // response helpers, and `createMcpHandler` applies neither on its own —
      // verified, not assumed. We leave them off because the threat they answer
      // does not exist here: this server binds no port. It is reachable only
      // through a WebSocket the Mac dialled out on, so there is no local origin
      // for a browser to be rebound onto. Enabling them would also mean
      // hardcoding the relay's authority, coupling this app to a deployment
      // detail it does not own.
      //
      // The `Host` that arrives is nonetheless forwarded through unmodified
      // (see relay-client's wire.ts), so if this ever binds a port or the
      // authority starts carrying meaning, the value to validate is real rather
      // than a placeholder that would always pass.
      //
      // Serve the 2025 handshake as well as the modern one. This was
      // `"reject"`, on the premise that "nothing is deployed against this, so
      // there is no 2025-era traffic to serve". That premise is false in the
      // field: claude.ai's connector opens with a 2025-era `initialize` at
      // protocol 2025-11-25, and Macs answered it `-32022 Unsupported protocol
      // version` — a 400 the relay faithfully replayed to users who had done
      // nothing wrong. `"stateless"` is the SDK's own default and adds no
      // compatibility code of ours: each legacy request is served by a fresh
      // instance, so there is still no session to hold and GET/DELETE still
      // answer 405. Modern callers keep negotiating 2026-07-28 untouched.
      legacy: "stateless",
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

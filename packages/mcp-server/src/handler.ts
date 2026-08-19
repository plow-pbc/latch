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
import { JSONValue, jv } from "@domo/protocol";
import { DeviceAgent } from "@domo/device-core";
import {
  CALL_BUDGET_MS,
  DeferredResults,
  DeniedError,
  DIRECT_CEILING_MS,
  Progress,
} from "./deferred.js";
import { Continuations, exchangeContext } from "./continuation.js";
import {
  checkOperationId,
  OperationConflictError,
  OperationError,
  OperationRecords,
  operationFingerprint,
} from "./operations.js";
import { JobOwners } from "./jobs.js";
import { AgentIdentity, TOOLS, ToolContext, toolBlocks, toolContent } from "./tools.js";

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

/**
 * Hold a direct-bounded tool to its ceiling.
 *
 * The work is not cancelled — nothing here can cancel a browser action already
 * in flight — but the caller stops waiting, so the answer reaches it inside the
 * relay's exchange rather than after the relay has given up on it.
 *
 * Takes a THUNK, not a promise. Passing the promise meant the tool body was
 * invoked while evaluating the argument — before this function existed, let
 * alone before its timer was scheduled — so a body's synchronous prologue, and
 * any I/O it kicked off, ran outside the ceiling it was supposed to be under.
 * The deferred path arms its budget before calling the work for the same
 * reason; this is that rule on the direct path.
 */
export function bounded<T>(work: () => Promise<T>, ceilingMs: number, tool: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${tool} did not finish within this Mac's ${ceilingMs}ms call ceiling`));
    }, ceilingMs);
    timer.unref?.();
    // Only now is anything invoked. A body that throws synchronously must still
    // land on this promise rather than escaping to the caller of `bounded`.
    let started: Promise<T>;
    try {
      started = work();
    } catch (error: unknown) {
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    started.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export interface McpServerOptions {
  /** Overridable so tests do not have to wait out the real budget. */
  budgetMs?: number;
  /** The direct-bounded ceiling, likewise overridable for tests. */
  directCeilingMs?: number;
  /** Deferred-result retention. Overridable so a test need not wait it out. */
  ttlMs?: number;
  /** Operation-record retention, and the tombstone that follows it. */
  operationTtlMs?: number;
  operationTombstoneMs?: number;
  /** The clock retention is measured against. Injectable for the same reason. */
  now?: () => number;
}

export interface DomoMcpServer {
  /**
   * Serve one HTTP exchange. `auth` is who the relay says is calling; `rid`
   * names the relay exchange it arrived on, so a later acknowledgement can be
   * matched to whatever this call deferred.
   */
  fetch(request: Request, auth?: RelayAuth, rid?: string): Promise<Response>;
  /** The tool names this server advertises, for logging and tests. */
  toolNames: string[];
  /**
   * Adopt the call budget the relay's advertised exchange deadline allows.
   * Until this is called the server runs the conservative default.
   */
  setCallBudgetMs(ms: number): void;
  /** The budget the next deferrable call will be armed with. */
  callBudgetMs(): number;
  /**
   * Adopt the ceiling a direct-bounded tool answers within. Separate from the
   * budget on purpose — see `DIRECT_CEILING_MS`.
   */
  setDirectCeilingMs(ms: number): void;
  /** The ceiling the next direct-bounded call will be held to. */
  directCeilingMs(): number;
  /**
   * The relay matched our response for `rid` to the exchange waiting on it.
   * The only thing that may move an operation to `backgrounded`.
   */
  acknowledgeExchange(rid: string): void;
  /** The response for `rid` went out and will never be acknowledged. */
  exchangeDeliveryUnknown(rid: string): void;
  /** The continuation lifecycle, for the approval window and for tests. */
  continuations: Continuations;
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
  let budgetMs = options.budgetMs ?? CALL_BUDGET_MS;
  // Defaults to the budget when a test names only that one, so a scripted short
  // budget still bounds the direct tools it exercises.
  let directCeiling = options.directCeilingMs ?? options.budgetMs ?? DIRECT_CEILING_MS;
  const continuations = new Continuations(device.audit);
  // Retry safety, keyed on (agent, operation_id). Process-local by design.
  const operations = new OperationRecords(options.operationTtlMs, options.operationTombstoneMs, options.now);
  const deferred = new DeferredResults(budgetMs, options.ttlMs, options.now, continuations);
  const jobs = new JobOwners();
  const sessionId = crypto.randomUUID().toUpperCase();

  const handler = createMcpHandler(
    (ctx) => {
      const server = new McpServer(
        { name: "plow", version: "0.1.0" },
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
              operations,
              agent,
              sessionId,
              commandWaitCapMs: budgetMs,
            };
            const body = (progress: Progress) =>
              spec.run((args ?? null) as JSONValue, toolCtx, progress);
            // What this tool would do if nothing had done it already.
            const attempt = () =>
              spec.classification === "deferrable"
                ? deferred.run(agent.agentId, body)
                : // A direct tool has no handle to fall back on, so it is held
                  // to the same ceiling the budget sets: answering late is
                  // answering into an exchange the relay has abandoned.
                  bounded(
                    () => body({ decided: () => {}, intent: () => {} }),
                    directCeiling,
                    spec.name,
                  );
            try {
              // A tool that can act twice is a tool a lost response can make
              // act twice, so the caller names the operation and this Mac
              // remembers it. `get_result` and the read-only tools are exempt:
              // asking again is the whole point of them.
              const argv = (args ?? null) as JSONValue;
              const result = spec.requiresOperationId
                ? await operations.run(
                    agent.agentId,
                    checkOperationId(jv(argv).get("operation_id").value),
                    operationFingerprint(spec.name, argv),
                    attempt,
                    (handle) => deferred.get(agent.agentId, handle),
                    (handle) => deferred.settled(handle),
                  )
                : await attempt();
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
                      : error instanceof OperationConflictError
                        ? { status: "conflict", reason: message }
                        : error instanceof OperationError
                          ? { status: "invalid_operation_id", reason: message }
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
    setCallBudgetMs(ms: number) {
      budgetMs = ms;
      deferred.setBudgetMs(ms);
    },
    callBudgetMs: () => budgetMs,
    setDirectCeilingMs(ms: number) {
      directCeiling = ms;
    },
    directCeilingMs: () => directCeiling,
    acknowledgeExchange: (rid: string) => continuations.acknowledgeExchange(rid),
    exchangeDeliveryUnknown: (rid: string) => continuations.exchangeDeliveryUnknown(rid),
    continuations,
    async fetch(request, auth, rid) {
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
      const serve = () => handler.fetch(request, auth ? { authInfo: toAuthInfo(auth) } : undefined);
      // Everything this exchange defers is tagged with the rid, inside the
      // async context rather than beside it: several agents are served at once,
      // and a shared "current rid" would hand one agent's handle to another's
      // acknowledgement.
      return rid === undefined ? serve() : exchangeContext.run({ rid }, serve);
    },
    close: () => handler.close(),
  };
}

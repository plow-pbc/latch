/**
 * The tool-authoring primitives — `ToolSpec`'s shape, `ToolContext`, the
 * intent-building/decision path (`decideAndRun`), and the one field a human
 * actually reads (`GOAL`) — shared by every module that defines tools.
 *
 * Lives apart from tools.ts (the Mac-local tool surface) and slackTools.ts
 * (the Slack tool surface) so that neither imports the other: both import
 * these primitives from here, and tools.ts alone assembles the complete
 * `TOOLS` array from both surfaces, with no module-level cycle. `tools.ts`
 * imports slackTools.ts's tool array; slackTools.ts imports nothing from
 * tools.ts.
 */
import { Capability, Intent, JSONValue, jv, makeIntent } from "@domo/protocol";
import { ToolAnnotations } from "@modelcontextprotocol/server";
import { DeviceAgent } from "@domo/device-core";
import { DeferredResults, DeniedError, Progress } from "./deferred.js";
import { JobOwners } from "./jobs.js";

/** A tool argument was missing or unusable — the agent's problem, not ours. */
export class ToolError extends Error {}

/** The calling agent, as the relay asserts it (design §3.4). */
export interface AgentIdentity {
  /** The credential's own session id. The isolation key — never the name. */
  agentId: string;
  /** For humans to read in the approval dialog and the audit log. Nullable. */
  agentName?: string;
}

export interface ToolContext {
  device: DeviceAgent;
  deferred: DeferredResults;
  /** Which agent started which command job (§4.4). */
  jobs: JobOwners;
  agent: AgentIdentity;
  /** Stable for the life of this Mac process; intents carry it for grouping. */
  sessionId: string;
  /** Ceiling on `plow_run_command`'s in-call wait — the call budget. */
  commandWaitCapMs: number;
}

/** One tool as this package defines it, before the MCP SDK wraps it. */
export interface ToolSpec {
  name: string;
  /** The human-readable label a client shows instead of the snake_case name. */
  title: string;
  description: string;
  /**
   * HINTS FOR DISPLAY AND ROUTING — not enforcement. What a tool may actually
   * do is the capability set the human approved, computed on this Mac from the
   * arguments. Nothing here is consulted by the policy engine, the sandbox or
   * the audit log, and a `readOnlyHint` read as a bound is exactly the drift
   * CLAUDE.md warns about. The MCP spec says the same from the other side: a
   * client must treat these as untrusted, because a server is free to lie.
   */
  annotations: ToolAnnotations;
  inputSchema: JSONValue;
  /**
   * Whether this tool constructs an intent and can therefore block on a human.
   * The three that cannot — retrieving output, listing tools, polling a handle
   * — must never be deferred: deferring the poller would be absurd.
   */
  deferrable: boolean;
  run(args: JSONValue, ctx: ToolContext, progress: Progress): Promise<JSONValue>;
}

/**
 * Build an intent from an already-constructed capability set and run it through
 * policy → approval → sandbox, mapping the device's answer onto §4.3's
 * vocabulary: a refusal is `denied`, anything else that went wrong is `failed`.
 */
export async function decideAndRun(
  ctx: ToolContext,
  progress: Progress,
  request: string,
  goal: string | undefined,
  capabilities: Capability[],
  payload: JSONValue = null,
): Promise<JSONValue> {
  const intent: Intent = makeIntent({
    agentId: ctx.agent.agentId,
    agentDisplay: ctx.agent.agentName ?? ctx.agent.agentId,
    deviceId: ctx.device.identity.deviceId,
    goal,
    request,
    capabilities,
    sessionId: ctx.sessionId,
  });
  const response = await ctx.device.handleIntent(intent, payload, () => progress.decided());
  const r = jv(response);
  switch (r.get("status").str) {
    case "denied":
      // Most denials say only that they happened. When the device supplies a
      // reason it is a standing condition the caller can act on — forward it
      // verbatim rather than flattening every denial to the same sentence.
      throw new DeniedError(r.get("reason").str ?? "the owner of this Mac denied the request");
    case "rejected":
      throw new ToolError(`rejected: ${r.get("reason").str ?? "unknown"}`);
    case "error":
      throw new Error(r.get("error").str ?? "device error");
    default:
      return response;
  }
}

/**
 * The one field a human actually reads. It said "Why (shown to the approver)",
 * which never told the model that a person is on the other end of it.
 *
 * Deliberately phrased as description, not persuasion: goal text is
 * display-only and never influences a decision path, so this must not read as
 * "explain well and you get more access". The enforceable bound is the
 * capability set.
 */
export const GOAL = {
  type: "string",
  description:
    "Why you need this, in one line. The user reads exactly this when deciding whether to approve.",
};

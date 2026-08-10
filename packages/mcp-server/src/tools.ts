/**
 * The Mac-local tool surface (design §4.5) and the capability construction that
 * feeds it (§4.2).
 *
 * This is the half of the old broker's MCPSession that was worth keeping, moved
 * to where it belongs. The broker built a *signed intent* from tool arguments
 * and shipped it to a Mac; we build the same capability set from the same
 * arguments, in-process, and hand it straight to the policy engine. Nothing is
 * signed because nothing crosses a wire.
 *
 * The surface is reduced: the broker's tools assumed many Macs behind one
 * endpoint, so every one of them took a `device`. Ours is one Mac addressed by
 * its URL, so `list_devices` and `request_device_access` are gone and no tool
 * takes a `device` argument.
 */
import {
  canonicalizeAsync,
  Capability,
  canonicalJSON,
  Intent,
  JSONValue,
  jv,
  makeIntent,
} from "@domo/protocol";
import { DeviceAgent, MAX_FILE_BYTES } from "@domo/device-core";
import { DeferredResults, DeniedError, Progress } from "./deferred.js";

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
  agent: AgentIdentity;
  /** Stable for the life of this Mac process; intents carry it for grouping. */
  sessionId: string;
  /** Ceiling on `run_command`'s in-call wait — the call budget. */
  commandWaitCapMs: number;
}

/** One tool as this package defines it, before the MCP SDK wraps it. */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: JSONValue;
  /**
   * Whether this tool constructs an intent and can therefore block on a human.
   * The three that cannot — retrieving output, listing tools, polling a handle
   * — must never be deferred: deferring the poller would be absurd.
   */
  deferrable: boolean;
  run(args: JSONValue, ctx: ToolContext, progress: Progress): Promise<JSONValue>;
}

const strings = (value: JSONValue[] | null): string[] =>
  (value ?? []).filter((v): v is string => typeof v === "string");

/**
 * Resolve a path the agent supplied to the real path the kernel will see,
 * BEFORE it becomes a capability.
 *
 * The approval dialog's entire value is that the human sees what will actually
 * happen. A raw `~/x`, `a/../b`, or a symlink shown verbatim would let an
 * innocuous-looking bound stand in for somewhere else entirely — approving
 * `/tmp/report` when that is a symlink to `~/.ssh/id_rsa`. Resolving here means
 * the human sees `~/.ssh/id_rsa`, the rule key is computed over it, and
 * execution targets that resolved path rather than re-following the symlink
 * afterwards — which also closes the swap window on the path itself.
 *
 * ASYNC on purpose. Resolution is filesystem I/O, and a tool runs under a call
 * budget whose timer lives on the event loop: resolving synchronously on a slow
 * or unresponsive mounted volume would block the loop and stop the budget from
 * ever firing, exactly as a synchronous read would.
 */
const resolved = (p: string): Promise<string> => canonicalizeAsync(p);

/** Resolve a list of supplied paths concurrently. */
const resolveAll = (paths: string[]): Promise<string[]> => Promise.all(paths.map(resolved));

/**
 * Build an intent from an already-constructed capability set and run it through
 * policy → approval → sandbox, mapping the device's answer onto §4.3's
 * vocabulary: a refusal is `denied`, anything else that went wrong is `failed`.
 */
async function decideAndRun(
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
      throw new DeniedError("the owner of this Mac denied the request");
    case "rejected":
      throw new ToolError(`rejected: ${r.get("reason").str ?? "unknown"}`);
    case "error":
      throw new Error(r.get("error").str ?? "device error");
    default:
      return response;
  }
}

const GOAL = { type: "string", description: "Why (shown to the approver)" };

export const TOOLS: ToolSpec[] = [
  {
    name: "read_file",
    description: "Read a file on this Mac. The owner may be asked to approve.",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: {
        path: { type: "string", description: "Absolute path (~ allowed)" },
        goal: GOAL,
      },
      additionalProperties: false,
    },
    deferrable: true,
    async run(args, ctx, progress) {
      const a = jv(args);
      const raw = a.get("path").str;
      if (raw === null) throw new ToolError("missing 'path'");
      const path = await resolved(raw);
      const response = await decideAndRun(
        ctx,
        progress,
        `read file: ${path}`,
        a.get("goal").str ?? undefined,
        [{ kind: "fs.read", paths: [path] }],
      );
      const base64 = jv(response).get("content_base64").str;
      if (base64 === null) throw new Error("no content returned");
      const data = Buffer.from(base64, "base64");
      const text = data.toString("utf8");
      // Text when it round-trips as UTF-8, base64 otherwise — binary safety.
      return Buffer.from(text, "utf8").equals(data)
        ? { path, content: text }
        : { path, content_base64: base64 };
    },
  },
  {
    name: "write_file",
    description: "Write a file on this Mac. The owner may be asked to approve.",
    inputSchema: {
      type: "object",
      required: ["path", "content"],
      properties: { path: { type: "string" }, content: { type: "string" }, goal: GOAL },
      additionalProperties: false,
    },
    deferrable: true,
    async run(args, ctx, progress) {
      const a = jv(args);
      const raw = a.get("path").str;
      if (raw === null) throw new ToolError("missing 'path'");
      const path = await resolved(raw);
      const content = a.get("content").str;
      if (content === null) throw new ToolError("missing 'content'");
      // Refuse before encoding: the point of the ceiling is to bound the work,
      // and encoding an oversized string is the work.
      if (content.length > MAX_FILE_BYTES) {
        throw new ToolError(
          `content is ${content.length} bytes, over the ${MAX_FILE_BYTES}-byte single-call limit`,
        );
      }
      const data = Buffer.from(content, "utf8");
      const response = await decideAndRun(
        ctx,
        progress,
        `write file: ${path} (${data.length} bytes)`,
        a.get("goal").str ?? undefined,
        [{ kind: "fs.write", paths: [path] }],
        { content_base64: data.toString("base64") },
      );
      return { path, bytes: jv(response).get("bytes").value ?? null };
    },
  },
  {
    name: "run_command",
    description:
      "Run a CLI command on this Mac inside a sandbox limited to the paths you declare here. " +
      "Declare every path you need up front; undeclared paths are blocked by the sandbox. " +
      "If the command is still running when the wait elapses you get a job handle for get_output. " +
      "If the whole call outruns this Mac's budget you get a pending handle instead: poll it with " +
      "get_result, and the ready payload is the run_command result — including its job handle.",
    inputSchema: {
      type: "object",
      required: ["argv"],
      properties: {
        argv: {
          type: "array",
          items: { type: "string" },
          description: 'Command and arguments, e.g. ["ls", "-la", "/tmp"]',
        },
        cwd: { type: "string", description: "Working directory (readable by the sandbox)" },
        read_paths: {
          type: "array",
          items: { type: "string" },
          description: "Directories/files the command may read",
        },
        write_paths: {
          type: "array",
          items: { type: "string" },
          description: "Directories/files the command may write",
        },
        network: {
          type: "boolean",
          description: "Whether the command needs network access (default false)",
        },
        wait_ms: {
          type: "integer",
          description:
            "How long to wait for completion before returning a job handle (default 10000). " +
            "Capped at this Mac's call budget, beyond which the call defers instead.",
        },
        goal: GOAL,
      },
      additionalProperties: false,
    },
    deferrable: true,
    async run(args, ctx, progress) {
      const a = jv(args);
      const argvValues = a.get("argv").arr;
      if (!argvValues || argvValues.length === 0) throw new ToolError("missing 'argv'");
      const argv = strings(argvValues);
      if (argv.length !== argvValues.length) throw new ToolError("argv must be strings");

      // Resolve every declared path before it becomes the bound the human
      // approves and the sandbox enforces.
      const readPaths = await resolveAll(strings(a.get("read_paths").arr));
      const writePaths = await resolveAll(strings(a.get("write_paths").arr));
      const rawCwd = a.get("cwd").str;
      const capabilities: Capability[] = [
        { kind: "process.exec", argv, cwd: rawCwd === null ? undefined : await resolved(rawCwd) },
        { kind: "network", allowed: a.get("network").bool ?? false },
      ];
      if (readPaths.length > 0) capabilities.push({ kind: "fs.read", paths: readPaths });
      if (writePaths.length > 0) capabilities.push({ kind: "fs.write", paths: writePaths });

      // Capped at the call budget because a longer wait can never produce an
      // answer: the budget timer starts before approval and the executor's wait
      // starts after it, so the budget always expires first.
      //
      // Note what this does NOT do — an earlier comment here claimed it. A
      // command that outruns the budget does not hand back a job handle
      // directly; the call defers, and `get_result` later returns a ready
      // payload that CONTAINS the job handle. Two hops, not one.
      const waitMs = Math.min(a.get("wait_ms").int ?? 10_000, ctx.commandWaitCapMs);
      return decideAndRun(
        ctx,
        progress,
        `run: ${argv.join(" ")}`,
        a.get("goal").str ?? undefined,
        capabilities,
        { wait_ms: waitMs },
      );
    },
  },
  {
    name: "get_output",
    description:
      "Fetch incremental output of a command still running from run_command. " +
      "Pass 'since' = the output_length you last saw. Takes the job handle run_command returned, " +
      "not a handle from get_result.",
    inputSchema: {
      type: "object",
      required: ["handle"],
      properties: { handle: { type: "string" }, since: { type: "integer" } },
      additionalProperties: false,
    },
    // Output retrieval is bound to an already-approved run: no new intent, no
    // approval, and nothing slow to wait on.
    deferrable: false,
    async run(args, ctx) {
      const handle = jv(args).get("handle").str;
      if (handle === null) throw new ToolError("missing 'handle'");
      return ctx.device.getOutput(handle, jv(args).get("since").int ?? 0);
    },
  },
  {
    name: "list_tools",
    description:
      "List the blessed tools this Mac offers, with their JSON input schemas. " +
      "These are trusted in-process capabilities, distinct from the tools in this list.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    deferrable: false,
    async run(_args, ctx) {
      return { tools: ctx.device.blessedTools.manifest() };
    },
  },
  {
    name: "use_tool",
    description: "Invoke a blessed tool on this Mac (discover them with list_tools).",
    inputSchema: {
      type: "object",
      required: ["tool"],
      properties: { tool: { type: "string" }, args: { type: "object" }, goal: GOAL },
      additionalProperties: false,
    },
    deferrable: true,
    async run(args, ctx, progress) {
      const a = jv(args);
      const tool = a.get("tool").str;
      if (tool === null) throw new ToolError("missing 'tool'");
      const response = await decideAndRun(
        ctx,
        progress,
        `use blessed tool: ${tool}`,
        a.get("goal").str ?? undefined,
        [{ kind: "tool", tool }],
        { args: a.get("args").value ?? null },
      );
      return { result: jv(response).get("result").value ?? null };
    },
  },
  {
    name: "get_result",
    description:
      "Retrieve the result of any call that returned a pending handle — whichever tool created it. " +
      "Answers pending / ready / denied / failed / expired / unknown. " +
      "A ready result is exactly what the original call would have returned had it been fast enough.",
    inputSchema: {
      type: "object",
      required: ["handle"],
      properties: { handle: { type: "string" } },
      additionalProperties: false,
    },
    deferrable: false,
    async run(args, ctx) {
      const handle = jv(args).get("handle").str;
      if (handle === null) throw new ToolError("missing 'handle'");
      return ctx.deferred.get(ctx.agent.agentId, handle);
    },
  },
];

/** The MCP content block a tool result becomes. */
export function toolContent(value: JSONValue): { type: "text"; text: string } {
  return { type: "text", text: canonicalJSON(value) };
}

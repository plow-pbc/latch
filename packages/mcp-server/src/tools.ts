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
  Capability,
  canonicalJSON,
  Intent,
  JSONValue,
  jv,
  makeIntent,
} from "@domo/protocol";
import { DeviceAgent } from "@domo/device-core";
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
      const path = a.get("path").str;
      if (path === null) throw new ToolError("missing 'path'");
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
      const path = a.get("path").str;
      if (path === null) throw new ToolError("missing 'path'");
      const content = a.get("content").str;
      if (content === null) throw new ToolError("missing 'content'");
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
      "If the command is still running when the wait elapses you get a job handle for get_output.",
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
            "Capped by this Mac's call budget.",
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

      const readPaths = strings(a.get("read_paths").arr);
      const writePaths = strings(a.get("write_paths").arr);
      const capabilities: Capability[] = [
        { kind: "process.exec", argv, cwd: a.get("cwd").str ?? undefined },
        { kind: "network", allowed: a.get("network").bool ?? false },
      ];
      if (readPaths.length > 0) capabilities.push({ kind: "fs.read", paths: readPaths });
      if (writePaths.length > 0) capabilities.push({ kind: "fs.write", paths: writePaths });

      // Waiting longer than the call budget would only convert a job handle
      // (which the agent can poll cheaply) into a deferred handle (which it
      // also has to poll). Cap it and let the executor hand back the job.
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

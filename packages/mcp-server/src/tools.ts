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
import { DeviceAgent, MAX_FILE_BYTES, MAX_OUTPUT_BYTES } from "@domo/device-core";
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
  /** Ceiling on `run_command`'s in-call wait — the call budget. */
  commandWaitCapMs: number;
}

/** One tool as this package defines it, before the MCP SDK wraps it. */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: JSONValue;
  /**
   * How this tool answers inside the relay's exchange deadline.
   *
   * `deferrable` — it constructs an intent and can therefore block on a human,
   * so when the call budget expires it hands back a handle and keeps working.
   * Every tool that can open an approval prompt must be this.
   *
   * `direct_bounded` — it opens no prompt (polling, manifests, work already
   * riding an approved grant) and must return within a hard ceiling, because
   * there is no handle for the caller to come back to. Deferring a poller
   * would be absurd; blocking one past the deadline would be worse.
   */
  classification: "deferrable" | "direct_bounded";
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
    classification: "deferrable",
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
    classification: "deferrable",
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
      "Run a CLI command on this Mac inside a seatbelt sandbox. Declare every path you need: " +
      "read_paths and write_paths are what the owner approves and what the audit record shows, and " +
      "write access is granted from them. They are NOT the full extent of what the command can " +
      "read — the sandbox profile permits reads more broadly than the paths declared here. " +
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
          description:
            "Directories/files the command needs to read. Shown to the approver and recorded; " +
            "not a complete bound on reads.",
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
    classification: "deferrable",
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
      const result = await decideAndRun(
        ctx,
        progress,
        `run: ${argv.join(" ")}`,
        a.get("goal").str ?? undefined,
        capabilities,
        { wait_ms: waitMs },
      );
      // The job is this agent's. Claimed here rather than in the executor,
      // which has one registry for the whole process and no idea who called.
      const handle = jv(result).get("handle").str;
      if (handle !== null) ctx.jobs.claim(ctx.agent.agentId, handle);
      return result;
    },
  },
  {
    name: "get_output",
    description:
      "Fetch incremental output of a command still running from run_command. " +
      "Pass 'since' = the next_since you last saw. Takes the job handle run_command returned, " +
      "not a handle from get_result. One call carries at most " +
      `${MAX_OUTPUT_BYTES} bytes; when next_since is below output_length, ask again from it.`,
    inputSchema: {
      type: "object",
      required: ["handle"],
      properties: { handle: { type: "string" }, since: { type: "integer" } },
      additionalProperties: false,
    },
    // Output retrieval is bound to an already-approved run: no new intent and
    // no approval. It is also the one direct tool whose work is synchronous,
    // which is why the *bytes* are capped rather than the wait: a ceiling
    // cannot interrupt a copy already running on the event loop.
    classification: "direct_bounded",
    async run(args, ctx) {
      const handle = jv(args).get("handle").str;
      if (handle === null) throw new ToolError("missing 'handle'");
      // Another agent's job is indistinguishable from one that never existed.
      ctx.jobs.assertOwner(ctx.agent.agentId, handle);
      return ctx.device.getOutput(handle, jv(args).get("since").int ?? 0);
    },
  },
  {
    name: "list_tools",
    description:
      "List the blessed tools this Mac offers, with their JSON input schemas, and any skills " +
      "it publishes (how-to guides for a task — read one with read_skill before starting). " +
      "Blessed tools are trusted in-process capabilities, distinct from the tools in this list.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    classification: "direct_bounded",
    async run(_args, ctx) {
      return {
        tools: ctx.device.blessedTools.manifest(),
        skills: (jv(ctx.device.skills.manifest()).arr ?? []).map((s) => ({
          name: jv(s).get("name").str,
          description: jv(s).get("description").str,
        })),
      };
    },
  },
  {
    name: "read_skill",
    description:
      "Read a skill this Mac publishes (listed by list_tools): a how-to guide for a task. " +
      "Read the relevant skill before starting work it covers (e.g. 'camoufox-browsing' for the browser tools).",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: { name: { type: "string", description: "Skill name from list_tools" } },
      additionalProperties: false,
    },
    classification: "direct_bounded",
    async run(args, ctx) {
      const name = jv(args).get("name").str;
      if (name === null) throw new ToolError("missing 'name'");
      const skill = ctx.device.skills.skill(name);
      if (skill === null) throw new ToolError(`no skill named '${name}' on this Mac`);
      return { name: skill.name, description: skill.description, body: skill.body };
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
    classification: "deferrable",
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
    name: "browser_open",
    description:
      "Open a supervised anti-detection browser session on this Mac, scoped to the listed site " +
      "origins. The owner approves the origin list — include every domain you expect (apex AND " +
      "wildcard: 'dominos.com', '*.dominos.com'). Set credentials_metadata to also request " +
      "permission to list the owner's vault item names (never values). The browser window is " +
      "visible by default; pass headed:false only when the owner asked for it to run in the " +
      "background. Returns a session handle for the 'browser' tool. Read the camoufox-browsing " +
      "skill first.",
    inputSchema: {
      type: "object",
      required: ["origins"],
      properties: {
        origins: {
          type: "array",
          items: { type: "string" },
          description: "Host patterns: 'example.com' or '*.example.com'",
        },
        credentials_metadata: {
          type: "boolean",
          description: "Also request vault metadata listing (default false)",
        },
        headed: {
          type: "boolean",
          description:
            "Show the browser window so the owner can watch (default true). Pass false only " +
            "when the owner asked to run it in the background — you see the same screenshots " +
            "either way, they do not.",
        },
        goal: GOAL,
      },
      additionalProperties: false,
    },
    classification: "deferrable",
    async run(args, ctx, progress) {
      const a = jv(args);
      const origins = strings(a.get("origins").arr);
      if (origins.length === 0) throw new ToolError("missing 'origins'");
      const capabilities: Capability[] = [{ kind: "browser", origins }];
      if (a.get("credentials_metadata").bool === true) {
        capabilities.push({ kind: "credential", access: "metadata" });
      }
      // The owner is about to approve a browser they may not see: say so in the
      // line they read, and carry the choice as payload — it bounds nothing.
      const headed = a.get("headed").bool;
      const response = await decideAndRun(
        ctx,
        progress,
        `browse${headed === false ? " (hidden window)" : ""}: ${origins.join(", ")}`,
        a.get("goal").str ?? undefined,
        capabilities,
        headed === null ? null : { headed },
      );
      const r = jv(response);
      return {
        session: r.get("session").str,
        origins: r.get("origins").value ?? origins,
        headed: r.get("headed").bool,
        note: "use the 'browser' tool with this session handle; screenshot after every navigation",
      };
    },
  },
  {
    name: "browser_request",
    description:
      "Ask the owner to widen an open browser session: additional site origins (e.g. a payment " +
      "popup went to paypal.com) and/or permission to fill specific vault items into pages " +
      "(find item ids via the browser tool's 'credentials' action). Secret values are never " +
      "revealed to you; they are typed into the page on this Mac.",
    inputSchema: {
      type: "object",
      required: ["session"],
      properties: {
        session: { type: "string" },
        origins: { type: "array", items: { type: "string" } },
        credential_items: {
          type: "array",
          items: { type: "string" },
          description: "vault item ids to make fillable",
        },
        goal: GOAL,
      },
      additionalProperties: false,
    },
    classification: "deferrable",
    async run(args, ctx, progress) {
      const a = jv(args);
      const session = a.get("session").str;
      if (session === null) throw new ToolError("missing 'session'");
      const origins = strings(a.get("origins").arr);
      const items = strings(a.get("credential_items").arr);
      const capabilities: Capability[] = [];
      if (origins.length > 0) capabilities.push({ kind: "browser", origins });
      if (items.length > 0) capabilities.push({ kind: "credential", access: "fill", items });
      if (capabilities.length === 0) {
        throw new ToolError("browser_request needs origins and/or credential_items");
      }
      const parts = [
        ...(origins.length ? [`browse: ${origins.join(", ")}`] : []),
        ...(items.length ? [`fill credentials: ${items.join(", ")}`] : []),
      ];
      const response = await decideAndRun(
        ctx,
        progress,
        `widen browser session — ${parts.join("; ")}`,
        a.get("goal").str ?? undefined,
        capabilities,
        // The handle is delivery detail (like wait_ms); the approved bound is
        // entirely in the signed-off capabilities.
        { session },
      );
      const r = jv(response);
      return { session, origins: r.get("origins").value ?? null, items: r.get("items").value ?? null };
    },
  },
  {
    name: "browser",
    description:
      "Act within an approved browser session. Actions: goto, click, fill, fill_secret, scroll, " +
      "wait, back, eval, use_page, screenshot, text, url, title, links, forms, tables, pages. " +
      "'screenshot' returns an image of the page — take one after " +
      "every navigation to see where you are. Ask the vault tool what is in the vault; " +
      "'fill_secret' types an approved item's field into a form " +
      "field without ever showing you the value. Actions on pages outside the approved origins are " +
      "refused — use browser_request to widen scope. Every result includes the current url and " +
      "page_count (watch it for popups; switch with use_page).",
    inputSchema: {
      type: "object",
      required: ["session", "action"],
      properties: {
        session: { type: "string" },
        action: {
          type: "string",
          enum: [
            "goto", "click", "fill", "fill_secret", "scroll", "wait", "back", "eval", "use_page",
            "screenshot", "text", "url", "title", "links", "forms", "tables", "pages",
          ],
        },
        url: { type: "string", description: "goto: target URL (within approved origins)" },
        selector: { type: "string", description: "click / fill / fill_secret: CSS selector" },
        value: { type: "string", description: "fill: literal text to type (non-secret)" },
        expression: { type: "string", description: "eval: JS expression (top frame)" },
        index: { type: "integer", description: "use_page: page index from 'pages'" },
        item: { type: "string", description: "fill_secret / describe_item: vault item id" },
        field: { type: "string", description: "fill_secret: field label from describe_item (or 'totp')" },
        direction: { type: "string", description: "scroll: down|up|bottom|top" },
        seconds: { type: "number", description: "wait: seconds" },
        frame: { type: "integer", description: "click/fill: target a specific frame index" },
        max_chars: { type: "integer", description: "text: truncate to this many chars" },
      },
      additionalProperties: false,
    },
    // Rides the session grant — no new intent, no approval. Non-deferrable so a
    // screenshot's image block reaches the agent directly (a deferred result
    // would be re-serialized as text by get_result).
    classification: "direct_bounded",
    async run(args, ctx) {
      const a = jv(args);
      const session = a.get("session").str;
      if (session === null) throw new ToolError("missing 'session'");
      const action = a.get("action").str;
      if (action === null) throw new ToolError("missing 'action'");
      const params: { [k: string]: JSONValue } = { action };
      for (const key of ["url", "selector", "value", "expression", "index", "item", "field", "direction", "seconds", "frame"]) {
        const v = a.get(key).value;
        if (v !== null && v !== undefined) params[key] = v;
      }
      const maxChars = a.get("max_chars").int;
      if (maxChars !== null) params.max = maxChars;

      const response = await ctx.device.browserCommand(ctx.agent.agentId, session, params);
      const r = jv(response);
      if (r.get("status").str === "error") throw new ToolError(r.get("error").str ?? "browser error");

      // Screenshot becomes an MCP image block so the agent can SEE the page.
      const imageB64 = r.get("data_b64").str;
      if (action === "screenshot" && imageB64 !== null) {
        const meta = { url: r.get("url").str ?? "", page_count: r.get("page_count").int ?? 1 };
        return {
          __mcpContent: [
            { type: "image", data: imageB64, mimeType: r.get("mime").str ?? "image/jpeg" },
            { type: "text", text: canonicalJSON(meta as JSONValue) },
          ],
        };
      }
      const out = { ...(r.obj ?? {}) };
      delete out.status;
      return out as JSONValue;
    },
  },
  {
    name: "vault",
    description:
      "This machine keeps its own password vault. 'list' says what is in it — logins, cards, " +
      "notes, custom fields — with titles, usernames and sites but never a value. 'describe' " +
      "names the fields one item holds. No browser session is needed to ask. To USE a secret, " +
      "open a browser session and call the browser tool's fill_secret: values are typed into the " +
      "page and never returned to you.",
    inputSchema: {
      type: "object",
      required: ["action"],
      properties: {
        action: { type: "string", enum: ["list", "describe"] },
        item: { type: "string", description: "Item id, for 'describe'." },
      },
      additionalProperties: false,
    },
    classification: "direct_bounded",
    async run(args, ctx) {
      const a = jv(args);
      const action = a.get("action").str;
      if (action === "list") return ctx.device.vaultList();
      if (action === "describe") return ctx.device.vaultDescribe(a.get("item").str ?? "");
      throw new ToolError("action must be 'list' or 'describe'");
    },
  },
  {
    name: "browser_close",
    description: "Close a browser session when the task is done.",
    inputSchema: {
      type: "object",
      required: ["session"],
      properties: { session: { type: "string" } },
      additionalProperties: false,
    },
    classification: "direct_bounded",
    async run(args, ctx) {
      const session = jv(args).get("session").str;
      if (session === null) throw new ToolError("missing 'session'");
      await ctx.device.browserCommand(ctx.agent.agentId, session, { action: "close" });
      return { closed: true };
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
    classification: "direct_bounded",
    async run(args, ctx) {
      const handle = jv(args).get("handle").str;
      if (handle === null) throw new ToolError("missing 'handle'");
      return ctx.deferred.get(ctx.agent.agentId, handle);
    },
  },
];

/** An MCP content block a tool result can become. */
export type ToolBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/** The single text block a plain tool result becomes. */
export function toolContent(value: JSONValue): { type: "text"; text: string } {
  return { type: "text", text: canonicalJSON(value) };
}

/**
 * The content blocks a tool result becomes. Most results are one JSON text
 * block; a result carrying `__mcpContent` (a screenshot) is expanded into its
 * prebuilt image + text blocks so the agent SEES the page instead of a base64
 * string it cannot render.
 */
export function toolBlocks(value: JSONValue): ToolBlock[] {
  const mc = jv(value).get("__mcpContent").arr;
  if (mc === null) return [toolContent(value)];
  return mc.map((block) => {
    const b = jv(block);
    if (b.get("type").str === "image") {
      return {
        type: "image",
        data: b.get("data").str ?? "",
        mimeType: b.get("mimeType").str ?? "image/jpeg",
      };
    }
    return { type: "text", text: b.get("text").str ?? "" };
  });
}

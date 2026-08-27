/**
 * The Mac-local tool surface (design §4.5) and the capability construction that
 * feeds it (§4.2).
 *
 * This is the half of the old broker's MCPSession that was worth keeping, moved
 * to where it belongs. The broker built a *signed intent* from tool arguments
 * and shipped it to a Mac; we build the same capability set from the same
 * arguments, in-process, and hand it straight to the policy engine. Nothing is
 * signed because no third party's intent is received here. That is provenance,
 * not confinement — DESIGN.md §4 *The intent object* owns where an intent's
 * contents go.
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
import { ToolAnnotations } from "@modelcontextprotocol/server";
import {
  DeviceAgent,
  LIVE_WEB_ROUTING,
  MAX_CLICK_TIMEOUT_MS,
  MAX_FILE_BYTES,
  needsToken,
  vendoredProvider,
} from "@domo/device-core";
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

/**
 * The one field a human actually reads. It said "Why (shown to the approver)",
 * which never told the model that a person is on the other end of it.
 *
 * Deliberately phrased as description, not persuasion: goal text is
 * display-only and never influences a decision path, so this must not read as
 * "explain well and you get more access". The enforceable bound is the
 * capability set.
 */
const GOAL = {
  type: "string",
  description:
    "Why you need this, in one line. The user reads exactly this when deciding whether to approve.",
};

/**
 * The macOS tooling an agent is told to reach for, in ONE place — this sentence
 * and `plow_run_command`'s description are two consumers of one list.
 *
 * Every name here was RUN under the generated seatbelt profile before being
 * printed: `mdfind`, `sips`, `pbcopy` and `pbpaste` all exit 0 under
 * `(deny default)` + `(allow mach-lookup)`. `osascript` driving another
 * application, `screencapture` and `shortcuts` are deliberately absent — the
 * profile grants no `appleevent-send` and the app ships no automation
 * entitlement, so naming them would point an agent at a denial. Adding a name
 * means running it first; see the coupling note in device-core's executor.ts.
 */
export const MACOS_TOOLING =
  "mdfind for Spotlight search across their files, sips for images, " +
  "pbcopy and pbpaste for the clipboard, and whatever else they have installed";

export const TOOLS: ToolSpec[] = [
  {
    name: "plow_read_file",
    title: "Read a file on the user's Mac",
    description:
      "Read a file on the user's own Mac — their real filesystem, not your workspace. " +
      "They may be asked to approve, so this can return a pending handle.",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: {
        path: { type: "string", description: "Absolute path (~ allowed)" },
        goal: GOAL,
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
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
    name: "plow_write_file",
    title: "Write a file on the user's Mac",
    description:
      "Write a file on the user's own Mac — use this when the file is for them to open or keep, " +
      "not for your own working files. They may be asked to approve, so this can return a " +
      "pending handle.",
    inputSchema: {
      type: "object",
      required: ["path", "content"],
      properties: { path: { type: "string" }, content: { type: "string" }, goal: GOAL },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
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
    name: "plow_run_command",
    title: "Run a command on the user's Mac",
    description:
      "Run a command on the user's own Mac — their installed tools, their data, their network. " +
      "Use this when the command must affect their machine; use your own shell for your own work. " +
      "Their Mac is a macOS workstation, so reach for tooling your workspace does not have when " +
      `it fits the job: ${MACOS_TOOLING}. ` +
      "It runs inside a seatbelt sandbox. Declare every path you need: " +
      "read_paths and write_paths are what the owner approves and what the audit record shows, and " +
      "write access is granted from them. They are NOT the full extent of what the command can " +
      "read — the sandbox profile permits reads more broadly than the paths declared here. " +
      "If the command is still running when the wait elapses you get a job handle for plow_get_output. " +
      "A command that declares neither write_paths nor network can be killed if it has produced no " +
      "output at all after 15 minutes — so if long silent work is expected, have it print progress — " +
      "and in exchange its only writable place is `$TMPDIR`, a directory of its own that is deleted " +
      "when it is killed. Declare a write path (or " +
      "network) and it is never killed that way, because it could be mid-work and a truncated file " +
      "is worse than the wait. " +
      "A run ends when the command itself exits, and its stdout and stderr close with it — so a job " +
      "left running in the background will normally be killed by its next write unless it redirects " +
      "both (`>log 2>&1`), its output is not captured, and no handle tracks it. "  +
      "If the whole call outruns this Mac's budget you get a pending handle instead: poll it with " +
      "plow_get_result, and the ready payload is the plow_run_command result — including its job handle.",
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
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    deferrable: true,
    async run(args, ctx, progress) {
      const a = jv(args);
      const argvValues = a.get("argv").arr;
      if (!argvValues || argvValues.length === 0) throw new ToolError("missing 'argv'");
      const argv = strings(argvValues);
      if (argv.length !== argvValues.length) throw new ToolError("argv must be strings");

      // A vendored provider CLI refuses some argv outright — an argument that
      // would disarm its safety flags or read a local file into an outbound
      // message, or a command the bundled binary does not have. Checked HERE,
      // before an intent exists, because a card the owner approves mints a
      // live provider token: nobody should be asked to authorise a call this
      // Mac was always going to refuse. The device checks again; it is the
      // chokepoint and cannot rely on this caller.
      const provider = vendoredProvider(argv);
      const refusal = provider?.refuse(argv) ?? null;
      if (refusal !== null) throw new ToolError(refusal);

      // Resolve every declared path before it becomes the bound the human
      // approves and the sandbox enforces.
      const readPaths = await resolveAll(strings(a.get("read_paths").arr));
      const writePaths = await resolveAll(strings(a.get("write_paths").arr));
      const rawCwd = a.get("cwd").str;
      const capabilities: Capability[] = [
        { kind: "process.exec", argv, cwd: rawCwd === null ? undefined : await resolved(rawCwd) },
        // A vendored provider implies network. Its whole purpose is to reach
        // the service its minted token authenticates against, so a gog call
        // approved without it is a call the sandbox then denies — and making
        // the agent remember a flag whose answer is never in doubt is a
        // footgun a skill can only paper over. The human still sees it: it is
        // in the capability set they approve, like any other network grant.
        // `--help` is exempt for the same reason it mints nothing.
        {
          kind: "network",
          allowed: (a.get("network").bool ?? false) || (provider !== null && needsToken(argv)),
        },
      ];
      if (readPaths.length > 0) capabilities.push({ kind: "fs.read", paths: readPaths });
      if (writePaths.length > 0) capabilities.push({ kind: "fs.write", paths: writePaths });

      // Capped at the call budget because a longer wait can never produce an
      // answer: the budget timer starts before approval and the executor's wait
      // starts after it, so the budget always expires first.
      //
      // Note what this does NOT do — an earlier comment here claimed it. A
      // command that outruns the budget does not hand back a job handle
      // directly; the call defers, and `plow_get_result` later returns a ready
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
    name: "plow_get_output",
    title: "Get output from a running command",
    description:
      "Fetch incremental output of a command still running from plow_run_command. " +
      "Pass 'since' = the output_length you last saw. Takes the job handle plow_run_command returned, " +
      "not a handle from plow_get_result. " +
      "A read-only command that produces nothing and never exits is eventually killed by this Mac: " +
      "the reply then carries an 'error' saying so, which is for the user to hear. One approved to " +
      "write or to use the network is not — it could be mid-work — so polling will not resolve on " +
      "its own; tell the user, who is the only one who can end it.",
    inputSchema: {
      type: "object",
      required: ["handle"],
      properties: { handle: { type: "string" }, since: { type: "integer" } },
      additionalProperties: false,
    },
    // Output retrieval is bound to an already-approved run: no new intent, no
    // approval, and nothing slow to wait on.
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    deferrable: false,
    async run(args, ctx) {
      const handle = jv(args).get("handle").str;
      if (handle === null) throw new ToolError("missing 'handle'");
      // Another agent's job is indistinguishable from one that never existed.
      ctx.jobs.assertOwner(ctx.agent.agentId, handle);
      return ctx.device.getOutput(handle, jv(args).get("since").int ?? 0);
    },
  },
  {
    name: "plow_list_skills",
    title: "List this Mac's skills",
    description:
      "Call this early. This Mac publishes skills — how-to guides for tasks it can do, written " +
      "for whoever is driving it, and specific to this user's setup in ways you cannot otherwise " +
      "know. Lists their names and descriptions; read one with plow_read_skill before starting " +
      "work it covers.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    deferrable: false,
    async run(_args, ctx) {
      return { skills: ctx.device.skills.manifest() };
    },
  },
  {
    name: "plow_read_skill",
    title: "Read one of this Mac's skills",
    description:
      "Read a skill this Mac publishes (listed by plow_list_skills): a how-to guide for a task. " +
      "Read the relevant skill before starting work it covers (e.g. 'camoufox-browsing' for the plow_browser tools).",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: { name: { type: "string", description: "Skill name from plow_list_skills" } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    deferrable: false,
    async run(args, ctx) {
      const name = jv(args).get("name").str;
      if (name === null) throw new ToolError("missing 'name'");
      const skill = ctx.device.skills.skill(name);
      if (skill === null) throw new ToolError(`no skill named '${name}' on this Mac`);
      return { name: skill.name, description: skill.description, body: skill.body };
    },
  },
  {
    name: "plow_browser_open",
    title: "Open a browser on the user's Mac",
    description:
      "Open a browser on the user's own Mac, as the user — use this for reading the live web, " +
      `not your own fetch: ${LIVE_WEB_ROUTING}. ` +
      "What you sign into is merged back into their profile when the session closes — including " +
      "when several browsers are open at once. It can also fill passwords from their vault " +
      "without returning them to you ('eval' is the exception: it reads page values directly, " +
      "and must not be pointed at a field you filled). " +
      "The session id you get back says WHICH browser: pass it on every call and you keep the " +
      "same window. The Mac runs a few at once — every one of them the user's — and says so " +
      "plainly when it is full. " +
      "It is a supervised anti-detection browser, scoped to the listed " +
      "site origins. The owner approves the origin list — include every domain you expect (apex AND " +
      "wildcard: 'dominos.com', '*.dominos.com'). Vault item names are listed by 'plow_vault'. " +
      "The browser window is " +
      "hidden by default; pass headed:true only when the owner asked to watch it run. " +
      "Returns a session handle for the 'plow_browser' tool. Read the camoufox-browsing " +
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
        headed: {
          type: "boolean",
          description:
            "Show the browser window so the owner can watch (default false). Pass true only " +
            "when the owner asked to watch it run — you see the same screenshots either way, " +
            "they do not.",
        },
        goal: GOAL,
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    deferrable: true,
    async run(args, ctx, progress) {
      const a = jv(args);
      const origins = strings(a.get("origins").arr);
      if (origins.length === 0) throw new ToolError("missing 'origins'");
      const capabilities: Capability[] = [{ kind: "browser", origins }];
      // The owner does not see the browser unless this session asks for a
      // window: say when one is coming in the line they read, and carry the
      // choice as payload — it bounds nothing.
      const headed = a.get("headed").bool;
      const response = await decideAndRun(
        ctx,
        progress,
        `browse${headed === true ? " (visible window)" : ""}: ${origins.join(", ")}`,
        a.get("goal").str ?? undefined,
        capabilities,
        headed === null ? null : { headed },
      );
      const r = jv(response);
      return {
        session: r.get("session").str,
        origins: r.get("origins").value ?? origins,
        headed: r.get("headed").bool,
        note: "use the 'plow_browser' tool with this session handle; screenshot after every navigation",
      };
    },
  },
  {
    name: "plow_browser_request",
    title: "Ask to widen the browser session",
    description:
      "Ask the owner to widen an open browser session: additional site origins (e.g. a payment " +
      "popup went to paypal.com) and/or permission to fill specific vault items into pages " +
      "(find item ids with plow_vault's 'list' action). A secret is never returned to you by " +
      "these tools; it is typed into the page on this Mac, where it is page content like " +
      "anything else — readable through 'eval', which you must not point at a field you filled.",
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
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    deferrable: true,
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
        throw new ToolError("plow_browser_request needs origins and/or credential_items");
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
      // A widen the device refused is an error to the caller, not a reply with
      // empty fields: "your browser is closing" must not read as "widened".
      const failed = r.get("error").str;
      if (failed !== null) throw new ToolError(failed);
      return { session, origins: r.get("origins").value ?? null, items: r.get("items").value ?? null };
    },
  },
  {
    name: "plow_browser",
    title: "Drive the user's browser",
    description:
      "Act within an approved browser session. Actions: goto, click, fill, fill_secret, scroll, " +
      "wait, back, eval, use_page, screenshot, text, url, title, links, forms, tables, pages. " +
      "'screenshot' returns an image of the page — take one after " +
      "every navigation to see where you are. When a 'click' fails, give it a longer " +
      "'timeout_ms' — never synthesize the click with 'eval', which sites detect. A click " +
      "something is covering is refused and the error names what is over it: dismiss that " +
      "first, then click. " +
      "Ask plow_vault what is in the vault; " +
      "'fill_secret' types any approved vault field into a form field on this Mac without " +
      "returning the value to you — use it for every vault-backed field, including ones that " +
      "are not secret. Fields the vault itself conceals (passwords, card numbers and codes, " +
      "hidden custom fields) also render masked and come back from 'forms' without their " +
      "characters; everything else fills as ordinary text you can read back. A generated " +
      "'totp' code is the one field masked although the vault's own app shows it — fill it " +
      "and submit, you never need to read it. Masking covers what you see, screenshots and " +
      "'forms'; it does not cover 'eval', which reads a field's value straight out of the " +
      "page, so never inspect a field you filled that way. Actions on pages outside the approved origins are " +
      "refused — use plow_browser_request to widen scope. Every result includes the current url and " +
      "page_count (watch it for popups; switch with use_page), and 'failed_requests' when the " +
      "page's own requests came back refused — a 401, 403 or 429 there is why an action that " +
      "reported success changed nothing, so read it before retrying.",
    inputSchema: {
      type: "object",
      required: ["session", "action"],
      properties: {
        session: { type: "string", description: "Your browser, from plow_browser_open. Pass the same one to keep the same window; it is a secret — do not share or log it." },
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
        item: { type: "string", description: "fill_secret: vault item id, from plow_vault list" },
        field: { type: "string", description: "fill_secret: field label from plow_vault describe (or 'totp')" },
        direction: { type: "string", description: "scroll: down|up|bottom|top" },
        seconds: { type: "number", description: "wait: seconds" },
        frame: { type: "integer", description: "click/fill: target a specific frame index" },
        timeout_ms: { type: "integer", description: `click: how long to wait for the element (default 3000, capped at ${MAX_CLICK_TIMEOUT_MS})` },
        max_chars: { type: "integer", description: "text: truncate to this many chars" },
      },
      additionalProperties: false,
    },
    // Rides the session grant — no new intent, no approval. Non-deferrable so a
    // screenshot's image block reaches the agent directly (a deferred result
    // would be re-serialized as text by plow_get_result).
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    deferrable: false,
    async run(args, ctx) {
      const a = jv(args);
      const session = a.get("session").str;
      if (session === null) throw new ToolError("missing 'session'");
      const action = a.get("action").str;
      if (action === null) throw new ToolError("missing 'action'");
      const params: { [k: string]: JSONValue } = { action };
      for (const key of ["url", "selector", "value", "expression", "index", "item", "field", "direction", "seconds", "frame", "timeout_ms"]) {
        const v = a.get(key).value;
        if (v !== null && v !== undefined) params[key] = v;
      }
      const maxChars = a.get("max_chars").int;
      if (maxChars !== null) params.max = maxChars;

      const response = await ctx.device.browserCommand(session, params);
      const r = jv(response);
      if (r.get("status").str === "error") {
        // An error is a string here, so anything the device attached to it has
        // to be said IN that string — and what the page's own requests did is
        // usually the reason for the error.
        const refused = r.get("failed_requests").arr;
        throw new ToolError(
          (r.get("error").str ?? "browser error") +
            (refused === null ? "" : ` — the page's own requests were refused: ${canonicalJSON(refused)}`),
        );
      }

      // Screenshot becomes an MCP image block so the agent can SEE the page.
      // Built from the SAME cleaned result as every other action — only the
      // binary transport fields are lifted out — so a diagnostic added to a
      // result reaches a screenshot without a second copy of this code.
      const out = { ...(r.obj ?? {}) };
      delete out.status;
      const imageB64 = r.get("data_b64").str;
      if (action === "screenshot" && imageB64 !== null) {
        const mimeType = r.get("mime").str ?? "image/jpeg";
        delete out.data_b64;
        delete out.mime;
        delete out.path;
        return {
          __mcpContent: [
            { type: "image", data: imageB64, mimeType },
            { type: "text", text: canonicalJSON(out as JSONValue) },
          ],
        };
      }
      return out as JSONValue;
    },
  },
  {
    name: "plow_vault",
    title: "Look inside the user's password vault",
    description:
      "Check here before concluding you cannot sign in somewhere. " +
      "This machine keeps its own password vault. 'list' says what is in it — logins, cards, " +
      "identities, notes, custom fields — with titles, usernames and sites but never a value. " +
      "'describe' names the fields one item holds, an identity's address and ID numbers " +
      "included. No browser session is needed to ask. To USE any vault field, secret or not, " +
      "open a browser session and call the plow_browser tool's fill_secret — that is the only " +
      "way to put one into a page: the value is typed in on the Mac and is never returned by " +
      "these tools, nor by a screenshot or 'forms' if the vault conceals it. It is in the page " +
      "you are driving and 'eval' can read it, so treat it as you would anything else on that " +
      "page: do not go looking for it, copy it out, or repeat it.",
    inputSchema: {
      type: "object",
      required: ["action"],
      properties: {
        action: { type: "string", enum: ["list", "describe"] },
        item: { type: "string", description: "Item id, for 'describe'." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    deferrable: false,
    async run(args, ctx) {
      const a = jv(args);
      const action = a.get("action").str;
      if (action === "list") return ctx.device.vaultList();
      if (action === "describe") return ctx.device.vaultDescribe(a.get("item").str ?? "");
      throw new ToolError("action must be 'list' or 'describe'");
    },
  },
  {
    name: "plow_browser_close",
    title: "Close the browser session",
    description: "Close a browser session when the task is done.",
    inputSchema: {
      type: "object",
      required: ["session"],
      properties: { session: { type: "string" } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    deferrable: false,
    async run(args, ctx) {
      const session = jv(args).get("session").str;
      if (session === null) throw new ToolError("missing 'session'");
      // The device answers with an error for a handle it does not know, and
      // saying "closed" anyway would tell the caller it worked.
      const result = jv(await ctx.device.browserCommand(session, { action: "close" }));
      const error = result.get("error").str;
      if (error !== null) throw new ToolError(error);
      return { closed: true };
    },
  },
  {
    name: "plow_get_result",
    title: "Poll a pending result",
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
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false },
    deferrable: false,
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

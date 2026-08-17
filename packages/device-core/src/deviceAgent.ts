/**
 * The device-side engine: takes an intent built on this Mac, runs it through
 * policy, executes the approved operation, and audits everything. Shared by the
 * Electron app and (later) the relay client's request handler.
 *
 * There is no transport here any more. The broker link — dialing, the
 * enrollment challenge, pairing, reconnect, and the agent-key pinning that went
 * with them — was removed with the broker itself; an Intent is now built
 * in-process from an authenticated agent's call and never crosses a wire, so
 * there is no signature to verify and no agent public key to pin.
 */
import { capabilityDisplay, Intent, intentIsExpired, JSONValue, jv } from "@domo/protocol";
import os from "node:os";
import path from "node:path";
import { AuditLog } from "./auditLog.js";
import { BlessedToolRegistry } from "./blessedTools.js";
import { BrowserHost, ViewerFrame } from "./browser/browserHost.js";
import { BrowserSessions } from "./browser/browserSessions.js";
import { CredentialBroker } from "./browser/credentialBroker.js";
import { VaultServer } from "./browser/vaultServer.js";
import { ResolvedBrowserRuntime } from "./browser/browserRuntime.js";
import { BROWSING_SKILL } from "./browser/browsingSkill.js";
import { Executor } from "./executor.js";
import { FileOps } from "./fileOps.js";
import { DeviceIdentity, loadOrCreateIdentity } from "./identity.js";
import { PolicyDelegate, PolicyEngine } from "./policyEngine.js";
import { SkillRegistry } from "./skills.js";

/**
 * A delegate that denies because the adversarial reviewer could not run for
 * want of Plow credits. Set as the decision's `source`, so it rides the channel
 * that already exists rather than widening the frozen `Grant`.
 */
export const DENIAL_SOURCE_NO_CREDITS = "no_credits";

/**
 * Denial sources whose reason is worth telling the calling agent, and the exact
 * sentence it gets.
 *
 * Fixed strings by construction: nothing here is derived from a response body,
 * a credential, an account id, or an endpoint, so no amount of upstream
 * misbehaviour can put any of those in front of a caller.
 */
const EXPLAINED_DENIALS: Record<string, string> = {
  [DENIAL_SOURCE_NO_CREDITS]:
    "inference unavailable: this Plow account is out of credits, so the " +
    "adversarial reviewer could not run and the operation was denied",
};

export class DeviceAgent {
  readonly identity: DeviceIdentity;
  readonly audit: AuditLog;
  readonly policy: PolicyEngine;
  readonly blessedTools: BlessedToolRegistry;
  readonly executor: Executor;
  /** Owner-published skills (how-to guides), surfaced via list_tools/read_skill. */
  readonly skills: SkillRegistry;
  /** Null when no browser runtime is installed — browser tools report so. */
  readonly browserSessions: BrowserSessions | null = null;
  /** Exposed so the approval UI can resolve credential item titles locally. */
  readonly credentialBroker: CredentialBroker | null = null;
  /** The vault this machine runs, when this build ships one. */
  readonly vaultServer: VaultServer | null = null;
  private readonly browserHost: BrowserHost | null = null;
  private readonly seenNonces = new Set<string>();

  constructor(
    public readonly home: string,
    name: string,
    private readonly delegate: PolicyDelegate,
    blessedTools?: BlessedToolRegistry,
    browserRuntime?: ResolvedBrowserRuntime | null,
  ) {
    this.identity = loadOrCreateIdentity(home, name);
    this.audit = new AuditLog(path.join(home, "device/audit.ndjson"));
    this.policy = new PolicyEngine(path.join(home, "device/rules.json"));
    this.executor = new Executor(path.join(home, "device/scratch"));
    this.blessedTools = blessedTools ?? BlessedToolRegistry.standard();
    this.skills = new SkillRegistry();
    this.skills.loadDir(path.join(home, "device/skills"));
    if (browserRuntime) {
      this.skills.register(BROWSING_SKILL);
      const browserDir = path.join(home, "device/browser");
      const auditFn = (event: string, fields: { [k: string]: JSONValue }) =>
        this.audit.record(event, fields);
      this.browserHost = new BrowserHost({
        command: browserRuntime.serverCommand,
        // Visible by default: the owner should be able to watch what is being
        // done with their credentials. Set DOMO_BROWSER_HEADED=0 for headless,
        // which is what the test tiers and any unattended run want.
        headed: process.env.DOMO_BROWSER_HEADED !== "0",
        env: browserRuntime.env,
        screenshotsDir: path.join(browserDir, "screenshots"),
        profileDir: path.join(browserDir, "profile"),
        camoufoxInstallDir: browserRuntime.camoufoxInstallDir,
        isolatedHome: path.join(browserDir, "pyhome"),
        // Every `browser` action is non-deferrable and must answer inside the
        // relay's ~20s per-exchange ceiling; cap the per-action wait below it so
        // a hung page/eval returns an error in time instead of a torn 504. The
        // cold start is separate (startTimeoutMs) and paid by the deferrable
        // browser_open, so it does not need to fit this bound.
        actionTimeoutMs: 15_000,
        audit: auditFn,
      });
      // Launched from Finder there is no environment to speak of, so the vault
      // and the broker agree on one identity for this machine rather than each
      // falling back to a different default.
      const vaultPerson = process.env.DOMO_VAULT_PERSON ?? `${os.userInfo().username}@local`;
      // When this build ships its own vault, run it here rather than talking to
      // one we host: same broker, same CLI, just pointed at 127.0.0.1 with the
      // cert this machine minted for itself.
      const vault = browserRuntime.vaultServer
        ? new VaultServer({
            binary: browserRuntime.vaultServer.binary,
            webVaultDir: browserRuntime.vaultServer.webVaultDir,
            dataDir: path.join(browserDir, "vault"),
            person: vaultPerson,
          })
        : null;
      this.vaultServer = vault;
      // Up with the app, not on first use: the owner has to be able to open
      // the vault's own page whenever Domo is running, not only after an agent
      // happens to ask for a credential.
      void vault
        ?.start()
        .then(() => this.credentialBroker?.warm())
        .catch(() => {
          /* the broker surfaces this as a locked vault when it next runs */
        });
      const credentials = new CredentialBroker({
        command: browserRuntime.credentialBrokerCommand,
        env: browserRuntime.env,
        // Resolved per call: the account is created by the vault's first run,
        // which happens after this object exists. Getters in a spread would be
        // read once, right here, and freeze an empty account in place.
        envFor: vault
          ? () => ({
              SEED_VAULT_URL: vault.url,
              SEED_VAULT_CA: vault.certPath,
              SEED_VAULT_USER: vault.account?.email ?? "",
              SEED_VAULT_PASSWORD: vault.account?.password ?? "",
              // Its own client state, beside its own vault. Sharing the
              // standalone default means inheriting whatever server and
              // account a previous install was pointed at.
              SEED_VAULT_STATE: path.join(vault.dataDir, "client"),
              // Below the per-action ceiling on purpose: an unreachable vault
              // must come back as an error the agent can report, not as a call
              // that never returns and takes the session down with it.
              SEED_VAULT_TIMEOUT: "10",
            })
          : undefined,
        beforeRun: vault ? () => vault.start() : undefined,
        auditPath: path.join(browserDir, "credential-audit.log"),
        // The relay gives up around 20s and every browser action is capped at
        // 15s, so the broker has to fail inside that or the session dies.
        timeoutMs: 12_000,
        person: vaultPerson,
        fleetToken: process.env.DOMO_VAULT_TOKEN,
      });
      this.credentialBroker = credentials;
      this.browserSessions = new BrowserSessions(this.browserHost, credentials, auditFn);
    }
  }

  /**
   * What is in the vault, and what one item holds — metadata only, no page and
   * no browser session involved. Values are never returned here: releasing one
   * only makes sense against the page it is being typed into, which stays in
   * the browser's fill_secret.
   */
  async vaultList(): Promise<JSONValue> {
    if (!this.credentialBroker) return { status: "error", error: "this machine has no vault" };
    const items = await this.credentialBroker.whatsHere();
    this.audit.record("credential_metadata", { op: "list", source: "vault" });
    return {
      status: "completed",
      items: items.map((i) => ({
        id: i.id,
        title: i.title,
        category: i.category,
        username: i.username,
        urls: i.urls,
      })),
    };
  }

  async vaultDescribe(itemId: string): Promise<JSONValue> {
    if (!this.credentialBroker) return { status: "error", error: "this machine has no vault" };
    if (!itemId) return { status: "error", error: "missing item" };
    const item = await this.credentialBroker.describeItem(itemId);
    this.audit.record("credential_metadata", { op: "describe", item: itemId, source: "vault" });
    return { status: "completed", ...item };
  }

  /** Close any live browser session, and the vault if we are running one. */
  async shutdown(): Promise<void> {
    await this.browserSessions?.closeAll("shutdown");
    this.vaultServer?.stop();
  }

  /**
   * One frame for the owner's browser-viewer window. Best-effort and local:
   * null when no browser is running (it is never started for a viewer poll).
   */
  async browserViewFrame(): Promise<ViewerFrame | null> {
    return this.browserHost?.viewFrame() ?? null;
  }

  /**
   * Run one intent: validate, decide (rules → delegate), execute. The single
   * entry point into the Mac's decision path.
   *
   * `onDecided` fires the moment the decision lands, before execution starts.
   * A caller running against a call budget needs it to tell "still waiting on a
   * human" from "approved and now running" — the two are different answers to
   * an agent polling a deferred handle.
   */
  async handleIntent(
    intent: Intent,
    payload: JSONValue = null,
    onDecided?: () => void,
  ): Promise<JSONValue> {
    const failure = this.validate(intent);
    if (failure !== null) {
      this.audit.record("intent_rejected", { intentId: intent.intentId, reason: failure });
      return { status: "rejected", reason: failure };
    }

    this.audit.record("intent_received", {
      intentId: intent.intentId,
      agent: intent.agentId,
      // The name is for a human to read here and in the approval dialog. It is
      // never an identity: Session.name is nullable and not unique, so two
      // credentials can produce the same one. `agent` above is the identity.
      agent_name: intent.agentDisplay,
      request: intent.request,
      goal: intent.goal ?? "",
      capabilities: intent.capabilities.map(capabilityDisplay),
    });

    const grant = await this.policy.decide(intent, this.delegate);
    onDecided?.();
    this.audit.record("intent_decision", {
      intentId: intent.intentId,
      decision: grant.decision,
      source: grant.source,
    });
    if (grant.decision === "deny") {
      // Most denials need no explanation — the owner said no, and why is
      // between them and their Mac. A few are standing conditions the calling
      // agent can actually act on, and those carry a fixed sentence.
      const reason = EXPLAINED_DENIALS[grant.source];
      return reason ? { status: "denied", reason } : { status: "denied" };
    }
    return this.execute(intent, payload);
  }

  private validate(intent: Intent): string | null {
    if (intent.deviceId !== this.identity.deviceId) return "wrong device";
    if (intentIsExpired(intent)) return "expired";
    if (this.seenNonces.has(intent.nonce)) return "replayed nonce";
    this.seenNonces.add(intent.nonce);
    return null;
  }

  // MARK: Execution

  private async execute(intent: Intent, payload: JSONValue): Promise<JSONValue> {
    // Browser/credential intents contain only those kinds; dispatch them first
    // so they can never fall into the exec path.
    if (intent.capabilities.some((c) => c.kind === "browser" || c.kind === "credential")) {
      return this.executeBrowserIntent(intent, payload);
    }
    const exec = intent.capabilities.find((c) => c.kind === "process.exec");
    if (exec) return this.executeCommand(intent, exec, payload);
    const toolCap = intent.capabilities.find((c) => c.kind === "tool");
    if (toolCap) return this.executeTool(intent, toolCap, payload);
    const write = intent.capabilities.find((c) => c.kind === "fs.write");
    if (write) return this.executeWrite(intent, write, payload);
    const read = intent.capabilities.find((c) => c.kind === "fs.read");
    if (read) return this.executeRead(intent, read);
    return { status: "error", error: "no executable capability in intent" };
  }

  private async executeRead(intent: Intent, cap: { paths?: string[] }): Promise<JSONValue> {
    const p = cap.paths?.[0];
    if (p === undefined) return { status: "error", error: "missing path" };
    try {
      const data = await FileOps.read(p, cap.paths ?? []);
      this.audit.record("file_read", {
        intentId: intent.intentId,
        path: p,
        bytes: data.length,
      });
      return {
        status: "completed",
        content_base64: data.toString("base64"),
        bytes: data.length,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.audit.record("denied_operation", { intentId: intent.intentId, path: p, error: message });
      return { status: "error", error: message };
    }
  }

  private async executeWrite(
    intent: Intent,
    cap: { paths?: string[] },
    payload: JSONValue,
  ): Promise<JSONValue> {
    const p = cap.paths?.[0];
    if (p === undefined) return { status: "error", error: "missing path" };
    const contentBase64 = jv(payload).get("content_base64").str;
    if (contentBase64 === null) return { status: "error", error: "missing content" };
    const data = Buffer.from(contentBase64, "base64");
    try {
      await FileOps.write(p, data, cap.paths ?? []);
      this.audit.record("file_write", {
        intentId: intent.intentId,
        path: p,
        bytes: data.length,
      });
      return { status: "completed", bytes: data.length };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.audit.record("denied_operation", { intentId: intent.intentId, path: p, error: message });
      return { status: "error", error: message };
    }
  }

  private async executeCommand(
    intent: Intent,
    exec: { argv?: string[]; cwd?: string },
    payload: JSONValue,
  ): Promise<JSONValue> {
    const readPaths = intent.capabilities.find((c) => c.kind === "fs.read")?.paths ?? [];
    const writePaths = intent.capabilities.find((c) => c.kind === "fs.write")?.paths ?? [];
    const network = intent.capabilities.find((c) => c.kind === "network")?.allowed ?? false;
    // wait_ms is delivery detail, not an approved capability, so it rides in
    // the payload rather than the approved capability set.
    const waitMs = jv(payload).get("wait_ms").int ?? 10000;
    this.audit.record("exec_start", { intentId: intent.intentId, argv: exec.argv ?? [] });
    try {
      const result = await this.executor.run({
        argv: exec.argv ?? [],
        cwd: exec.cwd,
        readPaths,
        writePaths,
        network,
        waitMs,
      });
      if (!result.running) {
        this.audit.record("exec_end", {
          intentId: intent.intentId,
          exit_code: result.exitCode ?? -1,
        });
      }
      const response: { [k: string]: JSONValue } = {
        status: result.running ? "running" : "completed",
        handle: result.handle,
        output: result.output.toString("utf8"),
        output_length: result.outputLength,
      };
      if (result.exitCode !== null) response.exit_code = result.exitCode;
      return response;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.audit.record("exec_error", { intentId: intent.intentId, error: message });
      return { status: "error", error: message };
    }
  }

  private async executeTool(
    intent: Intent,
    toolCap: { tool?: string },
    payload: JSONValue,
  ): Promise<JSONValue> {
    const name = toolCap.tool;
    const tool = name !== undefined ? this.blessedTools.tool(name) : null;
    if (!tool || name === undefined) return { status: "error", error: "unknown tool" };
    try {
      const result = await tool.invoke(jv(payload).get("args").value ?? null);
      this.audit.record("tool_invoked", { intentId: intent.intentId, tool: name });
      return { status: "completed", result };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.audit.record("tool_error", { intentId: intent.intentId, tool: name, error: message });
      return { status: "error", error: message };
    }
  }

  /** Read more output from a still-running (or finished) command. */
  /**
   * A browser/credential intent either opens a session (no `session` in the
   * payload) or widens an existing one (payload carries the handle — delivery
   * detail, like wait_ms; the approved bound is entirely in the capabilities).
   */
  private async executeBrowserIntent(intent: Intent, payload: JSONValue): Promise<JSONValue> {
    if (!this.browserSessions) {
      return { status: "error", error: "no browser runtime installed on this device" };
    }
    const origins = intent.capabilities.find((c) => c.kind === "browser")?.origins ?? [];
    const metadata = intent.capabilities.some(
      (c) => c.kind === "credential" && c.access === "metadata",
    );
    const items =
      intent.capabilities.find((c) => c.kind === "credential" && c.access === "fill")?.items ?? [];

    const session = jv(payload).get("session").str;
    if (session !== null) {
      return this.browserSessions.extend(
        intent.intentId,
        intent.agentId,
        session,
        origins,
        items,
        metadata,
      );
    }
    if (origins.length === 0) {
      return { status: "error", error: "browser_open requires at least one origin" };
    }
    return this.browserSessions.open(intent.intentId, intent.agentId, origins, metadata);
  }

  /**
   * A command inside an already-approved browser session. Rides the session
   * grant — no new intent, no approval — exactly like getOutput binds to an
   * already-approved run. Called in-process by the mcp-server's `browser` tool.
   */
  async browserCommand(agentId: string, session: string, params: JSONValue): Promise<JSONValue> {
    if (!this.browserSessions) {
      return { status: "error", error: "no browser runtime installed on this device" };
    }
    if (jv(params).get("action").str === "close") {
      return this.browserSessions.close(session, "agent");
    }
    return this.browserSessions.command(agentId, session, params);
  }

  getOutput(handle: string, since = 0): JSONValue {
    const result = this.executor.output(handle, since);
    if (!result.running && result.exitCode !== null) {
      this.audit.record("exec_end", { handle, exit_code: result.exitCode });
    }
    const response: { [k: string]: JSONValue } = {
      status: result.running ? "running" : "completed",
      output: result.output.toString("utf8"),
      output_length: result.outputLength,
    };
    if (result.exitCode !== null) response.exit_code = result.exitCode;
    return response;
  }
}

/**
 * The device-side engine: takes an intent built on this Mac, runs it through
 * policy, executes the approved operation, and audits everything. Shared by the
 * Electron app and (later) the relay client's request handler.
 *
 * There is no transport here any more. The broker link — dialing, the
 * enrollment challenge, pairing, reconnect, and the agent-key pinning that went
 * with them — was removed with the broker itself; an Intent is now built
 * in-process from an authenticated agent's call and is never *received* over a
 * wire, so there is no third party's signature to verify and no agent public
 * key to pin. That is provenance, not confinement — DESIGN.md §4 *The intent
 * object* owns where an intent's contents go.
 */
import { capabilityDisplay, Intent, intentIsExpired, JSONValue, jv } from "@domo/protocol";
import os from "node:os";
import path from "node:path";
import { APPROVAL_SOURCE_EXPIRED } from "./approvalStore.js";
import { AuditLog } from "./auditLog.js";
import { BrowserHostConfig, ViewerFrame } from "./browser/browserHost.js";
import { BrowserSessions } from "./browser/browserSessions.js";
import { CredentialBroker } from "./browser/credentialBroker.js";
import { VaultServer } from "./browser/vaultServer.js";
import { VaultClient } from "./browser/vaultClient.js";
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
 * A delegate that denies because the reviewer it was told to use does not
 * exist — this Mac holds no Plow credential. Same channel as
 * `no_credits`, and the same reasoning: a standing condition the caller can
 * act on, so it says so instead of looking like a decision someone made.
 */
export const DENIAL_SOURCE_NO_REVIEWER = "no_reviewer";

/**
 * Denied because the reviewer looked and would not commit — it answered `ask`,
 * in a mode where there is nobody to ask. Distinct from the source below, and
 * the distinction is the whole point: this is a reviewer that ran.
 */
export const DENIAL_SOURCE_REVIEWER_UNDECIDED = "reviewer_undecided";

/**
 * Denied because the reviewer never reached a verdict at all — it timed out,
 * the provider errored or rate-limited, it declined to assess, or the answer
 * did not parse. Not a decision, wearing the same `deny` as one, so it says
 * which it was. It does not say WHY there was no verdict: the reviewer may have
 * been unreachable or may have run and produced nothing usable, and nothing
 * here can tell the two apart, so nothing here claims to.
 */
export const DENIAL_SOURCE_REVIEWER_UNAVAILABLE = "reviewer_unavailable";

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
  // Nobody answered. This used to fall through to the default sentence, so an
  // agent was told "the owner of this Mac denied the request" — byte-identical
  // to a human pressing Deny — and stopped, correctly, on a refusal that never
  // happened. The owner had simply walked away from the dialog. Distinguishing
  // the two is the whole fix: one is a decision, the other is a timeout, and
  // only one of them is worth trying again.
  //
  // RETRY FIRST, and say the old prompt is dead. Expiry settles this call from
  // a timer; it does not close the window, which stays on screen and inert. An
  // earlier version of this sentence said "ask the user to approve it on their
  // Mac, then try again" — following it, the user clicks a dead prompt, nothing
  // runs, and the retry's dialog (queued behind that window) appears as if they
  // had been asked twice. That is the loop, driven by our own copy.
  [DENIAL_SOURCE_REVIEWER_UNDECIDED]:
    "the reviewer would not decide this one, and this Mac is set to let the " +
    "reviewer decide — so there is no one to escalate to and it was denied " +
    "rather than left waiting. Narrow the request and try again",
  [DENIAL_SOURCE_REVIEWER_UNAVAILABLE]:
    "the reviewer produced no usable verdict — it did not answer, or answered " +
    "with something that was not one — and this Mac is set to let the reviewer " +
    "decide, so it was denied rather than left waiting. Trying again may work",
  [DENIAL_SOURCE_NO_REVIEWER]:
    "inference unavailable: Adversarial mode is selected but this Mac has no " +
    "credential for Plow, so the reviewer could not run and the operation was " +
    "denied",
  [APPROVAL_SOURCE_EXPIRED]:
    "no one answered in time, so the request expired and was denied — a timeout, " +
    "not a refusal. Try again to raise a fresh request; any prompt still on the " +
    "user's screen from the first attempt is expired and does nothing",
};

export class DeviceAgent {
  readonly identity: DeviceIdentity;
  readonly audit: AuditLog;
  readonly policy: PolicyEngine;
  readonly executor: Executor;
  /** Owner-published skills (how-to guides), surfaced via plow_list_skills/plow_read_skill. */
  readonly skills: SkillRegistry;
  /** Null when no browser runtime is installed — browser tools report so. */
  readonly browserSessions: BrowserSessions | null = null;
  /** Exposed so the approval UI can resolve credential item titles locally. */
  readonly credentialBroker: CredentialBroker | null = null;
  /** The vault this machine runs, when this build ships one. */
  readonly vaultServer: VaultServer | null = null;
  /** The owner's own way into the vault: no CLI, no port, no session on disk. */
  readonly vaultClient: VaultClient | null = null;
  /** How the sessions build a browser each: one config, many hosts. */
  private readonly browserConfig: BrowserHostConfig | null = null;
  private readonly seenNonces = new Set<string>();

  constructor(
    public readonly home: string,
    name: string,
    private readonly delegate: PolicyDelegate,
    browserRuntime?: ResolvedBrowserRuntime | null,
  ) {
    this.identity = loadOrCreateIdentity(home, name);
    this.audit = new AuditLog(path.join(home, "device/audit.ndjson"));
    this.policy = new PolicyEngine(path.join(home, "device/rules.json"));
    this.executor = new Executor(path.join(home, "device/scratch"));
    this.skills = new SkillRegistry();
    this.skills.loadDir(path.join(home, "device/skills"));
    if (browserRuntime) {
      this.skills.register(BROWSING_SKILL);
      const browserDir = path.join(home, "device/browser");
      const auditFn = (event: string, fields: { [k: string]: JSONValue }) =>
        this.audit.record(event, fields);
      this.browserConfig = {
        command: browserRuntime.serverCommand,
        // Hidden by default: a browser that takes over the screen is the
        // exception, not the shipped behaviour — the test tiers and every
        // unattended run want the background, and the audit log is what says
        // what was done with the owner's credentials. Set DOMO_BROWSER_HEADED=1
        // to get a window back for the whole app. This is only the default —
        // plow_browser_open carries the agent's per-session choice, so the owner
        // can ask to watch (or to hide it) in the moment.
        headed: process.env.DOMO_BROWSER_HEADED === "1",
        env: browserRuntime.env,
        screenshotsDir: path.join(browserDir, "screenshots"),
        // Sessions run in here, each on a clone of the user's own profile
        // below — Firefox locks a profile to one process, so several browsers
        // at once need a directory each — and hand it back when they close.
        profileDir: path.join(browserDir, "profiles"),
        seedProfile: path.join(browserDir, "profile"),
        // When this is set, every session starts and ends owning nothing —
        // which is what reproducing a bot block needs: the verdict a site
        // writes is a cookie,
        // so it rides the profile into every later session and "open a fresh
        // session and try once" replays the block instead of testing it. A
        // single session can decide the same thing for itself mid-flight —
        // plow_browser's fresh_profile — which is the only moment a block is
        // actually detectable.
        freshProfile: process.env.DOMO_BROWSER_FRESH_PROFILE === "1",
        mergeCookiesCommand: browserRuntime.mergeCookiesCommand,
        camoufoxInstallDir: browserRuntime.camoufoxInstallDir,
        isolatedHome: path.join(browserDir, "pyhome"),
        // Every `browser` action is non-deferrable and must answer inside the
        // relay's per-exchange ceiling; cap the per-action wait below it so
        // a hung page/eval returns an error in time instead of a torn 504. The
        // cold start is separate (startTimeoutMs) and paid by the deferrable
        // plow_browser_open, so it does not need to fit this bound.
        actionTimeoutMs: 15_000,
        audit: auditFn,
      };
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
      // What the Vault tab talks to. The broker below stays for the AGENT,
      // where a release is bound to the page on screen; this is the owner's.
      this.vaultClient = vault
        ? new VaultClient(vault, path.join(browserDir, "credential-audit.log"))
        : null;
      // Up with the app, not on first use: the Vault tab has to be able to show
      // the owner their own items whenever Domo is running, not only after an
      // agent happens to ask for a credential.
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
        // Innermost of three nested deadlines: the broker fails inside the
        // per-action cap, which sits inside the relay's own ceiling. It has to
        // give up first or the session dies with it.
        timeoutMs: 12_000,
        person: vaultPerson,
        fleetToken: process.env.DOMO_VAULT_TOKEN,
      });
      this.credentialBroker = credentials;
      this.browserSessions = new BrowserSessions(this.browserConfig, credentials, auditFn);
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
    // The vault runs as a detached child, so it outlives us unless we stop it:
    // a browser cleanup that throws must not be what leaves it running after
    // the app is gone. The failure still reaches the caller.
    try {
      await this.browserSessions?.closeAll("shutdown");
    } finally {
      this.vaultServer?.stop();
    }
  }

  /**
   * One frame for the owner's browser-viewer window. Best-effort and local:
   * null when no browser is running (it is never started for a viewer poll).
   */
  async browserViewFrame(): Promise<ViewerFrame | null> {
    return this.browserSessions?.viewFrame() ?? null;
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
      } else {
        // A deferred run's end is recorded when it actually ends, keyed to the
        // intent — never from the polling path, which may run many times or
        // not at all.
        this.executor.onExit(result.handle, (exitCode) => {
          // Fires from the child's exit event, possibly mid-shutdown; a failed
          // append must not become an uncaught exception in the event loop.
          try {
            this.audit.record("exec_end", {
              intentId: intent.intentId,
              handle: result.handle,
              exit_code: exitCode,
            });
          } catch (error) {
            // Nowhere durable left to write it — the durable sink is what
            // failed — but the loss should at least be visible in a terminal.
            console.error(`[audit] exec_end lost for handle ${result.handle}:`, error);
          }
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
    const items =
      intent.capabilities.find((c) => c.kind === "credential" && c.access === "fill")?.items ?? [];

    const session = jv(payload).get("session").str;
    if (session !== null) {
      return this.browserSessions.extend(intent.intentId, session, origins, items);
    }
    if (origins.length === 0) {
      return { status: "error", error: "plow_browser_open requires at least one origin" };
    }
    // Window mode is delivery detail too: it changes nothing about what the
    // owner approved, so it rides the payload and leaves the capability set —
    // and the rule the owner may have saved for these origins — untouched.
    const headed = jv(payload).get("headed").bool;
    return this.browserSessions.open(
      intent.intentId,
      intent.agentId,
      origins,
      headed ?? undefined,
    );
  }

  /**
   * A command inside an already-approved browser session. Rides the session
   * grant — no new intent, no approval — exactly like getOutput binds to an
   * already-approved run. Called in-process by the mcp-server's `browser` tool.
   */
  async browserCommand(session: string, params: JSONValue): Promise<JSONValue> {
    if (!this.browserSessions) {
      return { status: "error", error: "no browser runtime installed on this device" };
    }
    const action = jv(params).get("action").str;
    if (action === "close") {
      return this.browserSessions.close(session, "agent");
    }
    // Both of these are the session's own lifecycle rather than something the
    // page does, so neither reaches the browser server.
    if (action === "fresh_profile") {
      return this.browserSessions.freshProfile(session);
    }
    return this.browserSessions.command(session, params);
  }

  getOutput(handle: string, since = 0): JSONValue {
    const result = this.executor.output(handle, since);
    const response: { [k: string]: JSONValue } = {
      status: result.running ? "running" : "completed",
      output: result.output.toString("utf8"),
      output_length: result.outputLength,
    };
    if (result.exitCode !== null) response.exit_code = result.exitCode;
    return response;
  }
}

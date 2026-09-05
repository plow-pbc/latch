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
import { PROVIDERS, vendoredProvider, type VendoredProvider } from "./providers/registry.js";
import { MintError, type MintedAccounts, type Minter } from "./providers/mint.js";
import { gogExitReason, mergeFanout, planPlowGog } from "./providers/plowGog.js";
import fs from "node:fs";
import path from "node:path";
import { APPROVAL_SOURCE_EXPIRED } from "./approvalStore.js";
import { AuditLog } from "./auditLog.js";
import { BrowserHostConfig, ViewerFrame } from "./browser/browserHost.js";
import { BrowserSessions } from "./browser/browserSessions.js";
import { CredentialBroker } from "./browser/credentialBroker.js";
import { PaymentApprovalClient } from "./browser/financialGate.js";
import { BrokerCore } from "./browser/brokerCore.js";
import { LocalVault } from "./browser/localVault.js";
import { VaultKeyStore } from "./browser/vaultKeyStore.js";
import { VaultStore } from "./browser/vaultStore.js";
import { ResolvedBrowserRuntime } from "./browser/browserRuntime.js";
import { BROWSING_SKILL } from "./browser/browsingSkill.js";
import { ExecResult, Executor, REAPED_MESSAGE } from "./executor.js";
import { FileOps, FileOpsError } from "./fileOps.js";
import {
  appleEventTarget,
  collectFacts,
  BlockedCause,
  diagnose,
  Diagnosis,
  diagnosisPayload,
  guardedPrefix,
  HostFacts,
  hostInventory,
  HostInventory,
  HostProbes,
  isHostGate,
  nodeProbes,
  parseNodeError,
  stderrHint,
} from "./hostGate/index.js";
import { readCredentialsState } from "./browser/vaultCredentials.js";
import { DeviceIdentity, loadOrCreateIdentity } from "./identity.js";
import { PolicyDelegate, PolicyEngine } from "./policyEngine.js";
import { SkillRegistry } from "./skills.js";
import { registerContactsSkill } from "./contactsSkill.js";
import { registerImessageSkill } from "./imessageSkill.js";
import { ensurePlowFolder, registerPlowFolderSkill } from "./plowFolder.js";
import { registerWhatsappSkill } from "./whatsappSkill.js";

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

/**
 * How long an in-process file operation on a TCC-guarded path may take before
 * its silence is read as a consent dialog holding it.
 *
 * macOS does not refuse an unconsented open of the Desktop, Documents or
 * Downloads folder — it parks the call until someone at the Mac answers a
 * dialog, and this app's owner is routinely not at the Mac. An `fs.readFile`
 * parked that way would leave the agent's call pending until the handle
 * expired, with nothing anywhere saying why. Five seconds is far longer than a
 * capped (8MB) read takes and far shorter than any human answering a dialog.
 * Only guarded paths are raced: everything else fails or finishes on its own.
 */
const FILE_OP_HANG_MS = 5_000;

/** Thrown when the race above is lost: the operation is still parked. */
class FileOpHang extends Error {
  constructor() {
    super("the operation is waiting on a macOS permission dialog on this Mac's screen");
    this.name = "FileOpHang";
  }
}

/** `p` when it exists, else its nearest existing ancestor: the folder a
 *  creating write would touch, and where its consent dialog belongs. */
function existingAncestor(p: string): string {
  let target = p;
  while (!fs.existsSync(target)) {
    const parent = path.dirname(target);
    if (parent === target) return target;
    target = parent;
  }
  return target;
}

/** A run's diagnosis, kept by handle so a later poll carries it too. */
interface DiagnosedRun {
  diagnosis: Diagnosis;
  facts: HostFacts;
}

/** What a run's argv and capabilities give a diagnosis to work with. */
interface ExecDiagnosisContext {
  argv: readonly string[];
  cwd: string | undefined;
  readPaths: readonly string[];
  writePaths: readonly string[];
  appleEvents: boolean;
}

/**
 * One shape for a run, whether it is answering the call that started it or a
 * later `plow_get_output` poll. Written once because the two used to be
 * written twice and had already drifted: only the polling path told the agent
 * a run had been killed.
 *
 * A reaped run ends with no output and a signal exit — indistinguishable,
 * without `error`, from a command that genuinely produced nothing. The agent
 * holding the job is the one who has to tell the user, so it is told here.
 *
 * A run this Mac diagnosed carries the verdict and the facts (hostGate/). A
 * finished run whose cause is a gate is `blocked` rather than `completed`; a
 * run still going stays `running` with the diagnosis beside it, because a
 * consent dialog the owner answers lets it finish — killing it would only
 * make the owner's click pointless.
 */
function runPayload(result: ExecResult, diagnosed: DiagnosedRun | null): { [k: string]: JSONValue } {
  const payload: { [k: string]: JSONValue } = {
    status: result.running ? "running" : "completed",
    output: result.output.toString("utf8"),
    output_length: result.outputLength,
  };
  if (result.exitCode !== null) payload.exit_code = result.exitCode;
  if (result.reaped) payload.error = REAPED_MESSAGE;
  if (diagnosed) {
    Object.assign(payload, diagnosisPayload(diagnosed.diagnosis, diagnosed.facts));
    if (!result.running && isHostGate(diagnosed.diagnosis.cause)) payload.status = "blocked";
  }
  return payload;
}

/** The diagnosis as the audit log carries it — the verdict, its evidence and
 *  every probe's answer, so a wrong verdict can be traced to its branch. */
function auditDiagnosis(d: DiagnosedRun): { [k: string]: JSONValue } {
  return {
    cause: d.diagnosis.cause,
    confidence: d.diagnosis.confidence,
    permission: d.diagnosis.permission,
    evidence: d.diagnosis.evidence,
    ruled_out: d.diagnosis.ruled_out,
    owner_action: d.diagnosis.owner_action,
    probes: d.facts as unknown as JSONValue,
  };
}

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
  /** Where the vault keeps its items (used to report state; the data path). */
  readonly vaultDir: string | null = null;
  /** The owner's own way into the vault — what the Vault tab talks to. */
  readonly vaultClient: LocalVault | null = null;
  /** How the sessions build a browser each: one config, many hosts. */
  private readonly browserConfig: BrowserHostConfig | null = null;
  private readonly seenNonces = new Set<string>();
  /** The owner's real home — what the guarded-path table is keyed on. */
  private readonly ownerHome: string;
  /** How a failure is investigated (hostGate/probes.ts). Real by default;
   *  a test scripts the answers. */
  readonly hostProbes: HostProbes;
  /** Diagnoses by run handle, so a `plow_get_output` poll carries the one
   *  the run's end produced. */
  private readonly runDiagnoses = new Map<string, DiagnosedRun>();
  /** A diagnosis the run's exit started and has not finished: a poll that
   *  lands in between waits for it, or the agent would take "completed,
   *  exit 1" as the whole story and stop asking. */
  private readonly pendingDiagnoses = new Map<string, Promise<void>>();
  /** Runs recorded as blocked, with the cause on record: one that was found
   *  parked while running and then reaped is one story, not two audit rows —
   *  but a DIFFERENT cause at the end (the owner clicked Don't Allow, and a
   *  refusal replaced the parked guess) is a correction, recorded under the
   *  same handle so the owner's views take the newest. */
  private readonly blockedRuns = new Map<string, BlockedCause>();
  /** `FILE_OP_HANG_MS`, overridable by a test that cannot wait it out. */
  fileOpHangMs = FILE_OP_HANG_MS;

  constructor(
    public readonly home: string,
    name: string,
    private readonly delegate: PolicyDelegate,
    browserRuntime?: ResolvedBrowserRuntime | null,
    /**
     * The owner's real home — where their apps put their data, which is NOT
     * `home` (a DOMO_HOME a test points at a throwaway root). Defaults to
     * `home` rather than `os.homedir()` so nothing in here reads ambient OS
     * state: the desktop app is the only caller that knows the real one, and
     * it passes it. A test or a non-desktop caller gets its own isolated root
     * and a manifest that does not depend on the machine running the suite.
     */
    ownerHome: string = home,
    /**
     * How a vendored provider CLI is authorised. Null in a test that does not
     * exercise one, and on a Mac that has never paired — the exec path reports
     * that rather than throwing, so an unpaired Mac gets a sentence in the
     * approval dialog instead of a stack trace.
     */
    private readonly minter: Minter | null = null,
    /**
     * Directories holding vendored provider CLIs, prepended to an exec child's
     * PATH so a bare `gog` reaches the binary this app ships. Empty in a test
     * and on a Mac with none staged, where every non-provider command still
     * runs and a provider one reports that it is not installed.
     */
    private readonly vendorDirs: readonly string[] = [],
    /** Consulted before releasing a credential into a bank destination. `null`
     * (the default) fails closed — every financial release is blocked. The app
     * injects the real plow-consume client so production can obtain approvals. */
    approval: PaymentApprovalClient | null = null,
    /**
     * How a refused operation is investigated (hostGate/). Null builds the
     * real probes over `ownerHome`; the app passes its own so the Automation
     * helper it ships is found, and a test passes scripted answers.
     */
    hostProbes: HostProbes | null = null,
  ) {
    this.identity = loadOrCreateIdentity(home, name);
    this.ownerHome = ownerHome;
    this.hostProbes = hostProbes ?? nodeProbes({ ownerHome });
    this.audit = new AuditLog(path.join(home, "device/audit.ndjson"));
    this.policy = new PolicyEngine(path.join(home, "device/rules.json"));
    this.executor = new Executor(path.join(home, "device/scratch"), undefined, this.vendorDirs);
    this.skills = new SkillRegistry();
    // `ownerHome`, not `home` — this describes where WhatsApp put the owner's
    // messages on the real machine, while `home` is a DOMO_HOME a test points
    // at a throwaway root. It is a parameter rather than an `os.homedir()` read
    // in here so construction stays hermetic: otherwise a DeviceAgent built in
    // a test publishes a different manifest depending on whether the developer
    // happens to have WhatsApp installed. Presence is sampled ONCE, here — the
    // same start-time answer `browserRuntime` gives, so installing WhatsApp
    // while the app is running needs a restart to publish the skill.
    registerWhatsappSkill(this.skills, ownerHome);
    registerImessageSkill(this.skills, ownerHome);
    // The playground exists before any agent asks about it, and the skill can
    // therefore name a folder that is really there. `ownerHome` for the same
    // reason as WhatsApp above: the folder belongs to the owner's real home,
    // and a test's throwaway ownerHome keeps the suite off the developer's.
    ensurePlowFolder(ownerHome);
    registerPlowFolderSkill(this.skills, ownerHome);
    registerContactsSkill(this.skills, ownerHome);
    // Registered only when the CLI it documents is actually staged: a skill
    // for a binary this Mac does not have teaches an agent commands the exec
    // path refuses unconditionally. The SAME predicate that gate uses — two
    // sites answering one question two ways is what produces that gap — and
    // driven off the registry, so a provider's name has one spelling.
    for (const p of PROVIDERS) if (this.hasStaged(p.binary)) this.skills.register(p.skill);
    if (browserRuntime) {
      this.skills.register(BROWSING_SKILL);
      const browserDir = path.join(home, "device/browser");
      // Earlier builds wrote every agent screenshot under here and never
      // removed one. Nothing reads them, so an install that still has the
      // directory loses it on the next start.
      fs.rmSync(path.join(browserDir, "screenshots"), { recursive: true, force: true });
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
        // The frozen-fingerprint pin lives at a stable per-install path, so the
        // browser presents the SAME macOS fingerprint every launch (a persistent
        // browser carrying the owner's real logins wants one stable device, not a
        // new one each session — DESIGN.md §11a). `@domo/browser-server` records
        // its pick here on first launch and reuses it after; the whole Mac is one
        // person's, so every session shares it.
        env: { ...browserRuntime.env, DOMO_FINGERPRINT_PIN: path.join(browserDir, "fingerprint-pin.json") },
        // Sessions run in here, each on a clone of the user's own profile
        // below — Firefox locks a profile to one process, so several browsers
        // at once need a directory each — and hand it back when they close.
        profileDir: path.join(browserDir, "profiles"),
        seedProfile: path.join(browserDir, "profile"),
        mergeCookiesCommand: browserRuntime.mergeCookiesCommand,
        executablePath: browserRuntime.executablePath,
        // Every `browser` action is non-deferrable and must answer inside the
        // relay's per-exchange ceiling; cap the per-action wait below it so
        // a hung page/eval returns an error in time instead of a torn 504. The
        // cold start is separate (startTimeoutMs) and paid by the deferrable
        // plow_browser_open, so it does not need to fit this bound.
        actionTimeoutMs: 15_000,
        audit: auditFn,
      };
      // The vault: items in an encrypted local file, master key in the
      // Keychain (vaultKeyStore.ts). Same directory the old server kept its
      // data in, which is what lets migration find a legacy vault beside the
      // new store.
      const vaultDir = path.join(browserDir, "vault");
      this.vaultDir = vaultDir;
      const keyStore = new VaultKeyStore(vaultDir);
      const auditPath = path.join(browserDir, "credential-audit.log");
      // What the Vault tab talks to. The broker below is for the AGENT, where
      // a release is bound to the page on screen; this is the owner's.
      this.vaultClient = new LocalVault(vaultDir, keyStore, auditPath);
      // The broker: in-process against the same store — no server, no CLI, no
      // subprocess, and the master key never leaves this process. A command in
      // the resolved runtime is the test seam (DOMO_VAULT_BROKER_CMD) and wins,
      // so the fill path can still be driven against a scripted fake.
      const credentials = new CredentialBroker(
        browserRuntime.credentialBrokerCommand
          ? {
              command: browserRuntime.credentialBrokerCommand,
              env: browserRuntime.env,
              auditPath,
              // Innermost of three nested deadlines: the broker fails inside
              // the per-action cap, which sits inside the relay's own ceiling.
              // It has to give up first or the session dies with it.
              timeoutMs: 12_000,
            }
          : {
              local: new BrokerCore({ dir: vaultDir, store: new VaultStore(vaultDir), keyStore, auditPath }),
            },
      );
      this.credentialBroker = credentials;
      this.browserSessions = new BrowserSessions(
        this.browserConfig,
        credentials,
        auditFn,
        undefined,
        approval,
      );
    }
    // LAST, so the owner's own file wins. `register` is a Map.set, so whoever
    // goes last takes the name — and a skill the owner wrote into their own
    // DOMO_HOME is a deliberate act that a built-in default should not
    // silently discard. Built-ins are what this Mac ships; these are what its
    // owner said instead.
    this.skills.loadDir(path.join(home, "device/skills"));
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

  /**
   * What this Mac lets the app do right now (hostGate/inventory.ts): the
   * permissions and self-checks, one fresh snapshot. The Settings pane and
   * the `plow_device_status` tool both read this, so they cannot disagree.
   *
   * The sandbox rows go through the REAL executor with a throwaway profile:
   * a read-only run, no network, no writes, so it is also reapable — and
   * `/usr/bin/true` exits at once regardless.
   */
  async hostInventory(): Promise<HostInventory> {
    const vaultDir = this.vaultDir;
    return hostInventory({
      probes: this.hostProbes,
      ownerHome: this.ownerHome,
      runSandboxed:
        process.platform === "darwin"
          ? async (argv) => {
              const result = await this.executor.run({
                argv,
                readPaths: [],
                writePaths: [],
                network: false,
                appleEvents: false,
                waitMs: 5_000,
              });
              return { exitCode: result.exitCode, output: result.output.toString("utf8") };
            }
          : null,
      vaultKey: vaultDir === null ? null : () => readCredentialsState(vaultDir),
    });
  }

  /** Close any live browser session. The vault needs no stopping any more —
   * it is a file and a Keychain item, not a process. */
  async shutdown(): Promise<void> {
    await this.browserSessions?.closeAll("shutdown");
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
    // After the append, never before: the delegate's own record of the
    // question is what survives a crash between the answer and this line.
    await this.delegate.decisionRecorded?.(intent.intentId);
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
      const data = await this.guardedFileOp(p, () => FileOps.read(p, cap.paths ?? []));
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
      return this.fileOpFailed(intent.intentId, "read", p, error);
    }
  }

  /**
   * Run a file operation on a TCC-guarded path without ever letting the
   * operation itself park on a consent dialog.
   *
   * What parks is a read-only touch of the path (or, for a file not there
   * yet, of its nearest existing ancestor) — and the touch is the probe
   * battery's own `openAsApp`: a CHILD process, killed on its timer. Not an
   * open on this process's file-I/O pool, which has four threads; four
   * parked opens would stall every read and write in the app, the audit
   * log's among them, until somebody at the Mac clicked. TCC attributes
   * the child to the app, so the dialog it raises is the app's, and the
   * consent it meets is the operation's.
   *
   * Past `FILE_OP_HANG_MS` (or on the probe's own "hung") the touch is
   * reported as parked (`FileOpHang`) and the operation is NOT attempted —
   * a write let through by an Allow clicked minutes later would land on a
   * file the owner or another call may have changed since, over a result
   * that was already `blocked`. Only a touch that returns in time is
   * followed by the operation, which then meets the consent, or the
   * refusal, that the touch met. The touch's own errno is ignored: the
   * operation produces the real one.
   */
  private async guardedFileOp<T>(p: string, op: () => Promise<T>): Promise<T> {
    if (guardedPrefix(p, this.ownerHome) === null) return op();
    const touch = this.hostProbes.openAsApp(existingAncestor(p));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hang = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new FileOpHang()), this.fileOpHangMs);
      timer.unref?.();
    });
    try {
      if ((await Promise.race([touch, hang])) === "hung") throw new FileOpHang();
    } finally {
      clearTimeout(timer);
      // A probe the timer beat is the child's to finish or be killed.
      touch.catch(() => {});
    }
    return op();
  }

  /**
   * A file operation that did not happen: say why, as well as this Mac can
   * tell (hostGate/diagnose.ts).
   *
   * Only a failure the kernel answered is investigated — one with an errno in
   * it, or one that never returned. A path outside the approved scope is the
   * policy speaking, not the host, and a size-limit refusal is this app's own
   * rule; both already say exactly what they mean.
   */
  private async fileOpFailed(
    intentId: string,
    op: "read" | "write",
    p: string,
    error: unknown,
  ): Promise<JSONValue> {
    const message = error instanceof Error ? error.message : String(error);
    const hung = error instanceof FileOpHang;
    const outOfBounds = error instanceof FileOpsError && error.outOfBounds;
    if (!hung && (outOfBounds || parseNodeError(message).errno === null)) {
      // `cause` is what tells the audit view the bound from this app's own
      // rules (the size limit, "not a file"): the one refusal is the
      // policy's, the others are nobody's, and the row must not send the
      // owner looking for a path they never approved.
      this.audit.record("denied_operation", {
        intentId,
        path: p,
        error: message,
        cause: outOfBounds ? "outside_approved_bound" : "app_rule",
      });
      return { status: "error", error: message };
    }
    const facts = await collectFacts(
      { op, paths: [p], errorMessage: hung ? null : message, ranSandboxed: false, hung },
      this.hostProbes,
      this.ownerHome,
    );
    const diagnosed: DiagnosedRun = { diagnosis: diagnose(facts), facts };
    const blocked = isHostGate(diagnosed.diagnosis.cause);
    if (blocked) {
      this.audit.record("host_permission_blocked", { intentId, path: p, ...auditDiagnosis(diagnosed) });
    } else {
      this.audit.record("denied_operation", {
        intentId,
        path: p,
        error: message,
        cause: diagnosed.diagnosis.cause,
      });
    }
    return {
      status: blocked ? "blocked" : "error",
      error: message,
      ...diagnosisPayload(diagnosed.diagnosis, diagnosed.facts),
    };
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
      await this.guardedFileOp(p, () => FileOps.write(p, data, cap.paths ?? []));
      this.audit.record("file_write", {
        intentId: intent.intentId,
        path: p,
        bytes: data.length,
      });
      return { status: "completed", bytes: data.length };
    } catch (error: unknown) {
      return this.fileOpFailed(intent.intentId, "write", p, error);
    }
  }

  /**
   * Whether this Mac actually ships the named CLI.
   *
   * Per-provider rather than "is anything staged": the day a second row joins
   * the registry, a Mac with only gog staged would otherwise report the other
   * as present — publishing its skill and minting for it.
   */
  private hasStaged(command: string): boolean {
    return this.vendorDirs.some((d) => fs.existsSync(path.join(d, command)));
  }

  /** Every connected account's token, for the provider's fan-out. */
  private async mintAllFor(provider: VendoredProvider): Promise<MintedAccounts> {
    if (this.minter === null) throw MintError.unpaired();
    return this.minter.mintAll(provider);
  }

  private async executeCommand(
    intent: Intent,
    exec: { argv?: string[]; cwd?: string },
    payload: JSONValue,
  ): Promise<JSONValue> {
    const readPaths = intent.capabilities.find((c) => c.kind === "fs.read")?.paths ?? [];
    const writePaths = intent.capabilities.find((c) => c.kind === "fs.write")?.paths ?? [];
    const network = intent.capabilities.find((c) => c.kind === "network")?.allowed ?? false;
    const appleEvents =
      intent.capabilities.find((c) => c.kind === "apple_events")?.allowed ?? false;
    // wait_ms is delivery detail, not an approved capability, so it rides in
    // the payload rather than the approved capability set.
    const waitMs = jv(payload).get("wait_ms").int ?? 10000;
    const argv = exec.argv ?? [];

    // A vendored provider CLI gets its tokens minted into its children's
    // environment and is orchestrated per account. Everything else is the
    // ordinary exec path — the capability the owner approved is the argv, the
    // sandbox profile and the audit are unchanged, and `tools/list` never
    // grew a tool for it.
    const provider = vendoredProvider(argv);
    if (provider !== null) {
      // The device is the chokepoint and cannot rely on its caller having
      // checked. The tool checks too, so a refusal never reaches an approval
      // dialog — but an intent can arrive from a replayed or hand-built
      // request that never passed through it.
      const refusal = provider.refuse(argv);
      if (refusal !== null) return this.execError(intent.intentId, refusal);
      const approvedReads = new Set(readPaths);
      const approvedWrites = new Set(writePaths);
      for (const fileArg of provider.fileArgs(argv)) {
        for (const providerPath of fileArg.paths) {
          const approved = fileArg.access === "read" ? approvedReads : approvedWrites;
          if (!approved.has(providerPath)) {
            return this.execError(
              intent.intentId,
              "provider file arguments require matching approved file capabilities",
            );
          }
        }
      }
      // A provider NAME with no staged binary is refused, never let through.
      // Falling through would run whatever `gog` the owner happens to have on
      // their own PATH — unbelted, unrefused, and against their own
      // credentials rather than a minted one. The name is this Mac's to
      // resolve; if it cannot, that is an answer, not a pass.
      if (!this.hasStaged(provider.binary)) {
        return this.execError(intent.intentId, `${provider.command} is not installed on this Mac`);
      }
      return this.executePlowGog(intent, provider, argv, { readPaths, writePaths, network, appleEvents, waitMs });
    }

    this.audit.record("exec_start", { intentId: intent.intentId, argv });
    try {
      const result = await this.executor.run({
        argv,
        cwd: exec.cwd,
        readPaths,
        writePaths,
        network,
        appleEvents,
        waitMs,
      });
      return this.finishRun(intent.intentId, result, { argv, cwd: exec.cwd, readPaths, writePaths, appleEvents });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return this.execError(intent.intentId, message);
    }
  }

  /** Record an operation that errored before (or instead of) a run, and
   * shape the answer. Every `error` here is already display-safe by the
   * rules at its call site — a fixed sentence, a refusal, or a MintError. */
  private execError(intentId: string, error: string): JSONValue {
    this.audit.record("exec_error", { intentId, error });
    return { status: "error", error };
  }

  /**
   * Record a run's `exec_end` — now, or on exit for a deferred run — and
   * shape its payload. One spelling for the single-spawn path and the
   * orchestrated plow-gog runs that answer with a child's output.
   *
   * With `diag` (the plain exec path — a provider run's failures are
   * account-level and travel in its own envelope), a run that ended badly
   * or is sitting silent is investigated (`diagnoseRun`), now for a run that
   * has already ended and again at exit for one that has not.
   */
  private async finishRun(
    intentId: string,
    result: ExecResult,
    diag: ExecDiagnosisContext | null = null,
  ): Promise<JSONValue> {
    let diagnosed: DiagnosedRun | null = null;
    if (!result.running) {
      this.audit.record("exec_end", {
        intentId,
        exit_code: result.exitCode ?? -1,
        ...(result.reaped ? { reaped: true } : {}),
      });
      if (diag && result.exitCode !== 0) diagnosed = await this.diagnoseRun(intentId, result, diag);
    } else {
      // A deferred run's end is recorded when it actually ends, keyed to the
      // intent — never from the polling path, which may run many times or
      // not at all.
      this.executor.onExit(result.handle, (exitCode, reaped) => {
        // Fires from the child's exit event, possibly mid-shutdown; a failed
        // append must not become an uncaught exception in the event loop.
        try {
          this.audit.record("exec_end", {
            intentId,
            handle: result.handle,
            exit_code: exitCode,
            // A run this Mac killed is not a command that failed, and the
            // log is where that difference has to survive: the unpaired
            // exec_start was the only tell this failure ever had.
            ...(reaped ? { reaped: true } : {}),
          });
        } catch (error) {
          // Nowhere durable left to write it — the durable sink is what
          // failed — but the loss should at least be visible in a terminal.
          console.error(`[audit] exec_end lost for handle ${result.handle}:`, error);
        }
        // The end of a run that was answered `running` is where a killed or
        // failed run gets its diagnosis; the next poll carries it, and a poll
        // that arrives first waits (`pendingDiagnoses`). Nothing here awaits
        // it — the exit event is not a call — so it may not throw.
        // Whatever was said about the run while it ran — "parked on a
        // dialog" — was provisional, and the exit is the fact: the owner
        // answered (or the dialog never mattered) and the run went on to
        // its own end. Cleared first, whatever that end was; a poll must
        // not call a finished command blocked on a dialog that is gone. A
        // bad end is then diagnosed on its own terms, and only a gate is
        // stored back.
        //
        // The clearing is recorded too, when the parked verdict was: a
        // run that went on to an end of its own was let through the
        // dialog, and the Capabilities tab must stop counting a block the
        // owner has answered — a folder it cannot query would otherwise
        // stay red on the strength of a guess. A reaped run was still
        // parked, and its verdict stands.
        const provisional = this.runDiagnoses.get(result.handle);
        this.runDiagnoses.delete(result.handle);
        if (!reaped && this.blockedRuns.get(result.handle) === "prompt_waiting") {
          this.blockedRuns.delete(result.handle);
          try {
            this.audit.record("host_permission_cleared", {
              intentId,
              handle: result.handle,
              path: provisional?.facts.path ?? null,
              permission: provisional?.diagnosis.permission ?? null,
            });
          } catch (error) {
            console.error(`[audit] host_permission_cleared lost for handle ${result.handle}:`, error);
          }
        }
        if (diag && (reaped || exitCode !== 0)) {
          const pending = this.diagnoseRun(intentId, this.executor.output(result.handle, 0), diag)
            .then(() => {})
            .catch((error) => {
              console.error(`[hostGate] diagnosis lost for handle ${result.handle}:`, error);
            })
            .finally(() => this.pendingDiagnoses.delete(result.handle));
          this.pendingDiagnoses.set(result.handle, pending);
        }
      });
      // A run still going with nothing said yet may be parked on a consent
      // dialog. Asked now, inside the call, so the agent hears it in seconds
      // rather than at the reaper's fifteen minutes.
      if (diag && result.outputLength === 0) {
        diagnosed = await this.diagnoseRun(intentId, result, diag);
        // The probes took time; answer with where the run is now, not where
        // it was before they ran — and if it ended meanwhile, with the
        // verdict its end produced, waited for like a poll would.
        result = this.executor.output(result.handle, 0);
        if (!result.running) {
          await this.pendingDiagnoses.get(result.handle);
          diagnosed = this.runDiagnoses.get(result.handle) ?? null;
        }
      }
    }
    return { ...runPayload(result, diagnosed), handle: result.handle };
  }

  /**
   * Investigate a run that ended badly, was killed, or is sitting silent.
   *
   * Investigated only when something says a gate might be the reason: the
   * output carries a refusal this Mac knows how to follow up, the run was
   * reaped, or it is still running and has said nothing. An ordinary non-zero
   * exit (grep found nothing) is the command's own business and gets no
   * probes. The verdict is kept only when it is worth carrying — a gate, a
   * killed run's facts, or a running run that is confirmed parked; a silent
   * run that is simply running is left alone.
   */
  private async diagnoseRun(
    intentId: string,
    result: ExecResult,
    diag: ExecDiagnosisContext,
  ): Promise<DiagnosedRun | null> {
    const output = result.output.toString("utf8");
    if (!result.reaped && !result.running && stderrHint(output) === null) return null;
    const facts = await collectFacts(
      {
        op: "exec",
        paths: [...diag.readPaths, ...diag.writePaths],
        cwd: diag.cwd ?? null,
        argv: diag.argv,
        stderr: output,
        ranSandboxed: true,
        sandbox: (p) => this.executor.grants(result.handle, p),
        hung: result.reaped,
        automationTarget: diag.appleEvents ? appleEventTarget(diag.argv) : null,
      },
      this.hostProbes,
      this.ownerHome,
    );
    const diagnosis = diagnose(facts);
    if (result.running && diagnosis.cause !== "prompt_waiting") return null;
    // The probes took time; the run may have ended meanwhile, and then this
    // provisional verdict is about a run that no longer exists. A clean
    // exit says the dialog was answered (or never mattered); a bad one has
    // the exit's own diagnosis, pending or stored, which knows more than a
    // "parked" guess and must not be overwritten by it. Either way the
    // ended run's verdict is the exit path's, not this one's.
    if (result.running && !this.executor.output(result.handle, 0).running) return null;
    if (!result.running && !result.reaped && !isHostGate(diagnosis.cause)) return null;
    const diagnosed: DiagnosedRun = { diagnosis, facts };
    this.runDiagnoses.set(result.handle, diagnosed);
    if (isHostGate(diagnosis.cause) && this.blockedRuns.get(result.handle) !== diagnosis.cause) {
      this.blockedRuns.set(result.handle, diagnosis.cause);
      this.audit.record("host_permission_blocked", {
        intentId,
        handle: result.handle,
        path: facts.path,
        ...auditDiagnosis(diagnosed),
      });
    }
    return diagnosed;
  }

  /**
   * The plow-gog orchestration: one approved argv, N runs of the vendored gog
   * — one per connected Google account. The plan is pure (`plowGog.ts`); what
   * happens here is everything with a side effect: the batch mint, account
   * resolution, the conflict precheck, the runs, and the audit.
   *
   * Audit shape: ONE `exec_start`/`exec_end` pair on the argv the owner
   * approved — the per-account runs are implementation, and their failures
   * travel inside the returned envelope (`degraded`), not as audit rows.
   * Every error string below is composed here from mint-derived account
   * emails and fixed sentences; caller argv text never reaches one (the
   * gogFlags rule).
   */
  private async executePlowGog(
    intent: Intent,
    provider: VendoredProvider,
    argv: string[],
    opts: { readPaths: string[]; writePaths: string[]; network: boolean; appleEvents: boolean; waitMs: number },
  ): Promise<JSONValue> {
    const plan = planPlowGog(argv);
    // `refuse` already rejected these before the dialog; a hand-built intent
    // reaches the same answer.
    if (plan.kind === "refused") return this.execError(intent.intentId, plan.reason);
    const runGog = (tail: readonly string[], token: string | null) =>
      this.executor.run({
        argv: [provider.binary, ...provider.belt, ...tail],
        readPaths: opts.readPaths,
        writePaths: opts.writePaths,
        network: opts.network,
        appleEvents: opts.appleEvents,
        waitMs: opts.waitMs,
        // A help run gets no token, same as the gog path.
        env: token === null ? undefined : { [provider.tokenEnv]: token },
      });
    // An inner run that outlives wait_ms is WAITED OUT, not abandoned: the
    // per-account children have no public handle — the outer call owns the
    // only one — so a result left running here would be unretrievable, its
    // account wrongly degraded. `onExit` fires immediately for a child that
    // has already exited.
    const settled = async (result: ExecResult): Promise<ExecResult> => {
      if (!result.running) return result;
      await new Promise<void>((resolve) => this.executor.onExit(result.handle, () => resolve()));
      return this.executor.output(result.handle, 0);
    };

    if (plan.kind === "help") {
      this.audit.record("exec_start", { intentId: intent.intentId, argv });
      return this.finishRun(intent.intentId, await runGog(plan.gogArgv.slice(1), null));
    }

    let minted: MintedAccounts;
    try {
      minted = await this.mintAllFor(provider);
    } catch (e) {
      const message = e instanceof MintError ? e.message : `could not authorise ${provider.command}`;
      return this.execError(intent.intentId, message);
    }

    if (plan.kind === "accounts") {
      // Answered from the mint — no gog run, no further network.
      this.audit.record("exec_start", { intentId: intent.intentId, argv });
      this.audit.record("exec_end", { intentId: intent.intentId, exit_code: 0 });
      return {
        status: "completed",
        accounts: minted.accounts.map((a) => ({ account: a.account, is_default: a.isDefault })),
        degraded: minted.degraded,
      };
    }

    // The emails listed in every sentence below are the mint's own, so they
    // are safe for the audit log; the caller's spelling is never repeated.
    const connected = [
      ...minted.accounts.map((a) => (a.isDefault ? `${a.account} (default)` : a.account)),
      ...minted.degraded.map((d) => `${d.account} (unavailable)`),
    ].join(", ");

    if (plan.kind === "fanout") {
      // Named accounts narrow the fan-out; one that is not connected at all
      // is an error, not a silent drop — the agent asked for it by name.
      let targets = minted.accounts;
      let degraded = minted.degraded;
      if (plan.accounts !== null) {
        const wanted = new Set(plan.accounts.map((a) => a.toLowerCase()));
        targets = minted.accounts.filter((a) => wanted.has(a.account.toLowerCase()));
        degraded = minted.degraded.filter((d) => wanted.has(d.account.toLowerCase()));
        if (targets.length + degraded.length < wanted.size) {
          return this.execError(
            intent.intentId,
            `an --account entry is not a connected account. Connected: ${connected}`,
          );
        }
      }
      this.audit.record("exec_start", { intentId: intent.intentId, argv });
      const runs = await Promise.all(
        targets.map(async (a) => ({
          a,
          result: await settled(await runGog(plan.gogArgv.slice(1), a.token)),
        })),
      );
      const ok: { account: string; stdout: string }[] = [];
      const failed: { account: string; reason: string }[] = [];
      // Accounts that answered with nothing: `--fail-empty` makes gog exit 3
      // for an empty result, which is an ANSWER, not a failure — the same
      // "nothing today" an exit-0 empty list carries, spelled as an exit code
      // because the caller asked for it to be. Counted, and deliberately not
      // listed as degraded: there is nothing for an owner to fix.
      let empty = 0;
      for (const { a, result } of runs) {
        // The reasons carry the exit disposition only: a child's output is
        // service-fetched text and stays out of every error string. The
        // DISPOSITION is gog's published exit table, which says more than the
        // number without quoting a word the service wrote.
        if (result.exitCode === 3) {
          empty += 1;
        } else if (result.exitCode !== 0) {
          failed.push({ account: a.account, reason: gogExitReason(result.exitCode) });
        } else ok.push({ account: a.account, stdout: this.executor.stdout(result.handle).toString("utf8") });
      }
      const merged = mergeFanout(ok, plan.sort);
      const unreadable = new Set(merged.unparsed.map((u) => u.account));
      // An account ANSWERED: its child ran, said something gog calls a result,
      // and anything it printed parsed. Whether that answer had rows in it is
      // the account's business — "no mail today" is an answer.
      const answered = ok.filter((o) => !unreadable.has(o.account)).length + empty;
      const allDegraded = [
        ...degraded,
        ...failed,
        ...merged.unparsed.map((u) => ({ account: u.account, reason: u.error })),
      ];
      // One number for N accounts, so it can only answer "did ANY account
      // answer?" — counted over accounts, never over items. Counting items
      // marked a healthy account that legitimately returned nothing as a
      // failure the moment some OTHER account was degraded, which is a partial
      // success wearing a failure's badge.
      //
      // Counted over accounts rather than over children, too: an account can
      // fail before a child exists — every account degraded at the mint runs
      // nothing at all — and reading exit codes alone called that green.
      //
      // So: a partial success is 0, with the accounts that failed named in
      // `degraded`; a run where nobody answered and somebody failed is 1; and
      // a fan-out with no accounts at all stays 0, having nothing to report.
      this.audit.record("exec_end", {
        intentId: intent.intentId,
        exit_code: answered === 0 && allDegraded.length > 0 ? 1 : 0,
      });
      return {
        status: "completed",
        items: merged.items,
        degraded: allDegraded,
      } as JSONValue;
    }

    // single: exactly one account, whatever the command does. CONNECTED means
    // healthy PLUS degraded — a degraded default must never let an accountless
    // command silently run against a healthy non-default account.
    if (minted.accounts.length === 0) {
      // The real minter throws before this; a Minter that answers with only
      // degraded accounts still must not fall through to accounts[0].
      return this.execError(intent.intentId, "every connected Google account needs re-auth");
    }
    const requested = plan.account;
    let target: MintedAccounts["accounts"][number];
    if (requested !== null) {
      const healthy = minted.accounts.find((a) => a.account.toLowerCase() === requested.toLowerCase());
      const unhealthy = minted.degraded.find((d) => d.account.toLowerCase() === requested.toLowerCase());
      if (healthy === undefined) {
        // A degraded account's reason is local/allowlisted text (see
        // mintAccountTokens), safe to repeat.
        return this.execError(
          intent.intentId,
          unhealthy
            ? `that account cannot be used right now: ${unhealthy.reason}. Re-connect it in Plow`
            : `that --account is not a connected account. Connected: ${connected}`,
        );
      }
      target = healthy;
    } else if (minted.accounts.length + minted.degraded.length > 1) {
      return this.execError(
        intent.intentId,
        `this command runs on one account: pass --account <email>. Connected: ${connected}. ` +
          "When replying, use the account that received the thread.",
      );
    } else {
      target = minted.accounts[0]!;
    }

    this.audit.record("exec_start", { intentId: intent.intentId, argv });
    if (plan.conflictCheck !== null && !plan.confirmConflict) {
      const { from, to } = plan.conflictCheck;
      const probe = await settled(
        await runGog(
          ["calendar", "conflicts", "--from", from, "--to", to, "--json", "--results-only"],
          target.token,
        ),
      );
      let conflicts: unknown = null;
      if (probe.exitCode === 0) {
        try {
          conflicts = JSON.parse(this.executor.stdout(probe.handle).toString("utf8"));
        } catch {
          /* handled below: an unreadable probe is a failed check */
        }
      }
      // Both refusals below record exec_error, never a zero-exit exec_end:
      // the approved create did NOT happen, and the desktop renders an
      // exit-0 exec_end green (viewModel.ts) — a refusal wearing a success
      // badge. The create child's own outcome gets the one exec_end, in
      // finishRun.
      if (!Array.isArray(conflicts)) {
        // Fail loud, with the override in hand: silently booking past a
        // broken check would make the gate's absence invisible.
        return this.execError(
          intent.intentId,
          "could not check the calendar for conflicts; re-send the same command " +
            "with --confirm-conflict to book without the check",
        );
      }
      if (conflicts.length > 0) {
        // The COUNT only. The records themselves are calendar content the
        // owner approved a CREATE for, not a read — returning them would be
        // an unapproved read riding a create argv.
        return this.execError(
          intent.intentId,
          `the slot is busy — ${conflicts.length} event(s) overlap this window. ` +
            "Re-send the same command with --confirm-conflict to book anyway.",
        );
      }
    }
    return this.finishRun(intent.intentId, await runGog(plan.gogArgv.slice(1), target.token));
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
    if (jv(params).get("action").str === "close") {
      return this.browserSessions.close(session, "agent");
    }
    return this.browserSessions.command(session, params);
  }

  async getOutput(handle: string, since = 0): Promise<JSONValue> {
    await this.pendingDiagnoses.get(handle);
    return runPayload(this.executor.output(handle, since), this.runDiagnoses.get(handle) ?? null);
  }
}

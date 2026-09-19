/**
 * The settings mutations behind the IPC handlers.
 *
 * These live outside `main.ts` for the same reason `reviewPolicy.ts` does: the
 * untrusted side of the bridge calls them, and validation that cannot be
 * executed by a test is validation nobody can vouch for. `main.ts` registers
 * the channels and does nothing else.
 *
 * Every one of these reads and writes the on-disk settings under `DOMO_HOME`,
 * so what a test observes is what actually survives a relaunch.
 */
import { loadSettings, saveSettings, Settings } from "./settings.js";
import { InferenceStatus, inferenceStatus } from "./reviewPolicy.js";
import { PlowApiError } from "./plowApi.js";

export function queuePendingRevoke(settings: Settings, credential: string): void {
  const pending = credential.trim();
  if (!pending) return;
  if (!settings.pendingRevokeCredentials.includes(pending)) {
    settings.pendingRevokeCredentials.push(pending);
  }
}

function forgetPendingRevoke(home: string, credential: string): void {
  update(home, (s) => {
    s.pendingRevokeCredentials = s.pendingRevokeCredentials.filter((pending) => pending !== credential);
  });
}

/** One immediate pass over the durable queue. Callers provide the cadence:
 * launch, sign-out, relay recovery, and main's existing one-minute heartbeat.
 * Overlapping callers share one flight. */
export class PendingRevokeRetrier {
  private flight: Promise<void> | null = null;

  constructor(
    private readonly home: string,
    private readonly revoke: (credential: string) => Promise<unknown>,
  ) {}

  start(): Promise<void> {
    if (this.flight) return this.flight;
    const current = (async () => {
      for (const credential of [...loadSettings(this.home).pendingRevokeCredentials]) {
        try {
          await this.revoke(credential);
          forgetPendingRevoke(this.home, credential);
        } catch (error) {
          if (error instanceof PlowApiError && error.kind === "unauthorized") {
            forgetPendingRevoke(this.home, credential);
          }
        }
      }
    })();
    const wrapped = current.finally(() => {
      if (this.flight === wrapped) this.flight = null;
    });
    this.flight = wrapped;
    return wrapped;
  }
}

/** Read-modify-write. What the user chose is what stays on disk. */
function update(home: string, mutate: (settings: Settings) => void): Settings {
  const settings = loadSettings(home);
  mutate(settings);
  saveSettings(home, settings);
  return settings;
}

/** What the renderer may know about inference. Never a credential. */
export function readInference(home: string): InferenceStatus {
  return inferenceStatus(loadSettings(home));
}

/** What the owner wrote about what agents are for. Empty until they write it. */
export function readAgentPurpose(home: string): string {
  return loadSettings(home).agentPurpose ?? "";
}

function clearPlowSession(settings: Settings): void {
  settings.relayCredential = "";
  settings.relayCredentialEnc = undefined;
  settings.accountUid = "";
  settings.mcpUrl = "";
  settings.setupComplete = false;
  settings.onboardingResumeStep = undefined;
}

/**
 * Store (or clear) the purpose statement.
 *
 * The ONLY writer. It is reached from the renderer's settings IPC and nowhere
 * else — no tool, no intent, and no relay message can land here — which is what
 * lets the reviewer prompt label the text as owner-authored rather than
 * agent-supplied.
 *
 * Anything that is not a string stores as empty: the renderer is sandboxed but
 * still the untrusted side of the bridge,
 * and a hand-made call must not be able to park a non-string in a field the
 * prompt builder will interpolate.
 *
 * Returns what was stored, so a caller shows what the file holds rather than
 * what it hoped to write.
 */
export function setAgentPurpose(home: string, purpose: unknown): string {
  return update(home, (s) => (s.agentPurpose = typeof purpose === "string" ? purpose.trim() : ""))
    .agentPurpose;
}

/**
 * Forget this Mac's Plow credential.
 *
 * The stored approval mode is left alone. Adversarial with no credential is a
 * legal state that denies legibly, and rewriting the owner's choice behind
 * their back on sign-out was never the honest way to say so.
 */
export function signOutOfPlow(home: string): void {
  update(home, clearPlowSession);
}

/**
 * Is there still a credential to sign out of?
 *
 * The guard on a SECOND sign-out. Two clicks land before the button re-renders,
 * and each handler resets the setup window and starts a fresh activation — so
 * the second supersedes a code the user may already have texted, and the poll
 * loop watching it. The first click did the work; the rest are no-ops.
 *
 * Here rather than in `main.ts` for the usual reason: main cannot be imported
 * under vitest, and a decision that lives only there is one no test can make.
 */
export function isSignedIn(home: string): boolean {
  return (loadSettings(home).relayCredential ?? "").trim().length > 0;
}

/**
 * Sign out locally and retain the credential only in the retirement queue.
 *
 * The network executor is deliberately elsewhere. This atomic disk mutation
 * makes sign-out immediate; the shared retrier runs right after it and again
 * from launch, relay recovery, and the app heartbeat.
 */
export function queueRevokeAndSignOut(home: string): void {
  update(home, (s) => {
    queuePendingRevoke(s, s.relayCredential);
    clearPlowSession(s);
  });
}

/**
 * Set the approval mode, as asked. Adversarial with no usable reviewer is a
 * legal state: it denies, legibly. Anything unrecognised falls back to Ask, as
 * it always has.
 */
export function setApprovalMode(home: string, mode: unknown): Settings["approvalMode"] {
  const allowed: Settings["approvalMode"][] = ["approve", "adversarial", "ask", "deny"];
  const requested = allowed.find((m) => m === mode) ?? "ask";
  return update(home, (s) => (s.approvalMode = requested)).approvalMode;
}

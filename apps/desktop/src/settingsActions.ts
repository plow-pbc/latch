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

/** One process's retry budget. The queue itself survives after this budget and
 * is tried again on the next launch or successful relay connection. */
export const PENDING_REVOKE_RETRY_DELAYS_MS = [0, 5_000, 30_000, 120_000, 600_000] as const;

function forgetPendingRevoke(home: string, credential: string): void {
  update(home, (s) => {
    s.pendingRevokeCredentials = s.pendingRevokeCredentials.filter((pending) => pending !== credential);
  });
}

/** Retire every queued session without ever handing its credential to the UI.
 * A 401 means the credential is already unusable, which is the desired end
 * state. Other failures consume this process's bounded retry budget and leave
 * the queue on disk for a later launch. */
export async function retryPendingRevokes(
  home: string,
  revoke: (credential: string) => Promise<unknown>,
  options: {
    delaysMs?: readonly number[];
    wait?: (delayMs: number) => Promise<void>;
    warnOnExhausted?: boolean;
  } = {},
): Promise<boolean> {
  const delays = options.delaysMs ?? PENDING_REVOKE_RETRY_DELAYS_MS;
  const wait = options.wait ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  const warnOnExhausted = options.warnOnExhausted ?? true;

  for (const delayMs of delays) {
    if (delayMs > 0) await wait(delayMs);
    const pending = [...loadSettings(home).pendingRevokeCredentials];
    if (pending.length === 0) return true;

    for (const credential of pending) {
      try {
        await revoke(credential);
        forgetPendingRevoke(home, credential);
      } catch (error) {
        if (error instanceof PlowApiError && error.kind === "unauthorized") {
          forgetPendingRevoke(home, credential);
        }
      }
    }
  }

  if (loadSettings(home).pendingRevokeCredentials.length === 0) return true;
  if (warnOnExhausted) console.warn("[settings] pending session revoke retries exhausted");
  return false;
}

/** One retry owner per app process. Launch, sign-out, and relay recovery can
 * all ask for a flush; they share the same flight so no credential is sent by
 * two overlapping loops. */
export class PendingRevokeRetrier {
  private flight: Promise<boolean> | null = null;
  private requestedDelays: readonly number[] | null = null;

  constructor(
    private readonly home: string,
    private readonly revoke: (credential: string) => Promise<unknown>,
    private readonly wait: (delayMs: number) => Promise<void> =
      (delayMs) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)),
  ) {}

  start(delaysMs: readonly number[] = PENDING_REVOKE_RETRY_DELAYS_MS): Promise<boolean> {
    // A request arriving during the final snapshot of an existing flight may
    // represent a credential that flight has never seen. Remember one follow-
    // up schedule; later triggers can coalesce into it, but none are dropped.
    this.requestedDelays = delaysMs;
    if (this.flight) return this.flight;
    const current = (async () => {
      let retired = true;
      while (this.requestedDelays) {
        const requestedDelays = this.requestedDelays;
        this.requestedDelays = null;
        retired = await retryPendingRevokes(this.home, this.revoke, {
          delaysMs: requestedDelays,
          wait: this.wait,
          warnOnExhausted: false,
        });
      }
      if (!retired) console.warn("[settings] pending session revoke retries exhausted");
      return retired;
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
  update(home, (s) => {
    s.relayCredential = "";
    s.relayCredentialEnc = undefined;
    s.accountUid = "";
    s.mcpUrl = "";
    s.setupComplete = false;
  });
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
 * Sign out: forget the credential here, and ask Plow to retire it.
 *
 * LOCAL FIRST, and synchronously, before this function's first `await`. Erasing
 * the on-disk copy is the only half the app can guarantee on its own; revoking
 * is a network round-trip. Putting the round-trip in front would make "signed
 * out" depend on reaching a server, and a Mac that cannot reach Plow is the one
 * whose owner most wants the local copy gone.
 *
 * The immediate revoke is best effort. Offline, API down, route not deployed,
 * any error at all: the local clear has already happened, and the retiring
 * credential stays encrypted in the pending queue. A background retrier owns
 * the remaining process budget; launch and relay recovery try the durable queue
 * again, so quitting mid-flight does not lose the work.
 *
 * `revoke` is injected for one reason: it is what makes "sign-out always clears
 * locally, even when the revoke fails" executable by a test. `main.ts` cannot
 * be imported under vitest, so that property is only provable while this lives
 * here.
 */
export async function revokeAndSignOut(
  home: string,
  revoke: (credential: string) => Promise<unknown>,
): Promise<boolean> {
  let credential = "";
  update(home, (s) => {
    credential = (s.relayCredential ?? "").trim();
    if (credential && !s.pendingRevokeCredentials.includes(credential)) {
      s.pendingRevokeCredentials.push(credential);
    }
    s.relayCredential = "";
    s.relayCredentialEnc = undefined;
    s.accountUid = "";
    s.mcpUrl = "";
    s.setupComplete = false;
  });
  if (!credential) return true;
  try {
    await revoke(credential);
    forgetPendingRevoke(home, credential);
    return true;
  } catch (error) {
    if (error instanceof PlowApiError && error.kind === "unauthorized") {
      forgetPendingRevoke(home, credential);
      return true;
    }
    console.warn("[settings] session revoke pending; will retry");
    return false;
  }
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

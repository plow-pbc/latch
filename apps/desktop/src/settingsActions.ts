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
    // Account data, not device data: the next sign-in may be a different
    // account, and a stale chat label on its setup screen would name a chat
    // this Mac can no longer reach.
    s.provisionedChatUid = "";
    s.provisionedChatLabel = "";
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
 * The revoke is BEST EFFORT, deliberately. Offline, API down, route not
 * deployed, any error at all: the local clear has already happened and sign-out
 * logs one fixed sentence, with no server text or credential. **Completing the
 * revoke across a quit is explicitly NOT
 * guaranteed** — if the user quits while it is in flight, the credential stays
 * live on the account until it idles out or is retired by other means.
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
  const credential = (loadSettings(home).relayCredential ?? "").trim();
  signOutOfPlow(home);
  if (!credential) return true;
  try {
    await revoke(credential);
    return true;
  } catch {
    console.warn("[settings] session revoke failed; already signed out locally");
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

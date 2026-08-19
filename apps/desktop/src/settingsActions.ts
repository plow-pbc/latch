/**
 * The settings mutations behind the IPC handlers.
 *
 * These live outside `main.ts` for the same reason `reviewPolicy.ts` does: they
 * are the enforcement side of the reviewer interlock, and enforcement that
 * cannot be executed by a test is enforcement nobody can vouch for. `main.ts`
 * registers the channels and does nothing else.
 *
 * Every one of these reads and writes the on-disk settings under `DOMO_HOME`,
 * so what a test observes is what actually survives a relaunch — the interlock
 * is only worth anything if it persists.
 */
import { INFERENCE_PROVIDERS, loadSettings, saveSettings, Settings } from "./settings.js";
import { InferenceStatus, inferenceStatus } from "./reviewPolicy.js";

/**
 * Read-modify-write.
 *
 * There is no interlock here any more. Losing a credential used to retire
 * Adversarial mode to Ask in the same write, so the stored mode could never
 * name a reviewer that cannot run — which meant signing out silently changed
 * how operations get decided. A mode that cannot run now DENIES, and says why
 * (`DENIAL_SOURCE_NO_REVIEWER`), so the state is legible instead of impossible
 * and what the user chose is what stays on disk.
 */
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

/**
 * Select a provider.
 *
 * Any known provider, credential or not. Parking the reviewer on a provider
 * that cannot answer used to be refused here; it is now a state the user is
 * allowed to be in, and one that answers for itself at review time with an
 * explained denial rather than a silent fallback.
 *
 * An unknown provider name is still refused — that is input validation on the
 * untrusted side of the bridge, not a policy gate.
 */
export function setInferenceProvider(home: string, provider: unknown): InferenceStatus {
  const next = INFERENCE_PROVIDERS.find((p) => p === provider);
  const settings = loadSettings(home);
  if (!next) return inferenceStatus(settings);
  return inferenceStatus(update(home, (s) => (s.inferenceProvider = next)));
}

/**
 * Store (or clear) the Anthropic key. Clearing the credential the reviewer was
 * actually using retires Adversarial mode back to Ask.
 */
export function setAnthropicApiKey(home: string, key: unknown): void {
  update(home, (s) => (s.anthropicApiKey = typeof key === "string" ? key.trim() : ""));
}

/**
 * Forget this Mac's Plow credential.
 *
 * Sign-out takes the Plow reviewer's credential with it, so it has to retire
 * Adversarial mode exactly the way clearing the Anthropic key does — otherwise
 * signing out leaves a stored mode naming a reviewer with no way to run.
 */
export function signOutOfPlow(home: string): void {
  update(home, (s) => {
    s.relayCredential = "";
    s.accountUid = "";
    s.mcpUrl = "";
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
 * reports success. **Completing the revoke across a quit is explicitly NOT
 * guaranteed** — if the user quits while it is in flight, the credential stays
 * live on the account until it is retired by other means. That is an accepted
 * risk for this stage, not an oversight; it is tracked in domo-desktop#21.
 *
 * `revoke` is injected for one reason: it is what makes "sign-out always clears
 * locally, even when the revoke fails" executable by a test. `main.ts` cannot
 * be imported under vitest, so that property is only provable while this lives
 * here.
 */
export async function revokeAndSignOut(
  home: string,
  revoke: (credential: string) => Promise<unknown>,
): Promise<void> {
  const credential = (loadSettings(home).relayCredential ?? "").trim();
  signOutOfPlow(home);
  if (!credential) return;
  try {
    await revoke(credential);
  } catch {
    // Deliberately swallowed, and deliberately not logged: the failure is not
    // actionable here, and the only interesting value in scope is the
    // credential itself.
  }
}

/**
 * Set the approval mode. Adversarial is refused when the active provider has no
 * credential — the fourth door into the same interlock, and the one the UI also
 * guards. Anything unrecognised falls back to Ask, as it always has.
 */
export function setApprovalMode(home: string, mode: unknown): Settings["approvalMode"] {
  const allowed: Settings["approvalMode"][] = ["approve", "adversarial", "ask", "deny"];
  const requested = allowed.find((m) => m === mode) ?? "ask";
  // Stored as asked. Adversarial with no usable reviewer is a legal state now:
  // it denies, legibly, instead of being rewritten to Ask behind the user.
  return update(home, (s) => (s.approvalMode = requested)).approvalMode;
}

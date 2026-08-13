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
import {
  InferenceStatus,
  inferenceStatus,
  modeAfterAvailabilityChange,
  providerAvailability,
} from "./reviewPolicy.js";

/** Read-modify-write, always re-applying the interlock before persisting. */
function update(home: string, mutate: (settings: Settings) => void): Settings {
  const settings = loadSettings(home);
  mutate(settings);
  // Whatever just changed may have taken the active reviewer's credential with
  // it. Retiring Adversarial mode is part of the same write, so there is no
  // window where the stored mode names a reviewer that cannot run.
  settings.approvalMode = modeAfterAvailabilityChange(settings);
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
 * A provider with no credential is REFUSED here, not merely hidden in the UI:
 * the renderer is sandboxed but it is still the untrusted side of the bridge,
 * and a replayed or hand-made IPC call must not be able to park the reviewer on
 * a provider that can never answer. An unknown provider name is refused too.
 *
 * Returns the resulting status either way, so a refused call tells the renderer
 * what the truth is rather than leaving it to assume its own optimistic guess.
 */
export function setInferenceProvider(home: string, provider: unknown): InferenceStatus {
  const next = INFERENCE_PROVIDERS.find((p) => p === provider);
  const settings = loadSettings(home);
  if (!next || !providerAvailability(settings)[next]) return inferenceStatus(settings);
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
 * Sign out: forget the credential here, and ask Plow to retire it.
 *
 * LOCAL FIRST, and that ordering is the point. Erasing the on-disk copy is the
 * only half of this the app can guarantee on its own; revoking is a network
 * round-trip. Putting the round-trip in front would make "signed out" depend on
 * reaching a server, and a Mac that cannot reach Plow is the one whose owner
 * most wants the local copy gone. So the token is captured into a local, the
 * on-disk copy goes, and Plow is asked with the captured value — which does not
 * need the file to still exist.
 *
 * The revoke is BEST EFFORT, deliberately. Offline, API down, route not
 * deployed, any error at all: the local clear has already happened and sign-out
 * reports success. **Completing the revoke across a quit is explicitly NOT
 * guaranteed** — if the user quits while it is in flight, the credential stays
 * live on the account until it is retired by other means. That is an accepted
 * risk for this stage, not an oversight; it is tracked in domo-desktop#21.
 *
 * Nothing is sequenced after the clear: `afterClear` drops the relay socket and
 * `RelayClient.stop()` waits for in-flight requests, which is unbounded, so the
 * revoke is started alongside it rather than behind it.
 *
 * `revoke` and `afterClear` are injected so this path is reachable by a test
 * without a network or an Electron app.
 */
export async function revokeAndSignOut(
  home: string,
  revoke: (credential: string) => Promise<unknown>,
  afterClear: () => Promise<unknown> = async () => {},
): Promise<void> {
  const credential = (loadSettings(home).relayCredential ?? "").trim();
  signOutOfPlow(home);
  // Both STARTED before either is awaited. Calling them here is what makes
  // that true; awaiting neither until both are running is what keeps it true.
  const pending = [afterClear()];
  if (credential) pending.push(revoke(credential));
  // Failures are deliberately swallowed and deliberately not logged: neither is
  // actionable here, and the only interesting value in scope is the credential.
  await Promise.allSettled(pending);
}

/**
 * Set the approval mode. Adversarial is refused when the active provider has no
 * credential — the fourth door into the same interlock, and the one the UI also
 * guards. Anything unrecognised falls back to Ask, as it always has.
 */
export function setApprovalMode(home: string, mode: unknown): Settings["approvalMode"] {
  const allowed: Settings["approvalMode"][] = ["approve", "adversarial", "ask", "deny"];
  const requested = allowed.find((m) => m === mode) ?? "ask";
  // `update` re-applies the interlock, which is what turns an Adversarial
  // request with no usable reviewer into Ask — one definition of that rule,
  // not two.
  return update(home, (s) => (s.approvalMode = requested)).approvalMode;
}

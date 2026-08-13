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
 * A credential survives a sign-out in exactly two ways, and this function is
 * shaped around denying both:
 *
 *   1. **The on-disk copy is still there** — the next launch dials the relay
 *      back up with a token its owner believes they retired. Denied by doing
 *      the local clear FIRST, synchronously, before this function's first
 *      `await`. There is no point at which a quit can land between reading the
 *      token and erasing it.
 *   2. **The revoke never reaches Plow** — this Mac has forgotten the token but
 *      it stays valid on the account. Denied by INITIATING the revoke before
 *      awaiting anything, using the captured value (which does not need the
 *      file to still exist).
 *
 * The second is why nothing is sequenced here. `afterClear` drops the relay
 * socket, and `RelayClient.stop()` waits for in-flight requests so a shutdown
 * never strands an agent mid-call — an unbounded wait, on purpose. Awaiting it
 * before starting the revoke put the one network call that matters behind a
 * drain that can take as long as an agent's slowest tool, and `app.quit()` does
 * not wait for a pending IPC handler: Sign Out then Quit while the relay was
 * draining and `/self/revoke` never even began. So both are started here and
 * settled together.
 *
 * It stays strictly best-effort: offline, API down, route not deployed, any
 * error at all, and the local clear has already happened — both callbacks are
 * async, so every failure arrives as a rejection `allSettled` absorbs.
 * Sign-out that failed because a server could not be reached would
 * leave the Mac holding a live credential while telling its owner it had signed
 * out, which is worse than not revoking.
 *
 * What this function cannot promise on its own: initiating a request is not
 * completing one, so a quit inside the revoke's own round-trip would still exit
 * before it landed. That last gap is closed from the other side — `main.ts`
 * registers the revoke with the `ShutdownGate` and holds the quit until it
 * settles or a short bound elapses. See shutdownGate.ts.
 *
 * `revoke` and `afterClear` are injected so this path — including the ordering
 * above — is reachable by a test without a network or an Electron app.
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

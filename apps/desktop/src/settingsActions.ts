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
import { keyPrefixOf, PlowApi } from "./plowApi.js";

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
 *
 * A revoke that never completes — offline, a quit mid-flight — leaves the old
 * login session live on the account, and Plow refuses to register this Mac's
 * device to a NEW session while that one still is (409). So the credential's
 * `key_prefix`, a public identifier and never the secret, is recorded as
 * `unretiredKeyPrefix` in THIS SAME synchronous section, before the local
 * sign-out's first `await` — so it survives a quit exactly as reliably as the
 * local erase does. A successful revoke clears it; a failed one leaves it for
 * `retireUnretiredSession` to retry on the next sign-in.
 */
export async function revokeAndSignOut(
  home: string,
  revoke: (credential: string) => Promise<unknown>,
): Promise<boolean> {
  const credential = (loadSettings(home).relayCredential ?? "").trim();
  signOutOfPlow(home);
  if (!credential) return true;
  const prefix = keyPrefixOf(credential);
  update(home, (s) => (s.unretiredKeyPrefix = prefix));
  try {
    await revoke(credential);
    // Only clear a record that still names THIS attempt — the guard `update`
    // applies everywhere else, kept here even though nothing else can write
    // this field between the line above and this one.
    update(home, (s) => {
      if (s.unretiredKeyPrefix === prefix) s.unretiredKeyPrefix = undefined;
    });
    return true;
  } catch {
    console.warn("[settings] session revoke failed; already signed out locally");
    return false;
  }
}

/**
 * Retire the session an earlier offline sign-out recorded but could not
 * reach — the fix for the 409 above. Called at the top of every relay
 * registration attempt, so a Mac stuck saying "Plow returned 409" clears
 * itself on the very next connect rather than staying wedged until the old
 * session idles out.
 *
 * Nothing to do (no pending record, or no credential to act with) is not an
 * error — most connects have nothing to retire, and this must not itself
 * demand a credential. Otherwise: find the still-active key wearing that
 * prefix and revoke it, then clear the record so a Mac that has nothing left
 * to retire stops asking.
 *
 * Errors propagate rather than being swallowed here: the relay client that
 * calls this already backs off and retries `beforeConnect`, and the record
 * stays on disk for that retry — unlike `revokeAndSignOut`, this is not
 * itself the best-effort boundary.
 */
export async function retireUnretiredSession(
  home: string,
  api: Pick<PlowApi, "listApiKeys" | "revokeApiKey">,
): Promise<void> {
  const settings = loadSettings(home);
  const prefix = settings.unretiredKeyPrefix;
  const credential = (settings.relayCredential ?? "").trim();
  if (!prefix || !credential) return;
  const keys = await api.listApiKeys(credential);
  const stale = keys.find((key) => key.is_active && key.key_prefix === prefix);
  if (stale) await api.revokeApiKey(credential, stale.id);
  update(home, (s) => {
    if (s.unretiredKeyPrefix === prefix) s.unretiredKeyPrefix = undefined;
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

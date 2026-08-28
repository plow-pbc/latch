/**
 * App settings persisted under DOMO_HOME.
 *
 * This file holds a secret — the Plow relay credential — so it is written
 * **owner-only**. It used to be written with no mode at all, which on a shared
 * or backed-up Mac is a plaintext credential anyone could read. There is still
 * no Keychain or `safeStorage` here; 0600 is the floor,
 * not the destination.
 */
import fs from "node:fs";
import path from "node:path";

/**
 * How the credential is encrypted at rest, when the OS offers a way.
 *
 * Injected rather than imported: `safeStorage` is Electron's, and this module
 * is read by the test suite and by `latch-smoke`, neither of which runs
 * Electron. `main.ts` installs the real one at boot.
 */
export interface CredentialCodec {
  /** Whether the OS keychain can serve right now. False before `app.ready`,
   * and on a Linux box with no keyring. */
  available(): boolean;
  /** Plaintext in, base64 ciphertext out. */
  encrypt(plain: string): string;
  /** Base64 ciphertext in, plaintext out. Throws if it cannot. */
  decrypt(cipher: string): string;
}

let codec: CredentialCodec | null = null;
let warnedUnavailable = false;

/** Install the codec. `null` restores plaintext, which is what tests want. */
export function useCredentialCodec(next: CredentialCodec | null): void {
  codec = next;
  warnedUnavailable = false;
}

function activeCodec(): CredentialCodec | null {
  if (!codec) return null;
  try {
    return codec.available() ? codec : null;
  } catch {
    return null;
  }
}

/**
 * One sealed secret read back, or `""` when nothing here can read it.
 *
 * A decrypt that fails is not a crash: the keychain entry can be gone (a
 * restored backup, a new login keychain), and there is no codec at all under
 * the tests and `latch-smoke`. The honest answer in both cases is that this
 * Mac does not hold the secret.
 */
function unseal(sealed: string): string {
  const active = activeCodec();
  if (!active) return "";
  try {
    return active.decrypt(sealed);
  } catch {
    return "";
  }
}

/**
 * Put one secret into the record on its way to disk: sealed where the OS can
 * seal it, in the clear where it cannot. Returns whether it went out in the
 * clear, which is the only case worth a warning.
 *
 * `available()` answering yes is not a promise that `encrypt` works — the
 * keychain can lock between the two calls — and a throw escaping here used to
 * escape `saveSettings`, so a sign-in that had just spent its one-shot redeem
 * wrote nothing at all and the session it was handed was live on the account
 * with no copy anywhere. Falling back to the plaintext this Mac wrote until
 * yesterday keeps the secret; 0600 is the floor that holds either way.
 */
function storeSecret(
  stored: Record<string, unknown>,
  plainKey: string,
  sealedKey: string,
  active: CredentialCodec | null,
): boolean {
  const value = String(stored[plainKey] ?? "").trim();
  let sealed = "";
  if (value && active) {
    try {
      sealed = active.encrypt(value);
    } catch {
      sealed = "";
    }
  }
  if (sealed) {
    stored[sealedKey] = sealed;
    stored[plainKey] = "";
    return false;
  }
  delete stored[sealedKey];
  return value !== "";
}

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * How operation intents are decided:
 *   - approve:     auto "allow once", no dialog
 *   - adversarial: a Claude-backed adversarial review decides, and nothing else
 *                  does — there is no human in this mode. It FAILS CLOSED: no
 *                  credential, an API error, a timeout, a refusal or an answer
 *                  that is not a verdict all deny the operation outright, each
 *                  with a source saying which it was.
 *   - ask:         always show the approval dialog (default)
 *   - deny:        auto-deny, no dialog
 */
export type ApprovalMode = "approve" | "adversarial" | "ask" | "deny";

/**
 * What this Mac remembers about one cloud agent, on its own.
 *
 * Local because nothing on the server knows about it: adversarial review is
 * this app's reviewer, not a property of the machine Plow provisioned.
 */
export interface Settings {
  /* There is deliberately NO API base URL here. It is baked into the build
   * (`resolveApiBaseUrl`), because a credential is only valid against the
   * environment that minted it — a user-editable origin would turn a stored
   * token silently meaningless and produce an auth error nobody could explain.
   * The old `relayUrl` WebSocket setting is gone with it; the socket is derived
   * from the build's base URL by `relaySocketUrl`. */
  /**
   * The credential, ENCRYPTED, when the OS offered a way to encrypt it. Only
   * one of this and `relayCredential` is ever on disk.
   */
  relayCredentialEnc?: string;
  /** The Plow login session this Mac holds, from first-run activation or the
   * phone-code fallback. It carries the owner's full account authority — Latch
   * is their manager app, not an agent — and is never seen by the user. A
   * SECRET: never sent to the renderer, never written to a log or an error
   * string. */
  relayCredential: string;
  /**
   * A login session this Mac holds ONLY so it can be retired.
   *
   * A verified session it will not keep — a sign-out that landed mid-login, a
   * handoff that failed — has to be revoked, and the redeem that produced it
   * answers exactly once. When that revoke fails there is nowhere else the
   * token exists: dropping it leaves the owner's account carrying a live
   * `*:*` session for 180 days with nothing anywhere able to retire it. So it
   * is kept here, retried before the next activation and on the next launch,
   * and cleared the moment the server confirms.
   *
   * A SECRET, sealed and never shown, exactly like `relayCredential`. It is
   * never a credential this Mac USES — nothing reads it but the retry.
   */
  pendingRevocation: string;
  /** `pendingRevocation`, ENCRYPTED, when the OS offered a way. Only one of
   * this and `pendingRevocation` is ever on disk. */
  pendingRevocationEnc?: string;
  /** The account this Mac is signed into, and the endpoint agents POST to.
   * Both come from `GET /v1/relay/info` — the server stays authoritative and
   * the app never constructs the MCP URL itself. Cached only for display. */
  accountUid: string;
  mcpUrl: string;
  /** The last-selected main-window tab, restored across launches.
   *
   * The default is the FIRST launch's landing, not a fallback anyone returns
   * to: a home that has ever stored a tab keeps it, because the file's value
   * wins over the default. So moving this to "agents" points a new Mac at the
   * one screen it has to visit — nothing else in the app works until a client
   * can reach it — and leaves every existing home where its owner left it.
   *
   * A stored "connect" predates the Agents tab and is mapped to "agents" on
   * read (`ui:getTab`) rather than rewritten on disk. */
  selectedTab: string;
  /** The main window's last size + position, restored across launches. */
  windowBounds?: WindowBounds;
  /** How operation intents are decided. */
  approvalMode: ApprovalMode;
  /**
   * What the owner of this Mac says agents are for, in their own words.
   *
   * DEVICE-SIDE DATA, and the distinction is the whole point: it is typed here
   * by the person who owns the Mac, so the reviewer may be told to trust it —
   * unlike an intent's goal text, which the agent writes. It never rides on an
   * intent and no agent-reachable path can set it.
   *
   * Display and review only. It never reaches a rule key, a grant, or a
   * sandbox profile; enforcement still derives from the capability set alone.
   */
  agentPurpose: string;
  /** Check the update feed in the background (default on). A manual
   * "Check for Updates" always works regardless. */
  autoCheckUpdates: boolean;
  /** Apply a staged update on the next natural quit (default on). Off means
   * updates only install when the human clicks "Restart to Update". Never a
   * surprise restart either way. */
  autoInstallUpdates: boolean;
  /** When the last update check completed (ISO-8601) — display only. */
  updatesLastCheckedAt?: string;
  /**
   * The chat this Mac's activation provisioned, kept for display.
   *
   * The uid is the join key — the server stays authoritative on what the chat
   * *is*, and a cloud-agent screen lists chats rather than trusting this. The
   * label is display text derived at redeem time, cached because the redeem
   * that carried the chat answers exactly once: re-reading it is impossible, so
   * a setup window reopened later would otherwise have nothing to show.
   *
   * Neither is a secret. Both are empty on a Mac that activated before
   * `provision_chat`, which is why nothing may treat them as a signal that the
   * account has no chat.
   */
  provisionedChatUid: string;
  provisionedChatLabel: string;
  /** The first-run launch-at-login default has been applied (main.ts's
   * `applyFirstRunLaunchAtLogin`). NOT a mirror of the OS's login-item bit —
   * loginItem.ts explains why none exists — only the record that the one-time
   * default ran, so it can never run twice and a user who turns the toggle off
   * stays off. Deliberately survives sign-out: a re-setup is not a first run.
   * A signed-in home from before this field existed is grandfathered on load —
   * see `loadSettings` — for the same reason. */
  launchAtLoginDefaulted: boolean;
}

function settingsPath(home: string): string {
  return path.join(home, "app/settings.json");
}

export function loadSettings(home: string): Settings {
  const defaults: Settings = {
    relayCredential: "",
    pendingRevocation: "",
    accountUid: "",
    mcpUrl: "",
    selectedTab: "agents",
    approvalMode: "ask",
    agentPurpose: "",
    provisionedChatUid: "",
    provisionedChatLabel: "",
    autoCheckUpdates: true,
    autoInstallUpdates: true,
    launchAtLoginDefaulted: false,
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(settingsPath(home), "utf8"));
  } catch {
    return defaults;
  }
  const settings =
    parsed && typeof parsed === "object" ? { ...(parsed as Record<string, unknown>) } : {};
  // Bring-your-own-key is gone, and its two fields go with it. Unknown keys
  // otherwise ride this spread in and `saveSettings` writes them back, so a Mac
  // that once pasted an Anthropic key would keep it forever — unread by
  // anything, readable by anyone who opens the file. A secret nobody reads is
  // still a secret. Delete these three lines once the fleet has turned over:
  // they are a one-off, not a migration framework.
  const retired = "anthropicApiKey" in settings || "inferenceProvider" in settings;
  delete settings.anthropicApiKey;
  delete settings.inferenceProvider;

  const loaded = { ...defaults, ...settings };
  // The encrypted field wins where it exists. A decrypt that fails is treated
  // as no credential rather than as a crash: the keychain entry can be gone
  // (a restored backup, a new login keychain), and the honest answer to "what
  // is this Mac signed in as" is then nothing — which sends the owner through
  // setup rather than into an auth error nobody can explain.
  const sealed = typeof loaded.relayCredentialEnc === "string" ? loaded.relayCredentialEnc : "";
  if (sealed) {
    loaded.relayCredential = unseal(sealed);
    if (!loaded.relayCredential) {
      // Signed out, and signed out means ALL of it. Blanking the credential
      // alone left the account uid, the endpoint and the provisioned chat
      // behind, so the next login — possibly a different account — inherited a
      // chat label naming a thread it cannot reach. `signOutOfPlow` clears the
      // same set for the same reason; this is that state arrived at sideways.
      loaded.accountUid = "";
      loaded.mcpUrl = "";
      loaded.provisionedChatUid = "";
      loaded.provisionedChatLabel = "";
    }
  }
  // A seal nobody can open is nothing to retry — the token inside it is
  // unreachable either way, and reporting the ciphertext as a bearer would put
  // a value the server has never seen into a revoke.
  const sealedPending =
    typeof loaded.pendingRevocationEnc === "string" ? loaded.pendingRevocationEnc : "";
  if (sealedPending) loaded.pendingRevocation = unseal(sealedPending);
  // The spread above copies whatever the file held, and a hand-edited or
  // truncated file can put a non-object — or a `null` — where a record belongs.
  // Every reader of this map indexes it, so normalising once here is what keeps
  // A signed-in home from before `launchAtLoginDefaulted` existed: its owner's
  // launch-at-login choice predates the default, so reading the absent field as
  // false would let a later re-setup flip the bit on them. Grandfather it as
  // already defaulted. This can never swallow a genuinely new home's default:
  // setup saves the whole Settings object, so any file holding a credential
  // written since this field existed carries the key explicitly. Asked of the
  // scrubbed record rather than the raw parse — the scrub only ever removes the
  // retired key names, so the two answer this identically. It also has to run
  // BEFORE the scrub's write below, or a home cleaned on this load is written
  // back without the bit it was just granted.
  if (!("launchAtLoginDefaulted" in settings) && loaded.relayCredential.trim()) {
    loaded.launchAtLoginDefaulted = true;
  }
  // Take them OFF DISK here, rather than waiting for the next write of some
  // unrelated setting — and let a failure THROW. Swallowing it would report a
  // successful load while the credential is still in the file, which is the one
  // outcome this exists to prevent; every other write in this module propagates
  // too. It happens at most once, because the second read finds nothing to
  // remove.
  // A home written before the codec existed carries plaintext. Rewrite it
  // sealed on the first read that can — the same one-off shape the retired-key
  // scrub uses, and for the same reason: waiting for some unrelated write
  // leaves the plaintext on disk for as long as nobody changes a setting.
  const needsSealing =
    activeCodec() !== null &&
    ((!sealed && loaded.relayCredential.trim() !== "") ||
      (!sealedPending && loaded.pendingRevocation.trim() !== ""));
  if (retired || needsSealing) saveSettings(home, loaded);
  return loaded;
}

export function saveSettings(home: string, settings: Settings): void {
  const file = settingsPath(home);
  // Encrypted where the OS allows, plaintext where it does not — the file is
  // 0600 either way, which is what it has always been, so an unavailable
  // keychain is no worse than yesterday rather than a Mac that cannot sign in.
  const active = activeCodec();
  const stored: Record<string, unknown> = { ...settings };
  const credentialInClear = storeSecret(stored, "relayCredential", "relayCredentialEnc", active);
  const pendingInClear = storeSecret(stored, "pendingRevocation", "pendingRevocationEnc", active);
  if ((credentialInClear || pendingInClear) && codec && !warnedUnavailable) {
    warnedUnavailable = true;
    console.log("[settings] no OS keychain available; credential stored unencrypted (0600)");
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // mode on writeFileSync only applies when the file is created, so chmod
  // unconditionally — otherwise a file that predates this change keeps its
  // old permissions forever.
  fs.writeFileSync(file, JSON.stringify(stored, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

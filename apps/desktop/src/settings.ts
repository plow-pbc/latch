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
 * One secret sealed, or `""` when this Mac cannot seal it.
 *
 * `available()` answering yes is not a promise that `encrypt` works — the
 * keychain can lock between the two calls — and a throw escaping here used to
 * escape `saveSettings`, so a sign-in that had just spent its one-shot redeem
 * wrote nothing at all and the session it was handed was live on the account
 * with no copy anywhere. `""` sends the caller to the plaintext this Mac wrote
 * until yesterday; 0600 is the floor that holds either way.
 */
function seal(value: string, active: CredentialCodec | null): string {
  if (!value || !active) return "";
  try {
    return active.encrypt(value);
  } catch {
    return "";
  }
}

/**
 * Put one secret into the record on its way to disk: sealed where the OS can
 * seal it, in the clear where it cannot. Returns whether it went out in the
 * clear, which is the only case worth a warning.
 */
function storeSecret(
  stored: Record<string, unknown>,
  plainKey: string,
  sealedKey: string,
  active: CredentialCodec | null,
): boolean {
  const value = String(stored[plainKey] ?? "").trim();
  // Ciphertext `loadSettings` could not open, carried back verbatim. THE
  // dangerous case, and it took an ordinary window resize to reach: a locked
  // keychain made the secret read as `""`, `""` looked exactly like "there is
  // no secret", and the next save — a window move, a tab change, anything —
  // deleted the only copy of a live 180-day session. An unread secret is not
  // an absent one. Only sign-out and release, which know what they are
  // throwing away, clear these.
  const carried = String(stored[sealedKey] ?? "");
  const sealed = seal(value, active);
  if (sealed) {
    stored[sealedKey] = sealed;
    stored[plainKey] = "";
    return false;
  }
  if (!value && carried) {
    stored[sealedKey] = carried;
    stored[plainKey] = "";
    return false;
  }
  delete stored[sealedKey];
  return value !== "";
}

/**
 * The same, for a LIST of secrets — sealed entry by entry rather than as one
 * blob, so a single unreadable entry costs one token rather than all of them.
 *
 * All or nothing per write: if the keychain refuses even one, the whole list
 * goes out in the clear. A file holding half its tokens sealed and half not is
 * a shape nothing else here has to reason about, and the alternative is
 * dropping the ones that would not seal — which is the one outcome this list
 * exists to prevent.
 */
function storeSecretList(
  stored: Record<string, unknown>,
  plainKey: string,
  sealedKey: string,
  active: CredentialCodec | null,
): boolean {
  const values = readSecretList(stored[plainKey]);
  // Entries `loadSettings` could not open. Kept ahead of the ones written
  // here, blind and untouched: this Mac does not know which sessions they are,
  // and "cannot read it" is the one thing that must never mean "throw it away"
  // — those tokens are live on the owner's account either way.
  const carried = readSecretList(stored[sealedKey]);
  const sealedAll = values.map((value) => seal(value, active));
  if (values.length && sealedAll.every((entry) => entry !== "")) {
    stored[sealedKey] = [...carried, ...sealedAll];
    stored[plainKey] = [];
    return false;
  }
  if (!values.length && carried.length) {
    stored[sealedKey] = carried;
    stored[plainKey] = [];
    return false;
  }
  if (carried.length) stored[sealedKey] = carried;
  else delete stored[sealedKey];
  stored[plainKey] = values;
  return values.length > 0;
}

/** Whatever the file held where a list of secrets belongs, as a list of
 * non-empty strings. A hand-edited file can put anything here. */
function readSecretList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
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
   * Login sessions this Mac holds ONLY so they can be retired.
   *
   * A verified session it will not keep — a sign-out that landed mid-login, a
   * handoff that failed — has to be revoked, and the redeem that produced it
   * answers exactly once. When that revoke fails there is nowhere else the
   * token exists: dropping it leaves the owner's account carrying a live
   * `*:*` session for 180 days with nothing anywhere able to retire it. So it
   * is kept here, every entry retried before the next activation and on the
   * next launch, and each cleared the moment the server confirms.
   *
   * A LIST, and that is the point. It was one slot, which meant a second
   * failed revoke silently overwrote the first — the same orphaned session,
   * arrived at one layer further in. Sessions accumulate here only while Plow
   * is unreachable, and the same token is never held twice.
   *
   * SECRETS, sealed and never shown, exactly like `relayCredential`. None of
   * them is a credential this Mac USES — nothing reads them but the retry.
   */
  pendingRevocations: string[];
  /** `pendingRevocations`, each entry ENCRYPTED, when the OS offered a way.
   * Only one of this and `pendingRevocations` is ever on disk. */
  pendingRevocationsEnc?: string[];
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
    pendingRevocations: [],
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
  // A seal that opens becomes the plaintext and the ciphertext is dropped from
  // the object, because `saveSettings` will write it again from that plaintext.
  // A seal that does NOT open is carried instead — this Mac cannot read the
  // secret right now, which is not the same as not having one, and the whole
  // of `storeSecret` depends on telling those apart.
  //
  // This deliberately no longer reads as "signed out". It used to blank the
  // account uid, the endpoint and the provisioned chat here, on the theory
  // that an unopenable seal meant a home that had lost its credential for
  // good — and a locked keychain is a Tuesday, not a lost credential. The
  // fields come back on the first read that can open the seal. `signOutOfPlow`
  // still clears the same set, which is where clearing them belongs.
  const sealed = typeof loaded.relayCredentialEnc === "string" ? loaded.relayCredentialEnc : "";
  if (sealed) {
    loaded.relayCredential = unseal(sealed);
    loaded.relayCredentialEnc = loaded.relayCredential ? undefined : sealed;
  }
  // Entry by entry, and the same rule: the ones that open become tokens the
  // retry can use, the ones that do not are carried back as ciphertext for
  // `saveSettings` to write again untouched. Reporting an unopened entry as a
  // token would put a value the server has never seen into a revoke; dropping
  // it would strand a live session. It is neither.
  const sealedPending = readSecretList(loaded.pendingRevocationsEnc);
  if (sealedPending.length) {
    const opened = sealedPending.map((entry) => ({ entry, token: unseal(entry) }));
    loaded.pendingRevocations = opened.filter((o) => o.token).map((o) => o.token);
    const unopened = opened.filter((o) => !o.token).map((o) => o.entry);
    loaded.pendingRevocationsEnc = unopened.length ? unopened : undefined;
  } else {
    loaded.pendingRevocations = readSecretList(loaded.pendingRevocations);
    loaded.pendingRevocationsEnc = undefined;
  }
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
      (!sealedPending.length && loaded.pendingRevocations.length > 0));
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
  const pendingInClear = storeSecretList(
    stored,
    "pendingRevocations",
    "pendingRevocationsEnc",
    active,
  );
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

/**
 * Keep a session token for a later revoke, ALONGSIDE any already held.
 *
 * THE one place a failed revocation is retained, and it is here rather than in
 * either caller because both of them have the same problem and only one of
 * them used to know it: `Onboarding` holds tokens a login never persisted, and
 * sign-out holds the credential whose revoke did not land. A retention that
 * lived in one of them left the other silently dropping a live `*:*` session.
 *
 * Appended, never assigned. A single slot looked like it was doing this job
 * and was not: a second failure overwrote the first, which is the same
 * orphaned session, reached one layer further in. De-duplicated, because every
 * retry that fails comes back holding a token already on the list.
 *
 * Read fresh: every caller reaches this on the far side of a network call, and
 * anything may have written settings while it was out.
 */
export function holdForRevocation(home: string, token: string): void {
  const value = (token ?? "").trim();
  if (!value) return;
  const settings = loadSettings(home);
  if (settings.pendingRevocations.includes(value)) return;
  settings.pendingRevocations = [...settings.pendingRevocations, value];
  saveSettings(home, settings);
}

/** Forget one token the server has confirmed dead, leaving the rest alone. */
export function releaseRevocation(home: string, token: string): void {
  const settings = loadSettings(home);
  if (!settings.pendingRevocations.includes(token)) return;
  settings.pendingRevocations = settings.pendingRevocations.filter((held) => held !== token);
  saveSettings(home, settings);
}

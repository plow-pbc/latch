/**
 * App settings persisted under DOMO_HOME.
 *
 * This file holds a secret — the Plow relay credential — so it is written
 * **owner-only**. It used to be written with no mode at all, which on a shared
 * or backed-up Mac is a plaintext credential anyone could read. safeStorage
 * seals it wherever the OS offers a way; 0600 remains the floor for the
 * plaintext fallback.
 */
import fs from "node:fs";
import path from "node:path";
import { canonicalAgentHostUrl } from "./plowApi.js";

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
 * A decrypt that fails is not a crash: the keychain entry can be gone after a
 * restored backup or a new login keychain. The honest answer is that this Mac
 * does not hold the secret.
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
 *                  does — there is no human in this mode (default). It FAILS
 *                  CLOSED: no credential, an API error, a timeout, a refusal or
 *                  an answer that is not a verdict all deny the operation
 *                  outright, each with a source saying which it was.
 *   - ask:         always show the approval dialog
 *   - deny:        auto-deny, no dialog
 */
export type ApprovalMode = "approve" | "adversarial" | "ask" | "deny";

/**
 * The mode a home gets before its owner has chosen one. Adversarial rather
 * than Ask: the reviewer decides out of the box, and the owner opts INTO
 * per-operation dialogs. Safe on a not-yet-signed-in Mac because adversarial
 * fails closed — no credential means deny, and no agent can reach an
 * unsigned-in Mac anyway.
 */
export const DEFAULT_APPROVAL_MODE: ApprovalMode = "adversarial";

/**
 * What this Mac remembers about one cloud agent, on its own.
 *
 * Local because nothing on the server knows about it: adversarial review is
 * this app's reviewer, not a property of the machine Plow provisioned.
 */
/** The one self-hosted host, as it is kept on disk. */
export interface SelfHostedHost {
  baseUrl: string;
  /** A SECRET: sealed at rest, and never sent to the renderer. */
  bearer: string;
}

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
  /** The account this Mac is signed into. */
  accountUid: string;
  /** This installation's server-authored MCP endpoint. */
  mcpUrl: string;
  /**
   * The one self-hosted `agent-mgr` host this Mac drives, or `null`.
   *
   * ONE, not a list. A Mac points at its own box; `agent-mgr` also answers with
   * the agent's NAME as its `agent_id` rather than a uuid, so a second host
   * holding a same-named agent would collapse onto the first one's roster row.
   * A registry that makes that reachable buys nothing a single slot does not.
   *
   * The built-in Plow target is not here either — it is derived from the
   * build's base URL and `relayCredential`. So this is the one origin a human
   * typed, and `bearer` is that host's own `AGENT_MGR_SERVE_TOKEN`. The relay
   * credential must never be copied into it: it carries the owner's full Plow
   * authority, and handing that to a URL someone typed is how a support
   * request becomes an account compromise.
   *
   * `bearer` is a secret, sealed at rest exactly as `relayCredential` is.
   */
  agentTarget: SelfHostedHost | null;
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
  /** Keep this Mac awake while plugged in (default off). The opt-in only —
   * keepAwake.ts owns when a blocker is actually held (AC power only, and an
   * acquire the OS refuses writes this back to false). */
  keepAwakeWhileRunning: boolean;
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
    accountUid: "",
    mcpUrl: "",
    selectedTab: "agents",
    approvalMode: DEFAULT_APPROVAL_MODE,
    agentPurpose: "",
    provisionedChatUid: "",
    provisionedChatLabel: "",
    agentTarget: null,
    autoCheckUpdates: true,
    autoInstallUpdates: true,
    keepAwakeWhileRunning: false,
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
  loaded.agentTarget = readAgentTarget(settings.agentTarget);
  // The encrypted field wins where it exists. A decrypt that fails is treated
  // as signed out rather than as a crash, and the unreadable value is cleared
  // below along with the account-local display state.
  // 0 users; a session that can't be revoked idles out in 180 days; revisit
  // when there's a fleet.
  const sealed = typeof loaded.relayCredentialEnc === "string" ? loaded.relayCredentialEnc : "";
  let unreadableSeal = false;
  if (sealed) {
    loaded.relayCredential = unseal(sealed);
    loaded.relayCredentialEnc = undefined;
    if (!loaded.relayCredential) {
      unreadableSeal = true;
      loaded.accountUid = "";
      loaded.mcpUrl = "";
      loaded.provisionedChatUid = "";
      loaded.provisionedChatLabel = "";
    }
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
  // The host bearer counts too. `seal()` returns "" on a transient keychain
  // failure and the caller falls back to plaintext — for the relay credential
  // this line repairs that on the next readable load, and the bearer needs the
  // same repair or it stays in the clear indefinitely.
  const bearerInClear = (loaded.agentTarget?.bearer ?? "").trim() !== "" &&
    typeof (parsed as { agentTarget?: { bearer?: unknown } })?.agentTarget?.bearer === "string" &&
    ((parsed as { agentTarget?: { bearer?: string } }).agentTarget!.bearer ?? "").trim() !== "";
  const needsSealing = activeCodec() !== null &&
    ((!sealed && loaded.relayCredential.trim() !== "") || bearerInClear);
  if (retired || needsSealing || unreadableSeal) saveSettings(home, loaded);
  return loaded;
}

export function saveSettings(home: string, settings: Settings): void {
  const file = settingsPath(home);
  // Encrypted where the OS allows, plaintext where it does not — the file is
  // 0600 either way, which is what it has always been, so an unavailable
  // keychain is no worse than yesterday rather than a Mac that cannot sign in.
  const active = activeCodec();
  const stored: Record<string, unknown> = { ...settings };
  const credential = String(stored.relayCredential ?? "").trim();
  const encrypted = seal(credential, active);
  if (encrypted) {
    stored.relayCredentialEnc = encrypted;
    stored.relayCredential = "";
  } else {
    delete stored.relayCredentialEnc;
  }
  const host = settings.agentTarget;
  if (host) {
    const bearer = host.bearer.trim();
    const sealed = seal(bearer, active);
    // Same shape as the relay credential above: sealed where the OS can, and
    // plaintext inside a 0600 file where it cannot — never both.
    stored.agentTarget = sealed
      ? { baseUrl: host.baseUrl, bearer: "", bearerEnc: sealed }
      : { baseUrl: host.baseUrl, bearer };
  } else {
    stored.agentTarget = null;
  }
  const credentialInClear = !encrypted && credential !== "";
  if (credentialInClear && codec && !warnedUnavailable) {
    warnedUnavailable = true;
    console.log("[settings] no OS keychain available; credential stored unencrypted (0600)");
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp`;
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(temporary, "w", 0o600);
    // `mode` only applies when the file is created. A temp left by an interrupted
    // process is reused, so repair it before any secret bytes are written.
    fs.fchmodSync(descriptor, 0o600);
    const contents = Buffer.from(JSON.stringify(stored, null, 2) + "\n");
    let offset = 0;
    while (offset < contents.length) {
      const written = fs.writeSync(descriptor, contents, offset, contents.length - offset);
      if (written <= 0) throw new Error("settings write made no progress");
      offset += written;
    }
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporary, file);
  } catch (error) {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch {}
    }
    try {
      fs.unlinkSync(temporary);
    } catch {}
    throw error;
  }
}

/**
 * The stored self-hosted host, or `null` when there is not a usable one.
 *
 * A trust boundary, not housekeeping: every reader treats this as a live
 * request target, and a hand-edited file can put anything here. It survives
 * only if it can actually be used —
 *
 * - **No bearer, no host.** A sealed bearer this Mac can no longer decrypt (a
 *   restored backup, a new login keychain) leaves an origin that answers 401
 *   to everything. Dropping it costs the owner two fields to re-enter; keeping
 *   it costs them an error with no explanation.
 * - **The address is canonicalised or refused** — see `canonicalAgentHostUrl`.
 *   Applied here and not only on entry, so a host written by hand, or by a
 *   build from before the rule existed, gets it too.
 */
function readAgentTarget(raw: unknown): SelfHostedHost | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
  const baseUrl = canonicalAgentHostUrl(text(row.baseUrl));
  const sealedBearer = text(row.bearerEnc);
  const bearer = sealedBearer ? unseal(sealedBearer).trim() : text(row.bearer);
  if (!baseUrl || !bearer) return null;
  return { baseUrl, bearer };
}

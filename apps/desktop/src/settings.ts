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
export interface CloudAgentLocalSettings {
  adversarialReview: boolean;
}

export interface Settings {
  /* There is deliberately NO API base URL here. It is baked into the build
   * (`resolveApiBaseUrl`), because a credential is only valid against the
   * environment that minted it — a user-editable origin would turn a stored
   * token silently meaningless and produce an auth error nobody could explain.
   * The old `relayUrl` WebSocket setting is gone with it; the socket is derived
   * from the build's base URL by `relaySocketUrl`. */
  /** A `relay:device` key, minted by first-run login and never seen by the
   * user. A SECRET: it is never sent to the renderer and never written to a log
   * or an error string. */
  relayCredential: string;
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
  /** In Ask mode, highlight the button the adversarial agent suggests. */
  showAgentSuggestions: boolean;
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
  /**
   * The number this Mac's completed activation told it to text — the server's
   * assigned pool line, **verbatim**.
   *
   * Kept because there is no call that answers "which line is mine": the
   * relationship exists only inside the activation that created it, so it is
   * stored here or it is lost. The cloud-agent screen needs it to explain how a
   * new chat comes to exist.
   *
   * NEVER a number chosen here. Empty means we do not know one, and a screen
   * must say so rather than fill the gap — texting the right code to the wrong
   * number activates the account and provisions no chat at all.
   */
  activationSendTo: string;
  /**
   * Local per-cloud-agent settings, keyed on `agent_id`.
   *
   * `agent_id` and NEVER `session_id`: reconfiguring an agent mints a fresh
   * credential by design, so anything stored against the session id silently
   * resets itself the first time the user changes a permission. The id is
   * stable for the agent's whole life.
   *
   * Entries for agents that no longer exist are dropped when the agent is
   * removed; nothing here is a secret.
   */
  cloudAgentSettings: Record<string, CloudAgentLocalSettings>;
  /** The first-run launch-at-login default has been applied (main.ts's
   * `applyFirstRunLaunchAtLogin`). NOT a mirror of the OS's login-item bit —
   * loginItem.ts explains why none exists — only the record that the one-time
   * default ran, so it can never run twice and a user who turns the toggle off
   * stays off. Deliberately survives sign-out: a re-setup is not a first run.
   * A signed-in home from before this field existed is grandfathered on load —
   * see `loadSettings` — for the same reason. */
  launchAtLoginDefaulted: boolean;
}

/** Keep only well-formed `agent_id` → settings entries; drop the rest. */
function normalizeCloudAgentSettings(raw: unknown): Record<string, CloudAgentLocalSettings> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, CloudAgentLocalSettings> = {};
  for (const [agentId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!agentId || !value || typeof value !== "object") continue;
    out[agentId] = {
      adversarialReview: (value as Record<string, unknown>).adversarialReview === true,
    };
  }
  return out;
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
    approvalMode: "ask",
    showAgentSuggestions: true,
    agentPurpose: "",
    provisionedChatUid: "",
    provisionedChatLabel: "",
    activationSendTo: "",
    autoCheckUpdates: true,
    autoInstallUpdates: true,
    launchAtLoginDefaulted: false,
    cloudAgentSettings: {},
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
  // The spread above copies whatever the file held, and a hand-edited or
  // truncated file can put a non-object — or a `null` — where a record belongs.
  // Every reader of this map indexes it, so normalising once here is what keeps
  // a bad file from being a crash on the Agents tab.
  loaded.cloudAgentSettings = normalizeCloudAgentSettings(settings.cloudAgentSettings);
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
  if (retired) saveSettings(home, loaded);
  return loaded;
}

export function saveSettings(home: string, settings: Settings): void {
  const file = settingsPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // mode on writeFileSync only applies when the file is created, so chmod
  // unconditionally — otherwise a file that predates this change keeps its
  // old permissions forever.
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

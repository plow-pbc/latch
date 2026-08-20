/**
 * App settings persisted under DOMO_HOME.
 *
 * This file holds a secret — the Plow relay credential — so it is written
 * **owner-only**. It used to be written with no mode at all, which on a shared
 * or backed-up Mac is a plaintext credential anyone could read. There is still no Keychain or `safeStorage` here; 0600 is the floor,
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
    approvalMode: "ask",
    showAgentSuggestions: true,
    agentPurpose: "",
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
  const { settings, retired } = withoutRetiredKeys(parsed);
  const loaded = { ...defaults, ...settings };
  // A signed-in home from before `launchAtLoginDefaulted` existed: its owner's
  // launch-at-login choice predates the default, so reading the absent field as
  // false would let a later re-setup flip the bit on them. Grandfather it as
  // already defaulted. This can never swallow a genuinely new home's default:
  // setup saves the whole Settings object, so any file holding a credential
  // written since this field existed carries the key explicitly. Asked of the
  // scrubbed record rather than the raw parse — the scrub only ever removes the
  // retired key names, so the two answer this identically.
  if (!("launchAtLoginDefaulted" in settings) && loaded.relayCredential.trim()) {
    loaded.launchAtLoginDefaulted = true;
  }
  // Take them OFF DISK, here, rather than waiting for the next write of some
  // unrelated setting. A retired credential that is merely unread is still a
  // credential sitting in a file; the whole point of the scrub is that it stops
  // being one. Best effort — a home that cannot be written is not a reason to
  // fail the load — and it happens at most once, because the second read finds
  // nothing to remove.
  if (retired) {
    try {
      saveSettings(home, loaded);
    } catch {
      // Nothing actionable, and nothing worth logging: the only interesting
      // value in scope is the credential being removed.
    }
  }
  return loaded;
}

/**
 * Drop the bring-your-own-key fields this app no longer has.
 *
 * Unknown keys otherwise survive a load/save round-trip — the spread above
 * carries them in and `saveSettings` writes the whole object back — so a Mac
 * that once held a pasted Anthropic key would keep it on disk forever, unread
 * by anything and readable by anyone who opens the file. A retired credential
 * is not inert data; it is a live secret with nothing left to use it.
 *
 * The scrub happens on READ and writes the file back immediately, so a home is
 * cleaned by being opened rather than by a migration step somebody has to
 * remember to run. Removing a name from this list once the fleet has turned
 * over is the intended end state — it is not a permanent fixture.
 */
const RETIRED_KEYS = ["anthropicApiKey", "inferenceProvider"];

function withoutRetiredKeys(parsed: unknown): {
  settings: Record<string, unknown>;
  retired: boolean;
} {
  if (!parsed || typeof parsed !== "object") return { settings: {}, retired: false };
  const settings = { ...(parsed as Record<string, unknown>) };
  let retired = false;
  for (const key of RETIRED_KEYS) {
    if (key in settings) {
      delete settings[key];
      retired = true;
    }
  }
  return { settings, retired };
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

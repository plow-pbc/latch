/**
 * App settings persisted under DOMO_HOME.
 *
 * This file holds secrets — the Plow relay credential and an Anthropic API key
 * — so it is written **owner-only**. It used to be written with no mode at all,
 * which on a shared or backed-up Mac is a plaintext credential anyone could
 * read. There is still no Keychain or `safeStorage` here; 0600 is the floor,
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
 * Which backend runs the adversarial reviewer:
 *   - plow:      Plow's API, billed to the signed-in Plow account, authenticated
 *                with this Mac's relay credential. The default.
 *   - anthropic: the Anthropic API with a key the user pastes below.
 *
 * The tuple is the single source: the type derives from it, validation iterates
 * it, and availability is keyed by it. Adding a provider is one edit here.
 */
export const INFERENCE_PROVIDERS = ["plow", "anthropic"] as const;

export type InferenceProvider = (typeof INFERENCE_PROVIDERS)[number];

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
  /** Anthropic API key — required for the adversarial agent features. */
  anthropicApiKey: string;
  /** Which backend runs the reviewer. An absent field reads as `plow`. */
  inferenceProvider: InferenceProvider;
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
    anthropicApiKey: "",
    inferenceProvider: "plow",
    agentPurpose: "",
    autoCheckUpdates: true,
    autoInstallUpdates: true,
    launchAtLoginDefaulted: false,
  };
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath(home), "utf8"));
    const settings: Settings = { ...defaults, ...parsed };
    // A signed-in home from before `launchAtLoginDefaulted` existed: its
    // owner's launch-at-login choice predates the default, so reading the
    // absent field as false would let a later re-setup flip the bit on them.
    // Grandfather it as already defaulted. This can never swallow a genuinely
    // new home's default: setup saves the whole Settings object, so any file
    // holding a credential written since this field existed carries the key
    // explicitly.
    if (!("launchAtLoginDefaulted" in parsed) && settings.relayCredential.trim()) {
      settings.launchAtLoginDefaulted = true;
    }
    return settings;
  } catch {
    return defaults;
  }
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

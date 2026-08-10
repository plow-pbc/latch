/**
 * App settings persisted under DOMO_HOME. The editable broker connection
 * string is the only thing here today (mirrors the Swift settings window).
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
 * How operation intents (NOT device pairing/access — those are always asked)
 * are decided:
 *   - approve:     auto "allow once", no dialog
 *   - adversarial: (placeholder) an adversarial-agent review; for now waits
 *                  briefly, then "allow once"
 *   - ask:         always show the approval dialog (default)
 *   - deny:        auto-deny, no dialog
 */
export type ApprovalMode = "approve" | "adversarial" | "ask" | "deny";

/**
 * How the app reaches a broker:
 *   - broker: dial the configured broker connection (wss:// URL + pin) — default
 *   - local:  run the broker in-process and talk to it over Unix sockets;
 *             nothing listens on the network and it dies with the app
 */
export type ConnectionMode = "broker" | "local";

export interface Settings {
  brokerConnection: string;
  /** Where agent requests come from (network broker vs in-app local broker). */
  connectionMode: ConnectionMode;
  /** The last-selected main-window tab, restored across launches. */
  selectedTab: string;
  /** The main window's last size + position, restored across launches. */
  windowBounds?: WindowBounds;
  /** How operation intents are decided (device pairing is always asked). */
  approvalMode: ApprovalMode;
  /** In Ask mode, highlight the button the adversarial agent suggests. */
  showAgentSuggestions: boolean;
  /** Anthropic API key — required for the adversarial agent features. */
  anthropicApiKey: string;
}

function settingsPath(home: string): string {
  return path.join(home, "app/settings.json");
}

export function loadSettings(home: string): Settings {
  const defaults: Settings = {
    brokerConnection: "",
    connectionMode: "broker",
    selectedTab: "audit",
    approvalMode: "ask",
    showAgentSuggestions: true,
    anthropicApiKey: "",
  };
  try {
    return { ...defaults, ...JSON.parse(fs.readFileSync(settingsPath(home), "utf8")) };
  } catch {
    return defaults;
  }
}

export function saveSettings(home: string, settings: Settings): void {
  const file = settingsPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
}

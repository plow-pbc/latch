/**
 * App settings persisted under DOMO_HOME.
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
 *   - adversarial: a Claude-backed adversarial review decides. It FAILS CLOSED:
 *                  no API key, an API error, a timeout, a refusal or an answer
 *                  that is not a verdict all fall back to `ask`, so a broken
 *                  reviewer hands the decision to the human and never approves.
 *   - ask:         always show the approval dialog (default)
 *   - deny:        auto-deny, no dialog
 */
export type ApprovalMode = "approve" | "adversarial" | "ask" | "deny";

export interface Settings {
  /** The last-selected main-window tab, restored across launches. */
  selectedTab: string;
  /** The main window's last size + position, restored across launches. */
  windowBounds?: WindowBounds;
  /** How operation intents are decided. */
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

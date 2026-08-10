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

export interface Settings {
  brokerConnection: string;
  /** The last-selected main-window tab, restored across launches. */
  selectedTab: string;
  /** The main window's last size + position, restored across launches. */
  windowBounds?: WindowBounds;
}

function settingsPath(home: string): string {
  return path.join(home, "app/settings.json");
}

export function loadSettings(home: string): Settings {
  const defaults: Settings = { brokerConnection: "", selectedTab: "audit" };
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

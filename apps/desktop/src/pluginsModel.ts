/**
 * The Plugins tab's view model — pure, like capabilitiesModel.ts. A row
 * answers one question per plugin: can it work right now, and if not, what is
 * the one thing the owner has to do? A requirement that is MET is silent —
 * the tab is a list of what is stopping the agent, not an inventory (that is
 * Settings' Permissions section).
 */
import type { PluginManifest } from "@domo/device-core";

export type PluginStatus = "off" | "needs-setup" | "ready";

export interface UnmetRequirement {
  id: string;
  /** What the owner's button does, in their words: "Connect Google". */
  action: string;
}

export interface PluginRow {
  name: string;
  /** The plugin's skill's `description:` — the caller passes it through.
   *  Deliberately NOT a manifest field: a second place to write the same
   *  sentence is a second place for it to drift. */
  description: string | null;
  status: PluginStatus;
  unmet: UnmetRequirement[];
}

export interface PluginsInput {
  plugins: { manifest: PluginManifest; enabled: boolean; description?: string | null }[];
  /** Connector ids the owner has connected, e.g. "google". */
  connectedAccounts: string[];
}

/** One row per plugin, in the order they were staged. */
export function pluginRows(input: PluginsInput): PluginRow[] {
  const accounts = new Set(input.connectedAccounts);
  return input.plugins.map(({ manifest, enabled, description }) => {
    const unmet: UnmetRequirement[] = manifest.requires.accounts
      .filter((id) => !accounts.has(id))
      .map((id) => ({ id, action: "Connect Google" }));
    // Off wins: a disabled plugin's unmet requirements are not the owner's
    // problem until they turn it back on.
    const status: PluginStatus = !enabled ? "off" : unmet.length > 0 ? "needs-setup" : "ready";
    return { name: manifest.name, description: description ?? null, status, unmet: status === "off" ? [] : unmet };
  });
}

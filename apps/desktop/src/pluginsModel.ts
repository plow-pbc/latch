/**
 * The Plugins tab's view model — pure, like capabilitiesModel.ts. A row
 * answers one question per plugin: can it work right now, and if not, what is
 * the one thing the owner has to do? A requirement that is MET is silent —
 * the tab is a list of what is stopping the agent, not an inventory (that is
 * Settings' Permissions section).
 */
import type { PluginManifest } from "@domo/device-core";

export type PluginStatus = "off" | "needs-setup" | "ready";

/** A CLI plugin runs a manifest's binary; the browser is the one hardwired
 *  row with no manifest at all. The badge the renderer used to hardcode. */
export type PluginKind = "CLI" | "Browser";

export interface UnmetRequirement {
  id: string;
  /** What the owner's button does, in their words: "Connect Google". Null
   *  when nothing the app can do for the owner here (e.g. a missing browser
   *  runtime — that is a from-source fact, not a setting to flip). */
  action: string | null;
}

export interface PluginRow {
  name: string;
  /** The row's heading. A CLI plugin's is its manifest name; the browser's
   *  is fixed — "browser" would read as a technical name, not a feature. */
  title: string;
  kind: PluginKind;
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
    return {
      name: manifest.name,
      title: manifest.name,
      kind: "CLI",
      description: description ?? null,
      status,
      unmet: status === "off" ? [] : unmet,
    };
  });
}

export const SAFARI_JAVASCRIPT = "safari-javascript-from-apple-events";
export const BROWSER_RUNTIME = "browser-runtime";

/** The browser is a plugin without a manifest — the Camoufox tools and the
 *  Safari fallback as one row the owner can turn off. Its one actionable
 *  requirement is Safari's "Allow JavaScript from Apple Events", which the
 *  app performs for them (safariJavaScript.ts); the runtime ships in every
 *  packaged build, so its absence is a from-source fact with no button. */
export function browserPluginRow(input: {
  enabled: boolean;
  runtimePresent: boolean;
  safariJavaScript: boolean;
  description: string | null;
}): PluginRow {
  const unmet: UnmetRequirement[] = [];
  if (!input.runtimePresent) unmet.push({ id: BROWSER_RUNTIME, action: null });
  if (!input.safariJavaScript) unmet.push({ id: SAFARI_JAVASCRIPT, action: "Enable in Safari" });
  const status: PluginStatus = !input.enabled ? "off" : unmet.length > 0 ? "needs-setup" : "ready";
  return {
    name: "browser",
    title: "Browser use",
    kind: "Browser",
    description: input.description,
    status,
    unmet: status === "off" ? [] : unmet,
  };
}

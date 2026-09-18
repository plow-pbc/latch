/**
 * The Plugins tab's view model — pure, like capabilitiesModel.ts. A row
 * answers one question per plugin: can it work right now, and if not, what is
 * the one thing the owner has to do? A requirement that is MET is silent —
 * the tab is a list of what is stopping the agent, not an inventory (that is
 * Settings' Permissions section).
 */
import { BROWSER_PLUGIN, missingPluginAccounts, type PluginManifest } from "@domo/device-core";

export type PluginStatus = "off" | "needs-setup" | "ready";

/** A CLI plugin runs a manifest's binary; the browser is the one hardwired
 *  row with no manifest at all. The badge the renderer used to hardcode. */
export type PluginKind = "CLI" | "Browser";

export interface UnmetRequirement {
  id: string;
  /** The row's words, like the button's: what is missing ("Safari") and the
   *  one line under it. The renderer is plain JS with no imports, so the
   *  model carries every string it shows rather than a table keyed on ids. */
  title: string;
  detail: string;
  /** What the owner's button does, in their words: "Connect Google". Null
   *  when nothing the app can do for the owner here (e.g. a missing browser
   *  runtime — that is a from-source fact, not a setting to flip). */
  action: string | null;
}

export interface PluginRow {
  name: string;
  /** The row's heading — a technical name reads as jargon, not a feature. A
   *  CLI plugin's is its manifest's `title` (its `name` when it has none);
   *  the browser's is fixed. */
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
    const unmet: UnmetRequirement[] = missingPluginAccounts(manifest.requires, accounts)
      .map((id) => ({ id, title: "Account", detail: id, action: "Connect Google" }));
    // Off wins: a disabled plugin's unmet requirements are not the owner's
    // problem until they turn it back on.
    const status: PluginStatus = !enabled ? "off" : unmet.length > 0 ? "needs-setup" : "ready";
    return {
      name: manifest.name,
      title: manifest.title ?? manifest.name,
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
  if (!input.runtimePresent) {
    unmet.push({ id: BROWSER_RUNTIME, title: "Browser runtime", detail: "Not in this build — from source, run just fetch-browser", action: null });
  }
  if (!input.safariJavaScript) {
    unmet.push({ id: SAFARI_JAVASCRIPT, title: "Safari", detail: "Allow JavaScript from Apple Events — Safari relaunches", action: "Enable in Safari" });
  }
  const status: PluginStatus = !input.enabled ? "off" : unmet.length > 0 ? "needs-setup" : "ready";
  return {
    name: BROWSER_PLUGIN,
    title: "Browser use",
    kind: "Browser",
    description: input.description,
    status,
    unmet: status === "off" ? [] : unmet,
  };
}

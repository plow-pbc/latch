/**
 * The Plugins tab's view model — pure, like capabilitiesModel.ts. A row
 * reports every requirement a plugin declares, met or not; the tab decides
 * what to show and the setup flow walks `grantList()` to ask for what is
 * still missing.
 */
import { BROWSER_PLUGIN, type PluginManifest } from "@domo/device-core";
import { paneFor, permissionTitle } from "./capabilitiesModel.js";

export type PluginStatus = "off" | "needs-setup" | "ready";

/** A CLI plugin runs a manifest's binary; the browser is the one hardwired
 *  row with no manifest at all. The badge the renderer used to hardcode. */
export type PluginKind = "CLI" | "Browser";

export interface Requirement {
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
  /** The line setup's Access row shows while this requirement's flow runs:
   *  where the owner is needed. Empty for one setup never runs. */
  waiting: string;
  /** The word setup's Access row shows once it is met: "Granted",
   *  "Connected". Empty for one setup never runs. */
  done: string;
  /** "relaunch": granted, but only a relaunch lets this app's children
   *  inherit it — the button relaunches rather than acting. */
  status: "open" | "met" | "relaunch";
}

export interface PluginRow {
  name: string;
  /** The row's heading — a technical name reads as jargon, not a feature. A
   *  CLI plugin's is its manifest's `title` (its `name` when it has none);
   *  the browser's is fixed. */
  title: string;
  /** The manifest's `summary` — what the setup flow reads for this plugin.
   *  Absent (or the browser's fixed one) is null. */
  summary: string | null;
  kind: PluginKind;
  /** The plugin's skill's `description:` — the caller passes it through.
   *  Deliberately NOT a manifest field: a second place to write the same
   *  sentence is a second place for it to drift. */
  description: string | null;
  status: PluginStatus;
  /** Every requirement the manifest declares, met or not — status decides
   *  whether the plugin can run; hiding a met one is the tab's business. */
  requirements: Requirement[];
}

export interface PluginsInput {
  plugins: { manifest: PluginManifest; enabled: boolean; description?: string | null }[];
  /** Connector ids the owner has connected, e.g. "google". */
  connectedAccounts: string[];
  /** Permission keys this Mac's inventory reads as granted. */
  grantedPermissions: string[];
  /** Permission keys granted during this run that a relaunch will finish. */
  relaunchPending: string[];
}

/** The Access screen's row id for an account connector, distinct from a
 *  permission's own key so the two id spaces never collide. */
export const accountRequirementId = (id: string): string => `account:${id}`;

function permissionRequirement(key: string, met: boolean, relaunch: boolean): Requirement {
  const title = permissionTitle(key);
  const done = "Granted";
  if (relaunch) {
    // Setup never runs it, so no waiting line: its button is the relaunch.
    return { id: key, title, detail: "Quit and reopen Plow Latch to finish.", action: "Relaunch Plow Latch", waiting: "", done, status: "relaunch" };
  }
  return {
    id: key,
    title,
    detail: paneFor(key)?.acceptsDrop
      ? "Drag Plow Latch into the list in System Settings."
      : "Allow it when macOS asks, or in System Settings.",
    action: `Grant ${title}`,
    waiting: "Waiting for you in System Settings…",
    done,
    status: met ? "met" : "open",
  };
}

/** `ACCOUNT_IDS` in manifest.ts is `{google}` only, so the fixed Google
 *  title and copy are right for every account requirement today. */
function accountRequirement(id: string, met: boolean): Requirement {
  return {
    id: accountRequirementId(id),
    title: "Google account",
    detail: "Sign in with Google in your browser.",
    action: "Connect Google",
    waiting: "Finish signing in with Google in your browser.",
    done: "Connected",
    status: met ? "met" : "open",
  };
}

/** Off wins over an unmet requirement — a disabled plugin's status is `off`
 *  regardless — but the requirements themselves are always reported. */
function rowStatus(enabled: boolean, requirements: readonly Requirement[]): PluginStatus {
  return !enabled ? "off" : requirements.some((r) => r.status !== "met") ? "needs-setup" : "ready";
}

/** One row per plugin, in the order they were staged. */
export function pluginRows(input: PluginsInput): PluginRow[] {
  const accounts = new Set(input.connectedAccounts);
  const granted = new Set(input.grantedPermissions);
  const pending = new Set(input.relaunchPending);
  return input.plugins.map(({ manifest, enabled, description }) => {
    const requirements: Requirement[] = [
      ...manifest.requires.permissions.map((key) => permissionRequirement(key, granted.has(key), pending.has(key))),
      ...manifest.requires.accounts.map((id) => accountRequirement(id, accounts.has(id))),
    ];
    return {
      name: manifest.name,
      title: manifest.title ?? manifest.name,
      summary: manifest.summary ?? null,
      kind: "CLI",
      description: description ?? null,
      status: rowStatus(enabled, requirements),
      requirements,
    };
  });
}

export const SAFARI_JAVASCRIPT = "safari-javascript-from-apple-events";
export const BROWSER_RUNTIME = "browser-runtime";

/** The browser is a plugin without a manifest — the Camoufox tools and the
 *  Safari fallback as one row the owner can turn off. Its one actionable
 *  requirement is Safari's "Allow JavaScript from Apple Events", which the
 *  app performs for them (safariJavaScript.ts) and which needs Full Disk
 *  Access only to WRITE that setting — so Full Disk Access only shows up
 *  while Safari's setting is still off. The runtime ships in every packaged
 *  build, so its absence is a from-source fact with no button. */
export function browserPluginRow(input: {
  enabled: boolean;
  runtimePresent: boolean;
  safariJavaScript: boolean;
  fullDiskAccess: boolean;
  relaunchPending: string[];
  description: string | null;
}): PluginRow {
  const requirements: Requirement[] = [];
  if (!input.safariJavaScript) {
    requirements.push(permissionRequirement("full_disk_access", input.fullDiskAccess, input.relaunchPending.includes("full_disk_access")));
  }
  requirements.push({
    id: SAFARI_JAVASCRIPT,
    title: "Safari",
    detail: "Allow JavaScript from Apple Events — Safari relaunches",
    action: "Enable in Safari",
    waiting: "Turning it on. Safari relaunches.",
    done: "On",
    status: input.safariJavaScript ? "met" : "open",
  });
  if (!input.runtimePresent) {
    requirements.push({ id: BROWSER_RUNTIME, title: "Browser runtime", detail: "Not in this build — from source, run just fetch-browser", action: null, waiting: "", done: "", status: "open" });
  }
  return {
    name: BROWSER_PLUGIN,
    title: "Browser use",
    summary: "Browse and fill in forms in a private browser, with Safari as a fallback.",
    kind: "Browser",
    description: input.description,
    status: rowStatus(input.enabled, requirements),
    requirements,
  };
}

export interface GrantItem extends Requirement {
  /** Titles of the switched-on plugins that need it, in row order, deduped. */
  plugins: string[];
}

const rank = (id: string): number => (id.startsWith(accountRequirementId("")) ? 2 : id === SAFARI_JAVASCRIPT ? 1 : 0);

/** Every switched-on plugin's still-actionable requirements, as one ordered
 *  list the setup flow walks: permissions, then Safari, then accounts. A
 *  requirement two plugins share lists once, with both titles; an
 *  action-less one (the runtime) has nothing for setup to do and is
 *  dropped; a met one stays, so the Access screen can tick it off. */
export function grantList(rows: readonly PluginRow[]): GrantItem[] {
  const byId = new Map<string, GrantItem>();
  for (const row of rows) {
    if (row.status === "off") continue;
    for (const req of row.requirements) {
      if (req.action === null) continue;
      const existing = byId.get(req.id);
      if (existing) {
        if (!existing.plugins.includes(row.title)) existing.plugins.push(row.title);
      } else {
        byId.set(req.id, { ...req, plugins: [row.title] });
      }
    }
  }
  return [...byId.values()].sort((a, b) => rank(a.id) - rank(b.id));
}

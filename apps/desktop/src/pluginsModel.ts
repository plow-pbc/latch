/**
 * The Plugins tab's view model — pure, like capabilitiesModel.ts, whose
 * successor it is: the tab it drives replaces Capabilities, and the switches
 * that tab listed are now one of the three kinds of thing a plugin requires.
 *
 * A row answers one question per plugin: can it work right now, and if not,
 * what is the one thing the owner has to do? A requirement that is MET is
 * silent — the tab is a list of what is stopping the agent, not an
 * inventory. The full inventory lives in Settings, and whether a permission
 * is MET is that pane's answer, handed in — never re-derived here.
 *
 * `blockedCount` keeps the Capabilities badge's semantics exactly: it counts
 * only while a requirement is unmet AND something has actually hit it, and it
 * clears the moment the switch flips, with nobody marking anything done. It
 * is not a fourth status — a plugin that has been hit still needs the same
 * remedy; the count changes the urgency.
 *
 * The audit log is not re-folded here: `blocked` arrives already grouped by
 * `capabilitiesModel`'s `blockedGroups`, joined to plugins by
 * `pluginBlockCounts` below. One fold of the log, one place it lives.
 */
import type { PluginManifest } from "@domo/device-core";
import { PERMISSION_TITLES, type BlockedGroup, type RowStatus } from "./capabilitiesModel.js";

export type PluginStatus = "off" | "needs-setup" | "ready";

export interface UnmetRequirement {
  kind: "account" | "permission" | "path";
  id: string;
  /**
   * What the owner's button does, in their words: "Connect Google". The
   * `path` kind carries manifest text, so a renderer sets this with
   * `textContent` and never as HTML — the same rule the approval window
   * follows for every agent-controlled string.
   */
  action: string;
}

export interface PluginRow {
  name: string;
  /** Derived, never declared: a manifest that declares `exec.argv` IS a CLI,
   *  so there is no `kind` field to keep in sync and the badge is right the
   *  day a plugin isn't one. Every manifest carries one today — parseManifest
   *  requires it — so this reads true until a non-exec runtime kind lands. */
  isCli: boolean;
  /** The plugin's skill's `description:`, as SkillRegistry parsed it — the
   *  caller passes it through. Deliberately NOT a manifest field: a second
   *  place to write the same sentence is a second place for it to drift. */
  description: string | null;
  status: PluginStatus;
  unmet: UnmetRequirement[];
  /** 0 when nothing has hit an unmet requirement. */
  blockedCount: number;
}

export interface PluginsInput {
  plugins: { manifest: PluginManifest; enabled: boolean; description?: string | null }[];
  /** Every switch's status, as `capabilitiesModel.permissionStatuses` reads
   *  it — folder memos, the audit fold and the Full Disk Access umbrella
   *  already in. Not re-derived here: a second opinion about a status is how
   *  a switch Settings already knows is granted reads "Needs setup" on this
   *  tab. An id it has no answer for is unmet, which is the honest answer. */
  permissionStatus: Record<string, RowStatus>;
  /** Connector ids the owner has connected, e.g. "google". */
  connectedAccounts: string[];
  /** The declared paths that exist, spelled as the manifest spells them.
   *  Without this every `requires.paths` reads unmet forever and a
   *  path-declaring plugin is permanently "needs setup". */
  availablePaths: string[];
  /** Per plugin name, how many requests its unmet requirements have blocked. */
  blocked: Record<string, number>;
}

/** One row per plugin, in the order they were staged. */
export function pluginRows(input: PluginsInput): PluginRow[] {
  const accounts = new Set(input.connectedAccounts);
  const paths = new Set(input.availablePaths);
  return input.plugins.map(({ manifest, enabled, description }) => {
    const { accounts: needAccounts, permissions, paths: needPaths } = manifest.requires;
    const unmet: UnmetRequirement[] = [
      ...needAccounts.filter((id) => !accounts.has(id)).map((id) => ({ kind: "account" as const, id, action: `Connect ${titleCase(id)}` })),
      ...permissions.filter((id) => input.permissionStatus[id] !== "granted").map((id) => ({ kind: "permission" as const, id, action: `Grant ${PERMISSION_TITLES[id] ?? titleCase(id)}` })),
      ...needPaths.filter((p) => !paths.has(p)).map((id) => ({ kind: "path" as const, id, action: `Create ${id}` })),
    ];
    // Off wins: a disabled plugin's unmet requirements are not the owner's
    // problem until they turn it back on, so they are not shown and not
    // counted.
    const status: PluginStatus = !enabled ? "off" : unmet.length > 0 ? "needs-setup" : "ready";
    return {
      name: manifest.name,
      isCli: manifest.exec.argv.length > 0,
      description: description ?? null,
      status,
      unmet: status === "off" ? [] : unmet,
      blockedCount: status === "needs-setup" ? (input.blocked[manifest.name] ?? 0) : 0,
    };
  });
}

/**
 * The `blocked` input, from the audit log's own grouping: a group counts for
 * every plugin that requires the permission it names. Whether a plugin is
 * enabled is not this function's question — `pluginRows` zeroes the count for
 * any status but `needs-setup`. Automation groups key on
 * `automation:<bundle id>`, so the bare permission id is compared against the
 * part before the colon.
 */
export function pluginBlockCounts(
  groups: readonly BlockedGroup[],
  plugins: readonly { manifest: PluginManifest }[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const { manifest } of plugins) {
    const required = new Set(manifest.requires.permissions);
    for (const g of groups) {
      if (required.has(g.key.split(":")[0]!)) counts[manifest.name] = (counts[manifest.name] ?? 0) + g.count;
    }
  }
  return counts;
}

/** An id as the owner reads it: "google" → "Google", "one-password" → "One Password". */
function titleCase(id: string): string {
  return id.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/**
 * The tab's badge, with the Capabilities badge's semantics carried over
 * whole: a plugin counts while a requirement is unmet AND something has
 * actually hit it. `pluginRows` has already zeroed the count for every other
 * status, so this is the count of rows the owner is being told about — it
 * clears when the switch flips, with nobody marking anything done.
 */
export function pluginsBadge(rows: readonly PluginRow[]): number {
  return rows.filter((r) => r.blockedCount > 0).length;
}

/**
 * Settings' "Used by" back-reference: which plugins declare each permission.
 *
 * Declaring is the fact, so a plugin the owner turned off is still listed —
 * the inventory answers "what is this switch for on this Mac", and turning a
 * plugin off does not change what it needs. A switch nothing declares is
 * absent here, and Settings says so in its own words.
 */
export function permissionUsers(
  plugins: readonly { manifest: PluginManifest }[],
): Record<string, string[]> {
  const users: Record<string, string[]> = {};
  for (const { manifest } of plugins) {
    for (const id of manifest.requires.permissions) (users[id] ??= []).push(manifest.name);
  }
  return users;
}

/**
 * Where a block by this Mac sends the owner. A block names the permission it
 * was refused for, and the remedy lives with whoever owns that permission: a
 * switch some staged plugin declares is on the Plugins tab, which says what
 * it is stopping and offers the grant; one nobody declares — Contacts, from
 * the built-in skill — is only ever a switch, and the switch is in Settings.
 * A block that names no permission at all (a locked file, a SIP root) is
 * nothing a switch fixes, so it lands on the Audit tab's Blocked view, where
 * the row carries the sentence that fixes it.
 */
export type BlockDestination = "plugins" | "settings" | "audit";
export function blockDestination(
  permission: string | null,
  plugins: readonly { manifest: PluginManifest }[],
): BlockDestination {
  if (permission === null) return "audit";
  return (permissionUsers(plugins)[permission]?.length ?? 0) > 0 ? "plugins" : "settings";
}

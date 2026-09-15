/**
 * The Plugins tab's view model — pure, like viewModel.ts and its predecessor
 * capabilitiesModel.ts, so the tab's whole logic is unit-testable without
 * Electron.
 *
 * The tab answers one question, per plugin: does it work right now, and if
 * not, what does the owner need to do? A row's status comes entirely from
 * the plugin's own `enabled` flag and its manifest's `requires` block, read
 * against the standing inventory, the connected accounts and the audit log's
 * block counts — never from goal text, never from I/O.
 */
import type { HostInventory, PermissionStatus } from "@domo/device-core";
import type { PluginManifest } from "@domo/device-core";
import { PERMISSION_TITLES } from "./capabilitiesModel.js";

export type PluginStatus = "off" | "needs-setup" | "ready";

export interface UnmetRequirement {
  kind: "account" | "permission" | "path";
  id: string;
  action: string; // e.g. "Connect Google", "Grant Contacts"
}

export interface PluginRow {
  name: string;
  /** Derived: the manifest declares exec.argv, so this plugin is a CLI. */
  isCli: boolean;
  description: string | null;
  status: PluginStatus;
  unmet: UnmetRequirement[];
  /** 0 unless the status is needs-setup. */
  blockedCount: number;
}

export interface PluginRowsInput {
  plugins: { manifest: PluginManifest; enabled: boolean }[];
  inventory: HostInventory;
  connectedAccounts: string[];
  /** Paths that exist and the app can use; the caller stats them. */
  availablePaths: string[];
  /** Block hit counts, keyed "kind:id" (e.g. "account:google"). */
  blocked: Record<string, number>;
}

function capitalize(id: string): string {
  return id.length === 0 ? id : id[0]!.toUpperCase() + id.slice(1);
}

/** Unmet requirements for one plugin, in manifest order: accounts, then
 *  permissions, then paths. A met requirement is never included. */
function unmetRequirements(
  manifest: PluginManifest,
  inventory: HostInventory,
  connectedAccounts: readonly string[],
  availablePaths: readonly string[],
): UnmetRequirement[] {
  const unmet: UnmetRequirement[] = [];
  for (const id of manifest.requires.accounts) {
    if (!connectedAccounts.includes(id)) {
      unmet.push({ kind: "account", id, action: `Connect ${capitalize(id)}` });
    }
  }
  const permissionStatus = new Map<string, PermissionStatus>(
    inventory.permissions.map((p) => [p.permission, p.status]),
  );
  for (const id of manifest.requires.permissions) {
    const status = id === "full_disk_access" ? (inventory.full_disk_access.granted ? "granted" : "denied") : permissionStatus.get(id) ?? "unknown";
    if (status !== "granted") {
      unmet.push({ kind: "permission", id, action: `Grant ${PERMISSION_TITLES[id] ?? capitalize(id)}` });
    }
  }
  // Met literally against availablePaths: no tilde expansion, normalization
  // or realpath resolution here — this module does no I/O, so the caller
  // stats and normalizes before passing paths in, and must pass declared
  // paths through in the same form for this comparison to mean anything.
  for (const id of manifest.requires.paths) {
    if (!availablePaths.includes(id)) {
      unmet.push({ kind: "path", id, action: `Grant access to ${id}` });
    }
  }
  return unmet;
}

/** Build the tab's rows, one per installed plugin, in the order given. */
export function pluginRows(input: PluginRowsInput): PluginRow[] {
  return input.plugins.map(({ manifest, enabled }) => {
    const unmet = enabled
      ? unmetRequirements(manifest, input.inventory, input.connectedAccounts, input.availablePaths)
      : [];
    const status: PluginStatus = !enabled ? "off" : unmet.length > 0 ? "needs-setup" : "ready";
    // blocked is keyed by "kind:id", not id alone: requires.paths accepts any
    // string (see manifest.ts), so a path can legally read "contacts" or
    // "google" and would otherwise collide with an account/permission id of
    // the same name.
    const blockedCount =
      status === "needs-setup" ? unmet.reduce((n, r) => n + (input.blocked[`${r.kind}:${r.id}`] ?? 0), 0) : 0;
    return {
      name: manifest.name,
      isCli: manifest.exec.argv.length > 0,
      description: null,
      status,
      unmet,
      blockedCount,
    };
  });
}

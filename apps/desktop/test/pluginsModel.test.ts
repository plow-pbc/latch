/**
 * The Plugins tab's view model: one row per installed plugin, status derived
 * from whether it's enabled and whether its manifest's `requires` are met.
 */
import { describe, expect, it } from "vitest";
import type { HostInventory } from "@domo/device-core";
import type { PluginManifest } from "@domo/device-core";
import { blockedKey, pluginRows, PluginRow, PluginRowsInput } from "../src/pluginsModel.js";

type PluginRequires = PluginManifest["requires"];

const none: PluginRequires = { accounts: [], permissions: [], paths: [] };

function inventory(overrides: Partial<HostInventory> = {}): HostInventory {
  return {
    checked_at: "2026-09-15T08:00:00Z",
    full_disk_access: { granted: false, probes: [] },
    automation: [],
    automation_queryable: true,
    permissions: [],
    sandbox: { status: "ok", detail: null },
    child_attribution: { status: "not_applicable", detail: null },
    vault_key: { status: "ok", reason: null },
    ...overrides,
  };
}

function manifest(requires: PluginRequires): PluginManifest {
  return {
    name: "sample",
    version: "1.0.0",
    command: "sample",
    runtime: { binaries: [], sources: [] },
    exec: { cwd: "plugin", argv: ["sample"] },
    daemon: null,
    env: {},
    argv: { read: [], write: [] },
    hooks: {},
    skill: null,
    requires,
  };
}

/** Builds a one-plugin `pluginRows` input from the test table's shorthand. */
function build(input: {
  requires: PluginRequires;
  enabled: boolean;
  hits?: number;
  availablePaths?: string[];
}): PluginRowsInput {
  const blocked: Record<string, number> = {};
  if (input.hits !== undefined) {
    for (const id of input.requires.accounts) blocked[blockedKey("account", id)] = input.hits;
    for (const id of input.requires.permissions) blocked[blockedKey("permission", id)] = input.hits;
    for (const id of input.requires.paths) blocked[blockedKey("path", id)] = input.hits;
  }
  return {
    plugins: [{ manifest: manifest(input.requires), enabled: input.enabled }],
    inventory: inventory(),
    connectedAccounts: [],
    availablePaths: input.availablePaths ?? [],
    blocked,
  };
}

describe("pluginRows status", () => {
  it.each([
    ["ready when nothing is required", { requires: none, enabled: true }, "ready", 0],
    ["needs-setup when an account is missing", { requires: { ...none, accounts: ["google"] }, enabled: true }, "needs-setup", 0],
    [
      "needs-setup and counts hits",
      { requires: { ...none, permissions: ["contacts"] }, enabled: true, hits: 3 },
      "needs-setup",
      3,
    ],
    ["off wins over an unmet requirement", { requires: { ...none, accounts: ["google"] }, enabled: false }, "off", 0],
    ["off even when otherwise ready", { requires: none, enabled: false }, "off", 0],
    ["needs-setup when a path is missing", { requires: { ...none, paths: ["~/Plow/wiki"] }, enabled: true }, "needs-setup", 0],
    [
      "ready when the only requirement is a met path (plow-wiki's shape)",
      { requires: { ...none, paths: ["~/Plow/wiki"] }, enabled: true, availablePaths: ["~/Plow/wiki"] },
      "ready",
      0,
    ],
  ] as const)("%s", (_name, input, status, blockedCount) => {
    const [row] = pluginRows(build(input)) as [PluginRow];
    expect(row.status).toBe(status);
    expect(row.blockedCount).toBe(blockedCount);
  });
});

it("marks a plugin that declares exec.argv as a CLI", () => {
  const [row] = pluginRows(build({ requires: none, enabled: true })) as [PluginRow];
  expect(row.isCli).toBe(true);
});

it("a met account requirement never appears in unmet", () => {
  const input = build({ requires: { ...none, accounts: ["google"] }, enabled: true });
  input.connectedAccounts = ["google"];
  const [row] = pluginRows(input) as [PluginRow];
  expect(row.status).toBe("ready");
  expect(row.unmet).toEqual([]);
});

it("a met permission requirement never appears in unmet", () => {
  const input = build({ requires: { ...none, permissions: ["contacts"] }, enabled: true });
  input.inventory = inventory({ permissions: [{ permission: "contacts", status: "granted" }] });
  const [row] = pluginRows(input) as [PluginRow];
  expect(row.status).toBe("ready");
  expect(row.unmet).toEqual([]);
});

// full_disk_access is read from its own inventory field rather than the
// generic permissions list (see unmetRequirements), so it gets its own
// met/unmet pair rather than a shared table row.
it("full_disk_access is met when the inventory says granted", () => {
  const input = build({ requires: { ...none, permissions: ["full_disk_access"] }, enabled: true });
  input.inventory = inventory({ full_disk_access: { granted: true, probes: [] } });
  const [row] = pluginRows(input) as [PluginRow];
  expect(row.status).toBe("ready");
});

it("full_disk_access is unmet when the inventory says not granted", () => {
  const input = build({ requires: { ...none, permissions: ["full_disk_access"] }, enabled: true });
  const [row] = pluginRows(input) as [PluginRow];
  expect(row.status).toBe("needs-setup");
});

// requires.paths accepts any string, so a path can share literal text with
// an account/permission id — blocked must be keyed by kind, not id alone,
// or the two would double-count each other's hits.
it("blocked hits don't cross-count between a permission and a path sharing one id", () => {
  const input = build({ requires: { ...none, permissions: ["contacts"], paths: ["contacts"] }, enabled: true });
  input.blocked = { [blockedKey("permission", "contacts")]: 5 };
  const [row] = pluginRows(input) as [PluginRow];
  expect(row.blockedCount).toBe(5);
});

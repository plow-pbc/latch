/**
 * The Plugins tab's view model. What is pinned here: which requirement
 * kinds are met from which input, that `off` outranks an unmet requirement,
 * and that the hit count rides alongside `needs-setup` rather than being a
 * status of its own.
 */
import { describe, expect, it } from "vitest";
import { parseManifest, type PluginManifest } from "@domo/device-core";
import { blockedGroups } from "../src/capabilitiesModel.js";
import { pluginBlockCounts, pluginRows, type PluginsInput } from "../src/pluginsModel.js";
import { inventory } from "./hostFixtures.js";

const manifest = (requires: object, name = "wiki"): PluginManifest =>
  parseManifest(JSON.stringify({
    name, version: "1", command: name,
    exec: { cwd: "plugin", argv: ["/bin/sh", "cli.sh"] },
    argv: { read: [["index"]], write: [["init"]] },
    requires,
  }));

const none = {};

/** The shorthand the table rows carry, as one `pluginRows` input. */
function build(o: {
  requires: object;
  enabled: boolean;
  hits?: number;
  connected?: string[];
  paths?: string[];
}): PluginsInput {
  return {
    plugins: [{ manifest: manifest(o.requires), enabled: o.enabled, description: "Keeps a wiki." }],
    inventory: inventory(),
    connectedAccounts: o.connected ?? [],
    availablePaths: o.paths ?? [],
    blocked: o.hits === undefined ? {} : { wiki: o.hits },
  };
}

describe("pluginRows status", () => {
  it.each([
    ["ready when nothing is required", { requires: none, enabled: true }, "ready", 0],
    ["needs-setup when an account is missing", { requires: { accounts: ["google"] }, enabled: true }, "needs-setup", 0],
    ["ready once that account is connected", { requires: { accounts: ["google"] }, enabled: true, connected: ["google"] }, "ready", 0],
    ["needs-setup and counts hits", { requires: { permissions: ["contacts"] }, enabled: true, hits: 3 }, "needs-setup", 3],
    ["ready on a granted permission", { requires: { permissions: ["calendars"] }, enabled: true }, "ready", 0],
    ["needs-setup for a path that does not exist", { requires: { paths: ["~/Plow/wiki"] }, enabled: true }, "needs-setup", 0],
    ["ready once that path exists", { requires: { paths: ["~/Plow/wiki"] }, enabled: true, paths: ["~/Plow/wiki"] }, "ready", 0],
    ["off wins over an unmet requirement", { requires: { accounts: ["google"] }, enabled: false, hits: 3 }, "off", 0],
    ["off even when otherwise ready", { requires: none, enabled: false }, "off", 0],
    ["counts nothing while ready", { requires: none, enabled: true, hits: 3 }, "ready", 0],
  ])("%s", (_name, input, status, blockedCount) => {
    const [row] = pluginRows(build(input));
    expect(row!.status).toBe(status);
    expect(row!.blockedCount).toBe(blockedCount);
  });
});

it("names each unmet requirement with the action that fixes it, and stays silent about the met ones", () => {
  const [row] = pluginRows({
    ...build({ requires: { accounts: ["google"], permissions: ["contacts", "calendars"], paths: ["~/Plow/wiki"] }, enabled: true }),
    connectedAccounts: [],
  });
  expect(row!.unmet).toEqual([
    { kind: "account", id: "google", action: "Connect Google" },
    { kind: "permission", id: "contacts", action: "Grant Contacts" },
    { kind: "path", id: "~/Plow/wiki", action: "Create ~/Plow/wiki" },
  ]);
});

it("reads Full Disk Access as the umbrella it is", () => {
  const input = build({ requires: { permissions: ["contacts"] }, enabled: true });
  const [row] = pluginRows({ ...input, inventory: inventory({ full_disk_access: { granted: true, probes: [] } }) });
  expect(row!.status).toBe("ready");
});

it("shows a disabled plugin's requirements to nobody", () => {
  const [row] = pluginRows(build({ requires: { accounts: ["google"] }, enabled: false }));
  expect(row!.unmet).toEqual([]);
});

it("marks a plugin that declares exec.argv as a CLI and carries its skill's description", () => {
  const [row] = pluginRows(build({ requires: none, enabled: true }));
  expect(row!.isCli).toBe(true);
  expect(row!.description).toBe("Keeps a wiki.");
});

it("counts a permission's blocks against every plugin that requires it", () => {
  const events = [
    { event: "host_permission_blocked", permission: "contacts", intentId: "i1", handle: "h1", ts: "2026-09-02T09:00:00Z" },
    { event: "host_permission_blocked", permission: "calendars", intentId: "i2", handle: "h2", ts: "2026-09-02T09:01:00Z" },
  ];
  const plugins = [{ manifest: manifest({ permissions: ["contacts"] }) }, { manifest: manifest({ permissions: ["photos"] }, "photo") }];
  expect(pluginBlockCounts(blockedGroups(events), plugins)).toEqual({ wiki: 1 });
});

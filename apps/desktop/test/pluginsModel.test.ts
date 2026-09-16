/**
 * The Plugins tab's view model. What is pinned here: which requirement
 * kinds are met from which input, and that `off` outranks an unmet
 * requirement.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseManifest, type HostInventory, type PluginManifest } from "@domo/device-core";
import { capabilitiesView, permissionStatuses } from "../src/capabilitiesModel.js";
import { blockDestination, permissionUsers, pluginRows, type PluginsInput } from "../src/pluginsModel.js";
import { inventory } from "./hostFixtures.js";

const manifest = (requires: object, name = "wiki"): PluginManifest =>
  parseManifest(JSON.stringify({
    name, version: "1", command: name,
    exec: { cwd: "plugin", argv: ["/bin/sh", "cli.sh"] },
    argv: { read: [["index"]], write: [["init"]] },
    requires,
  }));

const none = {};

/** Every switch's status exactly as Settings reads it — the canonical map,
 *  from the real view model, so a test cannot assert a status the pane does
 *  not actually give. */
const statuses = (inv: HostInventory) =>
  permissionStatuses(capabilitiesView({ inventory: inv, automation: [], events: [], dismissals: {}, bannerSeenAt: null }));

/** The shorthand the table rows carry, as one `pluginRows` input. */
function build(o: {
  requires: object;
  enabled: boolean;
  connected?: string[];
  paths?: string[];
  inventory?: HostInventory;
}): PluginsInput {
  return {
    plugins: [{ manifest: manifest(o.requires), enabled: o.enabled, description: "Keeps a wiki." }],
    permissionStatus: statuses(o.inventory ?? inventory()),
    connectedAccounts: o.connected ?? [],
    availablePaths: o.paths ?? [],
  };
}

describe("pluginRows status", () => {
  it.each([
    ["ready when nothing is required", { requires: none, enabled: true }, "ready"],
    ["needs-setup when an account is missing", { requires: { accounts: ["google"] }, enabled: true }, "needs-setup"],
    ["ready once that account is connected", { requires: { accounts: ["google"] }, enabled: true, connected: ["google"] }, "ready"],
    ["needs-setup on a permission that is not granted", { requires: { permissions: ["contacts"] }, enabled: true }, "needs-setup"],
    ["ready on a granted permission", { requires: { permissions: ["calendars"] }, enabled: true }, "ready"],
    ["needs-setup for a path that does not exist", { requires: { paths: ["~/Plow/wiki"] }, enabled: true }, "needs-setup"],
    ["ready once that path exists", { requires: { paths: ["~/Plow/wiki"] }, enabled: true, paths: ["~/Plow/wiki"] }, "ready"],
    ["off wins over an unmet requirement", { requires: { accounts: ["google"] }, enabled: false }, "off"],
    ["off even when otherwise ready", { requires: none, enabled: false }, "off"],
  ])("%s", (_name, input, status) => {
    expect(pluginRows(build(input))[0]!.status).toBe(status);
  });
});

it("names each unmet requirement with the action that fixes it, and stays silent about the met ones", () => {
  const [row] = pluginRows(
    build({ requires: { accounts: ["google"], permissions: ["contacts", "calendars"], paths: ["~/Plow/wiki"] }, enabled: true }),
  );
  expect(row!.unmet).toEqual([
    { kind: "account", id: "google", action: "Connect Google" },
    { kind: "permission", id: "contacts", action: "Grant Contacts" },
    { kind: "path", id: "~/Plow/wiki", action: "Create ~/Plow/wiki" },
  ]);
});

it("reads Full Disk Access as the umbrella it is, because Settings does", () => {
  const fda = inventory({ full_disk_access: { granted: true, probes: [] } });
  const [row] = pluginRows(build({ requires: { permissions: ["contacts"] }, enabled: true, inventory: fda }));
  expect(row!.status).toBe("ready");
});

/**
 * The bug this wiring exists to make impossible: a folder Settings has
 * already reconciled to granted — from its own memo, not from anything the
 * live inventory can answer — must not read "Needs setup" here.
 */
it("takes a folder's status from Settings' memo, not from the raw inventory", () => {
  const permissionStatus = permissionStatuses(capabilitiesView({
    inventory: inventory(),
    automation: [],
    events: [],
    dismissals: {},
    bannerSeenAt: null,
    folders: { files_documents: "granted" },
    foldersAt: { files_documents: "2026-09-02T08:00:00Z" },
  }));
  const [row] = pluginRows({
    ...build({ requires: { permissions: ["files_documents"] }, enabled: true }),
    permissionStatus,
  });
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

it("names every plugin that declares a permission, off ones included, and omits a switch nobody declares", () => {
  const plugins = [
    { manifest: manifest({ permissions: ["contacts", "calendars"] }) },
    { manifest: manifest({ permissions: ["contacts"] }, "photo") },
    { manifest: manifest({}, "plain") },
  ];
  expect(permissionUsers(plugins)).toEqual({ contacts: ["wiki", "photo"], calendars: ["wiki"] });
});

describe("where a block by this Mac sends the owner", () => {
  // The off one is still declared: a switch a disabled plugin needs is still
  // that plugin's, and Plugins is where turning it back on lives.
  const staged = [
    { manifest: manifest({ permissions: ["calendars"] }) },
    { manifest: manifest({ permissions: ["accessibility"] }, "off-one") },
  ];
  it.each([
    { what: "a switch a plugin declares", permission: "calendars", to: "plugins" },
    { what: "a switch only a disabled plugin declares", permission: "accessibility", to: "plugins" },
    { what: "a switch nobody declares (the built-in skill's Contacts)", permission: "contacts", to: "settings" },
    { what: "no switch at all (a locked file)", permission: null, to: "audit" },
  ])("sends $what to $to", ({ permission, to }) => {
    expect(blockDestination(permission, staged)).toBe(to);
  });
});

/**
 * The shipped manifests, read off disk through the real parser: the readiness
 * graph is only as good as what a manifest declares, and a plugin that
 * declares nothing reads Ready on a Mac it cannot work on. gog mints Google
 * credentials on every non-help call, so a disconnected owner must be told.
 */
describe("the shipped plugins", () => {
  const shipped = (name: string): PluginManifest =>
    parseManifest(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "plugins", name, "latch-plugin.json"), "utf8"));

  it.each([
    { connected: [] as string[], status: "needs-setup", unmet: [{ kind: "account", id: "google", action: "Connect Google" }] },
    { connected: ["google"], status: "ready", unmet: [] },
  ])("reads gog as $status with connected accounts $connected", ({ connected, status, unmet }) => {
    const [row] = pluginRows({
      plugins: [{ manifest: shipped("gog"), enabled: true }],
      permissionStatus: statuses(inventory()),
      connectedAccounts: connected,
      availablePaths: [],
    });
    expect(row).toMatchObject({ name: "gog", status, unmet });
  });
});

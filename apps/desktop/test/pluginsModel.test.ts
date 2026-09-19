/**
 * The Plugins tab's view model. What is pinned here: a requirement is met
 * from the connected accounts and granted permissions, and `off` outranks an
 * unmet requirement in `status` — but never hides the requirement itself.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BROWSER_PLUGIN, parseManifest, type PluginManifest } from "@domo/device-core";
import {
  browserPluginRow,
  BROWSER_RUNTIME,
  grantList,
  pluginRows,
  SAFARI_JAVASCRIPT,
  type PluginRow,
  type PluginsInput,
} from "../src/pluginsModel.js";

const manifest = (requires: object, name = "wiki", title?: string): PluginManifest =>
  parseManifest(JSON.stringify({
    name, title, version: "1", command: name,
    exec: { argv: ["/bin/sh", "cli.sh"] },
    argv: { read: [["index"]], write: [["init"]] },
    requires,
  }));

const none = {};

/** The shorthand the table rows carry, as one `pluginRows` input. */
function build(o: { requires: object; enabled: boolean; connected?: string[]; granted?: string[] }): PluginsInput {
  return {
    plugins: [{ manifest: manifest(o.requires), enabled: o.enabled, description: "Keeps a wiki." }],
    connectedAccounts: o.connected ?? [],
    grantedPermissions: o.granted ?? [],
  };
}

describe("pluginRows status", () => {
  it.each([
    ["ready when nothing is required", { requires: none, enabled: true }, "ready"],
    ["needs-setup when an account is missing", { requires: { accounts: ["google"] }, enabled: true }, "needs-setup"],
    ["ready once that account is connected", { requires: { accounts: ["google"] }, enabled: true, connected: ["google"] }, "ready"],
    ["needs-setup when a permission is missing", { requires: { permissions: ["full_disk_access"] }, enabled: true }, "needs-setup"],
    ["ready once it is granted", { requires: { permissions: ["full_disk_access"] }, enabled: true, granted: ["full_disk_access"] }, "ready"],
    ["off wins over an unmet requirement", { requires: { accounts: ["google"] }, enabled: false }, "off"],
    ["off even when otherwise ready", { requires: none, enabled: false }, "off"],
  ])("%s", (_name, input, status) => {
    expect(pluginRows(build(input))[0]!.status).toBe(status);
  });
});

it("names an unmet account requirement with the action that fixes it, and flips met once connected — still listed", () => {
  const requirements = (connected: string[]) =>
    pluginRows(build({ requires: { accounts: ["google"] }, enabled: true, connected }))[0]!.requirements;
  expect(requirements([])).toEqual([
    { id: "account:google", title: "Google account", detail: "Sign in with Google in your browser.", action: "Connect Google", met: false },
  ]);
  expect(requirements(["google"])).toEqual([
    { id: "account:google", title: "Google account", detail: "Sign in with Google in your browser.", action: "Connect Google", met: true },
  ]);
});

it("names an unmet permission requirement, and flips met once granted", () => {
  const requirements = (granted: string[]) =>
    pluginRows(build({ requires: { permissions: ["full_disk_access"] }, enabled: true, granted }))[0]!.requirements;
  expect(requirements([])).toEqual([
    { id: "full_disk_access", title: "Full Disk Access", detail: "Drag Plow Latch into the list in System Settings.", action: "Grant Full Disk Access", met: false },
  ]);
  expect(requirements(["full_disk_access"])).toEqual([
    { id: "full_disk_access", title: "Full Disk Access", detail: "Drag Plow Latch into the list in System Settings.", action: "Grant Full Disk Access", met: true },
  ]);
});

it("keeps a disabled plugin's status off, but still lists its requirements — hiding them is the tab's business", () => {
  const [row] = pluginRows(build({ requires: { accounts: ["google"] }, enabled: false }));
  expect(row!.status).toBe("off");
  expect(row!.requirements).toEqual([
    { id: "account:google", title: "Google account", detail: "Sign in with Google in your browser.", action: "Connect Google", met: false },
  ]);
});

it("carries its skill's description", () => {
  const [row] = pluginRows(build({ requires: none, enabled: true }));
  expect(row!.description).toBe("Keeps a wiki.");
});

/**
 * The shipped manifests, read off disk through the real parser: the readiness
 * graph is only as good as what a manifest declares, and a plugin that
 * declares nothing reads Ready on a Mac it cannot work on. gog mints Google
 * credentials on every non-help call, so a disconnected owner must be told;
 * messages needs Full Disk Access to read the chat.db it works from.
 */
describe("the shipped plugins", () => {
  const shipped = (name: string): PluginManifest =>
    parseManifest(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "plugins", name, "latch-plugin.json"), "utf8"));

  it.each([
    { connected: [] as string[], status: "needs-setup", requirements: [{ id: "account:google", action: "Connect Google", met: false }] },
    { connected: ["google"], status: "ready", requirements: [{ id: "account:google", action: "Connect Google", met: true }] },
  ])("reads gog as $status with connected accounts $connected", ({ connected, status, requirements }) => {
    const [row] = pluginRows({ plugins: [{ manifest: shipped("gog"), enabled: true }], connectedAccounts: connected, grantedPermissions: [] });
    expect(row).toMatchObject({ name: "gog", status, requirements });
  });

  it.each([
    { granted: [] as string[], status: "needs-setup" },
    { granted: ["full_disk_access"], status: "ready" },
  ])("reads messages as $status with granted permissions $granted, carrying its summary", ({ granted, status }) => {
    const [row] = pluginRows({ plugins: [{ manifest: shipped("messages"), enabled: true }], connectedAccounts: [], grantedPermissions: granted });
    expect(row).toMatchObject({ name: "messages", status, summary: "Find and read your texts, right on this Mac." });
  });

  it.each([
    ["gog", "Gmail and Google Calendar"],
    ["wiki", "Obsidian-style wiki"],
  ])("titles %s as the owner reads it: %s", (name, title) => {
    const [row] = pluginRows({ plugins: [{ manifest: shipped(name), enabled: true }], connectedAccounts: [], grantedPermissions: [] });
    expect(row).toMatchObject({ name, title });
  });
});

describe("browserPluginRow", () => {
  const base = { enabled: true, runtimePresent: true, safariJavaScript: true, fullDiskAccess: false, description: "Browse websites…" };
  const fda = { id: "full_disk_access", title: "Full Disk Access", detail: "Drag Plow Latch into the list in System Settings.", action: "Grant Full Disk Access" };
  const safari = { id: SAFARI_JAVASCRIPT, title: "Safari", detail: "Allow JavaScript from Apple Events — Safari relaunches", action: "Enable in Safari" };
  const runtime = { id: BROWSER_RUNTIME, title: "Browser runtime", detail: "Not in this build — from source, run just fetch-browser", action: null };
  it.each([
    ["ready when the runtime is present and Safari allows JavaScript", base, "ready", [{ ...safari, met: true }]],
    // Full Disk Access is only needed to WRITE Safari's setting, so it only
    // shows up while that setting is still off.
    ["needs setup with Full Disk Access and Safari when the setting is off", { ...base, safariJavaScript: false }, "needs-setup", [{ ...fda, met: false }, { ...safari, met: false }]],
    ["Full Disk Access reads met once granted, Safari still is not", { ...base, safariJavaScript: false, fullDiskAccess: true }, "needs-setup", [{ ...fda, met: true }, { ...safari, met: false }]],
    ["needs setup with no button when the runtime is missing", { ...base, runtimePresent: false }, "needs-setup", [{ ...safari, met: true }, { ...runtime, met: false }]],
    ["off keeps status off but still lists its requirements", { ...base, enabled: false, safariJavaScript: false }, "off", [{ ...fda, met: false }, { ...safari, met: false }]],
  ] as const)("is %s", (_what, input, status, requirements) => {
    const row = browserPluginRow(input);
    expect(row).toMatchObject({ name: BROWSER_PLUGIN, title: "Browser use", kind: "Browser", status });
    // The words the owner reads, exactly — a swap of the two would otherwise pass.
    expect(row.requirements).toEqual(requirements);
  });

  it.each([
    ["its manifest title", "Mail", "Mail"],
    ["its name when the manifest has no title", undefined, "gog"],
  ])("every manifest plugin row is a CLI titled by %s", (_what, title, expected) => {
    const [row] = pluginRows({ plugins: [{ manifest: manifest(none, "gog", title), enabled: true }], connectedAccounts: [], grantedPermissions: [] });
    expect(row).toMatchObject({ kind: "CLI", title: expected });
  });
});

describe("grantList", () => {
  const rowWith = (title: string, status: PluginRow["status"], requirements: PluginRow["requirements"]): PluginRow => ({
    name: title.toLowerCase(), title, summary: null, kind: "CLI", description: null, status, requirements,
  });

  it("dedupes a permission two switched-on plugins share, listing both titles once", () => {
    const req = { id: "full_disk_access", title: "Full Disk Access", detail: "d", action: "Grant Full Disk Access", met: false };
    const rows = [rowWith("Wiki", "needs-setup", [req]), rowWith("Messages", "needs-setup", [req])];
    expect(grantList(rows)).toEqual([{ ...req, plugins: ["Wiki", "Messages"] }]);
  });

  it("orders permissions, then Safari, then accounts; drops off plugins and action-less requirements; keeps met ones", () => {
    const rows: PluginRow[] = [
      rowWith("Gog", "ready", [{ id: "account:google", title: "Google account", detail: "d", action: "Connect Google", met: true }]),
      rowWith("Browser use", "needs-setup", [
        { id: SAFARI_JAVASCRIPT, title: "Safari", detail: "d", action: "Enable in Safari", met: false },
        { id: BROWSER_RUNTIME, title: "Browser runtime", detail: "d", action: null, met: false },
      ]),
      rowWith("Messages", "needs-setup", [{ id: "full_disk_access", title: "Full Disk Access", detail: "d", action: "Grant Full Disk Access", met: false }]),
      rowWith("Off plugin", "off", [{ id: "account:google", title: "Google account", detail: "d", action: "Connect Google", met: false }]),
    ];
    expect(grantList(rows)).toEqual([
      { id: "full_disk_access", title: "Full Disk Access", detail: "d", action: "Grant Full Disk Access", met: false, plugins: ["Messages"] },
      { id: SAFARI_JAVASCRIPT, title: "Safari", detail: "d", action: "Enable in Safari", met: false, plugins: ["Browser use"] },
      { id: "account:google", title: "Google account", detail: "d", action: "Connect Google", met: true, plugins: ["Gog"] },
    ]);
  });
});

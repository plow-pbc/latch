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

const google = {
  id: "account:google",
  title: "Google account",
  detail: "Sign in with Google in your browser.",
  action: "Connect Google",
  waiting: "Finish signing in with Google in your browser.",
  done: "Connected",
};

/** The shorthand the table rows carry, as one `pluginRows` input. */
function build(o: { requires: object; enabled: boolean; connected?: string[]; granted?: string[]; pending?: string[] }): PluginsInput {
  return {
    plugins: [{ manifest: manifest(o.requires), enabled: o.enabled, description: "Keeps a wiki." }],
    connectedAccounts: o.connected ?? [],
    grantedPermissions: o.granted ?? [],
    relaunchPending: o.pending ?? [],
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

it("names an unmet account requirement with the action that fixes it, then gives its met row a model-owned repeat action", () => {
  const requirements = (connected: string[]) =>
    pluginRows(build({ requires: { accounts: ["google"] }, enabled: true, connected }))[0]!.requirements;
  expect(requirements([])).toEqual([{ ...google, status: "open" }]);
  expect(requirements(["google"])).toEqual([{ ...google, status: "met", repeatAction: "Add another" }]);
});

it("associates a connector-owned notice with its account requirement", () => {
  const [row] = pluginRows({
    ...build({ requires: { accounts: ["google"] }, enabled: true, connected: ["google"] }),
    accountNotices: { google: { message: "We couldn't see a new account.", noteKind: "neutral" } },
  });

  expect(row!.requirements).toEqual([{
    ...google,
    status: "met",
    repeatAction: "Add another",
    notice: { message: "We couldn't see a new account.", noteKind: "neutral" },
  }]);
});

it.each([
  ["full_disk_access", { title: "Full Disk Access", detail: "Drag Plow Latch into the list in System Settings.", action: "Grant Full Disk Access", waiting: "Waiting for you in System Settings…", done: "Granted" }],
  // An Automation pair names its app — the same words the grant panel shows.
  ["automation:com.apple.MobileSMS", { title: "Automation for Messages", detail: "Allow it when macOS asks, or in System Settings.", action: "Grant Automation for Messages", waiting: "Waiting for you in System Settings…", done: "Granted" }],
])("names an unmet %s requirement, and flips met once granted", (key, words) => {
  const requirements = (granted: string[]) =>
    pluginRows(build({ requires: { permissions: [key] }, enabled: true, granted }))[0]!.requirements;
  expect(requirements([])).toEqual([{ id: key, ...words, status: "open" }]);
  expect(requirements([key])).toEqual([{ id: key, ...words, status: "met" }]);
});

// Granted during this run: the app reads it, a child does not inherit it
// until the app relaunches — so it is still unmet, the button is the
// relaunch, and setup's list keeps it.
it("reads a permission waiting on a relaunch as unmet, with the relaunch as its action — still on setup's list", () => {
  const rows = pluginRows(build({ requires: { permissions: ["full_disk_access"] }, enabled: true, pending: ["full_disk_access"] }));
  const relaunch = { id: "full_disk_access", title: "Full Disk Access", detail: "Quit and reopen Plow Latch to finish.", action: "Relaunch Plow Latch", waiting: "", done: "Granted", status: "relaunch" };
  expect(rows[0]!.requirements).toEqual([relaunch]);
  expect(grantList(rows)).toEqual([{ ...relaunch, plugins: ["wiki"] }]);
});

it("keeps a disabled plugin's status off, but still lists its requirements — hiding them is the tab's business", () => {
  const [row] = pluginRows(build({ requires: { accounts: ["google"] }, enabled: false }));
  expect(row!.status).toBe("off");
  expect(row!.requirements).toEqual([{ ...google, status: "open" }]);
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
    { connected: [] as string[], status: "needs-setup", requirements: [{ id: "account:google", action: "Connect Google", status: "open" }] },
    { connected: ["google"], status: "ready", requirements: [{ id: "account:google", action: "Connect Google", status: "met" }] },
  ])("reads gog as $status with connected accounts $connected", ({ connected, status, requirements }) => {
    const [row] = pluginRows({ plugins: [{ manifest: shipped("gog"), enabled: true }], connectedAccounts: connected, grantedPermissions: [], relaunchPending: [] });
    expect(row).toMatchObject({ name: "gog", status, requirements });
  });

  it.each([
    { granted: [] as string[], status: "needs-setup" },
    { granted: ["full_disk_access"], status: "ready" },
  ])("reads messages as $status with granted permissions $granted, carrying its summary", ({ granted, status }) => {
    const [row] = pluginRows({ plugins: [{ manifest: shipped("messages"), enabled: true }], connectedAccounts: [], grantedPermissions: granted, relaunchPending: [] });
    expect(row).toMatchObject({ name: "messages", status, summary: "Find and read your texts and WhatsApp, right on this Mac." });
  });

  it.each([
    ["gog", "Gmail and Google Calendar"],
    ["wiki", "Obsidian-style wiki"],
  ])("titles %s as the owner reads it: %s", (name, title) => {
    const [row] = pluginRows({ plugins: [{ manifest: shipped(name), enabled: true }], connectedAccounts: [], grantedPermissions: [], relaunchPending: [] });
    expect(row).toMatchObject({ name, title });
  });

});

describe("browserPluginRow", () => {
  const base = { enabled: true, runtimePresent: true, safariJavaScript: true, fullDiskAccess: false, relaunchPending: [] as string[], description: "Browse websites…" };
  const fda = { id: "full_disk_access", title: "Full Disk Access", detail: "Drag Plow Latch into the list in System Settings.", action: "Grant Full Disk Access", waiting: "Waiting for you in System Settings…", done: "Granted" };
  const safari = { id: SAFARI_JAVASCRIPT, title: "Safari", detail: "Allow JavaScript from Apple Events — Safari relaunches", action: "Enable in Safari", waiting: "Turning it on. Safari relaunches.", done: "On" };
  // Never run by setup (no action), so no waiting line and no done word.
  const runtime = { id: BROWSER_RUNTIME, title: "Browser runtime", detail: "Not in this build — from source, run just fetch-browser", action: null, waiting: "", done: "" };
  it.each([
    ["ready when the runtime is present and Safari allows JavaScript", base, "ready", [{ ...safari, status: "met" }]],
    // Full Disk Access is only needed to WRITE Safari's setting, so it only
    // shows up while that setting is still off.
    ["needs setup with Full Disk Access and Safari when the setting is off", { ...base, safariJavaScript: false }, "needs-setup", [{ ...fda, status: "open" }, { ...safari, status: "open" }]],
    ["Full Disk Access reads met once granted, Safari still is not", { ...base, safariJavaScript: false, fullDiskAccess: true }, "needs-setup", [{ ...fda, status: "met" }, { ...safari, status: "open" }]],
    ["Full Disk Access granted this run waits on a relaunch", { ...base, safariJavaScript: false, relaunchPending: ["full_disk_access"] }, "needs-setup", [{ ...fda, detail: "Quit and reopen Plow Latch to finish.", action: "Relaunch Plow Latch", waiting: "", status: "relaunch" }, { ...safari, status: "open" }]],
    ["needs setup with no button when the runtime is missing", { ...base, runtimePresent: false }, "needs-setup", [{ ...safari, status: "met" }, { ...runtime, status: "open" }]],
    ["off keeps status off but still lists its requirements", { ...base, enabled: false, safariJavaScript: false }, "off", [{ ...fda, status: "open" }, { ...safari, status: "open" }]],
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
    const [row] = pluginRows({ plugins: [{ manifest: manifest(none, "gog", title), enabled: true }], connectedAccounts: [], grantedPermissions: [], relaunchPending: [] });
    expect(row).toMatchObject({ kind: "CLI", title: expected });
  });
});

describe("grantList", () => {
  const rowWith = (title: string, status: PluginRow["status"], requirements: PluginRow["requirements"]): PluginRow => ({
    name: title.toLowerCase(), title, summary: null, kind: "CLI", description: null, status, requirements,
  });

  it("dedupes a permission two switched-on plugins share, listing both titles once", () => {
    const req = { id: "full_disk_access", title: "Full Disk Access", detail: "d", action: "Grant Full Disk Access", waiting: "w", done: "Granted", status: "open" };
    const rows = [rowWith("Wiki", "needs-setup", [req]), rowWith("Messages", "needs-setup", [req])];
    expect(grantList(rows)).toEqual([{ ...req, plugins: ["Wiki", "Messages"] }]);
  });

  it("orders permissions, then Safari, then accounts; drops off plugins and action-less requirements; keeps met ones", () => {
    const rows: PluginRow[] = [
      rowWith("Gog", "ready", [{ id: "account:google", title: "Google account", detail: "d", action: "Connect Google", waiting: "w", done: "Connected", status: "met" }]),
      rowWith("Browser use", "needs-setup", [
        { id: SAFARI_JAVASCRIPT, title: "Safari", detail: "d", action: "Enable in Safari", waiting: "w", done: "On", status: "open" },
        { id: BROWSER_RUNTIME, title: "Browser runtime", detail: "d", action: null, waiting: "", done: "", status: "open" },
      ]),
      rowWith("Messages", "needs-setup", [{ id: "full_disk_access", title: "Full Disk Access", detail: "d", action: "Grant Full Disk Access", waiting: "w", done: "Granted", status: "open" }]),
      rowWith("Off plugin", "off", [{ id: "account:google", title: "Google account", detail: "d", action: "Connect Google", waiting: "w", done: "Connected", status: "open" }]),
    ];
    expect(grantList(rows)).toEqual([
      { id: "full_disk_access", title: "Full Disk Access", detail: "d", action: "Grant Full Disk Access", waiting: "w", done: "Granted", status: "open", plugins: ["Messages"] },
      { id: SAFARI_JAVASCRIPT, title: "Safari", detail: "d", action: "Enable in Safari", waiting: "w", done: "On", status: "open", plugins: ["Browser use"] },
      { id: "account:google", title: "Google account", detail: "d", action: "Connect Google", waiting: "w", done: "Connected", status: "met", plugins: ["Gog"] },
    ]);
  });
});

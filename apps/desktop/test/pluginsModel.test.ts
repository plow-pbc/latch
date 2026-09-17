/**
 * The Plugins tab's view model. What is pinned here: a requirement is met
 * from the connected accounts, and `off` outranks an unmet requirement.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseManifest, type PluginManifest } from "@domo/device-core";
import { browserPluginRow, BROWSER_RUNTIME, pluginRows, SAFARI_JAVASCRIPT, type PluginsInput } from "../src/pluginsModel.js";

const manifest = (requires: object, name = "wiki"): PluginManifest =>
  parseManifest(JSON.stringify({
    name, version: "1", command: name,
    exec: { argv: ["/bin/sh", "cli.sh"] },
    argv: { read: [["index"]], write: [["init"]] },
    requires,
  }));

const none = {};

/** The shorthand the table rows carry, as one `pluginRows` input. */
function build(o: { requires: object; enabled: boolean; connected?: string[] }): PluginsInput {
  return {
    plugins: [{ manifest: manifest(o.requires), enabled: o.enabled, description: "Keeps a wiki." }],
    connectedAccounts: o.connected ?? [],
  };
}

describe("pluginRows status", () => {
  it.each([
    ["ready when nothing is required", { requires: none, enabled: true }, "ready"],
    ["needs-setup when an account is missing", { requires: { accounts: ["google"] }, enabled: true }, "needs-setup"],
    ["ready once that account is connected", { requires: { accounts: ["google"] }, enabled: true, connected: ["google"] }, "ready"],
    ["off wins over an unmet requirement", { requires: { accounts: ["google"] }, enabled: false }, "off"],
    ["off even when otherwise ready", { requires: none, enabled: false }, "off"],
  ])("%s", (_name, input, status) => {
    expect(pluginRows(build(input))[0]!.status).toBe(status);
  });
});

it("names an unmet requirement with the action that fixes it, and stays silent once met", () => {
  const unmet = (connected: string[]) => pluginRows(build({ requires: { accounts: ["google"] }, enabled: true, connected }))[0]!.unmet;
  expect(unmet([])).toEqual([{ id: "google", action: "Connect Google" }]);
  expect(unmet(["google"])).toEqual([]);
});

it("shows a disabled plugin's requirements to nobody", () => {
  const [row] = pluginRows(build({ requires: { accounts: ["google"] }, enabled: false }));
  expect(row!.unmet).toEqual([]);
});

it("carries its skill's description", () => {
  const [row] = pluginRows(build({ requires: none, enabled: true }));
  expect(row!.description).toBe("Keeps a wiki.");
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
    { connected: [] as string[], status: "needs-setup", unmet: [{ id: "google", action: "Connect Google" }] },
    { connected: ["google"], status: "ready", unmet: [] },
  ])("reads gog as $status with connected accounts $connected", ({ connected, status, unmet }) => {
    const [row] = pluginRows({ plugins: [{ manifest: shipped("gog"), enabled: true }], connectedAccounts: connected });
    expect(row).toMatchObject({ name: "gog", status, unmet });
  });
});

describe("browserPluginRow", () => {
  const base = { enabled: true, runtimePresent: true, safariJavaScript: true, description: "Browse websites…" };
  it.each([
    ["ready when the runtime is present and Safari allows JavaScript", base, "ready", []],
    ["needs setup with an Enable button when Safari does not", { ...base, safariJavaScript: false }, "needs-setup", [{ id: SAFARI_JAVASCRIPT, action: "Enable in Safari" }]],
    ["needs setup with no button when the runtime is missing", { ...base, runtimePresent: false }, "needs-setup", [{ id: BROWSER_RUNTIME, action: null }]],
    ["off hides its requirements", { ...base, enabled: false, safariJavaScript: false }, "off", []],
  ] as const)("is %s", (_what, input, status, unmet) => {
    const row = browserPluginRow(input);
    expect(row).toMatchObject({ name: "browser", title: "Browser use", kind: "Browser", status, unmet });
  });

  it("every manifest plugin row is a CLI titled by its name", () => {
    const [row] = pluginRows({ plugins: [{ manifest: manifest(none, "gog"), enabled: true }], connectedAccounts: [] });
    expect(row).toMatchObject({ kind: "CLI", title: row!.name });
  });
});

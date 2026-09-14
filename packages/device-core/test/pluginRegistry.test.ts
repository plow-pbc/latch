import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installPlugin } from "../src/plugins/install.js";
import { PluginRegistry } from "../src/plugins/registry.js";
import { fixturePlugin, FIXTURE_ENV } from "./pluginFixture.js";

const deps = { fetch: globalThis.fetch, arch: "arm64" as const, plowApiBase: "https://api.example", log: () => {} };

describe("PluginRegistry", () => {
  it("loads installed plugins, publishes their skills and refuses off-allowlist argv", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "latch-plugins-"));
    await installPlugin(root, fixturePlugin({ env: FIXTURE_ENV }), deps);
    const reg = new PluginRegistry(root);
    reg.load();
    expect(reg.all().map((p) => p.skill.name)).toEqual(["fix"]);
    expect(reg.find(["fix", "query"])?.manifest.name).toBe("fix");
    expect(reg.find(["/x/fix", "query"])).toBeNull();
    expect(reg.refuse(["fix", "query", "hi"])).toBeNull();
    expect(reg.refuse(["fix", "serve"])).toBe("fix allows: query, put");
    expect(reg.refuse(["ls"])).toBeNull();
    expect(reg.vendorDirs()).toEqual([path.join(root, "fix", "bin"), path.join(root, "fix", "runtime")]);
  });
  it("refuses every invocation while the daemon is unhealthy, before any intent", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "latch-plugins-"));
    await installPlugin(root, fixturePlugin({ daemon: { argv: ["serve"], health: "/health" } }), deps);
    const reg = new PluginRegistry(root); reg.load();
    expect(reg.refuse(["fix", "query", "x"])).toBe("fix is not running");
    reg.setHealth("fix", () => true);
    expect(reg.refuse(["fix", "query", "x"])).toBeNull();
  });
  it("resolves env with the plugin's secret and a per-invocation mint", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "latch-plugins-"));
    await installPlugin(root, fixturePlugin({ env: FIXTURE_ENV }), deps);
    const reg = new PluginRegistry(root); reg.load();
    const env = await reg.env(reg.all()[0], async (scope) => `minted:${scope}`, "https://api.example");
    expect(env.FIX_KEY).toBe("minted:llm:chat");
    expect(env.FIX_SECRET).toHaveLength(64);
    expect(env.FIX_HOME).toBe(path.join(root, "fix", "home"));
  });
  it("skips a plugin with no readable skill, surfacing it via problems() without stopping the others", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "latch-plugins-"));
    await installPlugin(root, fixturePlugin({ env: FIXTURE_ENV }), deps);
    await installPlugin(root, fixturePlugin({ name: "fox", command: "fox" }, { "skill.md": "not frontmatter" }), deps);
    const reg = new PluginRegistry(root);
    reg.load();
    expect(reg.all().map((p) => p.manifest.name)).toEqual(["fix"]);
    expect(reg.problems()).toEqual([{ name: "fox", problem: "skill has no frontmatter" }]);
  });
  it("skips an installed plugin whose on-disk manifest is corrupt, without throwing", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "latch-plugins-"));
    await installPlugin(root, fixturePlugin({ env: FIXTURE_ENV }), deps);
    await installPlugin(root, fixturePlugin({ name: "fox", command: "fox" }), deps);
    fs.writeFileSync(path.join(root, "fox", "repo", "latch-plugin.json"), "{not json");
    const reg = new PluginRegistry(root);
    expect(() => reg.load()).not.toThrow();
    expect(reg.all().map((p) => p.manifest.name)).toEqual(["fix"]);
    expect(reg.problems()).toEqual([{ name: "fox", problem: "manifest is not valid JSON" }]);
  });
  it("skips a plugin whose command collides with one already loaded", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "latch-plugins-"));
    await installPlugin(root, fixturePlugin({ env: FIXTURE_ENV }), deps);
    await installPlugin(root, fixturePlugin({ name: "fox" }), deps); // command stays "fix"
    const reg = new PluginRegistry(root);
    reg.load();
    expect(reg.all().map((p) => p.manifest.name)).toEqual(["fix"]);
    expect(reg.problems()).toEqual([{ name: "fox", problem: "command fix is already claimed by fix" }]);
  });
});

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installPlugin } from "../src/plugins/install.js";
import { PluginRegistry } from "../src/plugins/registry.js";
import { fixturePlugin, FIXTURE_ENV, FIXTURE_MINT_ENV } from "./pluginFixtures.js";

describe("PluginRegistry", () => {
  it("loads installed plugins, publishes their skills and refuses off-allowlist argv", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "latch-plugins-"));
    await installPlugin(root, fixturePlugin({ env: FIXTURE_ENV }));
    const reg = new PluginRegistry(root);
    reg.load();
    expect(reg.all().map((p) => p.skill.name)).toEqual(["fix"]);
    expect(reg.find(["fix", "query"])?.manifest.name).toBe("fix");
    expect(reg.find(["/x/fix", "query"])).toBeNull();
    expect(reg.refuse(["fix", "query", "hi"])).toBeNull();
    expect(reg.refuse(["fix", "serve"])).toBe("fix allows: query, put");
    expect(reg.refuse(["ls"])).toBeNull();
  });

  it("resolves fixed and secret env, and refuses a mint source with no mint function", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "latch-plugins-"));
    await installPlugin(root, fixturePlugin({ env: FIXTURE_ENV }));
    const reg = new PluginRegistry(root);
    reg.load();
    const env = await reg.env(reg.all()[0]!, null, "https://api.example");
    expect(env.FIX_SECRET).toHaveLength(64);
    expect(env.FIX_HOME).toBe(path.join(root, "fix", "home"));

    const root2 = fs.mkdtempSync(path.join(os.tmpdir(), "latch-plugins-"));
    await installPlugin(root2, fixturePlugin({ env: FIXTURE_MINT_ENV }));
    const reg2 = new PluginRegistry(root2);
    reg2.load();
    await expect(reg2.env(reg2.all()[0]!, null, "https://api.example")).rejects.toThrow("this Mac is not paired with Plow");
  });

  it("wraps a missing secret file as a PluginError naming the field, not the path", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "latch-plugins-"));
    await installPlugin(root, fixturePlugin({ env: FIXTURE_ENV }));
    const reg = new PluginRegistry(root);
    reg.load();
    fs.rmSync(path.join(root, "fix", "secrets", "token"));
    await expect(reg.env(reg.all()[0]!, null, "https://api.example")).rejects.toThrow("no secret named token");
  });

  it("setHealth gates every invocation while unhealthy, before any intent", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "latch-plugins-"));
    await installPlugin(root, fixturePlugin({ env: FIXTURE_ENV }));
    const reg = new PluginRegistry(root);
    reg.load();
    reg.setHealth("fix", () => false);
    expect(reg.refuse(["fix", "query", "x"])).toBe("fix is not running");
    reg.setHealth("fix", () => true);
    expect(reg.refuse(["fix", "query", "x"])).toBeNull();
  });

  it("skips a plugin with no readable skill, surfacing it via problems() without stopping the others", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "latch-plugins-"));
    await installPlugin(root, fixturePlugin({ env: FIXTURE_ENV }));
    await installPlugin(root, fixturePlugin({ name: "fox", command: "fox" }, { "skill.md": "not frontmatter" }));
    const reg = new PluginRegistry(root);
    reg.load();
    expect(reg.all().map((p) => p.manifest.name)).toEqual(["fix"]);
    expect(reg.problems()).toEqual([{ name: "fox", problem: "skill has no frontmatter" }]);
  });

  it("skips an installed plugin whose on-disk manifest is corrupt, without throwing", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "latch-plugins-"));
    await installPlugin(root, fixturePlugin({ env: FIXTURE_ENV }));
    await installPlugin(root, fixturePlugin({ name: "fox", command: "fox" }));
    fs.writeFileSync(path.join(root, "fox", "repo", "latch-plugin.json"), "{not json");
    const reg = new PluginRegistry(root);
    expect(() => reg.load()).not.toThrow();
    expect(reg.all().map((p) => p.manifest.name)).toEqual(["fix"]);
    expect(reg.problems()).toEqual([{ name: "fox", problem: "manifest is not valid JSON" }]);
  });

  it("skips a plugin whose command collides with one already loaded", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "latch-plugins-"));
    await installPlugin(root, fixturePlugin({ env: FIXTURE_ENV }));
    await installPlugin(root, fixturePlugin({ name: "fox" })); // command stays "fix"
    const reg = new PluginRegistry(root);
    reg.load();
    expect(reg.all().map((p) => p.manifest.name)).toEqual(["fix"]);
    expect(reg.problems()).toEqual([{ name: "fox", problem: "command fix is already claimed by fix" }]);
  });
});

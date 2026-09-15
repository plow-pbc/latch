import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PluginError } from "../src/plugins/manifest.js";
import { loadPlugins, pluginRoots } from "../src/plugins/registry.js";
import { fakePlugin, MINIMAL } from "./pluginFixtures.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const c of cleanups.splice(0)) c(); delete process.env.DOMO_PLUGINS; });
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "latch-reg-"));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}
const SCRIPT = "#!/bin/sh\necho hi\n";

describe("loadPlugins", () => {
  it("loads a staged plugin and names its bin dir", () => {
    const root = tmp();
    const dir = fakePlugin(root, MINIMAL, SCRIPT);
    const [p] = loadPlugins([root]);
    expect(p.manifest.name).toBe("fix");
    expect(p.dir).toBe(dir);
    expect(p.binDir).toBe(path.join(dir, "runtime", process.arch, "bin"));
  });

  it("omits a plugin whose executable is not staged, and a directory with no manifest", () => {
    const root = tmp();
    fakePlugin(root, MINIMAL, SCRIPT);
    fs.rmSync(path.join(root, "fix", "runtime"), { recursive: true });
    fs.mkdirSync(path.join(root, "stray"));
    expect(loadPlugins([root])).toEqual([]);
  });

  it("takes the first root that has a name, and a missing root is not an error", () => {
    const first = tmp(); const second = tmp();
    fakePlugin(first, { ...MINIMAL, version: "first" }, SCRIPT);
    fakePlugin(second, { ...MINIMAL, version: "second" }, SCRIPT);
    const loaded = loadPlugins([path.join(tmp(), "absent"), first, second]);
    expect(loaded.map((p) => p.manifest.version)).toEqual(["first"]);
  });

  it("refuses a manifest whose name is not its directory", () => {
    const root = tmp();
    fakePlugin(root, MINIMAL, SCRIPT);
    fs.renameSync(path.join(root, "fix"), path.join(root, "other"));
    expect(() => loadPlugins([root])).toThrow(PluginError);
  });
});

describe("pluginRoots", () => {
  it("orders override, Resources, vendor tree, then the owner's installed plugins", () => {
    process.env.DOMO_PLUGINS = "/o";
    expect(pluginRoots({ resourcesDir: "/r", repoRoot: "/c", home: "/h" })).toEqual([
      "/o", "/r/plugins", "/c/vendor/plugins", "/h/plugins",
    ]);
    delete process.env.DOMO_PLUGINS;
    expect(pluginRoots({ home: "/h" })).toEqual(["/h/plugins"]);
  });
});

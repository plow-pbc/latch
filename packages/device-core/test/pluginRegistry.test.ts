import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parseManifest, PluginError } from "../src/plugins/manifest.js";
import { loadPlugins, pluginRoots } from "../src/plugins/registry.js";
import { stageBinaries, type Arch } from "../src/plugins/stage.js";
import { fakePlugin, MINIMAL, tarball, tempDirs } from "./pluginFixtures.js";

const { tmp, cleanup } = tempDirs("latch-reg-");
afterEach(() => { cleanup(); delete process.env.DOMO_PLUGINS; });
const SCRIPT = "#!/bin/sh\necho hi\n";

describe("loadPlugins", () => {
  it("loads a plugin with no declared binaries, present on its manifest alone", () => {
    const root = tmp();
    const dir = fakePlugin(root, MINIMAL, SCRIPT);
    const [p] = loadPlugins([root]);
    expect(p.manifest.name).toBe("fix");
    expect(p.dir).toBe(dir);
    expect(p.binDir).toBe(path.join(dir, "runtime", process.arch, "bin"));
  });

  it("omits a plugin whose declared binary is not staged, and a directory with no manifest", () => {
    const root = tmp();
    const withBinary = {
      ...MINIMAL,
      runtime: { binaries: [{
        name: "tool",
        url: { arm64: "https://x/tool", x64: "https://x/tool" },
        sha256: { arm64: "a".repeat(64), x64: "a".repeat(64) },
      }], sources: [] },
    };
    fakePlugin(root, withBinary, SCRIPT);
    fs.rmSync(path.join(root, "fix", "runtime", process.arch, "bin", "tool"));
    fs.mkdirSync(path.join(root, "stray"));
    expect(loadPlugins([root])).toEqual([]);
  });

  it("is present once stageBinaries has staged its declared binary, not before", async () => {
    const { file, sha256 } = tarball(tmp);
    const root = tmp();
    const manifest = parseManifest(JSON.stringify({
      ...MINIMAL,
      runtime: { binaries: [{
        name: "tool",
        url: { arm64: "https://example.invalid/tool", x64: "https://example.invalid/tool" },
        sha256: { arm64: sha256, x64: sha256 },
      }], sources: [] },
    }));
    const dir = path.join(root, manifest.name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "latch-plugin.json"), JSON.stringify(manifest));
    expect(loadPlugins([root])).toEqual([]);
    await stageBinaries(manifest, dir, process.arch as Arch, tmp(), async () => fs.readFileSync(file));
    const [p] = loadPlugins([root]);
    expect(p.manifest.name).toBe(manifest.name);
    expect(p.binDir).toBe(path.join(dir, "runtime", process.arch, "bin"));
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
    // Resolved, so no root — and so no binDir — can depend on the cwd.
    process.env.DOMO_PLUGINS = "rel/plugins";
    expect(pluginRoots({ home: "/h" })[0]).toBe(path.resolve("rel/plugins"));
    delete process.env.DOMO_PLUGINS;
    expect(pluginRoots({ home: "/h" })).toEqual(["/h/plugins"]);
  });
});

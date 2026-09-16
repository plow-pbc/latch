import { afterEach, describe, expect, it, vi } from "vitest";
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
    expect(p.binDir).toBe(path.join(fs.realpathSync(dir), "runtime", process.arch, "bin"));
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
    expect(p.binDir).toBe(path.join(fs.realpathSync(dir), "runtime", process.arch, "bin"));
  });

  it("takes the first root that has a name, and a missing root is not an error", () => {
    const first = tmp(); const second = tmp();
    fakePlugin(first, { ...MINIMAL, version: "first" }, SCRIPT);
    fakePlugin(second, { ...MINIMAL, version: "second" }, SCRIPT);
    const loaded = loadPlugins([path.join(tmp(), "absent"), first, second]);
    expect(loaded.map((p) => p.manifest.version)).toEqual(["first"]);
  });

  it("an unstaged plugin in a higher root claims its name; a lower root cannot supply the binary", () => {
    const first = tmp(); const second = tmp();
    const withBinary = {
      ...MINIMAL,
      runtime: { binaries: [{
        name: "tool",
        url: { arm64: "https://x/tool", x64: "https://x/tool" },
        sha256: { arm64: "a".repeat(64), x64: "a".repeat(64) },
      }], sources: [] },
    };
    fakePlugin(first, withBinary, SCRIPT);
    fs.rmSync(path.join(first, "fix", "runtime", process.arch, "bin", "tool"));
    fakePlugin(second, withBinary, SCRIPT);
    expect(loadPlugins([first, second])).toEqual([]);
  });

  it("skips the second of two staged plugins claiming the same command, keeping the load", () => {
    const root = tmp();
    fakePlugin(root, { ...MINIMAL, name: "fixa" }, SCRIPT);
    fakePlugin(root, { ...MINIMAL, name: "fixb" }, SCRIPT);
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const loaded = loadPlugins([root]);
    // Alphabetically, "fixa" is read first — it keeps the command, "fixb" is
    // skipped, and the sentence names both the command and the loser.
    expect(loaded.map((p) => p.manifest.name)).toEqual(["fixa"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"fix"'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("fixb"));
    warn.mockRestore();
  });

  it("across roots, the higher-priority root's plugin keeps a command a lower root's plugin also declares", () => {
    const first = tmp(); const second = tmp();
    fakePlugin(first, { ...MINIMAL, name: "fixa" }, SCRIPT);
    fakePlugin(second, { ...MINIMAL, name: "fixb" }, SCRIPT);
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const loaded = loadPlugins([first, second]);
    expect(loaded.map((p) => p.manifest.name)).toEqual(["fixa"]);
    warn.mockRestore();
  });

  it("refuses a manifest whose name is not its directory", () => {
    const root = tmp();
    fakePlugin(root, MINIMAL, SCRIPT);
    fs.renameSync(path.join(root, "fix"), path.join(root, "other"));
    expect(() => loadPlugins([root])).toThrow(PluginError);
  });
});

describe("pluginRoots", () => {
  it.each([
    ["nothing", (d: string) => path.join(d, "absent")],
    ["a file", (d: string) => { const f = path.join(d, "file"); fs.writeFileSync(f, ""); return f; }],
  ])("refuses a DOMO_PLUGINS that names %s, instead of reading the next root", (_, at) => {
    process.env.DOMO_PLUGINS = at(tmp());
    expect(() => pluginRoots({})).toThrow(PluginError);
  });

  it("orders override, Resources, then the vendor tree", () => {
    const o = tmp();
    process.env.DOMO_PLUGINS = o;
    expect(pluginRoots({ resourcesDir: "/r", repoRoot: "/c" })).toEqual([
      o, "/r/plugins", "/c/vendor/plugins",
    ]);
    // Resolved, so no root — and so no binDir — can depend on the cwd.
    const rel = path.relative(process.cwd(), tmp());
    process.env.DOMO_PLUGINS = rel;
    expect(pluginRoots({})[0]).toBe(path.resolve(rel));
    delete process.env.DOMO_PLUGINS;
    expect(pluginRoots({})).toEqual([]);
  });
});

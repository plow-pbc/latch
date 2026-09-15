import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installPlugin, listInstalled, pluginDirs, removePlugin } from "../src/plugins/install.js";
import { PluginError } from "../src/plugins/manifest.js";
import { fixturePlugin, FIXTURE_ENV } from "./pluginFixtures.js";

const roots: string[] = [];
const root = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "latch-plugins-"));
  roots.push(d);
  return d;
};
afterEach(() => {
  for (const d of roots.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("installPlugin", () => {
  it("materializes repo, a secret and home, and records the commit", async () => {
    const r = root();
    const installed = await installPlugin(r, fixturePlugin({ env: FIXTURE_ENV }));
    const d = pluginDirs(r, "fix");
    expect(installed.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(fs.existsSync(path.join(d.repo, "latch-plugin.json"))).toBe(true);
    expect(fs.statSync(d.secrets).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(d.secrets, "token")).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(path.join(d.secrets, "token"), "utf8")).toHaveLength(64);
    expect(fs.existsSync(d.home)).toBe(true);
    expect(listInstalled(r).map((p) => p.installed.name)).toEqual(["fix"]);
  });

  it("refuses a plugin command that shadows a vendored provider, before creating anything", async () => {
    const r = root();
    await expect(installPlugin(r, fixturePlugin({ command: "gog" }))).rejects.toThrow(
      new PluginError("command gog is already provided by Latch"),
    );
    expect(fs.existsSync(pluginDirs(r, "fix").root)).toBe(false);
  });

  it("refuses a manifest that declares runtime.binaries, leaving nothing behind", async () => {
    const r = root();
    await expect(
      installPlugin(
        r,
        fixturePlugin({ runtime: { binaries: [{ name: "b", version: "1", url: { arm64: "https://x/b", x64: "https://x/b" }, sha256: { arm64: "a".repeat(64), x64: "a".repeat(64) } }], sources: [] } }),
      ),
    ).rejects.toThrow(new PluginError("this build cannot install a plugin that declares runtime.binaries or runtime.sources yet"));
    expect(fs.existsSync(r)).toBe(true);
    expect(fs.readdirSync(r).filter((n) => !n.startsWith("."))).toEqual([]);
  });

  it("refuses a manifest that declares runtime.sources", async () => {
    const r = root();
    await expect(
      installPlugin(r, fixturePlugin({ runtime: { binaries: [], sources: [{ name: "s", git: "https://x/s", commit: "a".repeat(40) }] } })),
    ).rejects.toThrow(new PluginError("this build cannot install a plugin that declares runtime.binaries or runtime.sources yet"));
  });

  it("refuses a manifest that declares hooks.postinstall", async () => {
    const r = root();
    await expect(installPlugin(r, fixturePlugin({ hooks: { postinstall: "hooks/post.sh" } }, { "hooks/post.sh": "#!/bin/sh\n" }))).rejects.toThrow(
      new PluginError("this build cannot install a plugin that declares hooks.postinstall yet"),
    );
  });

  it("refuses a manifest that declares a daemon", async () => {
    const r = root();
    await expect(installPlugin(r, fixturePlugin({ daemon: { argv: ["serve"], health: "/health" } }))).rejects.toThrow(
      new PluginError("this build cannot install a plugin that declares a daemon yet"),
    );
  });

  it("refuses a manifest whose declared skill file is missing", async () => {
    const r = root();
    await expect(installPlugin(r, fixturePlugin({ skill: "missing.md" }))).rejects.toThrow(new PluginError("manifest skill file is missing"));
    expect(fs.existsSync(pluginDirs(r, "fix").root)).toBe(false);
  });

  it("removes everything but home, and home too with purge", async () => {
    const r = root();
    await installPlugin(r, fixturePlugin());
    removePlugin(r, "fix", { purge: false });
    expect(fs.existsSync(pluginDirs(r, "fix").home)).toBe(true);
    expect(fs.existsSync(pluginDirs(r, "fix").repo)).toBe(false);
    removePlugin(r, "fix", { purge: true });
    expect(fs.existsSync(pluginDirs(r, "fix").root)).toBe(false);
  });

  it("reinstalling keeps home and the same secret", async () => {
    const r = root();
    await installPlugin(r, fixturePlugin({ env: FIXTURE_ENV }));
    const d = pluginDirs(r, "fix");
    fs.writeFileSync(path.join(d.home, "data"), "kept");
    const secret = fs.readFileSync(path.join(d.secrets, "token"), "utf8");
    await installPlugin(r, fixturePlugin({ env: FIXTURE_ENV }));
    expect(fs.readFileSync(path.join(d.home, "data"), "utf8")).toBe("kept");
    expect(fs.readFileSync(path.join(d.secrets, "token"), "utf8")).toBe(secret);
  });
});

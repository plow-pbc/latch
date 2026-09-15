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

  it("leaves no staging directory behind when the git url is refused", async () => {
    // The url is validated before anything is created: the `finally` that
    // removes the staging dir only covers the clone, so a url rejected
    // before it would otherwise orphan a `.install-` dir on every attempt.
    const r = root();
    await expect(installPlugin(r, "ext::sh -c 'echo pwned'")).rejects.toThrow(PluginError);
    expect(fs.readdirSync(r)).toEqual([]);
  });

  it("lists a good install even when a stray directory sits beside it", async () => {
    // One unusable entry under the plugins root never stops the others
    // loading — the slug guard in pluginDirs refuses such a name, so the
    // listing has to skip it rather than propagate the refusal.
    const r = root();
    await installPlugin(r, fixturePlugin());
    fs.mkdirSync(path.join(r, "Not A Plugin"));
    expect(listInstalled(r).map((p) => p.installed.name)).toEqual(["fix"]);
  });

  it("refuses a plugin command that shadows a vendored provider, before creating anything", async () => {
    const r = root();
    await expect(installPlugin(r, fixturePlugin({ command: "gog" }))).rejects.toThrow(
      new PluginError("command gog is already provided by Latch"),
    );
    expect(fs.existsSync(pluginDirs(r, "fix").root)).toBe(false);
  });

  // One shape per declaration this build cannot yet materialize: refused
  // outright, at install, rather than silently installing something
  // narrower than the manifest asked for.
  it.each([
    ["runtime.binaries", { runtime: { binaries: [{ name: "b", version: "1", url: { arm64: "https://x/b", x64: "https://x/b" }, sha256: { arm64: "a".repeat(64), x64: "a".repeat(64) } }], sources: [] } }, "runtime.binaries or runtime.sources"],
    ["runtime.sources", { runtime: { binaries: [], sources: [{ name: "s", git: "https://x/s", commit: "a".repeat(40) }] } }, "runtime.binaries or runtime.sources"],
    ["hooks.postinstall", { hooks: { postinstall: "hooks/post.sh" } }, "hooks.postinstall"],
    ["a daemon", { daemon: { argv: ["serve"], health: "/health" } }, "a daemon"],
  ])("refuses a manifest that declares %s, leaving nothing behind", async (_label, patch, fragment) => {
    const r = root();
    await expect(installPlugin(r, fixturePlugin(patch))).rejects.toThrow(
      new PluginError(`this build cannot install a plugin that declares ${fragment} yet`),
    );
    expect(fs.readdirSync(r).filter((n) => !n.startsWith("."))).toEqual([]);
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

  it("refuses a git url using a transport helper (ext::), never quoting it", async () => {
    const r = root();
    await expect(installPlugin(r, "ext::sh -c 'touch /tmp/latch-plugins-pwned; exit 1'")).rejects.toThrow(
      new PluginError("plugin git url must be https or a local path"),
    );
  });

  it("still clones a normal (local path) git url", async () => {
    const r = root();
    const installed = await installPlugin(r, fixturePlugin());
    expect(installed.name).toBe("fix");
  });

  it("refuses installing a different plugin that reuses an existing name, without touching its secrets or home", async () => {
    const r = root();
    await installPlugin(r, fixturePlugin({ env: FIXTURE_ENV }));
    const d = pluginDirs(r, "fix");
    const secret = fs.readFileSync(path.join(d.secrets, "token"), "utf8");
    fs.writeFileSync(path.join(d.home, "data"), "kept");
    const otherOrigin = fixturePlugin({ env: FIXTURE_ENV }); // different repo, same manifest name "fix"
    await expect(installPlugin(r, otherOrigin)).rejects.toThrow(
      new PluginError("a plugin named fix is already installed from a different origin; remove it first"),
    );
    expect(fs.readFileSync(path.join(d.secrets, "token"), "utf8")).toBe(secret);
    expect(fs.readFileSync(path.join(d.home, "data"), "utf8")).toBe("kept");
    expect(fs.existsSync(d.repo)).toBe(true);
  });

  it("removePlugin refuses a name that escapes the plugins root", () => {
    const r = root();
    expect(() => removePlugin(r, "../../etc", { purge: true })).toThrow(
      new PluginError("plugin name must be lowercase letters, digits and dashes"),
    );
  });

  it("reinstalling from the same origin keeps home and the same secret", async () => {
    const r = root();
    const origin = fixturePlugin({ env: FIXTURE_ENV });
    await installPlugin(r, origin);
    const d = pluginDirs(r, "fix");
    fs.writeFileSync(path.join(d.home, "data"), "kept");
    const secret = fs.readFileSync(path.join(d.secrets, "token"), "utf8");
    await installPlugin(r, origin);
    expect(fs.readFileSync(path.join(d.home, "data"), "utf8")).toBe("kept");
    expect(fs.readFileSync(path.join(d.secrets, "token"), "utf8")).toBe(secret);
  });
});

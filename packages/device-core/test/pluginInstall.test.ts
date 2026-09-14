import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installPlugin, listInstalled, pluginDirs, removePlugin } from "../src/plugins/install.js";
import { PluginError } from "../src/plugins/manifest.js";
import { fixturePlugin, FIXTURE_ENV } from "./pluginFixture.js";

const roots: string[] = [];
const root = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "latch-plugins-"));
  roots.push(d);
  return d;
};
afterEach(() => {
  for (const d of roots.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const bytes = Buffer.from("#!/bin/sh\necho tool $*\n");
const sha = crypto.createHash("sha256").update(bytes).digest("hex");
const fakeFetch = (body: Buffer) => (async () => new Response(body)) as unknown as typeof fetch;
const deps = (fetch = fakeFetch(bytes)) => ({ fetch, arch: "arm64" as const, plowApiBase: "https://api.example", log: () => {} });

describe("installPlugin", () => {
  it("materializes repo, wrapper, secrets and home, and records the commit", async () => {
    const r = root();
    const installed = await installPlugin(r, fixturePlugin({ env: FIXTURE_ENV }), deps());
    const d = pluginDirs(r, "fix");
    expect(installed.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(fs.statSync(path.join(d.bin, "fix")).mode & 0o111).not.toBe(0);
    expect(fs.statSync(path.join(d.secrets, "token")).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(path.join(d.secrets, "token"), "utf8")).toHaveLength(64);
    expect(fs.existsSync(d.home)).toBe(true);
    expect(listInstalled(r).map((p) => p.installed.name)).toEqual(["fix"]);
  });

  it("stages a binary whose sha matches, and refuses one whose sha does not — leaving nothing", async () => {
    const binary = (s: string) => ({ runtime: { binaries: [{ name: "tool", version: "1", url: { arm64: "https://x/t", x64: "https://x/t" }, sha256: { arm64: s, x64: s } }], sources: [] } });
    const r = root();
    await installPlugin(r, fixturePlugin(binary(sha)), deps());
    expect(fs.statSync(path.join(pluginDirs(r, "fix").runtimeBin, "tool")).mode & 0o111).not.toBe(0);
    const r2 = root();
    await expect(installPlugin(r2, fixturePlugin(binary("0".repeat(64))), deps())).rejects.toThrow(new PluginError("binary tool did not match its sha256"));
    expect(fs.existsSync(pluginDirs(r2, "fix").root)).toBe(false);
  });

  it("wraps a binary fetch's network exception so the url never reaches the error", async () => {
    const binary = { runtime: { binaries: [{ name: "tool", version: "1", url: { arm64: "https://x/t", x64: "https://x/t" }, sha256: { arm64: sha, x64: sha } }], sources: [] } };
    const failingFetch = (async () => {
      throw new Error("getaddrinfo ENOTFOUND https://x/t");
    }) as unknown as typeof fetch;
    const r = root();
    await expect(installPlugin(r, fixturePlugin(binary), deps(failingFetch))).rejects.toThrow(new PluginError("binary tool could not be downloaded"));
    expect(fs.existsSync(pluginDirs(r, "fix").root)).toBe(false);
  });

  it("extracts an archive binary even when its download url carries a query string", async () => {
    const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "latch-archive-"));
    fs.writeFileSync(path.join(srcDir, "tool"), "#!/bin/sh\necho tool $*\n", { mode: 0o755 });
    const tgz = path.join(srcDir, "tool.tar.gz");
    execFileSync("/usr/bin/tar", ["-czf", tgz, "-C", srcDir, "tool"]);
    const archiveBytes = fs.readFileSync(tgz);
    const archiveSha = crypto.createHash("sha256").update(archiveBytes).digest("hex");
    const binary = {
      runtime: {
        binaries: [{ name: "tool", version: "1", url: { arm64: "https://x/tool.tar.gz?X-Amz-Signature=abc", x64: "https://x/tool.tar.gz?X-Amz-Signature=abc" }, sha256: { arm64: archiveSha, x64: archiveSha } }],
        sources: [],
      },
    };
    const r = root();
    await installPlugin(r, fixturePlugin(binary), deps(fakeFetch(archiveBytes)));
    const linked = path.join(pluginDirs(r, "fix").runtimeBin, "tool");
    expect(fs.lstatSync(linked).isSymbolicLink()).toBe(true);
    expect(fs.statSync(linked).mode & 0o111).not.toBe(0);
  });

  it("clones a source at its commit and runs its install argv with runtime/bin on PATH", async () => {
    const src = fixturePlugin(); // any git repo will do as a source
    const commit = fs.readFileSync(path.join(src, ".git", "refs", "heads", fs.readdirSync(path.join(src, ".git", "refs", "heads"))[0]), "utf8").trim();
    const r = root();
    await installPlugin(r, fixturePlugin({ runtime: { binaries: [], sources: [{ name: "lib", git: src, commit, install: ["/bin/sh", "-c", "echo built > built.txt"] }] } }), deps());
    expect(fs.readFileSync(path.join(pluginDirs(r, "fix").runtime, "lib", "built.txt"), "utf8")).toBe("built\n");
  });

  it("runs the postinstall hook with fixed and secret env, and refuses the install when it fails", async () => {
    const r = root();
    await installPlugin(r, fixturePlugin({ env: FIXTURE_ENV, hooks: { postinstall: "hooks/post.sh" } }, { "hooks/post.sh": '#!/bin/sh\necho "$FIX_HOME" > "$FIX_HOME/seen"\n' }), deps());
    expect(fs.readFileSync(path.join(pluginDirs(r, "fix").home, "seen"), "utf8").trim()).toBe(pluginDirs(r, "fix").home);
    const r2 = root();
    await expect(installPlugin(r2, fixturePlugin({ hooks: { postinstall: "hooks/post.sh" } }, { "hooks/post.sh": "#!/bin/sh\nexit 3\n" }), deps())).rejects.toThrow(new PluginError("postinstall hook failed"));
    expect(fs.existsSync(pluginDirs(r2, "fix").root)).toBe(false);
  });

  it("allocates a port for a plugin with a daemon and none otherwise", async () => {
    const r = root();
    expect((await installPlugin(r, fixturePlugin(), deps())).port).toBeNull();
    const r2 = root();
    expect((await installPlugin(r2, fixturePlugin({ daemon: { argv: ["serve"], health: "/health" } }), deps())).port).toBeGreaterThan(1024);
  });

  it("removes everything but home, and home too with purge", async () => {
    const r = root();
    await installPlugin(r, fixturePlugin(), deps());
    removePlugin(r, "fix", { purge: false });
    expect(fs.existsSync(pluginDirs(r, "fix").home)).toBe(true);
    expect(fs.existsSync(pluginDirs(r, "fix").bin)).toBe(false);
    removePlugin(r, "fix", { purge: true });
    expect(fs.existsSync(pluginDirs(r, "fix").root)).toBe(false);
  });

  it("reinstalling keeps home and secrets", async () => {
    const r = root();
    await installPlugin(r, fixturePlugin({ env: FIXTURE_ENV }), deps());
    const d = pluginDirs(r, "fix");
    fs.writeFileSync(path.join(d.home, "data"), "kept");
    const secret = fs.readFileSync(path.join(d.secrets, "token"), "utf8");
    await installPlugin(r, fixturePlugin({ env: FIXTURE_ENV }), deps());
    expect(fs.readFileSync(path.join(d.home, "data"), "utf8")).toBe("kept");
    expect(fs.readFileSync(path.join(d.secrets, "token"), "utf8")).toBe(secret);
  });
});

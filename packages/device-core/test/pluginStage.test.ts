import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseManifest, PluginError } from "../src/plugins/manifest.js";
import { binDir, runPostinstall, stageBinaries, type Arch } from "../src/plugins/stage.js";
import { MINIMAL } from "./pluginFixtures.js";

const ARCH = process.arch as Arch;
const cleanups: (() => void)[] = [];
afterEach(() => { for (const c of cleanups.splice(0)) c(); });
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "latch-stage-"));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

/** A gzipped tarball holding one executable `tool` that prints its argv. */
function tarball(): { file: string; sha256: string } {
  const src = tmp();
  fs.writeFileSync(path.join(src, "tool"), '#!/bin/sh\necho "ARGV=$*"\n', { mode: 0o755 });
  const file = path.join(tmp(), "tool.tgz");
  execFileSync("tar", ["czf", file, "-C", src, "tool"]);
  return { file, sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex") };
}

function manifestWith(sha256: string, extra: Record<string, unknown> = {}) {
  return parseManifest(JSON.stringify({
    ...MINIMAL,
    exec: { cwd: "plugin", argv: ["tool", "--fixed"] },
    runtime: { binaries: [{
      name: "tool", version: "1",
      url: { arm64: "https://example.invalid/tool", x64: "https://example.invalid/tool" },
      sha256: { arm64: sha256, x64: sha256 },
    }], sources: [] },
    ...extra,
  }));
}

describe("stageBinaries", () => {
  it("verifies the archive, extracts it, and puts the executable in runtime/<arch>/bin", async () => {
    const { file, sha256 } = tarball();
    const pluginDir = tmp();
    let fetched = 0;
    await stageBinaries(manifestWith(sha256), pluginDir, ARCH, tmp(), async () => { fetched++; return fs.readFileSync(file); });
    const staged = path.join(binDir(pluginDir, ARCH), "tool");
    expect(fetched).toBe(1);
    expect(execFileSync(staged, ["a"], { encoding: "utf8" })).toBe("ARGV=a\n");
  });

  it("refuses an archive whose bytes do not match the pin, staging nothing", async () => {
    const { file } = tarball();
    const pluginDir = tmp();
    const wrong = "0".repeat(64);
    await expect(
      stageBinaries(manifestWith(wrong), pluginDir, ARCH, tmp(), async () => fs.readFileSync(file)),
    ).rejects.toThrow(PluginError);
    expect(fs.existsSync(binDir(pluginDir, ARCH))).toBe(false);
  });

  it("re-hashes a cached archive instead of downloading, and rebuilds the runtime tree", async () => {
    const { file, sha256 } = tarball();
    const pluginDir = tmp();
    const downloads = tmp();
    const m = manifestWith(sha256);
    let fetched = 0;
    const fetch = async () => { fetched++; return fs.readFileSync(file); };
    await stageBinaries(m, pluginDir, ARCH, downloads, fetch);
    // Something modified the staged copy. The next stage must replace it from the verified archive.
    fs.writeFileSync(path.join(binDir(pluginDir, ARCH), "tool"), "#!/bin/sh\necho tampered\n");
    await stageBinaries(m, pluginDir, ARCH, downloads, fetch);
    expect(fetched).toBe(1);
    expect(execFileSync(path.join(binDir(pluginDir, ARCH), "tool"), ["x"], { encoding: "utf8" })).toBe("ARGV=x\n");
  });
});

describe("runPostinstall", () => {
  it("runs the hook with the staged bin first on PATH, and returns what it printed", async () => {
    const { file, sha256 } = tarball();
    const pluginDir = tmp();
    fs.writeFileSync(path.join(pluginDir, "check.sh"), '#!/bin/sh\ntool probe\n', { mode: 0o755 });
    const m = manifestWith(sha256, { hooks: { postinstall: "check.sh" } });
    await stageBinaries(m, pluginDir, ARCH, tmp(), async () => fs.readFileSync(file));
    expect(runPostinstall(m, pluginDir, ARCH)).toBe("ARGV=probe");
  });

  it("is null when the manifest declares no hook", () => {
    expect(runPostinstall(manifestWith("0".repeat(64)), tmp(), ARCH)).toBeNull();
  });
});

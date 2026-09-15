import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseManifest, PluginError } from "../src/plugins/manifest.js";
import { binDir, runPostinstall, stageBinaries, type Arch } from "../src/plugins/stage.js";
import { MINIMAL, tarball } from "./pluginFixtures.js";

const ARCH = process.arch as Arch;
const cleanups: (() => void)[] = [];
afterEach(() => { for (const c of cleanups.splice(0)) c(); });
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "latch-stage-"));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

function manifestWith(sha256: string, extra: Record<string, unknown> = {}) {
  return parseManifest(JSON.stringify({
    ...MINIMAL,
    exec: { cwd: "plugin", argv: ["tool", "--fixed"] },
    runtime: { binaries: [{
      name: "tool",
      url: { arm64: "https://example.invalid/tool", x64: "https://example.invalid/tool" },
      sha256: { arm64: sha256, x64: sha256 },
    }], sources: [] },
    ...extra,
  }));
}

describe("stageBinaries", () => {
  it("verifies the archive, extracts it, and puts the executable in runtime/<arch>/bin", async () => {
    const { file, sha256 } = tarball(tmp);
    const pluginDir = tmp();
    let fetched = 0;
    await stageBinaries(manifestWith(sha256), pluginDir, ARCH, tmp(), async () => { fetched++; return fs.readFileSync(file); });
    const staged = path.join(binDir(pluginDir, ARCH), "tool");
    expect(fetched).toBe(1);
    expect(execFileSync(staged, ["a"], { encoding: "utf8" })).toBe("ARGV=a\n");
  });

  it("refuses an archive whose bytes do not match the pin, staging nothing", async () => {
    const { file } = tarball(tmp);
    const pluginDir = tmp();
    const wrong = "0".repeat(64);
    await expect(
      stageBinaries(manifestWith(wrong), pluginDir, ARCH, tmp(), async () => fs.readFileSync(file)),
    ).rejects.toThrow(PluginError);
    expect(fs.existsSync(binDir(pluginDir, ARCH))).toBe(false);
  });

  it("re-hashes a cached archive instead of downloading, and rebuilds the runtime tree", async () => {
    const { file, sha256 } = tarball(tmp);
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

  it("stages two binaries whose executables share a basename without one overwriting the other", async () => {
    const a = tarball(tmp);
    const b = tarball(tmp);
    const pluginDir = tmp();
    const bin = (name: string, sha: string) => ({
      name, executable: "tool",
      url: { arm64: `https://example.invalid/${name}`, x64: `https://example.invalid/${name}` },
      sha256: { arm64: sha, x64: sha },
    });
    const manifest = parseManifest(JSON.stringify({
      ...MINIMAL,
      exec: { cwd: "plugin", argv: ["tool-a", "--fixed"] },
      runtime: { binaries: [bin("tool-a", a.sha256), bin("tool-b", b.sha256)], sources: [] },
    }));
    await stageBinaries(manifest, pluginDir, ARCH, tmp(), async (url) =>
      fs.readFileSync(url.endsWith("tool-a") ? a.file : b.file),
    );
    expect(fs.readdirSync(binDir(pluginDir, ARCH)).sort()).toEqual(["tool-a", "tool-b"]);
  });

  it("leaves no runtime tree when a later binary in the manifest fails to stage", async () => {
    const { file, sha256 } = tarball(tmp);
    const pluginDir = tmp();
    const manifest = parseManifest(JSON.stringify({
      ...MINIMAL,
      exec: { cwd: "plugin", argv: ["tool", "--fixed"] },
      runtime: {
        binaries: [
          { name: "tool", url: { arm64: "https://example.invalid/tool", x64: "https://example.invalid/tool" }, sha256: { arm64: sha256, x64: sha256 } },
          { name: "broken", url: { arm64: "https://example.invalid/broken", x64: "https://example.invalid/broken" }, sha256: { arm64: "1".repeat(64), x64: "1".repeat(64) } },
        ],
        sources: [],
      },
    }));
    await expect(
      stageBinaries(manifest, pluginDir, ARCH, tmp(), async (url) => {
        if (url.endsWith("broken")) throw new Error("network down");
        return fs.readFileSync(file);
      }),
    ).rejects.toThrow("network down");
    expect(fs.existsSync(binDir(pluginDir, ARCH))).toBe(false);
  });
});

describe("runPostinstall", () => {
  it("runs the hook with the staged bin first on PATH, and returns what it printed", async () => {
    const { file, sha256 } = tarball(tmp);
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

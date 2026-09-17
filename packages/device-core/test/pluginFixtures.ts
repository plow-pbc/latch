import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** A suite's throwaway dirs: `tmp()` makes one, `cleanup()` (from `afterEach`) removes them all. */
export function tempDirs(prefix: string): { tmp: () => string; cleanup: () => void } {
  const made: string[] = [];
  const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); made.push(d); return d; };
  const cleanup = () => { for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true }); };
  return { tmp, cleanup };
}

export const MINIMAL = {
  name: "fix", version: "1", command: "fix",
  runtime: { binaries: [] },
  exec: { argv: ["/bin/sh", "cli.sh"] },
  env: { FIX_HOME: { fixed: "${plugin_home}" } },
  argv: { read: [["query"]], write: [["put"]] },
  skill: "skill.md",
};

/**
 * A gzipped tarball holding an executable `tool` that prints its argv, plus
 * DECOY — a second member no manifest names, so every stage test exercises
 * the narrowing that keeps an archive's other contents out of the runtime
 * tree. `tmp` is the caller's own throwaway-dir helper, so cleanup stays
 * with it.
 */
export const DECOY = "decoy";

export function tarball(tmp: () => string): { file: string; sha256: string } {
  const src = tmp();
  fs.writeFileSync(path.join(src, "tool"), '#!/bin/sh\necho "ARGV=$*"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(src, DECOY), "not ours\n");
  const file = path.join(tmp(), "tool.tgz");
  execFileSync("tar", ["czf", file, "-C", src, "tool", DECOY]);
  return { file, sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex") };
}

/**
 * A plugin directory on disk: its manifest, plus `script` staged as each of
 * its declared binaries. A plugin declaring none (MINIMAL) gets no bin/ at
 * all — per registry.ts, presence for those comes from the manifest alone.
 */
export function fakePlugin(root: string, manifest: Record<string, unknown>, script: string): string {
  const name = manifest.name as string;
  const binaries = (manifest.runtime as { binaries?: { name: string }[] } | undefined)?.binaries ?? [];
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "latch-plugin.json"), JSON.stringify(manifest));
  if (binaries.length > 0) {
    const bin = path.join(dir, "runtime", process.arch, "bin");
    fs.mkdirSync(bin, { recursive: true });
    for (const b of binaries) fs.writeFileSync(path.join(bin, b.name), script, { mode: 0o755 });
  }
  return dir;
}

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const MINIMAL = {
  name: "fix", version: "1", command: "fix",
  runtime: { binaries: [], sources: [] },
  exec: { cwd: "plugin", argv: ["/bin/sh", "cli.sh"] },
  env: { FIX_HOME: { fixed: "${plugin_home}" } },
  argv: { read: [["query"]], write: [["put"]] },
  skill: "skill.md",
};

/**
 * A gzipped tarball holding one executable `tool` that prints its argv.
 * `tmp` is the caller's own throwaway-dir helper, so cleanup stays with it.
 */
export function tarball(tmp: () => string): { file: string; sha256: string } {
  const src = tmp();
  fs.writeFileSync(path.join(src, "tool"), '#!/bin/sh\necho "ARGV=$*"\n', { mode: 0o755 });
  const file = path.join(tmp(), "tool.tgz");
  execFileSync("tar", ["czf", file, "-C", src, "tool"]);
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

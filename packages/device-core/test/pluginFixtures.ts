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

/** A staged plugin on disk: manifest plus one shell script as exec.argv[0]. */
export function fakePlugin(root: string, manifest: Record<string, unknown>, script: string): string {
  const name = manifest.name as string;
  const argv0 = (manifest.exec as { argv: string[] }).argv[0];
  const dir = path.join(root, name);
  const bin = path.join(dir, "runtime", process.arch, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(dir, "latch-plugin.json"), JSON.stringify(manifest));
  // argv0 may itself contain a slash (an absolute system binary like /bin/sh
  // for a fixture that doesn't stage one): the executable lands wherever
  // loadPlugins' own path.join(bin, argv0) will look, however deep that is.
  const exe = path.join(bin, argv0);
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(exe, script, { mode: 0o755 });
  return dir;
}

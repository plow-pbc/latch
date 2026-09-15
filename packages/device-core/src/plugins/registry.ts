/**
 * Which plugins this Mac has, staged and ready to exec.
 *
 * One on-disk shape for every root: `<root>/<name>/latch-plugin.json`, and
 * `<root>/<name>/runtime/<arch>/bin/<binary name>` for each binary the
 * manifest declares — exactly what stageBinaries writes. A plugin is present
 * when its manifest parses AND every declared binary is staged there; a plugin
 * declaring none (its argv[0] falls through to PATH) is present on its
 * manifest alone. Staged-ness says nothing about exec.argv[0] — that's
 * resolved at exec time, not here: a plugin driven by a provider row
 * (plow-gog) has its argv[0] joined under `binDir` by the exec path, so that
 * one must be relative and name a staged binary.
 */
import fs from "node:fs";
import path from "node:path";
import { parseManifest, PluginError, type PluginManifest } from "./manifest.js";
import { binDir, type Arch } from "./stage.js";

export interface StagedPlugin {
  manifest: PluginManifest;
  binDir: string;
}

function executable(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function loadPlugins(roots: readonly string[]): StagedPlugin[] {
  const arch = process.arch as Arch;
  const out: StagedPlugin[] = [];
  // A name is claimed by the FIRST manifest that carries it, staged or not: an
  // incomplete plugin in a higher root must not let a lower root supply the
  // binary a provider row will hand a minted token to.
  const claimed = new Set<string>();
  for (const root of roots) {
    let names: string[];
    try {
      names = fs.readdirSync(root).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      if (claimed.has(name)) continue;
      const dir = path.join(root, name);
      const file = path.join(dir, "latch-plugin.json");
      if (!fs.existsSync(file)) continue;
      claimed.add(name);
      const manifest = parseManifest(fs.readFileSync(file, "utf8"));
      if (manifest.name !== name) throw new PluginError("plugin directory must be named after its manifest");
      const bin = binDir(dir, arch);
      if (!manifest.runtime.binaries.every((b) => executable(path.join(bin, b.name)))) continue;
      out.push({ manifest, binDir: bin });
    }
  }
  return out;
}

/**
 * `DOMO_PLUGINS` is the test/operator override, ahead of everything. It is
 * resolved because every root is carried through to a `binDir`, and a relative
 * one would make the child's PATH and the sandbox's reads depend on a cwd.
 */
export function pluginRoots(opts: { resourcesDir?: string; repoRoot?: string }): string[] {
  const roots: string[] = [];
  if (process.env.DOMO_PLUGINS) {
    // The operator NAMED this one, so a missing directory is a wrong path, not
    // an empty root: refuse it rather than quietly reading the next root.
    const named = path.resolve(process.env.DOMO_PLUGINS);
    if (!fs.statSync(named, { throwIfNoEntry: false })?.isDirectory()) {
      throw new PluginError("DOMO_PLUGINS must name an existing directory");
    }
    roots.push(named);
  }
  if (opts.resourcesDir) roots.push(path.join(opts.resourcesDir, "plugins"));
  if (opts.repoRoot) roots.push(path.join(opts.repoRoot, "vendor", "plugins"));
  return roots;
}

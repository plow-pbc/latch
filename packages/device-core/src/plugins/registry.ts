/**
 * Which plugins this Mac has, staged and ready to exec.
 *
 * One on-disk shape for every root: `<root>/<name>/latch-plugin.json` and
 * `<root>/<name>/runtime/<arch>/bin/<exec.argv[0]>`. A plugin is present only
 * when that executable is: a manifest with nothing staged is absent, so an
 * argv naming it falls to the provider gate (bare `gog`) or ordinary exec.
 */
import fs from "node:fs";
import path from "node:path";
import { parseManifest, PluginError, type PluginManifest } from "./manifest.js";
import { binDir, type Arch } from "./stage.js";

export interface StagedPlugin {
  manifest: PluginManifest;
  dir: string;
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
  for (const root of roots) {
    let names: string[];
    try {
      names = fs.readdirSync(root).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      if (out.some((p) => p.manifest.name === name)) continue;
      const dir = path.join(root, name);
      const file = path.join(dir, "latch-plugin.json");
      if (!fs.existsSync(file)) continue;
      const manifest = parseManifest(fs.readFileSync(file, "utf8"));
      if (manifest.name !== name) throw new PluginError("plugin directory must be named after its manifest");
      const bin = binDir(dir, arch);
      if (!executable(path.join(bin, manifest.exec.argv[0]))) continue;
      out.push({ manifest, dir, binDir: bin });
    }
  }
  return out;
}

/** `DOMO_PLUGINS` is the test/operator override, ahead of everything. */
export function pluginRoots(opts: { resourcesDir?: string; repoRoot?: string; home: string }): string[] {
  const roots: string[] = [];
  if (process.env.DOMO_PLUGINS) roots.push(process.env.DOMO_PLUGINS);
  if (opts.resourcesDir) roots.push(path.join(opts.resourcesDir, "plugins"));
  if (opts.repoRoot) roots.push(path.join(opts.repoRoot, "vendor", "plugins"));
  roots.push(path.join(opts.home, "plugins"));
  return roots;
}

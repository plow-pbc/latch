/**
 * Staging a plugin's runtime tree: pinned downloaded archives into
 * `runtime/<arch>/bin`, and git sources — cloned at a pinned commit, then
 * built by their own `install` argv — into `runtime/<arch>/<source name>`.
 *
 * ONE code path for a bundled plugin (`scripts/stage-plugins.mjs`, into
 * `vendor/plugins`) and an installed one (into `$DOMO_HOME/plugins`). A
 * binary's archive is kept under `downloads` and re-hashed on every run; the
 * runtime tree is rebuilt from it every time, so a modified staged binary
 * never survives a stage — the property the old per-binary digest pin
 * carried. A source is re-cloned fresh on every stage for the same reason.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PluginError, type PluginManifest } from "./manifest.js";

export type Arch = "arm64" | "x64";
export type FetchBytes = (url: string) => Promise<Buffer>;

export const fetchBytes: FetchBytes = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new PluginError(`download failed with status ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
};

/** The one directory a child's PATH and the sandbox's reads name. */
export const binDir = (pluginDir: string, arch: Arch): string => path.join(pluginDir, "runtime", arch, "bin");

const digest = (file: string): string => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

export async function stageBinaries(
  manifest: PluginManifest,
  pluginDir: string,
  arch: Arch,
  downloads: string,
  fetch: FetchBytes,
): Promise<void> {
  const runtime = path.join(pluginDir, "runtime", arch);
  fs.rmSync(runtime, { recursive: true, force: true });
  const bin = binDir(pluginDir, arch);
  fs.mkdirSync(bin, { recursive: true });
  // One try/catch for the whole loop: a fetch or tar failure partway through
  // must leave no runtime tree behind, same as a digest mismatch does — a
  // half-staged plugin would still pass loadPlugins' single-executable check.
  try {
    for (const b of manifest.runtime.binaries) {
      const want = b.sha256[arch];
      // Keyed on the pin itself: a bump changes the sha, so it can never hit a stale cache entry.
      const archive = path.join(downloads, `${manifest.name}-${b.name}-${arch}-${want}`);
      if (!fs.existsSync(archive) || digest(archive) !== want) {
        fs.mkdirSync(downloads, { recursive: true });
        fs.writeFileSync(archive, await fetch(b.url[arch]));
        if (digest(archive) !== want) {
          fs.rmSync(archive, { force: true });
          throw new PluginError(`binary ${b.name} does not match its sha256 for ${arch}`);
        }
      }
      const into = path.join(runtime, b.name);
      fs.mkdirSync(into, { recursive: true });
      // One named member, the way the retired fetch-vendored.mjs did it: an
      // archive carrying anything else never lands in the runtime tree.
      execFileSync("tar", ["xf", archive, "-C", into, "--", b.executable ?? b.name]);
      const executable = path.join(into, b.executable ?? b.name);
      // Keyed on the binary's own (already unique) name, not the archive's
      // internal executable basename, so two binaries whose executables
      // happen to share a basename never overwrite each other in bin/.
      const staged = path.join(bin, b.name);
      fs.copyFileSync(executable, staged);
      fs.chmodSync(staged, 0o755);
    }
    for (const s of manifest.runtime.sources) stageSource(s, runtime);
  } catch (err) {
    fs.rmSync(runtime, { recursive: true, force: true });
    throw err;
  }
}

/**
 * A source: cloned at its pinned commit into `runtime/<arch>/<source name>`
 * — the same "named entry under the arch's runtime dir" convention a
 * binary's extracted archive uses — then built in place by its own
 * `install` argv, if it declares one. The commit hash is the integrity pin;
 * there is no separate digest, same as a binary's tar member has none once
 * its sha256 has matched. Every refusal names the source's declared `name`
 * only — never the git url, the commit, or a command's output, all of which
 * are third-party text.
 */
function stageSource(source: { name: string; git: string; commit: string; install?: string[] }, runtime: string): void {
  const into = path.join(runtime, source.name);
  try {
    execFileSync("git", ["clone", "--quiet", "--", source.git, into], { stdio: "pipe" });
    execFileSync("git", ["-C", into, "checkout", "--quiet", source.commit], { stdio: "pipe" });
  } catch {
    throw new PluginError(`source ${source.name} failed to clone at its pinned commit`);
  }
  if (source.install !== undefined) {
    try {
      execFileSync(source.install[0]!, source.install.slice(1), { cwd: into, stdio: "pipe" });
    } catch {
      throw new PluginError(`source ${source.name} failed to install`);
    }
  }
}

export function runPostinstall(manifest: PluginManifest, pluginDir: string, arch: Arch): string | null {
  if (manifest.hooks.postinstall === undefined) return null;
  return execFileSync(path.join(pluginDir, manifest.hooks.postinstall), [], {
    cwd: pluginDir,
    encoding: "utf8",
    env: { ...process.env, PATH: `${binDir(pluginDir, arch)}:${process.env.PATH ?? ""}` },
  }).trim();
}

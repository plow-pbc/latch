/**
 * Materializes a plugin from a git url into `$DOMO_HOME/plugins/<name>/`:
 * clone-and-register only. Everything else a manifest can declare — staged
 * binaries, cloned sources, a postinstall hook, a daemon — is refused at
 * install time rather than silently installing something narrower than the
 * owner asked for; see `refuseUnsupported`. A first install that fails
 * leaves nothing behind; a failed reinstall keeps `home/` and `secrets/`.
 */
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { parseManifest, PluginError, SLUG, type PluginManifest } from "./manifest.js";
import { vendoredProvider } from "../providers/registry.js";

const run = promisify(execFile);

export interface Installed {
  name: string;
  version: string;
  command: string;
  commit: string;
  installedAt: string;
  /** Normalized `gitUrl`. Absent on a plugin installed before this field
   * existed — treated as unknown, never as a match (see `installPlugin`). */
  origin?: string;
}

export function pluginDirs(pluginsRoot: string, name: string) {
  if (!SLUG.test(name)) throw new PluginError("plugin name must be lowercase letters, digits and dashes");
  const root = path.join(pluginsRoot, name);
  return {
    root,
    repo: path.join(root, "repo"),
    secrets: path.join(root, "secrets"),
    home: path.join(root, "home"),
    installedFile: path.join(root, "installed.json"),
  };
}

/**
 * `https://` for a real remote, or a bare absolute filesystem path (what the
 * test fixtures and a local install both pass) for a local clone. Anything
 * else — `ssh://`, `file://`, and every git transport helper (`ext::`,
 * `fd::`, ...) — is refused before git ever sees it: a transport helper runs
 * an arbitrary shell command on clone. A colon anywhere in what would
 * otherwise read as a local path is refused too, since that is exactly how a
 * transport helper is spelled.
 */
function validateGitUrl(gitUrl: string): void {
  if (gitUrl.startsWith("https://")) return;
  if (gitUrl.startsWith("/") && !gitUrl.includes(":")) return;
  throw new PluginError("plugin git url must be https or a local path"); // never quote the url
}

function normalizeOrigin(gitUrl: string): string {
  return gitUrl.trim().replace(/\/+$/, "");
}

function readOrigin(installedFile: string): string | undefined {
  try {
    return (JSON.parse(fs.readFileSync(installedFile, "utf8")) as Installed).origin;
  } catch {
    return undefined;
  }
}

/** `op` both names the error and becomes the subcommand, so the two can't drift apart. */
async function git(op: string, rest: string[], cwd?: string): Promise<void> {
  try {
    await run("/usr/bin/git", [op, ...rest], {
      cwd,
      // Backstop for `validateGitUrl`: even if that check were ever
      // bypassed, git itself refuses every transport but the two we allow.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "https:file" },
    });
  } catch {
    throw new PluginError(`git ${op} failed`); // the url/ref is the caller's; never quote it
  }
}

/**
 * A binary, a source, a postinstall hook, or a daemon is a real declaration
 * in the manifest — refusing the install is the honest answer, not quietly
 * installing a plugin that lacks what it declared it needs.
 */
function refuseUnsupported(manifest: PluginManifest): void {
  if (manifest.runtime.binaries.length > 0 || manifest.runtime.sources.length > 0) {
    throw new PluginError("this build cannot install a plugin that declares runtime.binaries or runtime.sources yet");
  }
  if (manifest.hooks.postinstall) {
    throw new PluginError("this build cannot install a plugin that declares hooks.postinstall yet");
  }
  if (manifest.daemon !== null) {
    throw new PluginError("this build cannot install a plugin that declares a daemon yet");
  }
}

export async function installPlugin(pluginsRoot: string, gitUrl: string): Promise<Installed> {
  // Clone into a staging dir first: the NAME comes from the manifest, and the
  // manifest comes from the clone.
  fs.mkdirSync(pluginsRoot, { recursive: true });
  const staging = fs.mkdtempSync(path.join(pluginsRoot, ".install-"));
  let dirs: ReturnType<typeof pluginDirs> | null = null;
  let fresh = true;
  validateGitUrl(gitUrl);
  const origin = normalizeOrigin(gitUrl);
  try {
    await git("clone", ["-q", "--depth", "1", "--", gitUrl, path.join(staging, "repo")]);
    const manifest = parseManifest(fs.readFileSync(path.join(staging, "repo", "latch-plugin.json"), "utf8"));
    refuseUnsupported(manifest);
    // A plugin may not take a name a vendored provider (registry.ts) already
    // answers to — `DeviceAgent.executeCommand` checks plugins first, so a
    // colliding command would silently shadow the provider's own binary on
    // an argv the owner reads as the provider's. Refused once, at install,
    // rather than silently at every later invocation.
    if (vendoredProvider([manifest.command]) !== null) {
      throw new PluginError(`command ${manifest.command} is already provided by Latch`);
    }
    if (!fs.existsSync(path.join(staging, "repo", manifest.skill))) throw new PluginError("manifest skill file is missing");
    const { stdout: commit } = await run("/usr/bin/git", ["-C", path.join(staging, "repo"), "rev-parse", "HEAD"]);
    const candidate = pluginDirs(pluginsRoot, manifest.name);
    fresh = !fs.existsSync(candidate.root);
    if (!fresh && readOrigin(candidate.installedFile) !== origin) {
      // A same-named install from elsewhere: refuse rather than reuse its
      // secrets/ and home/ for a repo we have no reason to trust is the same
      // plugin. An unrecorded origin (a plugin installed before this field
      // existed) counts as unknown, never as a match — fail closed.
      throw new PluginError(`a plugin named ${manifest.name} is already installed from a different origin; remove it first`);
    }
    dirs = candidate; // only start touching disk once the origin check has passed
    // A reinstall replaces repo/ and keeps home/ + secrets/.
    fs.rmSync(dirs.repo, { recursive: true, force: true });
    for (const d of [dirs.root, dirs.secrets, dirs.home]) fs.mkdirSync(d, { recursive: true });
    fs.chmodSync(dirs.secrets, 0o700);
    fs.renameSync(path.join(staging, "repo"), dirs.repo);
    for (const source of Object.values(manifest.env)) {
      if ("secret" in source) {
        const file = path.join(dirs.secrets, source.secret);
        if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
      }
    }
    const installed: Installed = {
      name: manifest.name,
      version: manifest.version,
      command: manifest.command,
      commit: commit.trim(),
      installedAt: new Date().toISOString(),
      origin,
    };
    fs.writeFileSync(dirs.installedFile, JSON.stringify(installed, null, 2) + "\n");
    return installed;
  } catch (e) {
    if (dirs) {
      fs.rmSync(dirs.repo, { recursive: true, force: true });
      fs.rmSync(dirs.installedFile, { force: true });
      // A FIRST install that failed leaves nothing; a failed reinstall keeps home/ and secrets/.
      if (fresh) fs.rmSync(dirs.root, { recursive: true, force: true });
    }
    throw e;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

export function removePlugin(pluginsRoot: string, name: string, opts: { purge: boolean }): void {
  const dirs = pluginDirs(pluginsRoot, name);
  fs.rmSync(dirs.repo, { recursive: true, force: true });
  fs.rmSync(dirs.installedFile, { force: true });
  if (opts.purge) fs.rmSync(dirs.root, { recursive: true, force: true });
}

export function readInstalled(pluginsRoot: string, name: string): { installed: Installed; manifest: PluginManifest } | null {
  const dirs = pluginDirs(pluginsRoot, name);
  if (!fs.existsSync(dirs.installedFile) || !fs.existsSync(path.join(dirs.repo, "latch-plugin.json"))) return null;
  const installed = JSON.parse(fs.readFileSync(dirs.installedFile, "utf8")) as Installed;
  const manifest = parseManifest(fs.readFileSync(path.join(dirs.repo, "latch-plugin.json"), "utf8"));
  return { installed, manifest };
}

/** Every directory under `pluginsRoot` that looks like an install, by name — before either JSON file is parsed. */
export function listInstalledNames(pluginsRoot: string): string[] {
  if (!fs.existsSync(pluginsRoot)) return [];
  return fs
    .readdirSync(pluginsRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
}

export function listInstalled(pluginsRoot: string): { installed: Installed; manifest: PluginManifest }[] {
  return listInstalledNames(pluginsRoot)
    .map((name) => readInstalled(pluginsRoot, name))
    .filter((x): x is { installed: Installed; manifest: PluginManifest } => x !== null);
}

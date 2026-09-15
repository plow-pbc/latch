/**
 * Materializes a plugin from a git url into `$DOMO_HOME/plugins/<name>/`:
 * repo clone, runtime (binaries + sources), secrets, a command wrapper in
 * bin/, and installed.json. A first install that fails leaves nothing behind
 * (the supply-chain posture of `scripts/vendored-providers.mjs`); a failed
 * reinstall keeps `home/` and `secrets/`.
 */
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { resolveEnv } from "./env.js";
import { parseManifest, PluginError, type PluginManifest } from "./manifest.js";
import { vendoredProvider } from "../providers/registry.js";
const run = promisify(execFile);

export interface InstallDeps {
  fetch: typeof globalThis.fetch; // injected: tests never touch the network
  arch: "arm64" | "x64"; // process.arch mapped; tests pin one
  plowApiBase: string; // for ${plow_api_base} in postinstall env
  log: (line: string) => void; // progress lines for the caller (never a secret)
}
export interface Installed {
  name: string;
  version: string;
  command: string;
  commit: string;
  port: number | null;
  installedAt: string;
}

export function pluginDirs(pluginsRoot: string, name: string) {
  const root = path.join(pluginsRoot, name);
  return {
    root,
    repo: path.join(root, "repo"),
    runtime: path.join(root, "runtime"),
    runtimeBin: path.join(root, "runtime", "bin"),
    secrets: path.join(root, "secrets"),
    bin: path.join(root, "bin"),
    home: path.join(root, "home"),
    installedFile: path.join(root, "installed.json"),
  };
}

/** `op` both names the error and becomes the subcommand, so the two can't drift apart. */
async function git(op: string, rest: string[], cwd?: string): Promise<void> {
  const args = [...(cwd ? ["-C", cwd] : []), op, ...rest];
  try {
    await run("/usr/bin/git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  } catch {
    throw new PluginError(`git ${op} failed`); // the URL/ref is the caller's; never quote it
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

async function stageBinary(b: PluginManifest["runtime"]["binaries"][number], dirs: ReturnType<typeof pluginDirs>, deps: InstallDeps): Promise<void> {
  // try/catch, not `.catch()`: a malformed-but-https-prefixed manifest url
  // makes both `fetch` and `new URL` throw SYNCHRONOUSLY, before a `.catch`
  // on the call expression's result would ever attach — and that raw error
  // carries the url. Neither bytes nor a parsed URL exist until this returns.
  let res: Response;
  let url: string;
  try {
    url = b.url[deps.arch];
    res = await deps.fetch(url);
  } catch {
    throw new PluginError(`binary ${b.name} could not be downloaded`); // the url is the caller's; never quote it
  }
  if (!res.ok) throw new PluginError(`binary ${b.name} could not be downloaded`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (crypto.createHash("sha256").update(bytes).digest("hex") !== b.sha256[deps.arch]) throw new PluginError(`binary ${b.name} did not match its sha256`);
  // Test the path, not the raw URL: a presigned download (S3, a GitHub
  // release asset) carries a query string after the extension.
  const archive = /\.(zip|tar\.gz|tgz)$/.test(url.split(/[?#]/)[0]!);
  if (!archive) {
    fs.writeFileSync(path.join(dirs.runtimeBin, b.name), bytes, { mode: 0o755 });
    return;
  }
  // bsdtar reads zip and tar.gz alike. Extract beside bin/, then link the executable in.
  const extracted = path.join(dirs.runtime, `${b.name}-${b.version}`);
  fs.mkdirSync(extracted, { recursive: true });
  const tmp = path.join(dirs.runtime, `${b.name}.download`);
  fs.writeFileSync(tmp, bytes);
  try {
    // List before extracting: an absolute entry, or one a `..` climbs out
    // with, is a write outside the plugin's own tree — a new capability a
    // binaries-only plugin (no postinstall, no source install) never opted
    // into. Never quote the entry; it's third-party archive text.
    const { stdout } = await run("/usr/bin/tar", ["-tf", tmp]);
    for (const entry of stdout.split("\n").map((line) => line.trim()).filter(Boolean)) {
      const resolved = path.resolve(extracted, entry);
      if (resolved !== extracted && !resolved.startsWith(extracted + path.sep)) {
        throw new PluginError(`binary ${b.name} archive has an entry outside its extraction directory`);
      }
    }
    await run("/usr/bin/tar", ["-xf", tmp, "-C", extracted]);
  } catch (e) {
    throw e instanceof PluginError ? e : new PluginError(`binary ${b.name} could not be extracted`);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  const executable = path.join(extracted, b.executable ?? b.name);
  if (!fs.existsSync(executable)) throw new PluginError(`binary ${b.name} archive has no ${b.executable ?? b.name}`);
  fs.chmodSync(executable, 0o755);
  fs.symlinkSync(executable, path.join(dirs.runtimeBin, b.name));
}

export async function installPlugin(pluginsRoot: string, gitUrl: string, deps: InstallDeps): Promise<Installed> {
  // Clone into a staging dir first: the NAME comes from the manifest, and the
  // manifest comes from the clone.
  fs.mkdirSync(pluginsRoot, { recursive: true });
  const staging = fs.mkdtempSync(path.join(pluginsRoot, ".install-"));
  let dirs: ReturnType<typeof pluginDirs> | null = null;
  let fresh = true;
  try {
    await git("clone", ["-q", "--depth", "1", "--", gitUrl, path.join(staging, "repo")]);
    const manifest = parseManifest(fs.readFileSync(path.join(staging, "repo", "latch-plugin.json"), "utf8"));
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
    dirs = pluginDirs(pluginsRoot, manifest.name);
    fresh = !fs.existsSync(dirs.root);
    // A reinstall replaces repo/, runtime/ and bin/ and keeps home/ + secrets/.
    for (const d of [dirs.repo, dirs.runtime, dirs.bin]) fs.rmSync(d, { recursive: true, force: true });
    for (const d of [dirs.root, dirs.runtimeBin, dirs.secrets, dirs.bin, dirs.home]) fs.mkdirSync(d, { recursive: true });
    fs.chmodSync(dirs.secrets, 0o700);
    fs.renameSync(path.join(staging, "repo"), dirs.repo);
    fs.symlinkSync(dirs.repo, path.join(dirs.runtime, "plugin"));
    for (const b of manifest.runtime.binaries) {
      deps.log(`staging ${b.name} ${b.version}`);
      await stageBinary(b, dirs, deps);
    }
    for (const s of manifest.runtime.sources) {
      deps.log(`cloning ${s.name}`);
      const dest = path.join(dirs.runtime, s.name);
      await git("clone", ["-q", "--", s.git, dest]);
      await git("checkout", ["-q", s.commit], dest);
      if (s.install) {
        try {
          await run(s.install[0], s.install.slice(1), { cwd: dest, env: { ...process.env, PATH: `${dirs.runtimeBin}:${process.env.PATH ?? ""}` } });
        } catch {
          throw new PluginError(`source ${s.name} install failed`);
        }
      }
    }
    for (const source of Object.values(manifest.env)) {
      if ("secret" in source) {
        const file = path.join(dirs.secrets, source.secret);
        if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
      }
    }
    const existing = readInstalled(pluginsRoot, manifest.name);
    const port = manifest.daemon ? (existing?.installed.port ?? (await freePort())) : null;
    const execCwd = path.join(dirs.runtime, manifest.exec.cwd);
    const argv0 = manifest.exec.argv[0].includes("/") ? manifest.exec.argv[0] : path.join(dirs.runtimeBin, manifest.exec.argv[0]);
    const exec0 = fs.existsSync(argv0) ? argv0 : manifest.exec.argv[0]; // fall back to PATH lookup for /bin/sh-style argv
    const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    fs.writeFileSync(path.join(dirs.bin, manifest.command), `#!/bin/sh\ncd ${q(execCwd)} && exec ${[exec0, ...manifest.exec.argv.slice(1)].map(q).join(" ")} "$@"\n`, { mode: 0o755 });
    if (manifest.hooks.postinstall) {
      // Fixed and secret values only: a mint is per invocation and needs Plow; a hook that needs one belongs in the daemon.
      const env = await resolveEnv(
        { ...manifest, env: Object.fromEntries(Object.entries(manifest.env).filter(([, s]) => !("mint" in s))) },
        { pluginHome: dirs.home, port, plowApiBase: deps.plowApiBase, secret: (n) => fs.readFileSync(path.join(dirs!.secrets, n), "utf8"), mint: null },
      );
      try {
        await run("/bin/sh", [path.join(dirs.repo, manifest.hooks.postinstall)], { cwd: dirs.repo, env: { ...env, PATH: `${dirs.runtimeBin}:/usr/bin:/bin`, HOME: dirs.home } });
      } catch {
        throw new PluginError("postinstall hook failed");
      }
    }
    const installed: Installed = { name: manifest.name, version: manifest.version, command: manifest.command, commit: commit.trim(), port, installedAt: new Date().toISOString() };
    fs.writeFileSync(dirs.installedFile, JSON.stringify(installed, null, 2) + "\n");
    return installed;
  } catch (e) {
    if (dirs) {
      for (const d of [dirs.repo, dirs.runtime, dirs.bin, dirs.installedFile]) fs.rmSync(d, { recursive: true, force: true });
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
  for (const d of [dirs.repo, dirs.runtime, dirs.bin, dirs.installedFile]) fs.rmSync(d, { recursive: true, force: true });
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

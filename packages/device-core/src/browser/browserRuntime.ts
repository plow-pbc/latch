/**
 * Locates the browser runtime for whichever process is hosting device-core —
 * the packaged Electron app, the headless apps/device runner, or a test.
 *
 * The runtime is now pure TypeScript (@domo/browser-server) driven by
 * playwright-core; there is no bundled Python. The server and the cookie merger
 * are Node scripts run on the host process's OWN runtime — the app binary under
 * ELECTRON_RUN_AS_NODE, or the plain node hosting a test/headless run — and the
 * browser is a Camoufox binary we point playwright at directly. The fingerprint
 * config comes from a build-time pool that ships beside the server
 * (fingerprints.json), so no fingerprint generator ships either.
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface ResolvedBrowserRuntime {
  /** Argv that starts the browser server (before server-specific flags). */
  serverCommand: string[];
  /** Argv for a SUBPROCESS credential broker — only ever a test fake now
   * (DOMO_VAULT_BROKER_CMD). Null means the real thing: the in-process
   * BrokerCore over the local vault store. */
  credentialBrokerCommand: string[] | null;
  /** Argv that reconciles a session's cookies into the user's. */
  mergeCookiesCommand: string[];
  /** Extra environment for the spawned server/merger — ELECTRON_RUN_AS_NODE so
   * the app binary runs our script as node, nothing else. */
  env: Record<string, string>;
  /** The Camoufox executable playwright launches; null when nothing is
   * installed (browser tools then report "not available"). */
  executablePath: string | null;
}

interface Layout {
  /** The @domo/browser-server package root (dist/server.js, dist/mergeCookies.js,
   * fingerprints.json live under it). It ships in node_modules — packaged
   * (app.asar.unpacked) and dev alike — so it is resolved from device-core's own
   * dependency graph, NOT from the resources dir. */
  serverPkgDir: string;
  /** A complete camoufox install dir (config.json + browsers/). This one DOES
   * ship under the resources dir, so its location differs by layout. */
  camoufoxDir: string;
}

/** Packaged: camoufox under Contents/Resources/browser-runtime/camoufox; the
 * server package in the app's node_modules. */
function packagedLayout(dir: string): Layout {
  return {
    serverPkgDir: repoServerPkgDir() ?? "",
    camoufoxDir: path.join(dir, "camoufox"),
  };
}

/** Dev: repo vendor/camoufox-browser + the built @domo/browser-server package. */
function vendorLayout(dir: string): Layout {
  return {
    serverPkgDir: repoServerPkgDir() ?? "",
    camoufoxDir: path.join(dir, "camoufox-browser"),
  };
}

const hostArch = (): string => (process.arch === "arm64" ? "arm64" : "x86_64");

/** The Camoufox executable inside an install dir, or null. The `camoufox fetch`
 * layout keeps it at browsers/official/<version>/Camoufox.app/Contents/MacOS/. A
 * dev checkout has thin per-arch trees; a universal tree is the packaged shape,
 * where the install dir IS `dir` itself. */
function camoufoxBinaryIn(dir: string): string | null {
  const roots = [path.join(dir, hostArch()), path.join(dir, "universal"), dir];
  for (const root of roots) {
    const official = path.join(root, "browsers", "official");
    if (!fs.existsSync(official)) continue;
    for (const build of fs.readdirSync(official)) {
      const bin = path.join(official, build, "Camoufox.app", "Contents", "MacOS", "camoufox");
      if (fs.existsSync(bin)) return bin;
    }
  }
  return null;
}

/** The host node command: the app binary as node under Electron, else plain
 * node. Both run our server.js/mergeCookies.js scripts. */
function hostNode(): { argv: string[]; env: Record<string, string> } {
  if (process.versions.electron) {
    // The app binary launches the app unless told to be a node. Requires the
    // RunAsNode fuse to stay enabled (DESIGN.md §11a).
    return { argv: [process.execPath], env: { ELECTRON_RUN_AS_NODE: "1" } };
  }
  return { argv: [process.execPath], env: {} };
}

function fromLayout(layout: Layout): ResolvedBrowserRuntime | null {
  const server = path.join(layout.serverPkgDir, "dist", "server.js");
  const merger = path.join(layout.serverPkgDir, "dist", "mergeCookies.js");
  const pool = path.join(layout.serverPkgDir, "fingerprints.json");
  const executablePath = process.env.DOMO_CAMOUFOX
    ? camoufoxBinaryIn(process.env.DOMO_CAMOUFOX) ?? process.env.DOMO_CAMOUFOX
    : camoufoxBinaryIn(layout.camoufoxDir);
  // A materialized browser runtime needs ALL THREE: the built server, a Camoufox
  // to drive, and the frozen fingerprint pool. Missing any — a checkout that
  // never ran `just fetch-browser`, a worktree cloned without the pool — means
  // browsing is not offered: return null so DeviceAgent registers no browsing
  // skill and no sessions, rather than a runtime that only fails at first launch.
  // (The DOMO_BROWSER_CMD test seam is handled in resolveBrowserRuntime, before
  // this, and never reaches here.)
  if (!layout.serverPkgDir || !fs.existsSync(server) || !executablePath || !fs.existsSync(pool)) {
    return null;
  }
  const host = hostNode();
  return {
    serverCommand: [...host.argv, server],
    credentialBrokerCommand: null,
    mergeCookiesCommand: [...host.argv, merger],
    env: host.env,
    executablePath,
  };
}

/** The built @domo/browser-server package dir, resolved from device-core's own
 * dependency graph (works in node_modules and in the dev workspace). */
function repoServerPkgDir(): string | null {
  try {
    const require = createRequire(import.meta.url);
    return path.dirname(require.resolve("@domo/browser-server/package.json"));
  } catch {
    // Dev fallback: walk up to the repo and point at the sibling package.
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6; i++) {
      const pkg = path.join(dir, "packages", "browser-server");
      if (fs.existsSync(path.join(pkg, "package.json"))) return pkg;
      dir = path.dirname(dir);
    }
    return null;
  }
}

/** Walk up from this module looking for the repo's vendor/ dir (dev mode). */
function repoVendorDir(): string | null {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const vendor = path.join(dir, "vendor");
    if (fs.existsSync(path.join(vendor, "camoufox-browser"))) return vendor;
    dir = path.dirname(dir);
  }
  return null;
}

/**
 * The merger that goes with a hand-written DOMO_BROWSER_CMD. Required, not
 * optional: a runtime with no merger cannot write what a session signed into
 * back to the user's profile, and the quiet version of that is a lost login.
 */
function mergerFromEnv(): string[] {
  const cmd = process.env.DOMO_MERGE_COOKIES_CMD;
  const argv = cmd ? (JSON.parse(cmd) as string[]) : [];
  if (!argv.length) {
    throw new Error("DOMO_BROWSER_CMD needs DOMO_MERGE_COOKIES_CMD (JSON argv) beside it");
  }
  return argv;
}

/**
 * Resolution order: DOMO_BROWSER_CMD (JSON argv — the test seam, paired with
 * DOMO_MERGE_COOKIES_CMD) → DOMO_BROWSER_RUNTIME dir (either layout) → the
 * packaged resources dir passed by the caller → the repo (dev). Null when
 * nothing is installed; browser tools then report "not available".
 */
export function resolveBrowserRuntime(resourcesDir?: string): ResolvedBrowserRuntime | null {
  const cmdEnv = process.env.DOMO_BROWSER_CMD;
  if (cmdEnv) {
    let argv: string[];
    try {
      argv = JSON.parse(cmdEnv) as string[];
    } catch {
      throw new Error(`DOMO_BROWSER_CMD is not a JSON argv array: ${cmdEnv}`);
    }
    const brokerCmd = process.env.DOMO_VAULT_BROKER_CMD;
    return {
      serverCommand: argv,
      credentialBrokerCommand: brokerCmd ? (JSON.parse(brokerCmd) as string[]) : null,
      mergeCookiesCommand: mergerFromEnv(),
      env: {},
      executablePath: process.env.DOMO_CAMOUFOX ?? null,
    };
  }

  const runtimeEnv = process.env.DOMO_BROWSER_RUNTIME;
  if (runtimeEnv) {
    return fromLayout(packagedLayout(runtimeEnv)) ?? fromLayout(vendorLayout(runtimeEnv));
  }

  if (resourcesDir) {
    const resolved = fromLayout(packagedLayout(path.join(resourcesDir, "browser-runtime")));
    if (resolved) return resolved;
  }

  const vendor = repoVendorDir();
  if (vendor) return fromLayout(vendorLayout(vendor));
  return null;
}

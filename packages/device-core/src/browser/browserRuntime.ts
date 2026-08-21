/**
 * Locates the browser runtime (bundled Python + vendored server + Camoufox)
 * for whichever process is hosting device-core — the packaged Electron app,
 * the headless apps/device runner, or a test.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface ResolvedBrowserRuntime {
  /** Argv that starts the browser server (before server-specific flags). */
  serverCommand: string[];
  /** Argv that runs the vault credential broker (before its subcommand). */
  credentialBrokerCommand: string[];
  /** Argv that reconciles a session's cookies into the user's (before its
   * three paths: profile, clone, and the baseline the clone started from). */
  mergeCookiesCommand: string[];
  /** Extra environment for both. */
  env: Record<string, string>;
  /** The vault this machine runs for itself, when one ships in this build. */
  vaultServer: { binary: string; webVaultDir: string } | null;
  /** A complete camoufox install dir (contains config.json + browsers/), the
   * layout `camoufox fetch` creates. BrowserHost exposes it to the server via
   * an app-scoped $HOME symlink. Null when the command embeds its own. */
  camoufoxInstallDir: string | null;
}

interface Layout {
  pythonRoot: string; // contains Python.framework and site-packages
  serverDir: string; // contains server.py and seed_vault_broker/
  camoufoxDir: string; // contains <arch>/ or universal/ install dirs (or one directly)
  vaultCliDir: string; // contains <arch>/bw (or bw directly)
  vaultServerDir: string; // contains <arch>/vaultwarden and web-vault/
}

/** Packaged: Contents/Resources/browser-runtime/{python,server,camoufox,vault-cli}. */
function packagedLayout(dir: string): Layout {
  return {
    pythonRoot: path.join(dir, "python"),
    serverDir: path.join(dir, "server"),
    camoufoxDir: path.join(dir, "camoufox"),
    vaultCliDir: path.join(dir, "vault-cli"),
    vaultServerDir: path.join(dir, "vault-server"),
  };
}

/** Dev: repo vendor/{python-runtime,browser-server,camoufox-browser,vault-cli}. */
function vendorLayout(dir: string): Layout {
  return {
    pythonRoot: path.join(dir, "python-runtime"),
    serverDir: path.join(dir, "browser-server"),
    camoufoxDir: path.join(dir, "camoufox-browser"),
    vaultCliDir: path.join(dir, "vault-cli"),
    vaultServerDir: path.join(dir, "vault-server"),
  };
}

const hostArch = (): string => (process.arch === "arm64" ? "arm64" : "x86_64");

function camoufoxIn(dir: string): string | null {
  // Dev checkouts have thin per-arch trees (`just fetch-browser`); a
  // `fetch-browser-both` also leaves the lipo-fused universal tree, which is
  // what the packaged app bundles — there the install dir IS `dir` itself.
  const candidates = [path.join(dir, hostArch()), path.join(dir, "universal"), dir];
  return candidates.find((c) => fs.existsSync(path.join(c, "config.json"))) ?? null;
}

/** The vault we ship: its binary for this arch plus the shared web interface.
 * Null when this build has no vault payload — the broker then talks to whatever
 * SEED_VAULT_URL points at, the way it did when we hosted it. */
function vaultServerIn(dir: string): { binary: string; webVaultDir: string } | null {
  const binary = path.join(dir, hostArch(), "vaultwarden");
  const webVaultDir = path.join(dir, "web-vault");
  if (!fs.existsSync(binary) || !fs.existsSync(webVaultDir)) return null;
  return { binary, webVaultDir };
}

/** The `bw` we ship, this machine's arch. Null falls back to one on PATH. */
function vaultCliIn(dir: string): string | null {
  const candidates = [path.join(dir, hostArch(), "bw"), path.join(dir, "bw")];
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

function fromLayout(layout: Layout): ResolvedBrowserRuntime | null {
  const py = path.join(
    layout.pythonRoot,
    "Python.framework",
    "Versions",
    "3.12",
    "bin",
    "python3.12",
  );
  const server = path.join(layout.serverDir, "server.py");
  if (!fs.existsSync(py) || !fs.existsSync(server)) return null;
  // The broker ships as a module next to server.py and runs on the same
  // bundled interpreter; the vault CLI it shells out to ships beside it. Both
  // env vars are overrides the broker already supports, so a machine with its
  // own install can still be pointed at that instead.
  const bw = process.env.SEED_VAULT_BW ?? vaultCliIn(layout.vaultCliDir);
  const sitePackages = path.join(layout.pythonRoot, "site-packages");
  // python.org's framework hunts for CA certs under its ORIGINAL install path
  // (/Library/Frameworks/...), which does not exist inside the app — every
  // https call out of the broker then dies with CERTIFICATE_VERIFY_FAILED.
  // Point it at the bundle certifi already ships.
  const caBundle = path.join(sitePackages, "certifi", "cacert.pem");
  return {
    serverCommand: [py, server],
    credentialBrokerCommand: [py, "-m", "seed_vault_broker"],
    mergeCookiesCommand: [py, path.join(layout.serverDir, "merge_cookies.py")],
    env: {
      PYTHONPATH: `${sitePackages}:${layout.serverDir}`,
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONNOUSERSITE: "1",
      ...(fs.existsSync(caBundle) ? { SSL_CERT_FILE: caBundle } : {}),
      ...(bw ? { SEED_VAULT_BW: bw } : {}),
    },
    vaultServer: vaultServerIn(layout.vaultServerDir),
    camoufoxInstallDir: process.env.DOMO_CAMOUFOX ?? camoufoxIn(layout.camoufoxDir),
  };
}

/** Walk up from this module looking for the repo's vendor/ dir (dev mode). */
function repoVendorDir(): string | null {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const vendor = path.join(dir, "vendor");
    if (fs.existsSync(path.join(vendor, "browser-server", "server.py"))) return vendor;
    dir = path.dirname(dir);
  }
  return null;
}

/**
 * Resolution order: DOMO_BROWSER_CMD (JSON argv — the test seam, paired with
 * DOMO_OP_BROKER_CMD) → DOMO_BROWSER_RUNTIME dir (either layout) → the
 * packaged resources dir passed by the caller → the repo's vendor/ tree (dev).
 * Null when nothing is installed; browser tools then report "not available"
 * rather than failing device startup.
 */
/**
 * The merger that goes with a hand-written DOMO_BROWSER_CMD.
 *
 * Required, not optional: a runtime with no merger cannot write what a session
 * signed into back to the user's profile, and the quiet version of that is a
 * lost login. Better to say so when the seam is set up than at the first close.
 */
function mergerFromEnv(): string[] {
  const cmd = process.env.DOMO_MERGE_COOKIES_CMD;
  const argv = cmd ? (JSON.parse(cmd) as string[]) : [];
  if (!argv.length) {
    throw new Error("DOMO_BROWSER_CMD needs DOMO_MERGE_COOKIES_CMD (JSON argv) beside it");
  }
  return argv;
}

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
      credentialBrokerCommand: brokerCmd ? (JSON.parse(brokerCmd) as string[]) : argv,
      mergeCookiesCommand: mergerFromEnv(),
      env: {},
      vaultServer: null,
      camoufoxInstallDir: process.env.DOMO_CAMOUFOX ?? null,
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

/**
 * Locates the msgvault CLI for whichever process hosts device-core. Only the
 * copy we ship (or the test seam) is ever used — a user's own install is
 * deliberately ignored, because its version is a moving target: a Homebrew
 * update could change flags or output framing under us, and the whole point
 * of pinning vendor/msgvault.lock.json is that the CLI surface we call is the
 * one we tested. The archive therefore always lives in a home we own.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface ResolvedMsgvaultRuntime {
  /** Argv prefix that runs the CLI (subcommand + flags are appended). */
  command: string[];
  source: "custom" | "bundled";
  /** Shown in the Capabilities tab; null for the custom test seam. */
  binaryPath: string | null;
}

const hostArch = (): string => (process.arch === "arm64" ? "arm64" : "x86_64");

function bundledIn(dir: string): string | null {
  const candidates = [path.join(dir, hostArch(), "msgvault"), path.join(dir, "msgvault")];
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

/** Walk up from this module looking for the repo's vendor/ dir (dev mode). */
function repoMsgvaultDir(): string | null {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const vendor = path.join(dir, "vendor", "msgvault");
    if (bundledIn(vendor)) return vendor;
    dir = path.dirname(dir);
  }
  return null;
}

/**
 * Resolution order: DOMO_MSGVAULT_CMD (JSON argv — the test seam) → the
 * packaged resources dir passed by the caller → the repo's vendor/ tree
 * (dev). Null when nothing is installed; msgvault tools then report "not
 * available" rather than failing device startup.
 */
export function resolveMsgvaultRuntime(resourcesDir?: string): ResolvedMsgvaultRuntime | null {
  const cmdEnv = process.env.DOMO_MSGVAULT_CMD;
  if (cmdEnv) {
    let argv: string[];
    try {
      argv = JSON.parse(cmdEnv) as string[];
    } catch {
      throw new Error(`DOMO_MSGVAULT_CMD is not a JSON argv array: ${cmdEnv}`);
    }
    return { command: argv, source: "custom", binaryPath: null };
  }

  if (resourcesDir) {
    const bundled = bundledIn(path.join(resourcesDir, "msgvault"));
    if (bundled) return { command: [bundled], source: "bundled", binaryPath: bundled };
  }

  const vendorDir = repoMsgvaultDir();
  if (vendorDir) {
    const bundled = bundledIn(vendorDir);
    if (bundled) return { command: [bundled], source: "bundled", binaryPath: bundled };
  }
  return null;
}

/**
 * Where the bundled gog binary is, if it is anywhere.
 *
 * Three sources, in the order `resolveBrowserRuntime` uses for the same
 * problem: an explicit env override first (tests, and a run driven on another
 * Mac), then the packaged app's Resources, then the vendor tree a from-source
 * checkout builds into.
 */
import fs from "node:fs";
import path from "node:path";

/** Where `just fetch-gog` lands it, and where electron-builder copies it from. */
export const VENDOR_DIR = "vendor/gog";

function executable(candidate: string): string | null {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return candidate;
  } catch {
    return null;
  }
}

/**
 * Where gog is, and — when it is nowhere — why.
 *
 * A result rather than a throw. The only caller runs inside
 * `app.whenReady().then(...)`, which has no `.catch`, so throwing here would
 * reject the launch chain before `new DeviceAgent` completes: no windows, no
 * tray, no relay. A misconfigured env var must not be able to take the app
 * down, however wrong it is.
 */
export type VendoredLocation =
  | { path: string; problem?: undefined }
  | { path: null; problem: "not-staged" | "override-missing" };

export function resolveVendoredBinary(opts: { resourcesDir?: string; repoRoot?: string } = {}): VendoredLocation {
  const override = process.env.DOMO_GOG;
  if (override) {
    const resolved = executable(override);
    // Distinguished from "nothing is staged": the operator NAMED a path, so
    // telling them to run a fetch they have already run sends them the wrong
    // way. Reported, never thrown — see above.
    return resolved === null ? { path: null, problem: "override-missing" } : { path: resolved };
  }

  if (opts.resourcesDir) {
    const packaged = executable(path.join(opts.resourcesDir, "gog", process.arch, "gog"));
    if (packaged) return { path: packaged };
  }
  if (opts.repoRoot) {
    const vendored = executable(path.join(opts.repoRoot, VENDOR_DIR, process.arch, "gog"));
    if (vendored) return { path: vendored };
  }
  return { path: null, problem: "not-staged" };
}

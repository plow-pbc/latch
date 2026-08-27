/**
 * Where a vendored CLI is, if it is anywhere.
 *
 * Three sources, in the order `resolveBrowserRuntime` uses for the same
 * problem: an explicit env override first (tests, and a run driven on another
 * Mac), then the packaged app's Resources, then the vendor tree a from-source
 * checkout builds into.
 *
 * Keyed on the provider's command, because the registry's whole claim is that
 * adding a provider is one row. This function used to be generic in NAME only
 * — `DOMO_GOG`, a literal `gog` in every path segment — which is the shape
 * that makes a facade a lie: it reads as done, and the second provider
 * discovers it is not.
 */
import fs from "node:fs";
import path from "node:path";

/** Where `just fetch-<command>` lands it, and electron-builder copies it from. */
export function vendorDir(command: string): string {
  return `vendor/${command}`;
}

/** The override, e.g. `DOMO_GOG`. Uppercase because env vars are. */
export function overrideVar(command: string): string {
  return `DOMO_${command.toUpperCase()}`;
}

function executable(candidate: string): string | null {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return candidate;
  } catch {
    return null;
  }
}

/**
 * Where the binary is, and — when it is nowhere — why.
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

export function resolveVendoredBinary(
  command: string,
  opts: { resourcesDir?: string; repoRoot?: string } = {},
): VendoredLocation {
  const override = process.env[overrideVar(command)];
  if (override) {
    const resolved = executable(override);
    // Distinguished from "nothing is staged": the operator NAMED a path, so
    // telling them to run a fetch they have already run sends them the wrong
    // way. Reported, never thrown — see above.
    return resolved === null ? { path: null, problem: "override-missing" } : { path: resolved };
  }

  if (opts.resourcesDir) {
    const packaged = executable(path.join(opts.resourcesDir, command, process.arch, command));
    if (packaged) return { path: packaged };
  }
  if (opts.repoRoot) {
    const vendored = executable(path.join(opts.repoRoot, vendorDir(command), process.arch, command));
    if (vendored) return { path: vendored };
  }
  return { path: null, problem: "not-staged" };
}

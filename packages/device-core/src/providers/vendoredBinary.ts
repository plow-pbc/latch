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
function vendorDir(command: string): string {
  return `vendor/${command}`;
}

/**
 * The override, e.g. `DOMO_GOG`: the command uppercased, with every
 * non-alphanumeric folded to `_`.
 *
 * The folding is not cosmetic. `DOMO_GH-CLI` is a name Node reads back
 * perfectly well through `process.env[...]` and no shell can `export`, so the
 * override would fail for the human only, and only on the second provider —
 * which is the discovery-on-provider-two failure this file exists to prevent.
 *
 * It is NOT injective: `gh-cli`, `gh.cli` and `gh_cli` all fold to
 * `DOMO_GH_CLI`. Two rows whose commands differ only in punctuation would
 * silently share one override — the resolver returns a path, just the wrong
 * one — so the derived name must stay unique across `PROVIDERS`, which
 * `registry.test.ts` asserts rather than leaving to whoever adds the row.
 */
export function overrideVar(command: string): string {
  return `DOMO_${command.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

function executable(candidate: string): string | null {
  try {
    // A FILE with the bit set. `X_OK` on a directory means traversable, not
    // runnable, so a directory named `gog` satisfied both this and the
    // basename check and put its parent on the child's PATH.
    if (!fs.statSync(candidate).isFile()) return null;
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
  | { path: null; problem: "not-staged" | "override-missing" | "override-misnamed" };

export function resolveVendoredBinary(
  command: string,
  opts: { resourcesDir?: string; repoRoot?: string } = {},
): VendoredLocation {
  const override = process.env[overrideVar(command)];
  if (override) {
    // ABSOLUTE first. Only the DIRECTORY of this path reaches the child, as a
    // PATH entry, and the child runs from a per-run scratch cwd — so a
    // relative override becomes an entry that resolves somewhere else
    // entirely, or nowhere, and an ambient `gog` further along PATH takes the
    // token this Mac has already minted. Resolving against the desktop
    // process's cwd is what someone setting it in a shell meant.
    const resolved = executable(path.resolve(override));
    // Distinguished from "nothing is staged": the operator NAMED a path, so
    // telling them to run a fetch they have already run sends them the wrong
    // way. Reported, never thrown — see above.
    // Covers a path that does not exist, one without the bit, and a DIRECTORY
    // — which `X_OK` alone accepts, since on a directory it means traversable.
    // The operator line says "no executable FILE" because that is the whole
    // set, and the misnamed case below is the one worth telling apart.
    if (resolved === null) return { path: null, problem: "override-missing" };
    // The basename has to BE the command. A vendored provider is reached
    // through the PATH this Mac controls, so only the directory survives —
    // point the override at `/tmp/gog-0.36.0` and the child looking for `gog`
    // finds nothing, or worse finds a different `/tmp/gog` and runs THAT with
    // a minted Google token. Refusing is the loud version of a failure whose
    // quiet version hands the credential to the wrong binary; a symlink named
    // `gog` is the fix, and it takes a second.
    if (path.basename(resolved) !== command) return { path: null, problem: "override-misnamed" };
    return { path: resolved };
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

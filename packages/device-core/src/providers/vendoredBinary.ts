/**
 * Where a vendored CLI is, if it is anywhere.
 *
 * Three sources, in the order `resolveBrowserRuntime` uses for the same
 * problem: an explicit env override first (tests, and a run driven on another
 * Mac), then the packaged app's Resources, then the vendor tree a from-source
 * checkout builds into.
 *
 * Keyed on the provider's command, because the registry's whole claim is that
 * adding a provider is one row. Generic in NAME only — a literal `gog` in
 * every path segment — is the shape that makes a facade a lie.
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
 * The folding is not cosmetic. `DOMO_GH-CLI` is a name Node reads back through
 * `process.env[...]` perfectly well and no shell can `export`, so the override
 * would fail for the human only, and only on the second provider.
 *
 * It is NOT injective: `gh-cli`, `gh.cli` and `gh_cli` all fold together, and
 * two such rows would silently share one override — the resolver returns a
 * path, just the wrong one. `registry.test.ts` asserts the derived names stay
 * unique rather than leaving it to whoever adds the row.
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
 * A result rather than a throw: the only caller runs inside
 * `app.whenReady().then(...)`, which has no `.catch`, so throwing would reject
 * the launch chain before `new DeviceAgent` completes — no windows, no tray, no
 * relay. A misconfigured env var must not be able to take the app down.
 */
export type VendoredLocation =
  | { path: string; problem?: undefined }
  | { path: null; problem: "not-staged" }
  // `given` is what the operator set; `tried` is the normalized path this
  // actually looked at. Both travel because the diagnostic needs both and had
  // been re-reading the environment and repeating the resolve to get them —
  // a second copy of the normalization rule beside the one that decided.
  | {
      path: null;
      problem: "override-missing" | "override-misnamed";
      given: string;
      tried: string;
    };

export function resolveVendoredBinary(
  command: string,
  opts: { resourcesDir?: string; repoRoot?: string } = {},
): VendoredLocation {
  const override = process.env[overrideVar(command)];
  if (override) {
    // ABSOLUTE first. Only the DIRECTORY of this path reaches the child, as a
    // PATH entry, and the child runs from a per-run scratch cwd — so a relative
    // override resolves somewhere else entirely, or nowhere, and an ambient
    // `gog` further along PATH takes the token this Mac has already minted.
    const attempted = path.resolve(override);
    const resolved = executable(attempted);
    // Distinguished from "nothing is staged": the operator NAMED a path, so
    // telling them to run a fetch they have already run sends them the wrong
    // way. Covers a path that does not exist, one without the bit, and a
    // DIRECTORY — which `X_OK` alone accepts, since there it means traversable.
    if (resolved === null) {
      return { path: null, problem: "override-missing", given: override, tried: attempted };
    }
    // The basename has to BE the command: only the directory survives, so an
    // override at `/tmp/gog-0.36.0` leaves the child looking for `gog` finding
    // nothing — or worse, a different `/tmp/gog`, run with a minted Google
    // token. Refusing is the loud version of that. A symlink is the fix.
    if (path.basename(resolved) !== command) {
      return { path: null, problem: "override-misnamed", given: override, tried: attempted };
    }
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

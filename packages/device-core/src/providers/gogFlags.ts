/**
 * The arguments a caller may not supply to gog.
 *
 * gog resolves repeated global flags LAST-WINS and accepts them after the
 * command path too. Caller argv reaches gog verbatim, so without this the belt
 * flags in `registry.ts` are decorative — verified live at 0.36.0, appending
 * `--readonly=false` to a `gmail send` that is otherwise refused before network
 * dispatch let it reach Google. This module is the gate, not hardening around
 * one. It is deliberately NOT an attempt to police gog's flag grammar
 * generally; that chase was declined once for the account flag, which is inert
 * under a supplied token. These are not.
 *
 * **Double-dash only, verified rather than assumed.** kong rejects the
 * single-dash spelling of a long flag, reading `-r` as a shorthand cluster, and
 * none of these has a shorthand. The other spelling kong can mint is the
 * negated `--no-<name>`, which would disarm a boolean flag while matching
 * neither the set nor either rule — so the fetch asserts against the binary it
 * just extracted that no gog flag is negatable, failing a pin bump at the
 * earliest point it can.
 *
 * File-bearing flags are deliberately absent from the reserved set. They are
 * parsed by `fileArgsIn` below and turned into canonical read/write
 * capabilities, so the owner approves the path and gog executes that exact
 * path instead of the old blanket refusal making attachments impossible.
 *
 * What a bumper has to DO is not written here. Every bump runs through
 * `scripts/vendored-providers.mjs`, whose checklist carries the digests, the
 * probes to re-run by hand, and what the automated assertion does and does not
 * cover. A second copy here is a second thing to keep in step.
 */

/** Flags that would override the gate itself. */
const RESERVED_EXACT: ReadonlySet<string> = new Set([
  "--readonly",
  "--gmail-no-send",
  "--enable-commands",
  "--enable-commands-exact",
  "--disable-commands",
  "--wrap-untrusted",
  "--no-input",
  "--home",
  "--access-token",
]);

/**
 * A safe-to-display name for the first caller-supplied argument that would
 * override the gate, or null when none does.
 *
 * **The return value is never agent text.** It names a flag from the closed
 * set above, and reaches an error message, the approval dialog and the
 * append-only audit log.
 *
 * No `--` terminator branch: it would let a caller who leads with `--` switch
 * the whole scan off. gog rejects a reserved global after a terminator, but
 * the gate does not depend on that parser behavior.
 */
export function reservedFlagIn(argv: readonly string[]): string | null {
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    // Split on `=` so the joined spelling is caught alongside the space-
    // separated one — `--readonly=false` is the one verified to have reached
    // Google.
    const flag = arg.split("=", 1)[0]!;
    if (RESERVED_EXACT.has(flag)) return flag;
  }
  return null;
}

interface GogFileArg {
  readonly access: "read" | "write";
  /** The argv element holding the value, not necessarily the flag. */
  readonly index: number;
  /** Present for a joined `--flag=value`; null for `--flag value`. */
  readonly joinedPrefix: string | null;
  readonly paths: readonly string[];
}

/**
 * Local paths gog reads from or writes to, including enough location data for
 * the MCP layer to replace each path with the canonical one the owner approved.
 *
 * Rules, not a leaf list: every input-file flag ends in `-file`, `--attach` is
 * its one exceptional spelling, and gog's output paths start with `--out`.
 * The rules were verified across the pinned CLI in the vendored-provider bump
 * checklist. `--` ends this scan because everything after it is positional.
 */
export function fileArgsIn(argv: readonly string[]): GogFileArg[] {
  const found: GogFileArg[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--") break;
    if (!arg.startsWith("--")) continue;
    const equals = arg.indexOf("=");
    const flag = equals === -1 ? arg : arg.slice(0, equals);
    const access = flag === "--attach" || flag.endsWith("-file")
      ? "read"
      : flag.startsWith("--out")
        ? "write"
        : null;
    if (access === null) continue;
    const valueIndex = equals === -1 ? i + 1 : i;
    const value = equals === -1 ? argv[valueIndex] : arg.slice(equals + 1);
    if (value === undefined || value === "" || value === "-") continue;
    const paths = flag === "--attach" ? value.split(",").filter(Boolean) : [value];
    if (paths.length === 0) continue;
    found.push({
      access,
      index: valueIndex,
      joinedPrefix: equals === -1 ? null : `${flag}=`,
      paths,
    });
    if (equals === -1) i += 1;
  }
  return found;
}

/** The raw paths alone, for enforcement and focused tests. */
export function filePathsIn(argv: readonly string[]): { read: string[]; write: string[] } {
  const paths = { read: [] as string[], write: [] as string[] };
  for (const arg of fileArgsIn(argv)) paths[arg.access].push(...arg.paths);
  return paths;
}

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
 * What a bumper has to DO is not written here. Every bump runs through
 * `scripts/vendored-providers.mjs`, whose checklist carries the digests, the
 * probes to re-run by hand, and what the automated assertion does and does not
 * cover. A second copy here is a second thing to keep in step.
 */

/** Flags that would override the gate itself, plus the one file-reading flag
 * with no shared suffix. */
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
  // Reads a local file into an outbound message like the `-file` family below,
  // but does not share their suffix.
  "--attach",
]);

/**
 * Two rules rather than lists of spellings, because enumeration has already
 * failed twice: `--note-file` slipped through for two review rounds because
 * `forward` has no `--body` at all and spells it `--note`.
 *
 * IN (`--*-file`) reads a local file into an outbound message. `gmail send`
 * has to stay reachable for the product to work, so without this an injected
 * call exfiltrates any file this app can read.
 *
 * OUT (`--out*`) is a filesystem WRITE to a caller-chosen path: `gmail
 * attachment` takes `--out`/`--output` and `gmail thread get` takes
 * `--out-dir`, so an injected message could land chosen bytes anywhere
 * writable. Attachment CONTENT stays reachable through `--inline`, which
 * returns base64 on stdout, so the rule costs no legitimate call.
 *
 * Checked across every gmail/calendar leaf at 0.36.0: every file-reading flag
 * ends in `-file`, and the only `--out*` flags are those three writes.
 */
function ruleLabelFor(flag: string): string | null {
  if (flag.endsWith("-file")) return "a --*-file flag";
  if (flag.startsWith("--out")) return "a --out* flag";
  return null;
}

/**
 * A safe-to-display name for the first caller-supplied argument that would
 * override the gate, or null when none does.
 *
 * **The return value is never agent text.** An exact match names a flag from
 * the closed set above; a RULE match returns a fixed label, because
 * `--<anything>-file` matches whatever the caller spelled and this string
 * reaches an error message, the approval dialog and the append-only audit log.
 *
 * No `--` terminator branch: it would let a caller who leads with `--` switch
 * the whole scan off. The cost is that a query spelled `--outdated` is refused
 * with a message about safety flags — a knowingly accepted false positive,
 * fail-closed and vanishingly rare, and cheaper than a branch resting on gog
 * honouring the terminator at every parse level. (It does — `unexpected
 * argument --readonly=false` at 0.36.0 — which is why the scan need not.)
 */
export function reservedFlagIn(argv: readonly string[]): string | null {
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    // Split on `=` so the joined spelling is caught alongside the space-
    // separated one — `--readonly=false` is the one verified to have reached
    // Google.
    const flag = arg.split("=", 1)[0]!;
    if (RESERVED_EXACT.has(flag)) return flag;
    const label = ruleLabelFor(flag);
    if (label !== null) return label;
  }
  return null;
}

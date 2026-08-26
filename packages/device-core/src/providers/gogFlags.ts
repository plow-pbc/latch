/**
 * The arguments a caller may not supply to gog.
 *
 * gog resolves repeated global flags LAST-WINS and accepts them after the
 * command path too. Caller argv reaches gog verbatim, so without this the belt
 * flags in `registry.ts` are decorative — verified live at 0.36.0, appending
 * `--readonly=false` to a `gmail send` that is otherwise refused before network
 * dispatch let it reach Google. This module is the gate, not hardening around
 * one.
 *
 * Deliberately NOT an attempt to police gog's flag grammar generally. That
 * chase was declined once, correctly, for the account flag — which is inert
 * under a supplied token. These are not inert.
 *
 * **Double-dash only, and that is verified rather than assumed.** gog 0.36.0
 * parses with kong, which rejects the single-dash spelling of a long flag:
 * `gmail send … -readonly=false` and `… -readonly false` both fail with
 * `unknown flag -r, did you mean one of "-h", "-a", …` — kong reads `-r` as a
 * shorthand cluster, and none of these flags has a shorthand.
 *
 * The other spelling kong can mint is the negated one, `--no-<name>`, which
 * would disarm a boolean flag while matching neither the set nor either rule.
 * Also checked, both ways: `--no-readonly`, `--no-wrap-untrusted` and
 * `--no-gmail-no-send` are all `unknown flag` at 0.36.0, and the schema
 * reports ZERO negatable flags anywhere — globals or gmail/calendar.
 * `scripts/fetch-gog-schema.mjs` asserts that second one at generation time,
 * so a pin bump that makes a flag negatable fails the generator. It is not a
 * full replacement for the probe, though: it would not survive gog renaming
 * the `negated` key itself. Re-run the three `--no-*` commands above, and the
 * two single-dash ones, on a pin bump.
 */

/**
 * Flags that would override the gate itself, plus the one file-reading flag
 * with no shared suffix.
 *
 * Long spellings only, and that is sufficient rather than an oversight:
 * checked against gog 0.36.0, none of these has a shorthand alias.
 */
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
 * **The return value is never agent text.** An exact match names the flag,
 * which is one of the closed set above; a RULE match returns a fixed label,
 * because `--<anything>-file` matches whatever the caller spelled and this
 * string reaches an error message, the approval dialog and the append-only
 * audit log. `gogLeaf.ts` refuses to quote argv back for exactly that reason, and
 * a gate that quoted it here would have reopened the hole one module over.
 *
 * Split on `=` so the joined spellings (`--readonly=false`) are caught
 * alongside the space-separated ones.
 *
 * There is deliberately no `--` terminator branch, for one reason and not two:
 * it would have let a caller who leads with `--` switch the whole scan off.
 * The consequence is that a positional AFTER a terminator is scanned like any
 * other word, so a search query spelled `--outdated` is refused with a message
 * about safety flags. That is a false positive and it is accepted knowingly —
 * fail-closed, vanishingly rare in a Gmail query, and cheaper than a branch
 * whose correctness rests on gog honouring the terminator at every parse
 * level. (It does honour it — `unexpected argument --readonly=false`, verified
 * at 0.36.0 — which is why the scan does not need to.)
 */
export function reservedFlagIn(argv: readonly string[]): string | null {
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const flag = arg.split("=", 1)[0]!;
    if (RESERVED_EXACT.has(flag)) return flag;
    const label = ruleLabelFor(flag);
    if (label !== null) return label;
  }
  return null;
}

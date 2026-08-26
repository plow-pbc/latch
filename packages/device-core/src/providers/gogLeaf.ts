/**
 * The dotted command path a gog argv names — the `<leaf>` half of a
 * `gog.<leaf>` capability, and the thing the approval card and the rule key
 * are built on.
 *
 * Checked against the PINNED binary's own command list, which is not an
 * allowlist: every Gmail/Calendar leaf gog ships is accepted. It exists so a
 * typo fails on this Mac instead of minting a live Google token and spending
 * it on a usage error — plow hit exactly that, documenting `--start/--end` for
 * a command whose flags are `--from/--to`.
 *
 * Groups are refused alongside typos: running a group prints help rather than
 * acting, so it would mint a token, produce nothing, and leave an audit record
 * describing an action that never happened.
 */
import { GOG_LEAVES, GOG_VERSION } from "./gogLeaves.js";

export { GOG_VERSION };

/** The agent's argv did not name something the pinned gog can run. */
export class GogArgvError extends Error {}

const LEAVES: ReadonlySet<string> = new Set(GOG_LEAVES);

/**
 * Whether `words` name a command path this Mac can reach — a whole leaf, a
 * group that has leaves under it, or the top level.
 *
 * What `--help` is allowed against. Without the prefix half, `gog gmail --help`
 * would be refused (a group is not a leaf); without the known half, appending
 * `--help` to anything at all would walk past the leaf check entirely and turn
 * the gate into a scan for one token.
 */
export function isKnownCommandPath(words: readonly string[]): boolean {
  // No words is the top level, which is a real place: `gog --help` is the
  // first thing an agent discovering the surface tries, and it is as inert as
  // any group help. Refusing it told the agent its SPELLING was wrong, which
  // is the wrong direction to send someone.
  if (words.length === 0) return true;
  // A word that already contains a dot is not a command path, for the same
  // reason it is not one in `gogLeaf`: the join would match `gmail.search`
  // against a real leaf name while gog can run no such argv.
  if (words.some((w) => w.includes("."))) return false;
  const joined = words.join(".");
  return LEAVES.has(joined) || GOG_LEAVES.some((l) => l.startsWith(`${joined}.`));
}

export function gogLeaf(argv: readonly string[]): string {
  // The command path is the leading run of plain words. gog accepts globals
  // on BOTH sides of the path, but this requires the path to come first and
  // refuses a leading or interleaved global deliberately: a word starting with
  // `-` ends the path, so the resolved leaf can only ever be the command gog
  // will actually run.
  //
  // A word containing a dot ends it too. The walk joins words with `.` to
  // compare against dotted leaf names, so without this `["gmail.search"]`
  // would resolve to `gmail.search` — a leaf that exists — while gog receives
  // an argv naming no command it has. That is the precise failure this module
  // exists to prevent: a token minted and spent on a usage error, and an audit
  // record naming an action that never happened.
  //
  // Depth cannot be guessed, because positionals follow the path, so take the
  // LONGEST prefix that is itself a known leaf: `gmail get <id>` resolves to
  // `gmail.get` rather than running past it into the id. That is unambiguous
  // only while no leaf is a dotted prefix of another — an invariant of the
  // generated list, pinned by a test in `gogLeaf.test.ts`.
  const words: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith("-") || arg.includes(".")) break;
    words.push(arg);
  }
  for (let n = words.length; n > 0; n--) {
    const candidate = words.slice(0, n).join(".");
    if (LEAVES.has(candidate)) return candidate;
  }
  // Never quote the argv back: it is agent-supplied and this message reaches
  // the audit log and the approval dialog. It has to carry the whole rule
  // instead, because "not a command" sends someone hunting for a typo when the
  // real cause was a global flag in front of the path — or, likelier, the
  // dotted spelling: every agent-facing surface shows the leaf dotted
  // (`gog.gmail.search` in capabilities, rule keys and audit records), so
  // copying that name back into argv is the mistake this refuses most often.
  throw new GogArgvError(
    `argv must begin with a Gmail or Calendar command that gog ${GOG_VERSION} has, ` +
      `as separate words ("gmail", "search" — not "gmail.search") and before any flags`,
  );
}

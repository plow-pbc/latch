/**
 * Vendored provider CLIs, and what running one costs.
 *
 * The pattern (latch#181): an agent runs a command through `plow_run_command`,
 * Latch recognises `argv[0]` as a vendored CLI, mints that provider's
 * short-lived token, and puts it in the child's environment. Everything else
 * is the `process.exec` path that already exists — capability, approval
 * dialog, always-allow rules, adversarial reviewer, seatbelt profile, audit.
 *
 * **This adds nothing to `tools/list`.** A new provider is a vendored binary,
 * a PATH entry, one row here, and a skill. That is the whole point: the
 * alternative was a hand-written MCP tool surface per provider, which is what
 * this replaces.
 *
 * **The token rides `env`, never argv.** A token on a command line lands in
 * the calling agent's captured output and from there in a persisted
 * transcript, where it outlives the token by a long way. It is also why the
 * mint happens here rather than the agent minting and passing one: the agent
 * never holds it.
 */

import type { Skill } from "../skills.js";
import { reservedFlagIn } from "./gogFlags.js";
import { GOG_SKILL } from "./gogSkill.js";

/** What one vendored CLI needs in order to run. */
export interface VendoredProvider {
  /** `argv[0]`, and the binary's name inside its vendor directory. */
  readonly command: string;
  /** The connector action that mints this provider's token. */
  readonly mintAction: string;
  /** Where the mint's routes hang, e.g. `/v1/connectors/gmail/`. */
  readonly mintPrefix: string;
  /**
   * The environment variable the CLI reads its token from.
   *
   * There is deliberately no account variable beside it. The token IS the
   * account binding — gog with a caller-supplied token authenticates as
   * whoever that token belongs to, so an account flag in agent-supplied argv
   * cannot redirect the call, and Plow's mint resolves the owner's connected
   * account server-side. One fewer thing for this Mac to hold, get wrong, or
   * disagree with Plow about.
   */
  readonly tokenEnv: string;
  /**
   * Flags Latch puts in front of the command path on every invocation,
   * whatever the agent asked for.
   *
   * NOT a read/write boundary. An earlier design carried a `write` bit on the
   * capability and enforced it with gog's `--readonly`; under this pattern the
   * capability IS the argv, so the human approves the literal command and
   * there is no claim left to enforce. What remains are the flags that are
   * unconditionally right: no interactive prompting in a headless child, and
   * the marker that keeps fetched message text from reading as instructions.
   */
  readonly belt: readonly string[];
  /**
   * Reject argv the human must not be asked to approve, before any intent
   * exists. Returns a reason, or null.
   *
   * Two jobs. It refuses arguments that would disarm the belt or read/write
   * local files through the CLI — hazards a human cannot see by reading the
   * command, because the command itself looks legitimate. And it refuses a
   * command the vendored binary does not have, so a typo fails here instead
   * of minting a live token and spending it on a usage error.
   */
  readonly refuse: (argv: readonly string[]) => string | null;
  /**
   * How an agent learns to drive this CLI. Published only when the binary is
   * staged, and carried on the row so the provider's name has ONE spelling —
   * a rename here cannot silently unpublish a skill registered under a
   * literal somewhere else.
   */
  readonly skill: Skill;
}

/**
 * The groups the minted token's four Google scopes actually reach.
 *
 * The ONLY command check this Mac makes, and it exists for one reason: an
 * out-of-scope group is the case that SPENDS the token. Verified against
 * pinned 0.36.0 — `gog drive search x` reaches Google and returns 401, while
 * every in-group usage mistake fails locally with no network call at all.
 */
const GOG_GROUPS: ReadonlySet<string> = new Set(["gmail", "calendar"]);

/**
 * `... --help`, which names no group and reaches nothing.
 *
 * A `--` terminator disqualifies it: after one, `-h` is the query itself, and
 * treating `gmail search -- -h` as help would run a real search with no minted
 * token. Fail-safe — it would simply fail — but wrong, and one condition
 * cheaper to prevent than to explain.
 */
function isHelpInvocation(rest: readonly string[]): boolean {
  if (rest.includes("--")) return false;
  const last = rest[rest.length - 1];
  return last === "--help" || last === "-h";
}

const GOG: VendoredProvider = {
  command: "gog",
  mintAction: "access-token",
  // Not a Gmail-only scope, though the prefix says gmail: checked against
  // plow's GMAIL_DEFAULT_SCOPES, the mint covers calendar.readonly and
  // calendar.events too, which is what gog's ~40 calendar leaves are spent on.
  // The route was mounted on this prefix because the calendar routes already
  // lived there — the name is Plow's history, not a narrower grant.
  mintPrefix: "/v1/connectors/gmail/",
  tokenEnv: "GOG_ACCESS_TOKEN",
  belt: ["--no-input", "--wrap-untrusted"],
  skill: GOG_SKILL,
  refuse: (argv) => {
    const rest = argv.slice(1);
    const reserved = reservedFlagIn(rest);
    if (reserved !== null) {
      return `${reserved} may not be supplied: it would override this Mac's safety flags`;
    }
    // `--help` is how the skill tells an agent to discover the rest of the
    // surface, and it is inert: gog prints usage and exits, with no network
    // call and nothing mutated. Without an allowance the leaf check refuses
    // `gog gmail --help`, because a group is not a leaf — so the skill would
    // be teaching a command the gate rejects.
    //
    // `-h` is verified to be gog's group help at 0.36.0, and gog itself
    // refuses `--help` in a flag's value position (`--subject --help` →
    // "expected string value"), so that shape needs no handling here.
    if (isHelpInvocation(rest)) return null;
    // The group, and nothing finer. gog reports its own usage errors better
    // than a mirrored command list can — `unexpected argument serach, did you
    // mean "search"?` against `not a command gog has` — and reports them
    // LOCALLY, with no network call and nothing spent. What gog cannot do is
    // decline a group this Mac's token has no scope for: `drive search x`
    // reaches Google and comes back 401, which is a spent delegation. So this
    // checks the one thing that is actually ours to check.
    const group = rest[0];
    // Three different mistakes, three sentences — and NONE of them quotes the
    // argv back. These reach the approval dialog and the append-only audit
    // log, so the same rule `gogFlags` follows applies: a reason may name a
    // rule, never the caller's text. The rule is enough to self-correct from.
    if (group === undefined) return 'the command is missing: try ["gog", "gmail", "search", ...]';
    if (group.startsWith("-")) return "the command must come first, before any flags";
    // gog never sees a dotted spelling as a command, so its own error would
    // not help here — this is one of the two mistakes the skill flags as
    // likeliest, and it needs its own sentence.
    if (group.includes(".")) return 'the command must be separate words: ["gmail", "search"], not ["gmail.search"]';
    if (!GOG_GROUPS.has(group)) return "this Mac reaches only Gmail and Calendar through gog";
    return null;
  },
};

export const PROVIDERS: readonly VendoredProvider[] = [GOG];

/**
 * The provider an argv invokes, or null when it invokes none.
 *
 * Matched on `argv[0]` exactly. A path (`/usr/local/bin/gog`) is deliberately
 * NOT a match: the vendored binary is reached through the PATH this Mac
 * controls, and honouring a caller-supplied path would let an agent point the
 * mint at a binary of its choosing.
 */
export function vendoredProvider(argv: readonly string[]): VendoredProvider | null {
  const head = argv[0];
  if (head === undefined) return null;
  return PROVIDERS.find((p) => p.command === head) ?? null;
}

/**
 * Whether this invocation needs a token at all.
 *
 * `--help` does not: gog prints usage and exits without touching the network.
 * Minting for it would spend a real delegation — a token that has left Plow
 * whether or not anything used it — on a command that cannot use one.
 */
export function needsToken(argv: readonly string[]): boolean {
  // The SAME predicate `refuse` uses, not a second scan. When they disagreed,
  // an argv the gate accepted as a real command — `gmail search --help q`,
  // where `--help` is a positional and not the last word — was treated as
  // help here and ran with no minted token, which on a Mac where gog can find
  // ambient credentials means running against those instead.
  return !isHelpInvocation(argv.slice(1));
}

/** Every vendored command name, for the skill and for the tool description. */
export const VENDORED_COMMANDS: readonly string[] = PROVIDERS.map((p) => p.command);

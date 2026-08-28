/**
 * Vendored provider CLIs, and what running one costs.
 *
 * The pattern (latch#181): an agent runs a command through `plow_run_command`,
 * Latch recognises `argv[0]` as a vendored CLI, mints that provider's
 * short-lived token, and puts it in the child's environment. Everything else is
 * the `process.exec` path that already exists — capability, approval dialog,
 * always-allow rules, adversarial reviewer, seatbelt profile, audit.
 *
 * **This adds nothing to `tools/list`.** A new provider is a vendored binary, a
 * PATH entry, one row here, and a skill — the alternative it replaces was a
 * hand-written MCP tool surface per provider.
 *
 * **The token rides `env`, never argv.** A token on a command line lands in the
 * calling agent's captured output and from there in a persisted transcript,
 * where it outlives the token by a long way. It is also why the mint happens
 * here rather than the agent minting and passing one: the agent never holds it.
 */

import type { Skill } from "../skills.js";
import { isHelpInvocation, reservedRefusal, shapeRefusal } from "./gogGate.js";
import { GOG_CANONICAL } from "./gogGroups.js";
import { GOG_SKILL } from "./gogSkill.js";
import { planPlowGog } from "./plowGog.js";

/** What one vendored CLI needs in order to run. */
export interface VendoredProvider {
  /** `argv[0]`. */
  readonly command: string;
  /**
   * The staged binary this provider execs — usually `command` itself, but a
   * provider that ORCHESTRATES another provider's CLI names that one:
   * plow-gog runs the vendored gog N times and stages no payload of its own.
   * Every staging/resolution site reads this, never `command`.
   */
  readonly binary: string;
  /** The connector action that mints this provider's token. */
  readonly mintAction: string;
  /** Where the mint's routes hang, e.g. `/v1/connectors/gmail/`. */
  readonly mintPrefix: string;
  /**
   * The environment variable the CLI reads its token from.
   *
   * No account variable beside it, deliberately: the token IS the account
   * binding, so an account flag in agent-supplied argv cannot redirect the
   * call, and Plow resolves the owner's connected account server-side.
   */
  readonly tokenEnv: string;
  /**
   * Flags Latch puts in front of the command path on every invocation, whatever
   * the agent asked for.
   *
   * NOT a read/write boundary: the capability IS the argv, so the human
   * approves the literal command and there is no claim left to enforce. What
   * remains are the flags that are unconditionally right — no interactive
   * prompting in a headless child, the marker that keeps fetched message text
   * from reading as instructions, and the scope bound.
   *
   * `--enable-commands` is that bound, and gog enforces it ITSELF before any
   * network call. `refuse` still checks the group because it does so before the
   * dialog and the mint; this is the layer under it, and the one that holds if
   * the other is ever wrong. gog's last-wins parsing would let a caller append
   * their own to widen it, which is why it is in `RESERVED_EXACT`.
   *
   * The per-version verdicts behind all of that are step 5 of the pin-bump
   * checklist in `scripts/vendored-providers.mjs`, their only home.
   */
  readonly belt: readonly string[];
  /**
   * Reject argv the human must not be asked to approve, before any intent
   * exists. Returns a reason, or null.
   *
   * Two groups. Arguments that would disarm the belt or read/write local files
   * through the CLI — hazards a human cannot see by reading the command,
   * because the command itself looks legitimate. And four shapes of a wrong
   * command, all of which ONE check refuses: a group that is not gmail or
   * calendar. The other three branches only choose a better sentence.
   *
   * What differs is what each would have COST unrefused, and two reach Google:
   *
   *  - **An out-of-scope group** — without the belt's bound gog tries it and
   *    comes back 401, a spent call. This branch closes it before the mint.
   *  - **A leading global flag** — worse, and verified: `--json gmail search x`
   *    parses `--json` as a global and **succeeds**. `rest[0]` is not the group
   *    in that shape, so the group check would inspect the flag and never see
   *    one, which is why the message names the position rather than scopes.
   *  - **A dotted spelling** and **an empty argv** reach nothing.
   *
   * It deliberately does NOT mirror gog's command grammar. A misspelt leaf is
   * left to gog, which says `did you mean "search"?` without reaching Google.
   * That still costs a mint, since this Mac mints BEFORE it execs — the
   * accepted price of not carrying 101 leaf names, and cheap, because Plow
   * returns a cached token outside a 60s expiry buffer.
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

const GOG: VendoredProvider = {
  command: "gog",
  binary: "gog",
  mintAction: "access-token",
  // Not a Gmail-only scope, though the prefix says gmail: checked against
  // plow's GMAIL_DEFAULT_SCOPES, the mint covers calendar.readonly and
  // calendar.events too, which is what gog's ~40 calendar leaves are spent on.
  // The route was mounted on this prefix because the calendar routes already
  // lived there — the name is Plow's history, not a narrower grant.
  mintPrefix: "/v1/connectors/gmail/",
  tokenEnv: "GOG_ACCESS_TOKEN",
  // The bound is DERIVED from the same list the check reads, so the two
  // cannot drift into disagreeing about what is in scope.
  belt: ["--no-input", "--wrap-untrusted", `--enable-commands=${GOG_CANONICAL.join(",")}`],
  skill: GOG_SKILL,
  refuse: (argv) => {
    const rest = argv.slice(1);
    // `--help` is inert — gog prints usage and exits — and is how the skill
    // tells an agent to discover the surface. What the allowance rescues is
    // `gog --help` and `gog -h`, which the flags-first shape check would
    // otherwise refuse for leading with a flag; a group's own help
    // (`gog gmail --help`) passes the group check without it.
    //
    // It also passes `gmail send --subject --help`, where `--help` is a flag's
    // VALUE and the last word, so no group check is reached. What keeps that
    // safe is gog refusing `--help` in a value position itself — a per-version
    // verdict, so step 3 of the pin-bump checklist owns it, and the agreement
    // table pins the shape.
    return reservedRefusal(rest) ?? (isHelpInvocation(rest) ? null : shapeRefusal(rest, "gog"));
  },
};

/**
 * The multi-account front for the same vendored gog. One approved argv, N
 * runs of the binary — one per connected Google account — merged into one
 * account-tagged result; `deviceAgent.executePlowGog` is the orchestration.
 * `gog` above stays registered (deprecated) so existing exact-argv approvals
 * keep working; new work uses this row.
 */
const PLOW_GOG: VendoredProvider = {
  command: "plow-gog",
  binary: GOG.command,
  mintAction: GOG.mintAction,
  mintPrefix: GOG.mintPrefix,
  tokenEnv: GOG.tokenEnv,
  belt: GOG.belt,
  skill: GOG_SKILL,
  // The planner IS the gate: a refused plan and a refused argv are one
  // decision, so the dialog and the orchestrator cannot disagree about it.
  refuse: (argv) => {
    const plan = planPlowGog(argv);
    return plan.kind === "refused" ? plan.reason : null;
  },
};

export const PROVIDERS: readonly VendoredProvider[] = [GOG, PLOW_GOG];

/**
 * The provider an argv invokes, or null when it invokes none.
 *
 * Matched on `argv[0]` exactly. A path (`/usr/local/bin/gog`) is deliberately
 * NOT a match: honouring a caller-supplied one would let an agent point the
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
 * `--help` does not, and minting for it would spend a real delegation — a
 * token that has left Plow whether or not anything used it.
 */
export function needsToken(argv: readonly string[]): boolean {
  // The SAME predicate `refuse` uses, not a second scan. When they disagreed,
  // `gmail search --help q` — where `--help` is a positional, not the last
  // word — was treated as help here and ran with no minted token, which on a
  // Mac where gog can find ambient credentials means running against those.
  return !isHelpInvocation(argv.slice(1));
}

/**
 * Whether this argv gets the network capability whether or not it asked.
 *
 * A provider reaches its service by definition, so the flag is not the agent's
 * to remember — but a help invocation reaches nothing, for the same reason it
 * mints nothing.
 *
 * Spelled ONCE because it decides two different things in two packages: what
 * `mcp-server` puts in the capability set, and, through `Executor.isReapable`,
 * whether the run is exempt from the silent-run reaper. Spelled twice, one of
 * them drifted within a single commit.
 */
export function impliesNetwork(argv: readonly string[]): boolean {
  return vendoredProvider(argv) !== null && needsToken(argv);
}

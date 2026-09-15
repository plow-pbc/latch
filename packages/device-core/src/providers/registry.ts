/**
 * Providers, and what running one costs.
 *
 * A provider is a code row — gate, planner, mint, skill — layered on a bundled
 * plugin. The plugin pins, stages and bounds the binary; the row is the
 * judgment about driving it, and neither half is the other's.
 *
 * The pattern (latch#181): an agent runs a command through `plow_run_command`,
 * Latch recognises `argv[0]` as a provider's command, mints that provider's
 * short-lived token, and puts it in the child's environment. Everything else is
 * the `process.exec` path that already exists — capability, approval dialog,
 * always-allow rules, adversarial reviewer, seatbelt profile, audit.
 *
 * **This adds nothing to `tools/list`.** A new provider is a bundled plugin
 * (`apps/desktop/plugins/`, `packages/device-core/src/plugins/`), one row here,
 * and a skill — the alternative it replaces was a hand-written MCP tool surface
 * per provider.
 *
 * **The token rides `env`, never argv.** A token on a command line lands in the
 * calling agent's captured output and from there in a persisted transcript,
 * where it outlives the token by a long way. It is also why the mint happens
 * here rather than the agent minting and passing one: the agent never holds it.
 */

import type { Skill } from "../skills.js";
import { isHelpInvocation } from "./gogGate.js";
import { GOG_SKILL } from "./gogSkill.js";
import { fileArgsIn } from "./gogFlags.js";
import { planPlowGog } from "./plowGog.js";

export interface ProviderFileArg {
  readonly access: "read" | "write";
  /** The argv element holding the value, not necessarily the flag. */
  readonly index: number;
  /** Present for a joined `--flag=value`; null for `--flag value`. */
  readonly joinedPrefix: string | null;
  readonly paths: readonly string[];
}

/** What one provider needs in order to run. */
export interface Provider {
  /** `argv[0]`. */
  readonly command: string;
  /**
   * The bundled plugin whose executable this provider drives: its manifest name.
   *
   * The plugin's `exec.argv` carries the flags that go in front of every
   * invocation, `--enable-commands` among them — and gog enforces that bound
   * ITSELF before any network call. `refuse` still checks the group because it
   * does so before the dialog and the mint; the manifest is the layer under
   * it, and the one that holds if the other is ever wrong.
   */
  readonly plugin: string;
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
   * Reject argv the human must not be asked to approve, before any intent
   * exists. Returns a reason, or null.
   *
   * Two groups. Arguments that would disarm the belt, and four shapes of a
   * wrong command, all of which ONE check refuses: a group that is not gmail
   * or calendar. The other three branches only choose a better sentence.
   * Local file arguments are not refused: `fileArgs` below makes their paths
   * explicit capabilities before an intent exists.
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
  /** File-bearing argv positions that become approved filesystem capabilities. */
  readonly fileArgs: (argv: readonly string[]) => readonly ProviderFileArg[];
  /**
   * How an agent learns to drive this CLI. Published only when the binary is
   * staged, and carried on the row so the provider's name has ONE spelling —
   * a rename here cannot silently unpublish a skill registered under a
   * literal somewhere else.
   */
  readonly skill: Skill;
}

/**
 * The multi-account front for the bundled gog plugin. One approved argv, N runs
 * of the plugin's binary — one per connected Google account — merged into one
 * account-tagged result; `deviceAgent.executePlowGog` is the orchestration.
 *
 * A bare `gog` argv is NOT this row: `providerRefusal` answers it with a
 * sentence naming `plow-gog`. One surface carries the multi-account judgment,
 * and an agent that types the plugin's own binary name is pointed at it rather
 * than falling through to a single-account path beside it.
 */
const PLOW_GOG: Provider = {
  command: "plow-gog",
  plugin: "gog",
  mintAction: "access-token",
  // Not a Gmail-only scope, though the prefix says gmail: checked against
  // plow's GMAIL_DEFAULT_SCOPES, the mint covers calendar.readonly and
  // calendar.events too, which is what gog's ~40 calendar leaves are spent on.
  // The route was mounted on this prefix because the calendar routes already
  // lived there — the name is Plow's history, not a narrower grant.
  mintPrefix: "/v1/connectors/gmail/",
  tokenEnv: "GOG_ACCESS_TOKEN",
  skill: GOG_SKILL,
  fileArgs: fileArgsIn,
  // The planner IS the gate: a refused plan and a refused argv are one
  // decision, so the dialog and the orchestrator cannot disagree about it.
  // `--help` is inert — gog prints usage and exits — and is how the skill
  // tells an agent to discover the surface; the planner passes it before the
  // shape check, which would otherwise refuse `gog --help` for leading with a
  // flag. `gmail send --subject --help`, where `--help` is a flag's VALUE and
  // the last word, is kept safe by gog refusing `--help` in a value position
  // itself — a per-version verdict, step 3 of the pin-bump checklist.
  refuse: (argv) => {
    const plan = planPlowGog(argv);
    return plan.kind === "refused" ? plan.reason : null;
  },
};

export const PROVIDERS: readonly Provider[] = [PLOW_GOG];

/**
 * The provider an argv invokes, or null when it invokes none.
 *
 * Matched on `argv[0]` exactly, against the COMMAND alone. A path
 * (`/usr/local/bin/gog`) is deliberately NOT a match: honouring a
 * caller-supplied one would let an agent point the mint at a binary of its
 * choosing. Neither is the plugin's own name — `providerRefusal` below refuses
 * that, rather than routing it here.
 */
export function providerFor(argv: readonly string[]): Provider | null {
  const head = argv[0];
  if (head === undefined) return null;
  return PROVIDERS.find((p) => p.command === head) ?? null;
}

/**
 * What refuses an argv before any intent exists: the provider's own gate, or
 * the fixed sentence for a plugin a provider row drives — an agent that types
 * the binary's name gets pointed at the surface with the judgment in it.
 */
export function providerRefusal(argv: readonly string[]): string | null {
  const provider = providerFor(argv);
  if (provider !== null) return provider.refuse(argv);
  const claimed = PROVIDERS.find((p) => p.plugin === argv[0]);
  return claimed === undefined ? null : `${claimed.plugin} is driven through ${claimed.command}`;
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
  return providerFor(argv) !== null && needsToken(argv);
}

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
}

import { reservedFlagIn } from "./gogFlags.js";
import { gogLeaf, GogArgvError } from "./gogLeaf.js";

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
  refuse: (argv) => {
    const rest = argv.slice(1);
    const reserved = reservedFlagIn(rest);
    if (reserved !== null) {
      return `${reserved} may not be supplied: it would override this Mac's safety flags`;
    }
    // `--help` is how the skill tells an agent to discover the rest of the
    // surface, and it is inert: gog prints usage and exits, with no network
    // call and nothing mutated. Without this the leaf check refuses
    // `gog gmail --help`, because a group is not a leaf — so the skill would
    // be teaching a command the gate rejects.
    if (rest.some((a) => a === "--help" || a === "-h")) return null;
    try {
      gogLeaf(rest);
    } catch (e) {
      if (e instanceof GogArgvError) return e.message;
      throw e;
    }
    return null;
  },
};

const PROVIDERS: readonly VendoredProvider[] = [GOG];

/**
 * The provider an argv invokes, or null when it invokes none.
 *
 * Matched on `argv[0]` exactly. A path (`/usr/local/bin/gog`) is deliberately
 * NOT a match: the vendored binary is reached through the PATH this Mac
 * controls, and honouring a caller-supplied path would let an agent point the
 * mint at a binary of its choosing.
 */
export function vendoredProvider(
  argv: readonly string[],
  /**
   * The vendor directories actually staged on this Mac. A provider whose
   * binary is absent is NOT a provider: minting for it would spend a real
   * delegation — a token that has left Plow whether or not anything used it —
   * on a command that then fails to exec. Omitted by callers that only need
   * to know whether a name is provider-shaped, such as the tool's pre-intent
   * refusal, which runs before any token exists.
   */
  staged?: readonly string[],
): VendoredProvider | null {
  const head = argv[0];
  if (head === undefined) return null;
  const provider = PROVIDERS.find((p) => p.command === head) ?? null;
  if (provider === null || staged === undefined) return provider;
  return staged.length > 0 ? provider : null;
}

/** Every vendored command name, for the skill and for the tool description. */
export const VENDORED_COMMANDS: readonly string[] = PROVIDERS.map((p) => p.command);

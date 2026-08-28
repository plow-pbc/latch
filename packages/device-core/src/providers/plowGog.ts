/**
 * plow-gog: the multi-account front for the vendored gog binary.
 *
 * Same argv grammar, same gate, same belt — the difference is account reach.
 * Curated reads fan out across every connected Google account and come back
 * as one merged, account-tagged result; everything else runs on exactly one
 * account — named with `--account` whenever more than one is connected — and
 * timed calendar creates are conflict-gated. The functions here are the PURE
 * half:
 * classify an argv into a plan, and merge per-account output. Everything with
 * a side effect — minting, spawning, account resolution — is `deviceAgent`'s,
 * so this whole surface is testable offline.
 *
 * Three arguments are plow-gog's own and are stripped before anything reaches
 * gog: `--account <email>` (narrow to one account), `--confirm-conflict`
 * (override the conflict gate), and the `accounts` verb (list connected
 * accounts from the mint, no gog run at all). Refusal reasons follow the house
 * rule (`gogFlags.ts`): they may name a rule, never the caller's text.
 */
import { isHelpInvocation, reservedRefusal, shapeRefusal } from "./gogGate.js";
import { GOG_ALIAS_OF } from "./gogGroups.js";

export type PlowGogSort = "gmail-date" | "cal-start" | "none";

export type PlowGogPlan =
  | { kind: "refused"; reason: string }
  /** `plow-gog accounts`: answered from the mint result, no gog run. */
  | { kind: "accounts" }
  | { kind: "help"; gogArgv: string[] }
  /** A curated read, run once per connected account and merged. */
  | { kind: "fanout"; gogArgv: string[]; sort: PlowGogSort }
  /**
   * Everything else: ONE run, on ONE account. Which account is the runtime's
   * question — with more than one connected, `account` is required there —
   * and `conflictCheck` marks the one shape (a timed calendar create) whose
   * run is conflict-gated.
   */
  | {
      kind: "single";
      gogArgv: string[];
      account: string | null;
      confirmConflict: boolean;
      conflictCheck: { from: string; to: string } | null;
    };

/**
 * The curated fan-out reads, by canonical group then verb — including gog's
 * own verb aliases (`search (find,query,ls,list)`, `events (list,ls)`),
 * verified against the vendored binary's help at 0.36.0. Everything else
 * stays single-account.
 */
const FANOUT: Readonly<Record<string, Readonly<Record<string, PlowGogSort>>>> = {
  gmail: { search: "gmail-date", find: "gmail-date", query: "gmail-date", ls: "gmail-date", list: "gmail-date" },
  calendar: {
    events: "cal-start",
    list: "cal-start",
    ls: "cal-start",
    freebusy: "none",
    conflicts: "none",
  },
};

/**
 * The one shape whose run is conflict-gated: `calendar create` and its
 * aliases (verified against the vendored binary's help at 0.36.0).
 * Deliberately the ONLY verb recognition outside the fan-out table — there is
 * no read-vs-write classification to mirror gog's grammar with, because with
 * more than one account connected EVERY single-account command requires
 * `--account`, whatever it does. CREATE only: an update whose new window
 * overlaps its own old one would self-conflict, since the probe cannot
 * exclude the event being updated — and the gate exists for bookings.
 */
const CONFLICT_GATED: ReadonlySet<string> = new Set(["create", "add", "new"]);

/** The value of `--<name> v` / `--<name>=v` in an argv, or null. Last wins,
 * matching gog's own flag resolution. */
function flagValue(args: readonly string[], name: string): string | null {
  let value: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === `--${name}`) value = args[i + 1] ?? null;
    else if (arg.startsWith(`--${name}=`)) value = arg.slice(name.length + 3);
  }
  return value;
}

export function planPlowGog(argv: readonly string[]): PlowGogPlan {
  // Strip plow-gog's own flags first: they are this Mac's to interpret, and a
  // spelling that reached gog would collide with gog's own `--account` — which
  // is inert under a supplied token, but only when nothing forwards it.
  const stripped: string[] = [];
  let account: string | null = null;
  let confirmConflict = false;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--account") {
      const value = argv[i + 1];
      if (value === undefined || value === "") {
        return { kind: "refused", reason: "--account needs a value: the account's email address" };
      }
      account = value;
      i++;
      continue;
    }
    if (arg.startsWith("--account=")) {
      const value = arg.slice("--account=".length);
      if (value === "") {
        return { kind: "refused", reason: "--account needs a value: the account's email address" };
      }
      account = value;
      continue;
    }
    if (arg === "--confirm-conflict") {
      confirmConflict = true;
      continue;
    }
    stripped.push(arg);
  }

  const reserved = reservedRefusal(stripped);
  if (reserved !== null) return { kind: "refused", reason: reserved };

  if (stripped[0] === "accounts") {
    // From the mint result, so nothing may ride along — an extra token here
    // would be silently dropped, which reads as it having worked.
    if (stripped.length > 1 || account !== null || confirmConflict) {
      return { kind: "refused", reason: "accounts takes no arguments" };
    }
    return { kind: "accounts" };
  }

  const gogArgv = ["plow-gog", ...stripped];
  if (isHelpInvocation(stripped)) return { kind: "help", gogArgv };

  const shape = shapeRefusal(stripped, "plow-gog");
  if (shape !== null) return { kind: "refused", reason: shape };

  // Classification runs on the canonical group; the pass-through argv keeps
  // the agent's spelling, because gog resolves its own aliases.
  const group = GOG_ALIAS_OF[stripped[0]!] ?? stripped[0]!;
  const verb = stripped[1];

  const sort = verb !== undefined ? FANOUT[group]?.[verb] : undefined;
  if (sort !== undefined && account === null) {
    // A fan-out already asks every connected account for its own calendar.
    // Naming calendars on top of that sends each account the OTHERS' ids —
    // the same events back N times, and a degraded row for every account
    // that cannot read them. Observed as an agent's default grammar, so it
    // is refused with the correction rather than merged into a wrong answer.
    if (stripped.some((arg) => arg === "--calendars" || arg.startsWith("--calendars="))) {
      return {
        kind: "refused",
        reason:
          "a fan-out already queries every connected account's calendar: drop --calendars, or add --account <email> to query one account's",
      };
    }
    // Merging requires JSON; add what the agent did not already ask for.
    const extras: string[] = [];
    if (!stripped.includes("--json") && !stripped.includes("-j")) extras.push("--json");
    if (!stripped.includes("--results-only")) extras.push("--results-only");
    return { kind: "fanout", gogArgv: [...gogArgv, ...extras], sort };
  }

  let conflictCheck: { from: string; to: string } | null = null;
  if (group === "calendar" && verb !== undefined && CONFLICT_GATED.has(verb)) {
    const from = flagValue(stripped, "from");
    const to = flagValue(stripped, "to");
    // Timed bounds only: a date with no "T" is an all-day event, which skips
    // the gate (the retired relay contract).
    if (from !== null && to !== null && from.includes("T") && to.includes("T")) {
      conflictCheck = { from, to };
    }
  }
  return { kind: "single", gogArgv, account, confirmConflict, conflictCheck };
}

/**
 * One merged, account-tagged result from N per-account gog runs.
 *
 * Each stdout is `--json --results-only` output: an array of items (tagged
 * per element), or any other JSON (one tagged item). Output that does not
 * parse goes into `unparsed` under a rule label — the text itself is
 * service-fetched content and never travels in an error string.
 */
export function mergeFanout(
  perAccount: readonly { account: string; stdout: string }[],
  sort: PlowGogSort,
): { items: Record<string, unknown>[]; unparsed: { account: string; error: string }[] } {
  const items: Record<string, unknown>[] = [];
  const unparsed: { account: string; error: string }[] = [];
  for (const { account, stdout } of perAccount) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      unparsed.push({ account, error: "output was not JSON" });
      continue;
    }
    for (const element of Array.isArray(parsed) ? parsed : [parsed]) {
      // `account` is written LAST: the tag is this Mac's, and a same-named
      // field in fetched content must not be able to re-attribute an item.
      if (element !== null && typeof element === "object" && !Array.isArray(element)) {
        items.push({ ...(element as Record<string, unknown>), account });
      } else {
        items.push({ account, value: element });
      }
    }
  }
  if (sort !== "none") items.sort((a, b) => startOf(b, sort) - startOf(a, sort));
  return { items, unparsed };
}

/** A sortable timestamp for one item — negated for calendar so one comparator
 * serves both orders (gmail newest-first, calendar soonest-first). Items with
 * no parseable time sort last either way; the sort is stable, so ties keep
 * account order. */
function startOf(item: Record<string, unknown>, sort: PlowGogSort): number {
  const raw =
    sort === "gmail-date"
      ? item.date
      : ((item.start as Record<string, unknown> | undefined)?.dateTime ??
        (item.start as Record<string, unknown> | undefined)?.date);
  const parsed = typeof raw === "string" ? Date.parse(raw) : NaN;
  // Finite, below every representable date (±8.64e15): two unparseable items
  // must compare equal, and `-Infinity - -Infinity` is NaN, which a comparator
  // may not return.
  if (Number.isNaN(parsed)) return -9e15;
  return sort === "gmail-date" ? parsed : -parsed;
}

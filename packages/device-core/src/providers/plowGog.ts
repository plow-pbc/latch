/**
 * plow-gog: the multi-account front for the vendored gog binary.
 *
 * Same argv grammar, same gate, same belt — the difference is account reach.
 * Reads fan out across every connected Google account and come back as one
 * merged, account-tagged result; writes name exactly one account; timed
 * calendar creates are conflict-gated. The functions here are the PURE half:
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
  /** Pass-through: one run, `account` or the default when null. */
  | { kind: "single"; gogArgv: string[]; account: string | null }
  /** A mutation: exactly one account, conflict-gated when `conflictCheck`. */
  | {
      kind: "write";
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
 * The mutating verbs, by canonical group — the ones that must name ONE account
 * when several are connected. Verified against the vendored binary's help at
 * 0.36.0, aliases included (the plan's `untrash` does not exist there and was
 * dropped). Deliberately fail-open: a verb not listed — including the nested
 * `messages`/`thread`/`batch`/`settings` subtrees — falls through to `single`,
 * i.e. the default account, which is exactly today's gog behavior; the real
 * write gate is Google's scopes plus the approval dialog, not this list.
 */
const WRITES: Readonly<Record<string, ReadonlySet<string>>> = {
  gmail: new Set([
    "send", "reply", "reply-all", "replyall", "forward", "fwd",
    "drafts", "draft", "labels", "label", "trash", "archive",
    "mark-read", "read-messages", "unread", "mark-unread", "import", "autoreply",
  ]),
  calendar: new Set([
    "create", "add", "new", "update", "edit", "set",
    "delete", "rm", "del", "remove", "respond", "rsvp", "reply",
    "move", "transfer", "subscribe", "sub", "add-calendar", "unsubscribe", "unsub",
    "create-calendar", "new-calendar", "delete-calendar", "acl",
    "propose-time", "focus-time", "focus", "out-of-office", "ooo", "working-location", "wl",
  ]),
};

/** The writes whose timed window gets a conflict precheck: calendar
 * create/update and their aliases. Delete and respond never conflict-gate. */
const CONFLICT_GATED: ReadonlySet<string> = new Set(["create", "add", "new", "update", "edit", "set"]);

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

  if (verb !== undefined && WRITES[group]?.has(verb)) {
    let conflictCheck: { from: string; to: string } | null = null;
    if (group === "calendar" && CONFLICT_GATED.has(verb)) {
      const from = flagValue(stripped, "from");
      const to = flagValue(stripped, "to");
      // Timed bounds only: a date with no "T" is an all-day event, which
      // skips the gate (the retired relay contract).
      if (from !== null && to !== null && from.includes("T") && to.includes("T")) {
        conflictCheck = { from, to };
      }
    }
    return { kind: "write", gogArgv, account, confirmConflict, conflictCheck };
  }

  const sort = verb !== undefined ? FANOUT[group]?.[verb] : undefined;
  if (sort !== undefined && account === null) {
    // Merging requires JSON; add what the agent did not already ask for.
    const extras: string[] = [];
    if (!stripped.includes("--json") && !stripped.includes("-j")) extras.push("--json");
    if (!stripped.includes("--results-only")) extras.push("--results-only");
    return { kind: "fanout", gogArgv: [...gogArgv, ...extras], sort };
  }

  return { kind: "single", gogArgv, account };
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

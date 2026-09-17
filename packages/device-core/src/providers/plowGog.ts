/**
 * plow-gog: the multi-account front for the bundled gog plugin's binary.
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
 * gog: `--account <email>[,<email>…]` (one account, or the several to fan
 * out to, spelled `-a` too), `--confirm-conflict`
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
  /**
   * A curated read, run once per connected account and merged. `accounts`
   * narrows the fan-out to the ones `--account a@x,b@y` named, or is null
   * for all of them.
   */
  | {
      kind: "fanout";
      gogArgv: string[];
      sort: PlowGogSort;
      accounts: string[] | null;
      /** A calendar event list the agent did not project itself: its merged
       * items go through `compactCalendarEvents`, in this time zone — the
       * same one gog was asked for. */
      compact?: string;
    }
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
 * verified against the staged binary's help at 0.36.0. Everything else
 * stays single-account.
 */
const FANOUT: Readonly<Record<string, Readonly<Record<string, PlowGogSort>>>> = {
  gmail: { search: "gmail-date", find: "gmail-date", query: "gmail-date", ls: "gmail-date", list: "gmail-date" },
  calendar: {
    calendars: "none",
    events: "cal-start",
    list: "cal-start",
    ls: "cal-start",
    freebusy: "none",
    conflicts: "none",
  },
};

/**
 * The one shape whose run is conflict-gated: `calendar create` and its
 * aliases (verified against the staged binary's help at 0.36.0).
 * Deliberately the ONLY verb recognition outside the fan-out table — there is
 * no read-vs-write classification to mirror gog's grammar with, because with
 * more than one account connected EVERY single-account command requires
 * `--account`, whatever it does. CREATE only: an update whose new window
 * overlaps its own old one would self-conflict, since the probe cannot
 * exclude the event being updated — and the gate exists for bookings.
 */
const CONFLICT_GATED: ReadonlySet<string> = new Set(["create", "add", "new"]);

/**
 * Every calendar verb whose `--help` lists `--send-updates`, with its aliases
 * as that help spells them (re-check the list on a gog bump). gog's own
 * default is `none`, so an invite to someone outside the account went out
 * silent and the agent said "invite's out" (#421). Attendees live on the
 * event for the other verbs, not the argv, and Google emails nobody when
 * there are none — so every one gets `all` unless the agent chose a mode.
 */
const NOTIFYING: ReadonlySet<string> = new Set([
  ...CONFLICT_GATED,
  "update", "edit", "set",
  "move", "transfer",
  "delete", "rm", "del", "remove",
]);

/** The `--max` a calendar event list gets when the agent names none — per account. */
export const CALENDAR_EVENTS_MAX = "100";

/**
 * The owner's time zone — this Mac's. Calendar days and times are reported in
 * it, whatever zone each event was created in.
 */
export function ownerTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

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

/**
 * The account flag's value at `i`, and the index the scan continues from — or
 * null when the argument is not the account flag.
 *
 * gog publishes `-a` as the shorthand for its own `--account`, so an agent
 * that read `gog --help` writes it, and all three spellings kong accepts for a
 * shorthand carrying a value (`-a v`, `-a=v`, `-av`) are plow-gog's too. A
 * shorthand CLUSTER (`-ja x@y.co`) deliberately is not: it stays gog's, where
 * a supplied token makes the flag inert. Nothing else can be spelled `-a…` —
 * gog's shorthands are single letters and its long flags take two dashes.
 */
function accountAt(
  argv: readonly string[],
  i: number,
): { value: string | undefined; next: number } | null {
  const arg = argv[i]!;
  if (arg === "--account" || arg === "-a") return { value: argv[i + 1], next: i + 1 };
  if (arg.startsWith("--account=")) return { value: arg.slice("--account=".length), next: i };
  if (arg.startsWith("-a=")) return { value: arg.slice("-a=".length), next: i };
  if (arg.startsWith("-a")) return { value: arg.slice("-a".length), next: i };
  return null;
}

/**
 * Why an account FAILED, as a fixed sentence.
 *
 * gog publishes its exit codes as a contract (`gog schema --json` →
 * `automation.exit_codes`) and maps Google's own failures onto that same
 * table, so the NUMBER carries the diagnosis and the child's output — which is
 * service-fetched text — never has to travel in a reason string (the
 * `gogFlags.ts` rule). Verified against the staged binary at 0.36.0.
 *
 * Without this the only account-level diagnosis was `gog exited 2`, and a
 * fan-out that came back empty for every account could not be told apart from
 * one whose token had expired.
 *
 * Exit 3 is absent deliberately: gog's "empty results" is an ANSWER, and the
 * caller counts it as one before asking this what went wrong. A sentence for
 * it here would be a second, disagreeing opinion about the same code.
 *
 * The rest of gog's table (5 not found, 8 retryable, 10 config, 11 orphaned,
 * 130 interrupted) keeps the bare number on purpose: those say nothing an
 * owner could act on without the command in front of them, and a wrong
 * sentence is worse than a number.
 */
export function gogExitReason(exitCode: number | null): string {
  switch (exitCode) {
    // "usage" — the belt and the gate settle gog's own grammar before a child
    // starts, so in practice this is Google rejecting the request itself.
    case 2:
      return "gog rejected the request as invalid";
    case 4:
      return "that account needs re-auth — re-connect it in Plow";
    case 6:
      return "permission denied for that account";
    case 7:
      return "rate limited by Google";
    default:
      return `gog exited ${exitCode ?? -1}`;
  }
}

export function planPlowGog(argv: readonly string[], timeZone: string = ownerTimeZone()): PlowGogPlan {
  // Strip plow-gog's own flags first: they are this Mac's to interpret, and a
  // spelling that reached gog would collide with gog's own `--account` — which
  // is inert under a supplied token, but only when nothing forwards it.
  // `--account` is gog's own flag, one email; plow-gog's takes several
  // (`--account a@x,b@y`), which on a fan-out read means those accounts.
  const stripped: string[] = [];
  let accounts: string[] = [];
  let confirmConflict = false;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    const named = accountAt(argv, i);
    if (named !== null) {
      accounts = (named.value ?? "").split(",").filter((a) => a !== "");
      if (accounts.length === 0) {
        return { kind: "refused", reason: "--account needs a value: the account's email address" };
      }
      i = named.next;
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

  const account = accounts.length === 1 ? accounts[0]! : null;
  if (stripped[0] === "accounts") {
    // From the mint result, so nothing may ride along — an extra token here
    // would be silently dropped, which reads as it having worked.
    if (stripped.length > 1 || accounts.length > 0 || confirmConflict) {
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
  // gog lists 10 events unless told otherwise — fewer than a busy week holds —
  // and a fan-out's --results-only drops the page token that would say so, so
  // a cut-off calendar read as free time.
  if (sort === "cal-start" && flagValue(stripped, "max") === null) gogArgv.push("--max", CALENDAR_EVENTS_MAX);
  // gog labels each event's day and local time in that EVENT's zone unless
  // told otherwise, so a 9pm meeting set in São Paulo came back as the next
  // day for an owner in California.
  let zone = timeZone;
  if (sort === "cal-start") {
    const asked = flagValue(stripped, "timezone");
    if (asked === null) gogArgv.push("--timezone", timeZone);
    // gog's own spelling for this machine's zone, which is the owner's.
    else if (asked !== "local") zone = asked;
    if (!isTimeZone(zone)) {
      return { kind: "refused", reason: "--timezone needs an IANA zone name (e.g. America/New_York) or local" };
    }
  }
  if (sort !== undefined && account === null) {
    // Every account asked, or the several named. A calendar id under that
    // has no owner to send it to — forwarded, it reached every account, the
    // same events N times plus a degraded row per account that could not
    // read it — so it needs `--account` for the one account whose it is.
    if (group === "calendar" && stripped.some((arg) => arg === "--calendars" || arg.startsWith("--calendars="))) {
      return {
        kind: "refused",
        reason:
          "a calendar id needs its account: add --account <email> for the account that owns it, or drop --calendars and name the accounts to read with --account a@x,b@y",
      };
    }
    // Merging requires JSON; add what the agent did not already ask for.
    const extras: string[] = [];
    if (!stripped.includes("--json") && !stripped.includes("-j")) extras.push("--json");
    if (!stripped.includes("--results-only")) extras.push("--results-only");
    // A --select or --fields is the agent's own projection; everything else
    // comes back compact, because a busy week of raw events outgrows the
    // agent's tool output and the fields it needed are lost with the overflow.
    const projected = stripped.some((arg) => /^--(select|fields)(=|$)/.test(arg));
    return {
      kind: "fanout",
      gogArgv: [...gogArgv, ...extras],
      sort,
      accounts: accounts.length > 1 ? accounts : null,
      ...(sort === "cal-start" && !projected ? { compact: zone } : {}),
    };
  }
  if (accounts.length > 1) {
    return { kind: "refused", reason: "this command runs on one account: --account takes one email here" };
  }

  if (group === "calendar" && verb !== undefined && NOTIFYING.has(verb) && flagValue(stripped, "send-updates") === null) {
    gogArgv.push("--send-updates", "all");
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

/**
 * Where a compacted calendar read stops, in serialized characters. The agent's
 * tool output is cut off near 50,000; this leaves room for the envelope and
 * the degraded list.
 */
export const CALENDAR_ITEMS_BUDGET = 40_000;

/**
 * A merged calendar event list, cut down to what scheduling needs, with every
 * day and time stated in `timeZone`.
 *
 * Raw Google events run about 2 KB each, so a busy week across a few accounts
 * overflowed the agent's tool output — and an agent re-reading an overflow
 * keeps what it thinks matters, not the day name. Here the day name is
 * computed from the event's instant, never from the zone the event was
 * written in, and travels beside the time it names.
 *
 * Items arrive sorted by start. Past `budget` the rest are dropped and
 * `truncated` says how many, and `after`: the earliest start among them — a
 * local time, or a bare date when that is an all-day event, which covers the
 * whole of its day. The merge sorts an all-day date as UTC midnight, so one
 * can follow a timed event on its own local day; `after` still reaches back
 * to cover it, and the time from it on is never read as free.
 */
export function compactCalendarEvents(
  items: readonly Record<string, unknown>[],
  timeZone: string,
  budget: number = CALENDAR_ITEMS_BUDGET,
): { items: Record<string, unknown>[]; truncated: { omitted: number; after: string | null } | null } {
  const kept: Record<string, unknown>[] = [];
  let used = 0;
  for (const item of items) {
    const event = compactEvent(item, timeZone);
    used += JSON.stringify(event).length + 1;
    if (used > budget) {
      const omitted = items.slice(kept.length);
      const starts = omitted.map((o) => localTime(o.start, timeZone)).filter((t) => t !== null);
      const earliest = starts.reduce<LocalTime | null>((a, b) => (a === null || startsBefore(b, a) ? b : a), null);
      return { items: kept, truncated: { omitted: omitted.length, after: earliest?.local ?? null } };
    }
    kept.push(event);
  }
  return { items: kept, truncated: null };
}

/** Whether `a` starts before `b`: by local day, an all-day date first (it
 * covers that day from midnight), then by instant. */
function startsBefore(a: LocalTime, b: LocalTime): boolean {
  const dayA = a.local.slice(0, 10);
  const dayB = b.local.slice(0, 10);
  if (dayA !== dayB) return dayA < dayB;
  if (a.allDay !== b.allDay) return a.allDay;
  return a.instant < b.instant;
}

function compactEvent(item: Record<string, unknown>, timeZone: string): Record<string, unknown> {
  const start = localTime(item.start, timeZone);
  const end = localTime(item.end, timeZone);
  const event: Record<string, unknown> = {
    summary: item.summary ?? null,
    startDayOfWeek: start?.weekday ?? null,
    startLocal: start?.local ?? null,
    endLocal: end?.local ?? null,
  };
  if (start?.allDay) event.allDay = true;
  const attendees = Array.isArray(item.attendees) ? (item.attendees as unknown[]) : [];
  if (attendees.length > 0) event.attendees = attendees.length;
  // The two ways an event on the calendar leaves the owner free.
  if (item.transparency === "transparent") event.transparency = "transparent";
  const self = attendees.find((a) => (a as Record<string, unknown> | null)?.self === true) as
    | Record<string, unknown>
    | undefined;
  if (self?.responseStatus === "declined") event.declined = true;
  event.id = item.id ?? null;
  event.account = item.account;
  return event;
}

/**
 * A Google event time (`{dateTime}` or all-day `{date}`) as a local ISO time
 * with offset and a weekday name, both in `timeZone`. An all-day date names
 * its own day, whatever the zone.
 */
type LocalTime = { local: string; weekday: string; allDay: boolean; instant: number };

function localTime(when: unknown, timeZone: string): LocalTime | null {
  if (when === null || typeof when !== "object") return null;
  const { dateTime, date } = when as Record<string, unknown>;
  if (typeof dateTime === "string") {
    const instant = new Date(dateTime);
    if (Number.isNaN(instant.getTime())) return null;
    const p = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone,
        weekday: "long",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
        timeZoneName: "longOffset",
      })
        .formatToParts(instant)
        .map((part) => [part.type, part.value]),
    );
    // "GMT-07:00", or a bare "GMT" at offset zero.
    const offset = p.timeZoneName === "GMT" ? "+00:00" : p.timeZoneName!.slice("GMT".length);
    return {
      local: `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${offset}`,
      weekday: p.weekday!,
      allDay: false,
      instant: instant.getTime(),
    };
  }
  if (typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long" }).format(
      new Date(`${date}T12:00:00Z`),
    );
    return { local: date, weekday, allDay: true, instant: Date.parse(`${date}T00:00:00Z`) };
  }
  return null;
}

/**
 * The refusal a conflict-gated create earns, or null when every connected
 * account came back clear.
 *
 * Detection is complete or it is nothing: the probe runs on EVERY connected
 * account, because the owner's availability is the union of their calendars,
 * and a create that only checked the account it books on is the "if you had a
 * bunch of calendars, it wouldn't check them all" hole. An account that could
 * not be checked is named as `degraded` rather than passed over — a check
 * with a hole in it must not read as clear.
 *
 * COUNTS ONLY, per account. Approving a create does not approve a read, so
 * event titles stay on the Mac; the agent has `calendar conflicts` if it
 * wants names.
 */
export function conflictRefusal(
  probed: readonly { account: string; conflicts: number }[],
  degraded: readonly { account: string; reason: string }[],
): string | null {
  const busy = probed.filter((p) => p.conflicts > 0);
  if (busy.length === 0 && degraded.length === 0) return null;
  const parts = [
    ...busy.map((p) => `${p.account}: ${p.conflicts} event(s) overlap this window`),
    ...degraded.map((d) => `${d.account}: could not check (${d.reason})`),
  ];
  const head = busy.length > 0 ? "the slot is busy" : "the conflict check did not cover every account";
  return `${head} — ${parts.join("; ")}. Follow the Google Workspace skill's conflict rule before re-sending the same command with --confirm-conflict; this refusal carries counts only.`;
}

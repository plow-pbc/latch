/**
 * The plow-gog planner and merger — the pure half of the multi-account
 * orchestration. Offline by construction: no minting, no spawning, no account
 * list. `deviceAgent` consumes the plan; `providerExec.test.ts` covers that
 * seam.
 */
import { describe, expect, it } from "vitest";
import { GOG_SKILL } from "../src/providers/gogSkill.js";
import {
  bookableCalendar,
  compactCalendarEvents,
  conflictRefusal,
  freeBusyIntervals,
  gogExitReason,
  mergeFanout,
  planPlowGog,
  type PlowGogPlan,
} from "../src/providers/plowGog.js";

const PACIFIC = "America/Los_Angeles";

describe("planPlowGog", () => {
  // One row per behavior. `expected` is the WHOLE plan — a partial match would
  // let an extra field (an account that should have been stripped, a stale
  // conflictCheck) ride along unasserted.
  it.each<{ why: string; argv: string[]; expected: PlowGogPlan }>([
    {
      why: "fans a gmail search out across accounts, sorted by date",
      argv: ["plow-gog", "gmail", "search", "newer_than:7d"],
      expected: {
        kind: "fanout",
        gogArgv: ["plow-gog", "gmail", "search", "newer_than:7d", "--json", "--results-only"],
        sort: "gmail-date",
        accounts: null,
      },
    },
    {
      // The --calendars reading is the calendar group's: elsewhere the flag
      // is a usage error gog reports itself, like any other misspelling.
      why: "leaves a stray --calendars on a gmail fan-out to gog",
      argv: ["plow-gog", "gmail", "search", "q", "--calendars=a"],
      expected: {
        kind: "fanout",
        gogArgv: ["plow-gog", "gmail", "search", "q", "--calendars=a", "--json", "--results-only"],
        sort: "gmail-date",
        accounts: null,
      },
    },
    {
      // gog's --account takes one email; plow-gog's takes several, and on a
      // fan-out read that is the accounts to fan out to — gmail or calendar.
      why: "narrows a fan-out to the several accounts --account names",
      argv: ["plow-gog", "gmail", "search", "q", "--account", "a@example.com,b@example.com"],
      expected: {
        kind: "fanout",
        gogArgv: ["plow-gog", "gmail", "search", "q", "--json", "--results-only"],
        sort: "gmail-date",
        accounts: ["a@example.com", "b@example.com"],
      },
    },
    {
      // gog publishes `-a` as the shorthand for its own --account, so an agent
      // that read `gog --help` writes it. Reading it as anything but plow-gog's
      // own flag left the account unnamed and refused a command the agent had
      // spelled correctly.
      why: "reads gog's -a shorthand as --account, value in the next argument",
      argv: ["plow-gog", "gmail", "search", "q", "-a", "a@example.com,b@example.com"],
      expected: {
        kind: "fanout",
        gogArgv: ["plow-gog", "gmail", "search", "q", "--json", "--results-only"],
        sort: "gmail-date",
        accounts: ["a@example.com", "b@example.com"],
      },
    },
    {
      why: "reads the joined -a=<v> shorthand",
      argv: ["plow-gog", "gmail", "get", "m1", "-a=b@example.com"],
      expected: {
        kind: "single",
        gogArgv: ["plow-gog", "gmail", "get", "m1"],
        account: "b@example.com",
        confirmConflict: false,
        conflictCheck: null,
      },
    },
    {
      why: "reads the attached -a<v> shorthand",
      argv: ["plow-gog", "gmail", "get", "m1", "-ab@example.com"],
      expected: {
        kind: "single",
        gogArgv: ["plow-gog", "gmail", "get", "m1"],
        account: "b@example.com",
        confirmConflict: false,
        conflictCheck: null,
      },
    },
    {
      // Not one of the three spellings: a cluster stays gog's, where a
      // supplied token makes its account flag inert. It must still reach gog
      // whole rather than being half-eaten here.
      why: "leaves a shorthand cluster alone, forwarding it to gog",
      argv: ["plow-gog", "gmail", "get", "m1", "-ja", "b@example.com"],
      expected: {
        kind: "single",
        gogArgv: ["plow-gog", "gmail", "get", "m1", "-ja", "b@example.com"],
        account: null,
        confirmConflict: false,
        conflictCheck: null,
      },
    },
    {
      why: "classifies through gog's own aliases but keeps the agent's spelling",
      argv: ["plow-gog", "mail", "search", "q"],
      expected: {
        kind: "fanout",
        gogArgv: ["plow-gog", "mail", "search", "q", "--json", "--results-only"],
        sort: "gmail-date",
        accounts: null,
      },
    },
    {
      // gog's own default is 10 per account, which cut an owner's calendar
      // off mid-week and read the rest as free.
      why: "fans calendar events out, sorted by start, 100 deep by default, in the owner's zone, compacted",
      argv: ["plow-gog", "calendar", "events", "primary"],
      expected: {
        kind: "fanout",
        gogArgv: [
          "plow-gog", "calendar", "events", "primary", "--max", "100", "--timezone", PACIFIC, "--json", "--results-only",
        ],
        sort: "cal-start",
        accounts: null,
        compact: true,
      },
    },
    {
      why: "keeps the agent's own --timezone and --select on a calendar list, uncompacted",
      argv: ["plow-gog", "calendar", "events", "--timezone=UTC", "--select", "summary,startDayOfWeek"],
      expected: {
        kind: "fanout",
        gogArgv: [
          "plow-gog", "calendar", "events", "--timezone=UTC", "--select", "summary,startDayOfWeek",
          "--max", "100", "--json", "--results-only",
        ],
        sort: "cal-start",
        accounts: null,
      },
    },
    {
      // The zone the agent asked gog for is the one the days are named in.
      why: "keeps the agent's own --timezone on a compacted list",
      argv: ["plow-gog", "calendar", "events", "--timezone", "Asia/Tokyo"],
      expected: {
        kind: "fanout",
        gogArgv: ["plow-gog", "calendar", "events", "--timezone", "Asia/Tokyo", "--max", "100", "--json", "--results-only"],
        sort: "cal-start",
        accounts: null,
        compact: true,
      },
    },
    {
      why: "keeps the agent's own --max on a calendar list",
      argv: ["plow-gog", "cal", "ls", "--max=5"],
      expected: {
        kind: "fanout",
        gogArgv: ["plow-gog", "cal", "ls", "--max=5", "--timezone", PACIFIC, "--json", "--results-only"],
        sort: "cal-start",
        accounts: null,
        compact: true,
      },
    },
    {
      why: "fans freebusy out with no sort",
      argv: ["plow-gog", "cal", "freebusy", "primary"],
      expected: {
        kind: "fanout",
        gogArgv: ["plow-gog", "cal", "freebusy", "primary", "--json", "--results-only"],
        sort: "none",
        accounts: null,
      },
    },
    {
      why: "fans conflicts out with no sort",
      argv: ["plow-gog", "calendar", "conflicts", "--from", "x", "--to", "y"],
      expected: {
        kind: "fanout",
        gogArgv: ["plow-gog", "calendar", "conflicts", "--from", "x", "--to", "y", "--json", "--results-only"],
        sort: "none",
        accounts: null,
      },
    },
    {
      why: "does not double a --json the agent already passed",
      argv: ["plow-gog", "gmail", "search", "q", "--json"],
      expected: {
        kind: "fanout",
        gogArgv: ["plow-gog", "gmail", "search", "q", "--json", "--results-only"],
        sort: "gmail-date",
        accounts: null,
      },
    },
    {
      why: "narrows a read to one account when --account is given",
      argv: ["plow-gog", "gmail", "search", "q", "--account", "a@example.com"],
      expected: {
        kind: "single",
        gogArgv: ["plow-gog", "gmail", "search", "q"],
        account: "a@example.com",
        confirmConflict: false,
        conflictCheck: null,
      },
    },
    {
      why: "reads the joined --account=<v> spelling too",
      argv: ["plow-gog", "gmail", "search", "q", "--account=b@example.com"],
      expected: {
        kind: "single",
        gogArgv: ["plow-gog", "gmail", "search", "q"],
        account: "b@example.com",
        confirmConflict: false,
        conflictCheck: null,
      },
    },
    {
      // The flag the fan-out refuses is fine once one account is named:
      // that account is asked for calendars it can name.
      why: "narrows a --calendars read to the one account that owns them",
      argv: ["plow-gog", "calendar", "events", "list", "--calendars=a,b", "--account", "a@example.com"],
      expected: {
        kind: "single",
        gogArgv: ["plow-gog", "calendar", "events", "list", "--calendars=a,b", "--max", "100", "--timezone", PACIFIC],
        account: "a@example.com",
        confirmConflict: false,
        conflictCheck: null,
      },
    },
    {
      why: "leaves everything uncurated a single-account command, resolved at run time",
      argv: ["plow-gog", "gmail", "get", "msg-1", "--json"],
      expected: {
        kind: "single",
        gogArgv: ["plow-gog", "gmail", "get", "msg-1", "--json"],
        account: null,
        confirmConflict: false,
        conflictCheck: null,
      },
    },
    {
      // No write classification exists: a send is a single like any other, and
      // the more-than-one-account --account requirement is the runtime's.
      why: "leaves a send a single-account command",
      argv: ["plow-gog", "gmail", "send", "--to", "x@y.com", "--subject", "s", "--body", "b"],
      expected: {
        kind: "single",
        gogArgv: ["plow-gog", "gmail", "send", "--to", "x@y.com", "--subject", "s", "--body", "b"],
        account: null,
        confirmConflict: false,
        conflictCheck: null,
      },
    },
    {
      why: "carries --account on any single",
      argv: ["plow-gog", "gmail", "drafts", "reply", "m1", "--body", "b", "--account", "b@example.com"],
      expected: {
        kind: "single",
        gogArgv: ["plow-gog", "gmail", "drafts", "reply", "m1", "--body", "b"],
        account: "b@example.com",
        confirmConflict: false,
        conflictCheck: null,
      },
    },
    {
      why: "gates a timed calendar create on a conflict check",
      argv: [
        "plow-gog", "calendar", "create", "primary", "--summary", "X",
        "--from", "2026-08-28T10:00:00-07:00", "--to", "2026-08-28T11:00:00-07:00",
      ],
      expected: {
        kind: "single",
        gogArgv: [
          "plow-gog", "calendar", "create", "primary", "--summary", "X",
          "--from", "2026-08-28T10:00:00-07:00", "--to", "2026-08-28T11:00:00-07:00",
          "--send-updates", "all",
        ],
        account: null,
        confirmConflict: false,
        conflictCheck: { from: "2026-08-28T10:00:00-07:00", to: "2026-08-28T11:00:00-07:00" },
      },
    },
    {
      // CREATE only: an update whose new window overlaps its own old one
      // would self-conflict — the probe cannot exclude the event being
      // updated. The gate exists for bookings.
      why: "never gates an update, even a timed one",
      argv: ["plow-gog", "calendar", "update", "primary", "e1", "--from=2026-08-28T10:00:00Z", "--to=2026-08-28T11:00:00Z"],
      expected: {
        kind: "single",
        gogArgv: ["plow-gog", "calendar", "update", "primary", "e1", "--from=2026-08-28T10:00:00Z", "--to=2026-08-28T11:00:00Z", "--send-updates", "all"],
        account: null,
        confirmConflict: false,
        conflictCheck: null,
      },
    },
    {
      why: "reads the joined --from=/--to= spelling for the gate",
      argv: ["plow-gog", "calendar", "create", "primary", "--from=2026-08-28T10:00:00Z", "--to=2026-08-28T11:00:00Z"],
      expected: {
        kind: "single",
        gogArgv: ["plow-gog", "calendar", "create", "primary", "--from=2026-08-28T10:00:00Z", "--to=2026-08-28T11:00:00Z", "--send-updates", "all"],
        account: null,
        confirmConflict: false,
        conflictCheck: { from: "2026-08-28T10:00:00Z", to: "2026-08-28T11:00:00Z" },
      },
    },
    {
      why: "lets an all-day create (date-only bounds) skip the gate",
      argv: ["plow-gog", "calendar", "create", "primary", "--summary", "X", "--from", "2026-08-28", "--to", "2026-08-29"],
      expected: {
        kind: "single",
        gogArgv: ["plow-gog", "calendar", "create", "primary", "--summary", "X", "--from", "2026-08-28", "--to", "2026-08-29", "--send-updates", "all"],
        account: null,
        confirmConflict: false,
        conflictCheck: null,
      },
    },
    {
      why: "never gates a delete, timed window or not",
      argv: ["plow-gog", "calendar", "delete", "primary", "e1"],
      expected: {
        kind: "single",
        gogArgv: ["plow-gog", "calendar", "delete", "primary", "e1", "--send-updates", "all"],
        account: null,
        confirmConflict: false,
        conflictCheck: null,
      },
    },
    {
      // gog's own default is `none`: an invite to someone outside the account
      // went out silent, and a "video call" had no video (#421). Attendees
      // are on the event for update/delete, not the argv, and Google emails
      // nobody when there are none — so every write gets `all` unless the
      // agent chose.
      why: "keeps the agent's own --send-updates on a calendar write",
      argv: ["plow-gog", "cal", "rm", "primary", "e1", "--send-updates=none"],
      expected: {
        kind: "single",
        gogArgv: ["plow-gog", "cal", "rm", "primary", "e1", "--send-updates=none"],
        account: null,
        confirmConflict: false,
        conflictCheck: null,
      },
    },
    {
      why: "notifies on a move too, under gog's alias",
      argv: ["plow-gog", "cal", "transfer", "primary", "e1", "other"],
      expected: {
        kind: "single",
        gogArgv: ["plow-gog", "cal", "transfer", "primary", "e1", "other", "--send-updates", "all"],
        account: null,
        confirmConflict: false,
        conflictCheck: null,
      },
    },
    {
      why: "strips --confirm-conflict and carries it as the override",
      argv: [
        "plow-gog", "calendar", "create", "primary", "--summary", "X",
        "--from", "2026-08-28T10:00:00Z", "--to", "2026-08-28T11:00:00Z", "--confirm-conflict",
      ],
      expected: {
        kind: "single",
        gogArgv: [
          "plow-gog", "calendar", "create", "primary", "--summary", "X",
          "--from", "2026-08-28T10:00:00Z", "--to", "2026-08-28T11:00:00Z",
          "--send-updates", "all",
        ],
        account: null,
        confirmConflict: true,
        conflictCheck: { from: "2026-08-28T10:00:00Z", to: "2026-08-28T11:00:00Z" },
      },
    },
    {
      why: "answers the accounts verb without touching gog",
      argv: ["plow-gog", "accounts"],
      expected: { kind: "accounts" },
    },
    {
      why: "passes help through, still spelled by the agent",
      argv: ["plow-gog", "gmail", "--help"],
      expected: { kind: "help", gogArgv: ["plow-gog", "gmail", "--help"] },
    },
    {
      why: "passes top-level help through",
      argv: ["plow-gog", "--help"],
      expected: { kind: "help", gogArgv: ["plow-gog", "--help"] },
    },
  ])("$why", ({ argv, expected }) => {
    expect(planPlowGog(argv, PACIFIC)).toEqual(expected);
  });

  // The refusals, with the same sentences the gog provider uses — these reach
  // the approval dialog and the audit log, so none may quote caller argv.
  it.each<{ why: string; argv: string[]; reason: string }>([
    {
      why: "refuses a flag that would disarm the belt",
      argv: ["plow-gog", "gmail", "search", "q", "--readonly=false"],
      reason: "safety flags",
    },
    {
      why: "refuses a group outside the token's scopes",
      argv: ["plow-gog", "drive", "ls"],
      reason: "only Gmail and Calendar",
    },
    {
      why: "refuses a missing command, naming plow-gog's own spelling",
      argv: ["plow-gog"],
      reason: '["plow-gog", "gmail", "search", ...]',
    },
    {
      why: "refuses a leading global flag",
      argv: ["plow-gog", "--json", "gmail", "search", "q"],
      reason: "before any flags",
    },
    {
      why: "refuses the dotted spelling",
      argv: ["plow-gog", "gmail.search", "q"],
      reason: "separate words",
    },
    {
      why: "refuses arguments after the accounts verb",
      argv: ["plow-gog", "accounts", "sneakyagenttext"],
      reason: "accounts takes no arguments",
    },
    {
      why: "refuses an --account with no value",
      argv: ["plow-gog", "gmail", "search", "q", "--account"],
      reason: "--account needs a value",
    },
    {
      // The shorthand is the same flag, so it fails the same way rather than
      // running against whatever account happens to be default.
      why: "refuses a -a with no value",
      argv: ["plow-gog", "gmail", "search", "q", "-a"],
      reason: "--account needs a value",
    },
    {
      why: "refuses an empty -a= value",
      argv: ["plow-gog", "gmail", "search", "q", "-a="],
      reason: "--account needs a value",
    },
    {
      // A calendar id has an owner; under a fan-out there is no account to
      // send it to. The sentence carries both corrections.
      why: "refuses --calendars under a fan-out",
      argv: ["plow-gog", "calendar", "events", "list", "--calendars=sneakyagenttext", "--from=now"],
      reason: "--account a@x,b@y",
    },
    {
      why: "refuses several --account emails on a single-account command",
      argv: ["plow-gog", "gmail", "get", "msg-1", "--account=a@example.com,sneakyagenttext"],
      reason: "one email",
    },
  ])("$why", ({ argv, reason }) => {
    const plan = planPlowGog(argv, PACIFIC);
    expect(plan.kind).toBe("refused");
    if (plan.kind !== "refused") return;
    expect(plan.reason).toContain(reason);
    expect(plan.reason).not.toContain("sneaky");
  });
});

describe("mergeFanout", () => {
  const gmail = (account: string, rows: unknown) => ({ account, stdout: JSON.stringify(rows) });

  it("tags every item with its account and sorts gmail by date, newest first", () => {
    const { items, unparsed } = mergeFanout(
      [
        gmail("a@example.com", [
          { id: "1", date: "Mon, 16 Mar 2026 10:00:00 +0000" },
          { id: "2", date: "Wed, 18 Mar 2026 09:00:00 +0000" },
        ]),
        gmail("b@example.com", [{ id: "3", date: "Tue, 17 Mar 2026 12:00:00 +0000" }]),
      ],
      "gmail-date",
    );
    expect(unparsed).toEqual([]);
    expect(items).toEqual([
      { id: "2", date: "Wed, 18 Mar 2026 09:00:00 +0000", account: "a@example.com" },
      { id: "3", date: "Tue, 17 Mar 2026 12:00:00 +0000", account: "b@example.com" },
      { id: "1", date: "Mon, 16 Mar 2026 10:00:00 +0000", account: "a@example.com" },
    ]);
  });

  it("sorts an item with no parseable date last, keeping its place otherwise", () => {
    const { items } = mergeFanout(
      [
        gmail("a@example.com", [{ id: "undated" }]),
        gmail("b@example.com", [{ id: "dated", date: "Mon, 16 Mar 2026 10:00:00 +0000" }]),
      ],
      "gmail-date",
    );
    expect(items.map((i) => (i as { id: string }).id)).toEqual(["dated", "undated"]);
  });

  it("sorts calendar items by start ascending, dateTime or all-day date alike", () => {
    const { items } = mergeFanout(
      [
        gmail("a@example.com", [{ summary: "late", start: { dateTime: "2026-08-28T15:00:00-07:00" } }]),
        gmail("b@example.com", [
          { summary: "early", start: { dateTime: "2026-08-28T10:00:00-07:00" } },
          { summary: "allday", start: { date: "2026-08-27" } },
        ]),
      ],
      "cal-start",
    );
    expect(items.map((i) => (i as { summary: string }).summary)).toEqual(["allday", "early", "late"]);
  });

  it("keeps account order under sort 'none'", () => {
    const { items } = mergeFanout(
      [gmail("b@example.com", [{ id: "b1" }]), gmail("a@example.com", [{ id: "a1" }])],
      "none",
    );
    expect(items).toEqual([
      { id: "b1", account: "b@example.com" },
      { id: "a1", account: "a@example.com" },
    ]);
  });

  it("tags a non-array JSON result as one item", () => {
    const { items } = mergeFanout([gmail("a@example.com", { calendars: 2 })], "none");
    expect(items).toEqual([{ calendars: 2, account: "a@example.com" }]);
  });

  it("wraps a non-object array element rather than losing it", () => {
    const { items } = mergeFanout([gmail("a@example.com", ["plain-string"])], "none");
    expect(items).toEqual([{ account: "a@example.com", value: "plain-string" }]);
  });

  it("reports unparsable output by rule label, never echoing the output", () => {
    const { items, unparsed } = mergeFanout(
      [
        { account: "a@example.com", stdout: "Error: sneakyagenttext went wrong\n" },
        gmail("b@example.com", [{ id: "ok" }]),
      ],
      "none",
    );
    expect(items).toEqual([{ id: "ok", account: "b@example.com" }]);
    expect(unparsed).toEqual([{ account: "a@example.com", error: "output was not JSON" }]);
  });
});

/**
 * gog's published exit table (`gog schema --json` → `automation.exit_codes`),
 * verified against the staged binary at 0.36.0. The sentences are fixed:
 * the child's own output is service-fetched text and never reaches a reason.
 */
describe("gog exit reasons", () => {
  it.each<{ why: string; code: number | null; reason: string }>([
    { why: "usage — in practice Google rejecting the request", code: 2, reason: "gog rejected the request as invalid" },
    // No row for 3: gog's "empty results" is an answer, and `deviceAgent`
    // counts it as one before this is asked what went wrong.
    { why: "auth", code: 4, reason: "that account needs re-auth — re-connect it in Plow" },
    { why: "permission denied", code: 6, reason: "permission denied for that account" },
    { why: "rate limited", code: 7, reason: "rate limited by Google" },
    { why: "an unmapped code keeps the number", code: 5, reason: "gog exited 5" },
    { why: "a signalled child has no code at all", code: null, reason: "gog exited -1" },
  ])("$why", ({ code, reason }) => {
    expect(gogExitReason(code)).toBe(reason);
  });
});

describe("compactCalendarEvents", () => {
  const ACCOUNTS = ["a@example.com", "b@example.com", "c@example.com"];
  const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];

  // A raw event as gog prints it under --timezone: Google's own fields,
  // padded the way real ones are (description, attendees, conference data)
  // to the 2-5 KB each that overflowed, plus gog's localized fields.
  const rawEvent = (i: number) => {
    const day = 14 + (i % 5);
    const local = `2026-09-${day}T${String(8 + (i % 9)).padStart(2, "0")}:00:00-07:00`;
    return {
      kind: "calendar#event",
      id: `evt-${i}`,
      status: "confirmed",
      htmlLink: `https://www.google.com/calendar/event?eid=${"x".repeat(60)}${i}`,
      summary: `Meeting ${i}`,
      description: "Agenda. ".repeat(80),
      start: { dateTime: local, timeZone: "America/Sao_Paulo" },
      end: { dateTime: local, timeZone: "America/Sao_Paulo" },
      attendees: Array.from({ length: 8 }, (_, n) => ({ email: `person${n}@example.com`, responseStatus: "accepted" })),
      conferenceData: { entryPoints: [{ uri: `https://meet.google.com/${"abc-".repeat(20)}` }] },
      CalendarID: `cal-${i % ACCOUNTS.length}@group.calendar.google.com`,
      startDayOfWeek: DAYS[i % 5],
      startLocal: local,
      endDayOfWeek: DAYS[i % 5],
      endLocal: local,
      timezone: PACIFIC,
      account: ACCOUNTS[i % ACCOUNTS.length],
    };
  };

  it("renders a 63-event, 3-account week under the tool output limit, each with its own weekday", () => {
    const items = Array.from({ length: 63 }, (_, i) => rawEvent(i));
    expect(JSON.stringify(items).length).toBeGreaterThan(100_000);

    const { items: compact, truncated } = compactCalendarEvents(items);

    expect(truncated).toBeNull();
    expect(compact).toHaveLength(63);
    expect(JSON.stringify({ status: "completed", items: compact, degraded: [] }).length).toBeLessThan(50_000);
    compact.forEach((event, i) => {
      expect(event.startDayOfWeek).toBe(DAYS[i % 5]);
      expect(event.account).toBe(ACCOUNTS[i % ACCOUNTS.length]);
    });
    expect(compact[0]).toEqual({
      summary: "Meeting 0",
      startDayOfWeek: "Monday",
      startLocal: "2026-09-14T08:00:00-07:00",
      endLocal: "2026-09-14T08:00:00-07:00",
      calendarId: "cal-0@group.calendar.google.com",
      attendees: 8,
      id: "evt-0",
      account: "a@example.com",
    });
  });

  it("keeps an all-day date as its own day, and marks the ways an event leaves the owner free", () => {
    const { items } = compactCalendarEvents([
      {
        summary: "holiday",
        start: { date: "2026-09-16" },
        end: { date: "2026-09-17" },
        startDayOfWeek: "Wednesday",
        startLocal: "2026-09-16",
        endLocal: "2026-09-17",
        transparency: "transparent",
        attendees: [{ email: "me@example.com", self: true, responseStatus: "declined" }],
        account: "a",
      },
    ]);
    expect(items[0]).toEqual({
      summary: "holiday",
      startDayOfWeek: "Wednesday",
      startLocal: "2026-09-16",
      endLocal: "2026-09-17",
      allDay: true,
      attendees: 1,
      transparency: "transparent",
      declined: true,
      id: null,
      account: "a",
    });
  });

  const timed = (local: string, summary = "x".repeat(200)) => ({
    summary,
    start: { dateTime: local },
    startLocal: local,
    account: "a",
  });

  it("cuts by size, saying how many were dropped and from which start", () => {
    const items = Array.from({ length: 10 }, (_, i) =>
      timed(`2026-09-16T${String(8 + i).padStart(2, "0")}:00:00-07:00`),
    );
    const { items: kept, truncated } = compactCalendarEvents(items, 1_000);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(10);
    expect(JSON.stringify(kept).length).toBeLessThanOrEqual(1_000);
    expect(truncated).toEqual({
      omitted: 10 - kept.length,
      after: `2026-09-16T${String(8 + kept.length).padStart(2, "0")}:00:00-07:00`,
    });
  });

  it("reaches back to cover an all-day event that sorted after a timed one on its day", () => {
    // In Auckland the merge's UTC-midnight reading of an all-day 2026-09-16
    // falls at noon, after a 09:00 meeting that day — but the all-day event
    // covers the morning too.
    const items = [
      timed("2026-09-16T08:00:00+12:00"),
      timed("2026-09-16T09:00:00+12:00"),
      { summary: "offsite", start: { date: "2026-09-16" }, startLocal: "2026-09-16", account: "b" },
      timed("2026-09-16T13:00:00+12:00"),
    ];
    const { items: kept, truncated } = compactCalendarEvents(items, 700);
    expect(kept.map((k) => k.startLocal)).toEqual(["2026-09-16T08:00:00+12:00", "2026-09-16T09:00:00+12:00"]);
    expect(truncated).toEqual({ omitted: 2, after: "2026-09-16" });
  });
});

describe("freeBusyIntervals", () => {
  const BUSY = { start: "2026-09-18T22:30:00Z", end: "2026-09-18T23:00:00Z" };
  const OTHER = { start: "2026-09-18T21:00:00Z", end: "2026-09-18T21:30:00Z" };
  const ERRORED = { errors: [{ reason: "notFound" }] };

  it.each<{ why: string; output: unknown; expected: { start: string; end: string }[] | null }>([
    {
      why: "collects every calendar's busy spans",
      output: { primary: { busy: [BUSY] }, "luca@group.calendar.google.com": { busy: [OTHER] }, team: {} },
      expected: [BUSY, OTHER],
    },
    {
      why: "answers clear when every calendar answered with nothing",
      output: { primary: { busy: [] }, team: {} },
      expected: [],
    },
    {
      // A create must not proceed on a partial answer: the calendar that
      // failed is exactly where the commitment might be.
      why: "counts an account unchecked when ANY calendar failed to answer",
      output: { primary: { busy: [] }, "gone@group.calendar.google.com": ERRORED },
      expected: null,
    },
    { why: "counts an account unchecked when every calendar failed", output: { gone: ERRORED }, expected: null },
    { why: "rejects output with no calendars in it", output: {}, expected: null },
    { why: "rejects output that is not a calendar map at all", output: [], expected: null },
  ])("$why", ({ output, expected }) => {
    expect(freeBusyIntervals(output)).toEqual(expected);
  });
});

describe("bookableCalendar", () => {
  it("leaves out the holiday subscriptions nobody schedules around", () => {
    // Google refuses free/busy for these every time, and they hold no
    // commitment of the owner's — asking about them would make every
    // account unchecked and refuse every booking.
    expect(bookableCalendar("en.usa#holiday@group.v.calendar.google.com")).toBe(false);
    expect(bookableCalendar("plucas@plow.co")).toBe(true);
    expect(bookableCalendar("luca@group.calendar.google.com")).toBe(true);
  });
});

describe("conflictRefusal", () => {
  it("names the busy times per account, and never an event title", () => {
    const refusal = conflictRefusal(
      [
        { account: "a@example.com", busy: [{ start: "2026-09-18T22:30:00Z", end: "2026-09-18T23:00:00Z" }] },
        { account: "b@example.com", busy: [] },
      ],
      [],
    );
    expect(refusal).toContain("the slot is busy");
    expect(refusal).toContain("a@example.com: busy 2026-09-18T22:30:00Z-2026-09-18T23:00:00Z");
    expect(refusal).not.toContain("b@example.com");
    expect(refusal).toContain("--confirm-conflict");
  });

  it("clears a create only when every account answered with no busy time", () => {
    expect(conflictRefusal([{ account: "a@example.com", busy: [] }], [])).toBeNull();
    expect(conflictRefusal([{ account: "a@example.com", busy: [] }], [{ account: "b@example.com", reason: "needs_reauth" }]))
      .toContain("did not cover every account");
  });
});

describe("the Google Workspace skill", () => {
  it("says day names come from startDayOfWeek, and names the compact fields", () => {
    expect(GOG_SKILL.body).toContain("Take every day name you write from `startDayOfWeek`");
    expect(GOG_SKILL.body).toContain("To get the raw events,\npass `--select` or `--fields`");
    expect(GOG_SKILL.body).toContain("never work\nit out from the date yourself, and never from memory");
    for (const field of ["startDayOfWeek", "startLocal", "endLocal", "truncated: {omitted, after}"]) {
      expect(GOG_SKILL.body).toContain(field);
    }
  });

  // gog's conflicts verb pairs commitments across calendars and skips
  // same-calendar pairs, so an owner with one 2pm commitment gets an empty
  // result — read as free, once, for a real owner.
  it("sends an availability question to a busy-time read, not to the conflict verb", () => {
    expect(GOG_SKILL.body).toContain('**"Am I free at 2pm?" is a busy-time read, never a conflict check.**');
    expect(GOG_SKILL.body).toContain("calendar freebusy --cal <ids> --account <email>");
    expect(GOG_SKILL.body).toContain("calendar events --calendars <ids> --account <email>");
    expect(GOG_SKILL.body).toContain("skips two that overlap on the SAME one");
    expect(GOG_SKILL.body).toContain("two commitments on different accounts are never compared");
    // The page has to say what the gate does: it skips these before asking,
    // so an agent told to read "every shown calendar" would keep a hole the
    // gate does not have.
    expect(GOG_SKILL.body).toContain("Leave out the holiday subscriptions (ids ending\n`@group.v.calendar.google.com`)");
    expect(GOG_SKILL.body).toContain("shown calendar except those holiday subscriptions");
    expect(GOG_SKILL.body).toContain("not that the owner is free, and not even\nthat nothing is double-booked");
  });
});

/**
 * The plow-gog planner and merger — the pure half of the multi-account
 * orchestration. Offline by construction: no minting, no spawning, no account
 * list. `deviceAgent` consumes the plan; `providerExec.test.ts` covers that
 * seam.
 */
import { describe, expect, it } from "vitest";
import { mergeFanout, planPlowGog, type PlowGogPlan } from "../src/providers/plowGog.js";

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
      },
    },
    {
      why: "classifies through gog's own aliases but keeps the agent's spelling",
      argv: ["plow-gog", "mail", "search", "q"],
      expected: {
        kind: "fanout",
        gogArgv: ["plow-gog", "mail", "search", "q", "--json", "--results-only"],
        sort: "gmail-date",
      },
    },
    {
      why: "fans calendar events out, sorted by start",
      argv: ["plow-gog", "calendar", "events", "primary"],
      expected: {
        kind: "fanout",
        gogArgv: ["plow-gog", "calendar", "events", "primary", "--json", "--results-only"],
        sort: "cal-start",
      },
    },
    {
      why: "fans freebusy out with no sort",
      argv: ["plow-gog", "cal", "freebusy", "primary"],
      expected: {
        kind: "fanout",
        gogArgv: ["plow-gog", "cal", "freebusy", "primary", "--json", "--results-only"],
        sort: "none",
      },
    },
    {
      why: "fans conflicts out with no sort",
      argv: ["plow-gog", "calendar", "conflicts", "--from", "x", "--to", "y"],
      expected: {
        kind: "fanout",
        gogArgv: ["plow-gog", "calendar", "conflicts", "--from", "x", "--to", "y", "--json", "--results-only"],
        sort: "none",
      },
    },
    {
      why: "does not double a --json the agent already passed",
      argv: ["plow-gog", "gmail", "search", "q", "--json"],
      expected: {
        kind: "fanout",
        gogArgv: ["plow-gog", "gmail", "search", "q", "--json", "--results-only"],
        sort: "gmail-date",
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
        ],
        account: null,
        confirmConflict: false,
        conflictCheck: { from: "2026-08-28T10:00:00-07:00", to: "2026-08-28T11:00:00-07:00" },
      },
    },
    {
      why: "gates a timed update spelled with =",
      argv: ["plow-gog", "calendar", "update", "primary", "e1", "--from=2026-08-28T10:00:00Z", "--to=2026-08-28T11:00:00Z"],
      expected: {
        kind: "single",
        gogArgv: ["plow-gog", "calendar", "update", "primary", "e1", "--from=2026-08-28T10:00:00Z", "--to=2026-08-28T11:00:00Z"],
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
        gogArgv: ["plow-gog", "calendar", "create", "primary", "--summary", "X", "--from", "2026-08-28", "--to", "2026-08-29"],
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
        gogArgv: ["plow-gog", "calendar", "delete", "primary", "e1"],
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
    expect(planPlowGog(argv)).toEqual(expected);
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
      why: "refuses a --*-file flag by its rule label",
      argv: ["plow-gog", "gmail", "send", "--body-file", "/etc/passwd"],
      reason: "a --*-file flag",
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
  ])("$why", ({ argv, reason }) => {
    const plan = planPlowGog(argv);
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

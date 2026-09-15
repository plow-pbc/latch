/**
 * The iMessage SEND-VERIFICATION recipes, RUN.
 *
 * Reading moved to `plow-messages` (latch#167) and its recipes were deleted
 * with their tests; what is left here is the pair that answers "did my send
 * land?", which reads delivery bookkeeping rather than a message body and so
 * needs nothing the CLI provides.
 *
 * Same reasoning as `whatsappRecipes.test.ts` next to this file: "the body
 * contains this substring" cannot tell a working query from a broken one.
 * Every test here builds a chat.db-shaped database, runs the exact text the
 * agent is handed, and asserts on the rows that come back.
 *
 * What this does NOT cover, so nobody reads more into a green run than is
 * there: the schema below is one this file invents from a real
 * `pragma table_info` dump of a live chat.db (2026-08-28, macOS 14) — only
 * the columns the queries touch. The SQL semantics are executed; the column
 * NAMES are still only as good as that dump.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  IMESSAGE_CHAT_GUID_PLACEHOLDER,
  IMESSAGE_CHAT_ID_PLACEHOLDER,
  IMESSAGE_HANDLE_PLACEHOLDER,
  IMESSAGE_QUERIES,
  IMESSAGE_SEARCH_PHRASE_PLACEHOLDER,
  IMESSAGE_SNAPSHOT_ROWID_PLACEHOLDER,
} from "@domo/device-core";
import { makeEmptyStore, makeStore } from "./chatDbFixture.js";

const SQLITE = "/usr/bin/sqlite3";
/** Apple's epoch: message.date counts nanoseconds from here (2001-01-01). */
const CORE_DATA_EPOCH = 978307200;
/** Exact helper from the brief: seconds-ago to the nanosecond value message.date wants. */
const ns = (secsAgo: number): number =>
  (Math.floor(Date.now() / 1000) - secsAgo - CORE_DATA_EPOCH) * 1_000_000_000;

const dirs: string[] = [];
function tempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "domo-im-recipe-"));
  dirs.push(d);
  return d;
}

/**
 * Every child this file spawns goes through here, so the TZ pin has ONE owner.
 *
 * The recipes render dates with 'localtime', which means the machine's zone.
 * Left to the environment, an assertion on a rendered date passes or fails on
 * where the suite runs.
 */
function run(cmd: string, args: string[], opts: { cwd?: string } = {}): string {
  return execFileSync(cmd, args, {
    ...opts,
    encoding: "utf8",
    stdio: "pipe",
    env: { ...process.env, TZ: "UTC" },
  });
}

const sqlite = (args: string[], opts: { cwd?: string } = {}): string =>
  run(SQLITE, args, opts);

/**
 * Run SQL against a store and hand back the rows, split into cells.
 *
 * `-list` rather than the `-csv` the skill teaches an agent to use: csv quotes
 * any cell with a space in it, and unquoting here would be a second parser to
 * get wrong. The recipes under test are the SQL, not the output format.
 */
function query(store: string, sql: string): string[][] {
  const out = sqlite(["-readonly", "-list", store, sql]).trim();
  return out === "" ? [] : out.split("\n").map((line) => line.split("|"));
}

/**
 * A store shaped like chat.db: the four tables the skill names, seeded with
 * chats and messages that exercise each recipe's discriminating behavior.
 * Dates are computed relative to "now" with `ns()` because `gather` and
 * `unreplied` both filter on a 36h window measured off `strftime('%s','now')`.
 */
/** Shared across every test below; held apart from the per-test dirs. */
let store = "";
let storeDir = "";
beforeAll(() => {
  storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "domo-im-store-"));
  store = makeStore(storeDir);
});

const cleanup = (d: string): void => {
  fs.chmodSync(d, 0o755);
  fs.rmSync(d, { recursive: true, force: true });
};
afterEach(() => dirs.splice(0).forEach(cleanup));
afterAll(() => cleanup(storeDir));

describe("the send-verification recipes the skill publishes", () => {
  it("snapshots the newest outbound ROWID before a send", () => {
    const rows = query(store, IMESSAGE_QUERIES.verifySendSnapshot);
    // The highest ROWID among every is_from_me=1 row seeded above.
    expect(rows).toEqual([["4001"]]);
  });

  it("the snapshot on an empty archive is 0, not NULL (the first-ever send is verifiable)", () => {
    // probe 6: a fresh Mac has sent nothing, so `max(ROWID)` is NULL; without
    // the coalesce the substituted verifySend SQL would read `ROWID > ` and
    // fail to parse. coalesce(..., 0) gives a number the first send exceeds.
    const emptyDir = tempDir();
    const empty = makeEmptyStore(emptyDir);
    expect(query(empty, IMESSAGE_QUERIES.verifySendSnapshot)).toEqual([["0"]]);
  });

  /** Build the verifySend query with all three placeholders substituted. */
  const verifySendQuery = (snapshotRowid: number, handle: string, chatGuid: string): string =>
    IMESSAGE_QUERIES.verifySend
      .replace(IMESSAGE_SNAPSHOT_ROWID_PLACEHOLDER, String(snapshotRowid))
      .replace(`'${IMESSAGE_HANDLE_PLACEHOLDER}'`, `'${handle}'`)
      .replace(`'${IMESSAGE_CHAT_GUID_PLACEHOLDER}'`, `'${chatGuid}'`);

  it("verifies a send: newest outbound rows within the snapshot, is_sent/is_delivered/error as stored", () => {
    // Snapshot of 0 excludes nothing, so this is the "just sent, no older
    // history to confuse it with" case — the ordering + column contract.
    const rows = query(store, verifySendQuery(0, "verify@example.com", "no-such-chat-guid"));
    // limit 3 of 5 outbound rows at this handle, newest first (3010 is the
    // most recent by date); the newer INBOUND row (3005) never appears
    // despite postdating every outbound row.
    expect(rows.map((r) => Number(r[0]))).toEqual([3010, 3001, 3002]);
    // is_sent, is_delivered, error. The last two rows are why `error` has to
    // be in the recipe at all: 3002 and 3010 are indistinguishable on
    // is_delivered alone, and only one of them failed.
    expect(rows.map((r) => [r[0], r[1], r[3], r[4], r[5]])).toEqual([
      ["3010", "chat-guid-20", "0", "0", "22"], // failed: not reachable on the pinned service
      ["3001", "chat-guid-20", "1", "1", "0"], // sent and receipted
      ["3002", "chat-guid-20", "1", "0", "0"], // sent, no receipt back — NOT a failure
    ]);
  });

  it("verifySend probe-3 fix: a silently-failed send is never confirmed by an older success at the same handle", () => {
    // Snapshot taken right before the failed send (ROWID 3010) — its value
    // is the newest outbound ROWID that existed at that moment, 3004.
    const rows = query(store, verifySendQuery(3004, "verify@example.com", "no-such-chat-guid"));
    expect(rows.map((r) => Number(r[0]))).toEqual([3010]);
    expect(rows[0][3]).toBe("0"); // is_sent
    expect(rows[0][4]).toBe("0"); // is_delivered
    expect(rows[0][5]).toBe("22"); // error: the failure is recorded, not silent
    // None of the older, already-successful sends leak through as if they
    // confirmed this one.
    expect(rows.some((r) => Number(r[0]) <= 3004)).toBe(false);
  });

  it("verifySend probe-3 fix: a group send has no single handle, so it verifies by chat guid", () => {
    const rows = query(store, verifySendQuery(4000, "no-such-handle", "chat-guid-21"));
    expect(rows.map((r) => Number(r[0]))).toEqual([4001]);
    const [rowid, chatGuid, handle, isSent, isDelivered] = rows[0];
    expect(rowid).toBe("4001");
    expect(chatGuid).toBe("chat-guid-21");
    expect(handle).toBe(""); // no handle: a group send has no single participant
    expect(isSent).toBe("1");
    expect(isDelivered).toBe("1");
  });
});

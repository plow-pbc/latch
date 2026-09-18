/**
 * The iMessage recipes, RUN.
 *
 * Same reasoning as `whatsappRecipes.test.ts` next to this file: "the body
 * contains this substring" cannot tell a working query from a broken one.
 * Every test here builds a chat.db-shaped database, runs the exact text the
 * agent is handed, and asserts on the rows that come back.
 *
 * What this covers is narrower than it used to be: reads (recentChats,
 * gather, gatherChat, search, unreplied) moved to `plow-messages` (latch#167)
 * and are tested in that CLI's own repo. What remains here is the pair that
 * answers "did my send land?" — they read delivery bookkeeping, never a
 * message body, so a chat.db-shaped fixture is still the right tool.
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
  IMESSAGE_HANDLE_PLACEHOLDER,
  IMESSAGE_QUERIES,
  IMESSAGE_SNAPSHOT_ROWID_PLACEHOLDER,
  imessageStorePath,
} from "@domo/device-core";

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
 * the chats and messages `verifySend` needs. Dates are computed relative to
 * "now" with `ns()` so the fixture reads as a plausible timeline rather than
 * a sequence of arbitrary integers.
 */
/** The chat.db-shaped schema, from a real `pragma table_info` dump — only the
 *  columns the recipes touch. Shared so an empty store and a seeded one agree. */
const SCHEMA = [
  "create table handle (ROWID integer primary key, id text);",
  "create table chat (ROWID integer primary key, guid text, chat_identifier text," +
    " display_name text, style integer);",
  "create table message (ROWID integer primary key, guid text, text text," +
    " attributedBody blob, handle_id integer, date integer," +
    " is_from_me integer default 0, is_sent integer default 0," +
    " is_delivered integer default 0, error integer default 0," +
    " associated_message_type integer default 0," +
    " item_type integer default 0);",
  "create table chat_message_join (chat_id integer, message_id integer, message_date integer);",
];

/** A store with the schema and nothing in it — for the empty-archive cases. */
function makeEmptyStore(dir: string): string {
  const store = imessageStorePath(dir);
  fs.mkdirSync(path.dirname(store), { recursive: true });
  sqlite([store, SCHEMA.join(" ")]);
  return store;
}

function makeStore(dir: string): string {
  const home = dir;
  const store = imessageStorePath(home);
  fs.mkdirSync(path.dirname(store), { recursive: true });
  sqlite([
    store,
    [
      ...SCHEMA,

      // verifySend: 20 is the direct chat behind handle 300's outbound rows;
      // 21 is a group chat with no single participant to scope by handle.
      "insert into chat (ROWID, guid, chat_identifier, display_name, style)" +
        " values (20, 'chat-guid-20', '+15550009999', NULL, 45);",
      "insert into chat (ROWID, guid, chat_identifier, display_name, style)" +
        " values (21, 'chat-guid-21', 'chat88888888', 'Group Verify', 43);",

      "insert into handle (ROWID, id) values (300, 'verify@example.com');",

      // verifySend: four outbound rows for one handle (newest three are the
      // ones a `limit 3` should return) plus a newer INBOUND row that must
      // not appear despite being the most recent message for that handle.
      // All four (plus the failed send below) sit in chat 20.
      `insert into message (ROWID, handle_id, date, is_from_me, is_sent, is_delivered)` +
        ` values (3001, 300, ${ns(100)}, 1, 1, 1);`,
      `insert into message (ROWID, handle_id, date, is_from_me, is_sent, is_delivered)` +
        ` values (3002, 300, ${ns(200)}, 1, 1, 0);`,
      `insert into message (ROWID, handle_id, date, is_from_me, is_sent, is_delivered)` +
        ` values (3003, 300, ${ns(300)}, 1, 0, 0);`,
      `insert into message (ROWID, handle_id, date, is_from_me, is_sent, is_delivered)` +
        ` values (3004, 300, ${ns(400)}, 1, 1, 1);`,
      `insert into message (ROWID, handle_id, date, is_from_me)` +
        ` values (3005, 300, ${ns(50)}, 0);`,
      "insert into chat_message_join (chat_id, message_id) values (20, 3001);",
      "insert into chat_message_join (chat_id, message_id) values (20, 3002);",
      "insert into chat_message_join (chat_id, message_id) values (20, 3003);",
      "insert into chat_message_join (chat_id, message_id) values (20, 3004);",
      "insert into chat_message_join (chat_id, message_id) values (20, 3005);",

      // verifySend probe-3 fix, scenario (a): a NEWER send that FAILED
      // (is_sent=0) at ROWID 3010 — higher than every already-successful row
      // above (3001..3004). A snapshot taken right before this send (ROWID
      // 3004) must return ONLY 3010, never the older successful rows at the
      // same handle.
      //
      // error=22 is the real shape of this failure: an iMessage-pinned send
      // to a handle that is only reachable over SMS. It is what distinguishes
      // 3010 from 3002 below, which is a genuinely-sent message still waiting
      // on a delivery receipt (is_delivered=0, error=0).
      `insert into message (ROWID, handle_id, date, is_from_me, is_sent, is_delivered, error)` +
        ` values (3010, 300, ${ns(10)}, 1, 0, 0, 22);`,
      "insert into chat_message_join (chat_id, message_id) values (20, 3010);",

      // verifySend probe-3 fix, scenario (b): a group send has no single
      // handle (handle_id is NULL — "me" isn't a handle), so it must be
      // verifiable by chat guid alone.
      `insert into message (ROWID, handle_id, date, is_from_me, is_sent, is_delivered)` +
        ` values (4001, NULL, ${ns(10)}, 1, 1, 1);`,
      "insert into chat_message_join (chat_id, message_id) values (21, 4001);",
    ].join(" "),
  ]);
  return store;
}

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

describe("the imessage recipes the skill publishes", () => {
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

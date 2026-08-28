/**
 * The iMessage recipes, RUN.
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
import { IMESSAGE_HANDLE_PLACEHOLDER, IMESSAGE_QUERIES, imessageStorePath } from "@domo/device-core";

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
function makeStore(dir: string): string {
  const home = dir;
  const store = imessageStorePath(home);
  fs.mkdirSync(path.dirname(store), { recursive: true });
  sqlite([
    store,
    [
      "create table handle (ROWID integer primary key, id text);",
      "create table chat (ROWID integer primary key, guid text, chat_identifier text," +
        " display_name text, style integer);",
      "create table message (ROWID integer primary key, guid text, text text," +
        " attributedBody blob, handle_id integer, date integer," +
        " is_from_me integer default 0, is_sent integer default 0," +
        " is_delivered integer default 0," +
        " associated_message_type integer default 0," +
        " item_type integer default 0);",
      "create table chat_message_join (chat_id integer, message_id integer, message_date integer);",

      // Chats. 1/2 exist for the recentChats ordering + kind test; 3/4/5/6
      // for unreplied; 10 for gather. A chat_identifier starting with 'chat'
      // is how the real store marks a group; anything else is a direct chat.
      "insert into chat (ROWID, guid, chat_identifier, display_name, style)" +
        " values (1, 'chat-guid-1', '+15551111111', NULL, 45);",
      "insert into chat (ROWID, guid, chat_identifier, display_name, style)" +
        " values (2, 'chat-guid-2', 'chat9999999999', 'Group Two', 43);",
      "insert into chat (ROWID, guid, chat_identifier, display_name, style)" +
        " values (3, 'chat-guid-3', '+15552222222', NULL, 45);",
      "insert into chat (ROWID, guid, chat_identifier, display_name, style)" +
        " values (4, 'chat-guid-4', '+15553333333', NULL, 45);",
      "insert into chat (ROWID, guid, chat_identifier, display_name, style)" +
        " values (5, 'chat-guid-5', '+15554444444', NULL, 45);",
      "insert into chat (ROWID, guid, chat_identifier, display_name, style)" +
        " values (6, 'chat-guid-6', 'chat55555555', 'Group Six', 43);",
      "insert into chat (ROWID, guid, chat_identifier, display_name, style)" +
        " values (10, 'chat-guid-10', '+15559999999', NULL, 45);",

      "insert into handle (ROWID, id) values (100, '+15551111111');",
      "insert into handle (ROWID, id) values (101, 'sender-group@icloud.com');",
      "insert into handle (ROWID, id) values (102, '+15552222222');",
      "insert into handle (ROWID, id) values (103, '+15553333333');",
      "insert into handle (ROWID, id) values (104, '+15554444444');",
      "insert into handle (ROWID, id) values (105, 'sender-group2@icloud.com');",
      "insert into handle (ROWID, id) values (200, 'gather-sender@icloud.com');",
      "insert into handle (ROWID, id) values (300, 'verify@example.com');",

      // recentChats: chat 2 (group) is newer than chat 1 (direct).
      `insert into message (ROWID, handle_id, date, text, is_from_me)` +
        ` values (1001, 100, ${ns(5000)}, 'ok', 1);`,
      `insert into message (ROWID, handle_id, date, text, is_from_me)` +
        ` values (1002, 101, ${ns(1000)}, 'group hi', 0);`,
      "insert into chat_message_join (chat_id, message_id) values (1, 1001);",
      "insert into chat_message_join (chat_id, message_id) values (2, 1002);",

      // unreplied: newest outbound (chat 3) excluded, newest inbound direct
      // (chat 4) included, tapback-only (chat 5) excluded, newest inbound
      // GROUP (chat 6) excluded despite otherwise qualifying.
      `insert into message (ROWID, handle_id, date, text, is_from_me)` +
        ` values (1003, 102, ${ns(2000)}, 'sent it', 1);`,
      `insert into message (ROWID, handle_id, date, text, is_from_me)` +
        ` values (1004, 103, ${ns(3000)}, 'need reply', 0);`,
      `insert into message (ROWID, handle_id, date, text, is_from_me, associated_message_type)` +
        ` values (1005, 104, ${ns(4000)}, NULL, 0, 2000);`,
      `insert into message (ROWID, handle_id, date, text, is_from_me)` +
        ` values (1006, 105, ${ns(3500)}, 'group need reply', 0);`,
      "insert into chat_message_join (chat_id, message_id) values (3, 1003);",
      "insert into chat_message_join (chat_id, message_id) values (4, 1004);",
      "insert into chat_message_join (chat_id, message_id) values (5, 1005);",
      "insert into chat_message_join (chat_id, message_id) values (6, 1006);",

      // gather: two real in-window rows (2001 oldest, 2002 newest, 2002's
      // body only in attributedBody), a tapback (2003) and a group-event
      // (2004) excluded by type, and an out-of-window row (2005, >36h ago).
      `insert into message (ROWID, handle_id, date, text, is_from_me)` +
        ` values (2001, 200, ${ns(40000)}, 'gather older', 0);`,
      `insert into message (ROWID, handle_id, date, text, attributedBody, is_from_me)` +
        ` values (2002, 200, ${ns(10000)}, NULL, X'68656C6C6F', 0);`,
      `insert into message (ROWID, handle_id, date, text, is_from_me, associated_message_type)` +
        ` values (2003, 200, ${ns(9000)}, 'thumbs up', 0, 2000);`,
      `insert into message (ROWID, handle_id, date, text, is_from_me, item_type)` +
        ` values (2004, 200, ${ns(8000)}, 'Alice added Bob', 0, 1);`,
      `insert into message (ROWID, handle_id, date, text, is_from_me)` +
        ` values (2005, 200, ${ns(200000)}, 'too old', 0);`,
      "insert into chat_message_join (chat_id, message_id) values (10, 2001);",
      "insert into chat_message_join (chat_id, message_id) values (10, 2002);",
      "insert into chat_message_join (chat_id, message_id) values (10, 2003);",
      "insert into chat_message_join (chat_id, message_id) values (10, 2004);",
      "insert into chat_message_join (chat_id, message_id) values (10, 2005);",

      // verifySend: four outbound rows for one handle (newest three are the
      // ones a `limit 3` should return) plus a newer INBOUND row that must
      // not appear despite being the most recent message for that handle.
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
  it("lists chats newest first, and says which are groups", () => {
    const rows = query(store, IMESSAGE_QUERIES.recentChats);
    const chat1 = rows.findIndex((r) => r[1] === "chat-guid-1");
    const chat2 = rows.findIndex((r) => r[1] === "chat-guid-2");
    expect(chat1).toBeGreaterThanOrEqual(0);
    expect(chat2).toBeGreaterThanOrEqual(0);
    // chat 2's message is newer than chat 1's, so it sorts first.
    expect(chat2).toBeLessThan(chat1);
    expect(rows[chat2][2]).toBe("chat9999999999");
    expect(rows[chat2][5]).toBe("group");
    expect(rows[chat1][2]).toBe("+15551111111");
    expect(rows[chat1][5]).toBe("direct");
  });

  it("gathers real messages from the last 36h, oldest first, excluding tapbacks and group events and stale rows", () => {
    const rows = query(store, IMESSAGE_QUERIES.gather);
    // Column order: ROWID, chat_guid, sender, is_from_me, at, text, body_hex.
    const gathered = rows.filter((r) => r[1] === "chat-guid-10");
    expect(gathered.map((r) => Number(r[0]))).toEqual([2001, 2002]);
    // NULL text, real content only in attributedBody — the hex comes back exact.
    const nullTextRow = gathered.find((r) => Number(r[0]) === 2002);
    expect(nullTextRow?.[5]).toBe("");
    expect(nullTextRow?.[6]).toBe("68656C6C6F");
    // Tapback, group event, and the >36h-old row never show up at all.
    expect(rows.some((r) => Number(r[0]) === 2003)).toBe(false);
    expect(rows.some((r) => Number(r[0]) === 2004)).toBe(false);
    expect(rows.some((r) => Number(r[0]) === 2005)).toBe(false);
  });

  it("finds the unreplied set: inbound direct chats only, not outbound, not tapback-only, not group", () => {
    const rows = query(store, IMESSAGE_QUERIES.unreplied);
    const guids = rows.map((r) => r[0]);
    expect(guids).toContain("chat-guid-4"); // newest message inbound, direct
    expect(guids).not.toContain("chat-guid-3"); // newest message outbound
    expect(guids).not.toContain("chat-guid-5"); // only message is a tapback
    expect(guids).not.toContain("chat-guid-6"); // newest inbound, but a GROUP chat
  });

  it("verifies a send: newest outbound rows only, is_sent/is_delivered as stored", () => {
    const q = IMESSAGE_QUERIES.verifySend.replace(
      IMESSAGE_HANDLE_PLACEHOLDER,
      "verify@example.com",
    );
    const rows = query(store, q);
    // limit 3 of 4 outbound rows, newest first; the newer INBOUND row (3005)
    // never appears even though it postdates every outbound row.
    expect(rows.map((r) => Number(r[0]))).toEqual([3001, 3002, 3003]);
    expect(rows.map((r) => [r[1], r[2]])).toEqual([
      ["1", "1"],
      ["1", "0"],
      ["0", "0"],
    ]);
  });
});

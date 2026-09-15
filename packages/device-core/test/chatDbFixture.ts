/**
 * A chat.db-shaped store, shared by everything that has to run against one.
 *
 * Extracted from `imessageRecipes.test.ts`, which imports it back unchanged:
 * the SQL recipes and the `plow-messages` CLI are two readers of the same
 * store, and a schema that drifted between their two fixtures would let one
 * of them pass against a shape the other proves wrong.
 *
 * The schema is invented from a real `pragma table_info` dump of a live
 * chat.db — only the columns the queries touch. The SQL semantics are
 * executed; the column NAMES are only as good as that dump.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { imessageStorePath } from "@domo/device-core";

const SQLITE = "/usr/bin/sqlite3";
/** Apple's epoch: message.date counts nanoseconds from here (2001-01-01). */
const CORE_DATA_EPOCH = 978307200;
/** Seconds-ago to the nanosecond value message.date wants. */
const ns = (secsAgo: number): number =>
  (Math.floor(Date.now() / 1000) - secsAgo - CORE_DATA_EPOCH) * 1_000_000_000;

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));

/** A captured typedstream blob, as the hex literal `X'...'` wants it. */
const FIXTURE = (name: string): string =>
  fs.readFileSync(path.join(FIXTURES, name), "utf8").trim();

/** TZ pinned for the same reason the recipe suite pins it: a rendered date
 *  otherwise passes or fails on where the suite runs. */
const sqlite = (args: string[]): string =>
  execFileSync(SQLITE, args, { encoding: "utf8", stdio: "pipe", env: { ...process.env, TZ: "UTC" } });

/** The rowids the typedstream fixtures occupy, for a test that names them. */
export const FIXTURE_ROWS = { delivered: 6001, costco: 6002, tapback: 6003 } as const;

/** The chat.db-shaped schema, from a real `pragma table_info` dump — only the
 *  columns the recipes touch. Shared so an empty store and a seeded one agree. */
export const SCHEMA = [
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
export function makeEmptyStore(dir: string): string {
  const store = imessageStorePath(dir);
  fs.mkdirSync(path.dirname(store), { recursive: true });
  sqlite([store, SCHEMA.join(" ")]);
  return store;
}

export function makeStore(dir: string): string {
  const home = dir;
  const store = imessageStorePath(home);
  fs.mkdirSync(path.dirname(store), { recursive: true });
  sqlite([
    store,
    [
      ...SCHEMA,

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
      // verifySend: 20 is the direct chat behind handle 300's outbound rows;
      // 21 is a group chat with no single participant to scope by handle.
      "insert into chat (ROWID, guid, chat_identifier, display_name, style)" +
        " values (20, 'chat-guid-20', '+15550009999', NULL, 45);",
      "insert into chat (ROWID, guid, chat_identifier, display_name, style)" +
        " values (21, 'chat-guid-21', 'chat88888888', 'Group Verify', 43);",

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

      // search (latch#385): the phrase lives in `text` on a legacy row (5001),
      // ONLY in attributedBody on a modern row (5002, text NULL — the bytes
      // are a typedstream-shaped prefix WITH A NUL BYTE, then the phrase),
      // in a tapback that must be excluded by type (5003), and not at all in
      // a row that merely shares the chat (5004). 5002 is newer than 5001 so
      // newest-first ordering is observable.
      "insert into chat (ROWID, guid, chat_identifier, display_name, style)" +
        " values (30, 'chat-guid-30', 'chat30303030', 'Dinner Group', 43);",
      "insert into handle (ROWID, id) values (400, '+15625550000');",
      `insert into message (ROWID, handle_id, date, text, is_from_me)` +
        ` values (5001, 400, ${ns(7000)}, 'dinner at Palm Court still stands', 0);`,
      // hex: "streamtyped" 00 "NSString" 01 "No worries, false alarm — 9/14 dinner at Palm Court still stands."
      `insert into message (ROWID, handle_id, date, text, attributedBody, is_from_me)` +
        ` values (5002, 400, ${ns(6000)}, NULL, X'73747265616D7479706564004E53537472696E6701` +
        `4E6F20776F72726965732C2066616C736520616C61726D20E280942039` +
        `2F31342064696E6E65722061742050616C6D20436F757274207374696C6C207374616E64732E', 0);`,
      `insert into message (ROWID, handle_id, date, text, is_from_me, associated_message_type)` +
        ` values (5003, 400, ${ns(5000)}, 'Loved "dinner at Palm Court still stands"', 0, 2000);`,
      `insert into message (ROWID, handle_id, date, text, is_from_me)` +
        ` values (5004, 400, ${ns(4000)}, 'see you there', 0);`,
      // 5005: exercises the doubled-apostrophe substitution the prose teaches.
      `insert into message (ROWID, handle_id, date, text, is_from_me)` +
        ` values (5005, 400, ${ns(3000)}, 'can''t make it', 0);`,
      "insert into chat_message_join (chat_id, message_id) values (30, 5001);",
      "insert into chat_message_join (chat_id, message_id) values (30, 5002);",
      "insert into chat_message_join (chat_id, message_id) values (30, 5003);",
      "insert into chat_message_join (chat_id, message_id) values (30, 5004);",
      "insert into chat_message_join (chat_id, message_id) values (30, 5005);",

      // plow-messages: chat 40 carries REAL typedstream bodies, captured from
      // a live store (2026-09-14, macOS 26). Both have `text` NULL and both
      // embed NUL bytes before the NSString marker — the exact shape a
      // `text`-only query misses, which on that store is 84% of the last 90
      // days' messages (#385). 6003 is a tapback that must never surface.
      //
      // The two blobs are automated business notifications chosen for
      // carrying no name, address, amount or one-time code; a fixture is
      // committed, so what it decodes to is published.
      "insert into chat (ROWID, guid, chat_identifier, display_name, style)" +
        " values (40, 'chat-guid-40', 'chat40404040', 'Deliveries', 43);",
      "insert into handle (ROWID, id) values (500, '+12795550100');",
      "insert into handle (ROWID, id) values (501, '36246');",
      `insert into message (ROWID, handle_id, date, text, attributedBody, is_from_me)` +
        ` values (6001, 500, ${ns(3000)}, NULL, X'${FIXTURE("typedstream-order-delivered.hex")}', 0);`,
      `insert into message (ROWID, handle_id, date, text, attributedBody, is_from_me)` +
        ` values (6002, 501, ${ns(2000)}, NULL, X'${FIXTURE("typedstream-costco-delivery.hex")}', 0);`,
      `insert into message (ROWID, handle_id, date, text, is_from_me, associated_message_type)` +
        ` values (6003, 500, ${ns(1000)}, 'Loved an image', 0, 2000);`,
      "insert into chat_message_join (chat_id, message_id) values (40, 6001);",
      "insert into chat_message_join (chat_id, message_id) values (40, 6002);",
      "insert into chat_message_join (chat_id, message_id) values (40, 6003);",

      // A MALFORMED typedstream body (6004) and an attachment-only row with no
      // body at all (6005). Both are rows a reader must survive: a message
      // body is attacker-supplied — anyone who can text the owner chooses
      // these bytes — and before the ObjC shim 6004 aborted the whole process
      // rather than yielding one unreadable row.
      `insert into message (ROWID, handle_id, date, text, attributedBody, is_from_me)` +
        ` values (6004, 500, ${ns(2500)}, NULL, X'040b73747265616d747970656481e800FFFFFFFFFFFF', 0);`,
      `insert into message (ROWID, handle_id, date, text, is_from_me)` +
        ` values (6005, 500, ${ns(2400)}, NULL, 0);`,
      "insert into chat_message_join (chat_id, message_id) values (40, 6004);",
      "insert into chat_message_join (chat_id, message_id) values (40, 6005);",

      // chat 41: a direct chat whose newest real message is an ATTACHMENT with
      // no caption. `unreplied` selects exactly one row per chat, so a reader
      // that drops a bodiless row drops the whole chat — the owner is never
      // told a photo is waiting on them.
      "insert into chat (ROWID, guid, chat_identifier, display_name, style)" +
        " values (41, 'chat-guid-41', '+15557777777', NULL, 45);",
      "insert into handle (ROWID, id) values (502, '+15557777777');",
      `insert into message (ROWID, handle_id, date, text, is_from_me)` +
        ` values (6101, 502, ${ns(600)}, NULL, 0);`,
      "insert into chat_message_join (chat_id, message_id) values (41, 6101);",
    ].join(" "),
  ]);
  return store;
}

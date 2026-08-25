/**
 * The WhatsApp recipes, RUN.
 *
 * `skills.test.ts` asserts what the published body says; this asserts that
 * what it says works. Three defects in a row got through the first oracle — a
 * reversed sort, a projected sort key, a shell-quoting hole — because "the
 * body contains this substring" cannot tell a working query from a broken one.
 * Every test here builds a WhatsApp-shaped database, runs the exact text the
 * agent is handed, and asserts on the rows that come back.
 *
 * What this does NOT cover, so nobody reads more into a green run than is
 * there: the schema below is one this file invents. It matches a live
 * `pragma table_info` dump of a real ChatStorage.sqlite, but a column the real
 * store renames tomorrow is green here and broken on a Mac. The SQL semantics
 * are executed; the column NAMES are still only as good as that dump.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  WHATSAPP_CHAT_PLACEHOLDER,
  WHATSAPP_QUERIES,
  whatsappFallbackArgv,
} from "@domo/device-core";

const SQLITE = "/usr/bin/sqlite3";
/** Core Data counts from 2001-01-01; the skill's whole date story rests on it. */
const CORE_DATA_EPOCH = 978307200;

const dirs: string[] = [];
function tempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "domo-wa-recipe-"));
  dirs.push(d);
  return d;
}

/**
 * Run SQL against a store and hand back the rows, split into cells.
 *
 * `-list` rather than the `-csv` the skill teaches an agent to use: csv quotes
 * any cell with a space in it, and unquoting here would be a second parser to
 * get wrong. The recipes under test are the SQL, not the output format.
 */
function query(store: string, sql: string): string[][] {
  const out = execFileSync(SQLITE, ["-readonly", "-list", store, sql], {
    encoding: "utf8",
    // 'localtime' in the recipes means the machine's zone; without pinning it
    // here, a run east of UTC+3 renders the next day and the suite fails on
    // geography rather than on a defect.
    env: { ...process.env, TZ: "UTC" },
  }).trim();
  return out === "" ? [] : out.split("\n").map((line) => line.split("|"));
}

/**
 * A store shaped like WhatsApp's: the three tables the skill names, in WAL
 * mode like the real one, with sixty messages in one chat so the conversation
 * recipe's `limit 50` has something to cut.
 */
function makeStore(dir: string): string {
  const store = path.join(dir, "ChatStorage.sqlite");
  const at = (unix: number): number => unix - CORE_DATA_EPOCH;
  const base = 1700000000;
  const rows: string[] = [];
  // Sixty messages, oldest first, so "msg 60" is the newest thing said.
  for (let i = 1; i <= 60; i++) {
    const text = i === 7 ? "what about dinner tomorrow" : `msg ${i}`;
    rows.push(
      "insert into ZWAMESSAGE (ZMESSAGEDATE, ZTEXT, ZCHATSESSION, ZISFROMME) values(" +
        `${at(base + i * 60)}, '${text}', 1, ${i % 2});`,
    );
  }
  // A group message, whose sender is the joined member rather than the chat.
  rows.push(
    "insert into ZWAMESSAGE (ZMESSAGEDATE, ZTEXT, ZCHATSESSION, ZISFROMME, ZGROUPMEMBER)" +
      ` values(${at(base + 5000)}, 'from the club', 2, 0, 1);`,
  );
  execFileSync(
    SQLITE,
    [
      store,
      [
        "pragma journal_mode=wal;",
        "create table ZWACHATSESSION (Z_PK integer primary key, ZPARTNERNAME text," +
          " ZCONTACTJID text, ZLASTMESSAGEDATE integer);",
        "create table ZWAGROUPMEMBER (Z_PK integer primary key, ZCONTACTNAME text," +
          " ZMEMBERJID text, ZCHATSESSION integer);",
        "create table ZWAMESSAGE (ZMESSAGEDATE integer, ZTEXT text, ZCHATSESSION integer," +
          " ZISFROMME integer, ZGROUPMEMBER integer, ZPUSHNAME text);",
        `insert into ZWACHATSESSION values(1, 'Alice', '15551234@s.whatsapp.net', ${at(base + 3600)});`,
        `insert into ZWACHATSESSION values(2, 'Book Club', '99887@g.us', ${at(base + 5000)});`,
        "insert into ZWAGROUPMEMBER values(1, 'Bernard', '15559999@s.whatsapp.net', 2);",
        ...rows,
      ].join(" "),
    ],
    { encoding: "utf8" },
  );
  return store;
}

/** Shared across the read-only cases; held apart from the per-test dirs. */
let store = "";
let storeDir = "";
beforeAll(() => {
  storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "domo-wa-store-"));
  store = makeStore(storeDir);
});

const cleanup = (d: string): void => {
  // quiescentStore() drops write permission to reproduce the real failure.
  fs.chmodSync(d, 0o755);
  fs.rmSync(d, { recursive: true, force: true });
};
afterEach(() => dirs.splice(0).forEach(cleanup));
afterAll(() => cleanup(storeDir));

describe("the recipes the skill publishes", () => {
  it("lists chats newest first, and says which are groups", () => {
    const rows = query(store, WHATSAPP_QUERIES.recentChats);
    expect(rows.map((r) => r[0])).toEqual(["Book Club", "Alice"]);
    expect(rows.map((r) => r[2])).toEqual(["group", "direct"]);
    // The date column is the whole reason 978307200 is in the query: a wrong
    // offset here shows up as a year in the 1980s or the 2050s.
    expect(rows[1][1]).toBe("2023-11-14 23:13:20");
  });

  // The bug this catches: `order by ... desc limit 50` alone returns the newest
  // FIRST, and a single ascending sort returns the fifty OLDEST messages. Both
  // read as plausible SQL; only the rows tell you which one you wrote.
  it("hands back the newest fifty messages, oldest first", () => {
    const rows = query(store, WHATSAPP_QUERIES.conversation.replace(WHATSAPP_CHAT_PLACEHOLDER, "Alice"));
    expect(rows.length).toBe(50);
    // Sixty messages, the newest fifty are 11..60, and they read in order.
    expect(rows[0][2]).toBe("msg 11");
    expect(rows[rows.length - 1][2]).toBe("msg 60");
    // The sort key exists only to sort; projecting it puts a raw epoch integer
    // in every row beside the formatted timestamp.
    expect(rows[0].length).toBe(3);
    // ZISFROMME picks the side, and it is not always the same side.
    expect(new Set(rows.map((r) => r[1]))).toEqual(new Set(["me", "Alice"]));
  });

  it("names the group member as the sender, not the group", () => {
    const rows = query(store, WHATSAPP_QUERIES.conversation.replace(WHATSAPP_CHAT_PLACEHOLDER, "Book Club"));
    expect(rows).toEqual([[expect.stringMatching(/2023/), "Bernard", "from the club"]]);
  });

  // The helper above reads with -list because it has to parse the output. The
  // skill teaches -header -csv, and an agent runs THAT — so run it once, on
  // the recipe most likely to contain a comma, and check the header arrives
  // and the quoting holds.
  it("survives the -header -csv the skill actually teaches", () => {
    const out = execFileSync(
      SQLITE,
      ["-readonly", "-header", "-csv", store, WHATSAPP_QUERIES.search],
      { encoding: "utf8", env: { ...process.env, TZ: "UTC" } },
    ).trim();
    const [header, ...rest] = out.split("\n");
    expect(header).toBe("chat,at,ZTEXT");
    expect(rest).toEqual(['Alice,"2023-11-14 22:20:20","what about dinner tomorrow"']);
  });

  it("finds a word across chats", () => {
    const rows = query(store, WHATSAPP_QUERIES.search);
    expect(rows.length).toBe(1);
    expect(rows[0][0]).toBe("Alice");
    expect(rows[0][2]).toBe("what about dinner tomorrow");
  });
});

describe("the fallback for a store that will not open", () => {
  /** The real failure: a WAL store with no -shm, in a directory nobody may write. */
  function quiescentStore(): { store: string; dir: string } {
    const dir = tempDir();
    const s = makeStore(dir);
    for (const sib of ["-shm", "-wal"]) fs.rmSync(s + sib, { force: true });
    fs.chmodSync(dir, 0o555);
    return { store: s, dir };
  }

  it("reproduces the failure it exists for", () => {
    const { store: s } = quiescentStore();
    // Not an empty result — an error, which is why it gets misreported.
    expect(() => query(s, "select count(*) from ZWAMESSAGE;")).toThrow(
      /unable to open database file/,
    );
  });

  it("answers anyway, and leaves no copy of the archive behind", () => {
    const { store: s } = quiescentStore();
    const scratch = tempDir();
    // The query carries the single quotes every recipe has: a fallback that
    // pasted it into the script string would be re-split into words here.
    const argv = whatsappFallbackArgv(
      s,
      "select datetime(max(ZMESSAGEDATE) + 978307200, 'unixepoch', 'localtime'), count(*) from ZWAMESSAGE;",
    );
    const out = execFileSync(argv[0], argv.slice(1), { cwd: scratch, encoding: "utf8" });
    expect(out).toContain("2023-11-");
    expect(out.trim().split("\n").pop()).toMatch(/,61$/);
    // The owner's whole message history was in that directory a moment ago.
    // Nothing else on this Mac deletes a scratch dir, so the command must.
    expect(fs.readdirSync(scratch)).toEqual([]);
  });

  it("reads what is still in the write-ahead log, not just the checkpointed file", () => {
    const dir = tempDir();
    const s = makeStore(dir);
    // A message that exists only in the -wal, as the newest ones do while
    // WhatsApp is running. Copying the main file alone would miss it.
    execFileSync(SQLITE, [
      s,
      "insert into ZWAMESSAGE (ZMESSAGEDATE, ZTEXT, ZCHATSESSION, ZISFROMME)" +
        " values(999999999, 'still in the wal', 1, 0);",
    ]);
    expect(fs.existsSync(s + "-wal")).toBe(true);

    const argv = whatsappFallbackArgv(s, "select ZTEXT from ZWAMESSAGE where ZMESSAGEDATE = 999999999;");
    const out = execFileSync(argv[0], argv.slice(1), { cwd: tempDir(), encoding: "utf8" });
    expect(out).toContain("still in the wal");
  });
});

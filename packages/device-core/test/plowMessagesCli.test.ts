/**
 * plow-messages, RUN.
 *
 * The built Swift CLI against a chat.db-shaped store whose modern rows carry
 * REAL typedstream bodies captured from a live archive. This is the suite that
 * would have caught #385: every assertion here is on a row whose `text` column
 * is NULL, which is the shape a hand-written `select ... from message where
 * text like ?` reports as "no such message".
 *
 * Mac-only because the binary is Swift and the build is the repo's own
 * build-native step (stamped, so a warm checkout does not recompile).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeStore } from "./chatDbFixture.js";

const ON_MAC = process.platform === "darwin";
const itMac = it.skipIf(!ON_MAC);
const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const BIN = path.join(REPO, "vendor/providers/plow-messages", process.arch, "plow-messages");

/** What the two captured blobs decode to. Asserted rather than described: the
 *  decode is the whole point of the CLI existing. */
const DELIVERED = "Your order was delivered! Thank you for ordering from Super Duper Burgers.";
const COSTCO =
  "Your Costco order will arrive shortly! Your shopper will follow any instructions you may have left for delivery.";

let store = "";

beforeAll(() => {
  if (!ON_MAC) return;
  if (!fs.existsSync(BIN)) {
    execFileSync("node", [path.join(REPO, "apps/desktop/scripts/build-native.mjs")], {
      stdio: "inherit",
    });
  }
  store = makeStore(fs.mkdtempSync(path.join(os.tmpdir(), "plow-messages-")));
}, 120_000);

type Row = Record<string, string | number | boolean | null>;

/** Run the CLI and parse its JSON Lines, or report how it refused. TZ is
 *  pinned for the same reason the recipe suite pins it: `at` renders in this
 *  Mac's zone, and an assertion on it otherwise passes or fails on where the
 *  suite runs. */
function cli(...args: string[]): { rows: Row[]; stdout: string; stderr: string; code: number } {
  try {
    const out = execFileSync(BIN, ["--store", store, ...args], {
      encoding: "utf8",
      env: { ...process.env, TZ: "UTC" },
    });
    const lines = out.trim() === "" ? [] : out.trim().split("\n");
    const rows = out.startsWith("{") ? lines.map((l) => JSON.parse(l) as Row) : [];
    return { rows, stdout: out, stderr: "", code: 0 };
  } catch (e) {
    const err = e as { status: number; stderr: string; stdout: string };
    return { rows: [], stdout: String(err.stdout ?? ""), stderr: String(err.stderr), code: err.status };
  }
}

describe("plow-messages search", () => {
  itMac("decodes a typedstream body whose text column is NULL — the #385 row shape", () => {
    const { rows } = cli("search", "Super Duper");
    expect(rows.map((r) => r.rowid)).toEqual([6001]);
    expect(rows[0].body).toBe(DELIVERED);
  });

  itMac("matches literally and case-insensitively for ASCII", () => {
    expect(cli("search", "COSTCO").rows.map((r) => r.body)).toEqual([COSTCO]);
    expect(cli("search", "costco").rows.map((r) => r.body)).toEqual([COSTCO]);
  });

  itMac("treats the phrase as a substring, never as a pattern", () => {
    // `%` and `_` are SQL LIKE wildcards and `.*` is a regex: a CLI that
    // leaked any of them through would match both fixture rows here.
    for (const pattern of ["%order%", "order_", ".*order.*"]) {
      expect(cli("search", pattern).rows, `"${pattern}" matched as a pattern`).toEqual([]);
    }
  });

  itMac("orders newest first by default and oldest first on --order asc", () => {
    // 6001 is older than 6002; both bodies contain "order".
    expect(cli("search", "order").rows.map((r) => r.rowid)).toEqual([6002, 6001]);
    expect(cli("search", "order", "--order", "asc").rows.map((r) => r.rowid)).toEqual([6001, 6002]);
  });

  itMac("never surfaces a tapback, whose body reads like a message", () => {
    // 6003 is `associated_message_type = 2000` and its text is "Loved an
    // image" — a row an agent would otherwise report as something someone
    // said.
    expect(cli("search", "Loved").rows).toEqual([]);
  });

  itMac("carries the chat and sender a reply would need", () => {
    const row = cli("search", "Costco").rows[0];
    expect(row).toMatchObject({
      chat_guid: "chat-guid-40",
      chat_identifier: "chat40404040",
      display_name: "Deliveries",
      sender: "36246",
      is_from_me: false,
    });
    expect(String(row.at)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/);
  });

  itMac("says nothing rather than something wrong when the archive has no such row", () => {
    const { rows, code } = cli("search", "nothing in this archive says this");
    expect(rows).toEqual([]);
    // Zero rows is a SUCCESS: an empty archive answer and a failed read must
    // not look alike to a caller that only checks the exit code.
    expect(code).toBe(0);
  });

  itMac.each([
    // The filters that scope a search, each asserted by what it EXCLUDES —
    // a filter that silently passes everything looks identical to one that
    // works when only the included row is checked.
    { name: "--chat-id", args: ["--chat-id", "40"], expect: [6002, 6001] },
    { name: "--chat-id elsewhere", args: ["--chat-id", "1"], expect: [] },
    { name: "--after-rowid", args: ["--after-rowid", "6001"], expect: [6002] },
  ])("scopes a search with $name", ({ args, expect: rowids }) => {
    expect(cli("search", "order", ...args).rows.map((r) => r.rowid)).toEqual(rowids);
  });

  itMac("bounds a search by date, excluding what falls outside the window", () => {
    // 6001 is ~3000s old and 6002 ~2000s; a boundary between them must keep
    // one and drop the other, in both directions.
    const between = new Date(Date.now() - 2500 * 1000).toISOString().replace(/\.\d+Z$/, "Z");
    expect(cli("search", "order", "--after", between).rows.map((r) => r.rowid)).toEqual([6002]);
    expect(cli("search", "order", "--before", between).rows.map((r) => r.rowid)).toEqual([6001]);
  });

  itMac("browses a chat with no phrase at all, bodiless rows included", () => {
    // The no-phrase path is a SEPARATE branch from the phrase match, and it is
    // where a bodiless row has to appear: with nothing to match against, a
    // reader that still required a decoded body would hand back a chat with
    // holes in it. Newest first, tapback excluded.
    const rows = cli("search", "--chat-id", "40").rows;
    expect(rows.map((r) => r.rowid)).toEqual([6002, 6005, 6004, 6001]);
    expect(rows.filter((r) => r.body === null).map((r) => r.rowid)).toEqual([6005, 6004]);
  });

  itMac("honours --limit and --handle", () => {
    expect(cli("search", "order", "--limit", "1").rows.map((r) => r.rowid)).toEqual([6002]);
    expect(cli("search", "order", "--handle", "36246").rows.map((r) => r.rowid)).toEqual([6002]);
  });
});

describe("plow-messages and a body it cannot read", () => {
  itMac("survives a malformed typedstream blob instead of aborting the process", () => {
    // Before the ObjC shim in plow-messages-bridge.h, NSUnarchiver RAISED on
    // this blob and the uncaught NSException killed the process — so one
    // crafted message, from anyone who can text the owner, broke every query
    // that touched its row. The whole thread still has to come back.
    const { rows, code } = cli("thread", "--chat-id", "40");
    expect(code).toBe(0);
    expect(rows.map((r) => r.rowid)).toContain(6004);
    expect(rows.find((r) => r.rowid === 6004)?.body).toBeNull();
  });

  itMac("reports an attachment-only row as a message with no body, not as no message", () => {
    expect(cli("thread", "--chat-id", "40").rows.find((r) => r.rowid === 6005)?.body).toBeNull();
  });

  itMac("still names a chat whose newest message is an attachment as unreplied", () => {
    // The silent omission this CLI exists to end, relocated: `unreplied`
    // selects exactly ONE row per chat, so dropping a bodiless row would take
    // the entire chat out of the answer.
    expect(cli("unreplied").rows.map((r) => r.chat_guid)).toContain("chat-guid-41");
  });

  itMac("never lets an undecodable body match a phrase", () => {
    expect(cli("search", "streamtyped").rows).toEqual([]);
  });
});

describe("plow-messages thread", () => {
  itMac("reads oldest first and drops the tapback", () => {
    const rows = cli("thread", "--chat-id", "40").rows;
    // Oldest first, the tapback (6003) gone, and the two unreadable rows
    // (6004 malformed, 6005 attachment-only) still present in their places —
    // a thread with a hole in it reads as a conversation that did not happen.
    expect(rows.map((r) => r.rowid)).toEqual([6001, 6004, 6005, 6002]);
    expect(rows.map((r) => r.body)).toEqual([DELIVERED, null, null, COSTCO]);
  });

  itMac("finds the chat from a handle, so an agent never has to guess a chat id", () => {
    expect(cli("thread", "--handle", "36246").rows.map((r) => r.rowid)).toEqual([6001, 6004, 6005, 6002]);
  });

  itMac("refuses without a chat or a handle rather than reading every chat", () => {
    const { code, stderr } = cli("thread");
    expect(code).toBe(2);
    expect(stderr).toContain("--chat-id");
  });
});

describe("plow-messages chats", () => {
  itMac("names each chat's kind and the guid a send targets", () => {
    const rows = cli("chats").rows;
    const deliveries = rows.find((r) => r.chat_id === 40);
    expect(deliveries).toMatchObject({ guid: "chat-guid-40", kind: "group", display_name: "Deliveries" });
    // A chat_identifier that does not start with `chat` is a direct message.
    expect(rows.find((r) => r.chat_id === 1)).toMatchObject({ kind: "direct" });
  });
});

describe("plow-messages unreplied", () => {
  itMac("lists a direct chat awaiting a reply and no group chat", () => {
    const guids = cli("unreplied").rows.map((r) => r.chat_guid);
    // chat 4's newest real row is inbound text; chat 10's and chat 41's are
    // inbound with NO readable body (a non-typedstream blob and an attachment)
    // — all three are awaiting a reply, and a reader that required a decoded
    // body reported only the first.
    expect(new Set(guids)).toEqual(new Set(["chat-guid-4", "chat-guid-10", "chat-guid-41"]));
    // chat 3's newest is outbound, chat 5's is a tapback over an outbound, and
    // chat 6 is a group — none qualify.
    for (const excluded of ["chat-guid-3", "chat-guid-5", "chat-guid-6"]) {
      expect(guids).not.toContain(excluded);
    }
  });
});

describe("plow-messages contract", () => {
  itMac("prints its own contract on --help, which is what the skill points at", () => {
    const { stdout, code } = cli("--help");
    expect(code).toBe(0);
    for (const subcommand of ["search", "thread", "chats", "unreplied"]) {
      expect(stdout).toContain(subcommand);
    }
    expect(stdout).toContain("untrusted input");
  });

  itMac("refuses an unknown option rather than silently widening the answer", () => {
    const { code, stderr } = cli("search", "--sql", "select 1");
    expect(code).toBe(2);
    expect(stderr).toContain("unknown option");
  });

  itMac("exits 1, not 2, when the store cannot be read", () => {
    // The two failures have different remedies — a usage error is the
    // caller's, an unreadable store is usually a missing Full Disk Access
    // grant — so they must not share an exit code.
    const missing = path.join(os.tmpdir(), "plow-messages-absent", "chat.db");
    try {
      execFileSync(BIN, ["--store", missing, "chats"], { encoding: "utf8" });
      expect.unreachable("reading an absent store should fail");
    } catch (e) {
      const err = e as { status: number; stderr: string };
      expect(err.status).toBe(1);
      expect(err.stderr).toContain("Full Disk Access");
    }
  });
});

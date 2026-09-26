/**
 * A message send is one script and one store check.
 *
 * The body rides in argv. A display name never becomes a recipient. WhatsApp
 * is refused before any keystroke when Accessibility is not granted. Zero
 * new rows, or more than one, is unverified, and the script is not run again.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  canonicalRecipient,
  imessageScript,
  imessageVerifySql,
  IMESSAGE_PARTICIPANT_SCRIPT,
  parseOutbound,
  performMessageSend,
  RECIPIENT_NOT_A_HANDLE,
  verifyOutcome,
  whatsappOpenUrl,
  whatsappSnapshotSql,
  whatsappVerifySql,
  WHATSAPP_SCRIPT,
  type MessageSendDeps,
  type MessageSendRequest,
} from "@domo/device-core";

function harness(opts: {
  snapshot?: string;
  listed?: string;
  snapshotThrows?: boolean;
  verifyThrows?: boolean;
  exitCode?: number | null;
  stderr?: string;
}): { deps: MessageSendDeps; scripts: number } {
  let scripts = 0;
  const deps: MessageSendDeps = {
    query: async (sql) => {
      if (sql.includes("coalesce(max")) {
        if (opts.snapshotThrows) throw new Error("sqlite down");
        return opts.snapshot ?? "4";
      }
      if (opts.verifyThrows) throw new Error("sqlite down");
      return opts.listed ?? "";
    },
    runScript: async () => {
      scripts += 1;
      return { exitCode: opts.exitCode ?? 0, stderr: opts.stderr ?? "" };
    },
    audit: () => {},
  };
  return {
    deps,
    get scripts() {
      return scripts;
    },
  };
}

const imessage = (over: Partial<MessageSendRequest> = {}): MessageSendRequest => ({
  intentId: "i1",
  app: "imessage",
  recipient: "ada@example.com",
  body: "hello",
  accessibility: "granted",
  ...over,
});

describe("canonicalRecipient", () => {
  it("keeps a phone, an email, a chat guid, and a jid, and drops a display name", () => {
    expect(canonicalRecipient("imessage", " +1 (415) 555-0100 ")).toBe("+14155550100");
    expect(canonicalRecipient("imessage", "Ada@Example.com")).toBe("ada@example.com");
    expect(canonicalRecipient("imessage", "any;-;+14155550100")).toBe("any;-;+14155550100");
    expect(canonicalRecipient("whatsapp", "14155550100@s.whatsapp.net")).toBe("14155550100@s.whatsapp.net");
    expect(canonicalRecipient("whatsapp", "+1 415 555 0100")).toBe("14155550100@s.whatsapp.net");
    expect(canonicalRecipient("whatsapp", "120363123@g.us")).toBe("120363123@g.us");
    expect(canonicalRecipient("imessage", "Ada Lovelace")).toBeNull();
    expect(canonicalRecipient("whatsapp", "Ada")).toBeNull();
    expect(RECIPIENT_NOT_A_HANDLE).not.toMatch(/Ada/);
  });
});

describe("verifyOutcome", () => {
  it("accepts exactly one successful row", () => {
    expect(verifyOutcome([{ rowid: 1, chat: "c", sent: false }, { rowid: 2, chat: "c", sent: true }])).toEqual({
      verified: true,
      row: { rowid: 2, chat: "c", sent: true },
    });
    expect(verifyOutcome([])).toEqual({ verified: false, reason: "none" });
    expect(
      verifyOutcome([
        { rowid: 1, chat: "c", sent: true },
        { rowid: 2, chat: "c", sent: true },
      ]),
    ).toEqual({ verified: false, reason: "many" });
  });
});

describe("performMessageSend", () => {
  it("reads is_sent, not the handle column, and puts the body in argv", async () => {
    const calls: { script: string; args: readonly string[] }[] = [];
    const deps: MessageSendDeps = {
      query: async (sql) => (sql.includes("coalesce(max") ? "4" : "9|iMessage;-;ada@example.com|ada@example.com|1|0|0|now"),
      runScript: async (script, args) => {
        calls.push({ script, args });
        return { exitCode: 0, stderr: "" };
      },
      audit: () => {},
    };
    const result = await performMessageSend(imessage({ body: 'say "hi"' }), deps);
    expect(result).toMatchObject({ status: "verified", row: { rowid: 9, chat: "iMessage;-;ada@example.com" } });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.script).toBe(IMESSAGE_PARTICIPANT_SCRIPT);
    expect(calls[0]?.args).toEqual(['say "hi"', "ada@example.com"]);
    expect(calls[0]?.script).not.toContain('say "hi"');
    expect(imessageScript("any;-;chat")).not.toBe(IMESSAGE_PARTICIPANT_SCRIPT);
  });

  it("a failed outbound row is unverified, and the script still ran once", async () => {
    const h = harness({ listed: "9|chat|ada@example.com|0|0|22|now" });
    const result = await performMessageSend(imessage(), h.deps);
    expect(result).toMatchObject({ status: "unverified", reason: "none" });
    expect(h.scripts).toBe(1);
    expect(parseOutbound("9|chat|ada@example.com|0|0|22|now", false)[0]?.sent).toBe(false);
  });

  it("does not send when the snapshot cannot be read", async () => {
    const h = harness({ snapshot: "nope" });
    const result = await performMessageSend(imessage(), h.deps);
    expect(result).toMatchObject({ status: "error" });
    expect(h.scripts).toBe(0);
  });

  it("stays unverified when the check itself fails, without a second script", async () => {
    const h = harness({ verifyThrows: true, exitCode: 0 });
    const result = await performMessageSend(imessage(), h.deps);
    expect(result).toMatchObject({ status: "unverified", reason: "none", script_exit: 0 });
    expect(h.scripts).toBe(1);
  });

  it("refuses WhatsApp before any keystroke when Accessibility is not granted", async () => {
    const h = harness({});
    const result = await performMessageSend(
      imessage({ app: "whatsapp", recipient: "14155550100@s.whatsapp.net", accessibility: "denied" }),
      h.deps,
    );
    expect(result).toMatchObject({ status: "blocked", host_gate: "accessibility" });
    expect(String(result.error)).not.toMatch(/Ada|1415/);
    expect(h.scripts).toBe(0);
  });

  it("opens the chat from the jid and treats one new from-me row as verified", async () => {
    const calls: { script: string; args: readonly string[] }[] = [];
    const deps: MessageSendDeps = {
      query: async (sql) => (sql.includes("coalesce(max") ? "3" : "8|14155550100@s.whatsapp.net|1"),
      runScript: async (script, args) => {
        calls.push({ script, args });
        return { exitCode: 0, stderr: "" };
      },
      audit: () => {},
    };
    const result = await performMessageSend(
      imessage({ app: "whatsapp", recipient: "14155550100@s.whatsapp.net", body: "on my way" }),
      deps,
    );
    expect(result).toMatchObject({ status: "verified", row: { rowid: 8 } });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.script).toBe(WHATSAPP_SCRIPT);
    expect(calls[0]?.args[1]).toBe(whatsappOpenUrl("14155550100@s.whatsapp.net"));
    expect(calls[0]?.args[1]).toBe("whatsapp://send?phone=14155550100");
    expect(whatsappOpenUrl("120363123@g.us")).toBe("whatsapp://send?jid=120363123@g.us");
    expect(calls[0]?.script).not.toContain("on my way");
  });

  it("a -1719 after the script is Accessibility, and it is not tried again", async () => {
    const h = harness({
      listed: "",
      exitCode: 1,
      stderr: "execution error: not allowed assistive access. (-1719)",
    });
    const result = await performMessageSend(
      imessage({ app: "whatsapp", recipient: "14155550100@s.whatsapp.net" }),
      h.deps,
    );
    expect(result).toMatchObject({ status: "blocked", host_gate: "accessibility" });
    expect(h.scripts).toBe(1);
  });
});

function sqliteList(db: string, sql: string): string {
  return execFileSync("/usr/bin/sqlite3", ["-readonly", "-list", db, sql], { encoding: "utf8" });
}

describe("verify SQL against a real sqlite -list", () => {
  it("reads a successful iMessage row and ignores a later failure and a CR on the error cell", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "domo-send-im-"));
    const db = path.join(dir, "chat.db");
    const schema = [
      "create table handle (ROWID integer primary key, id text);",
      "create table chat (ROWID integer primary key, guid text);",
      "create table message (ROWID integer primary key, handle_id integer, date integer, is_from_me integer, is_sent integer, is_delivered integer, error integer);",
      "create table chat_message_join (chat_id integer, message_id integer);",
      "insert into handle (ROWID, id) values (1, 'ada@example.com');",
      "insert into chat (ROWID, guid) values (1, 'iMessage;-;ada@example.com');",
      "insert into chat (ROWID, guid) values (2, 'iMessage;+;chatgroup');",
      "insert into message values (4, 1, 1, 1, 1, 1, 0);",
      "insert into message values (9, 1, 2, 1, 1, 0, 0);",
      "insert into message values (10, 1, 3, 1, 0, 0, 22);",
      "insert into message values (11, NULL, 4, 1, 1, 1, 0);",
      "insert into chat_message_join values (1, 4);",
      "insert into chat_message_join values (1, 9);",
      "insert into chat_message_join values (1, 10);",
      "insert into chat_message_join values (2, 11);",
    ].join(" ");
    execFileSync("/usr/bin/sqlite3", [db, schema]);
    const listed = sqliteList(db, imessageVerifySql(4, "ada@example.com"));
    const rows = parseOutbound(listed, false);
    expect(rows.filter((r) => r.sent).map((r) => r.rowid)).toEqual([9]);
    expect(rows.find((r) => r.rowid === 10)?.sent).toBe(false);
    const group = parseOutbound(sqliteList(db, imessageVerifySql(4, "iMessage;+;chatgroup")), false);
    expect(group.filter((r) => r.sent).map((r) => r.rowid)).toEqual([11]);
    expect(parseOutbound("9|iMessage;-;ada@example.com|ada@example.com|1|0|0\r|now", false)[0]?.sent).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("counts one new WhatsApp from-me row and not an older one or another chat", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "domo-send-wa-"));
    const db = path.join(dir, "ChatStorage.sqlite");
    const schema = [
      "create table ZWACHATSESSION (Z_PK integer primary key, ZCONTACTJID text);",
      "create table ZWAMESSAGE (ZCHATSESSION integer, ZISFROMME integer);",
      "insert into ZWACHATSESSION values (1, '14155550100@s.whatsapp.net');",
      "insert into ZWACHATSESSION values (2, '19998887777@s.whatsapp.net');",
      "insert into ZWAMESSAGE (rowid, ZCHATSESSION, ZISFROMME) values (3, 1, 1);",
      "insert into ZWAMESSAGE (rowid, ZCHATSESSION, ZISFROMME) values (8, 1, 1);",
      "insert into ZWAMESSAGE (rowid, ZCHATSESSION, ZISFROMME) values (9, 1, 0);",
      "insert into ZWAMESSAGE (rowid, ZCHATSESSION, ZISFROMME) values (10, 2, 1);",
    ].join(" ");
    execFileSync("/usr/bin/sqlite3", [db, schema]);
    const before = Number(sqliteList(db, whatsappSnapshotSql()).trim());
    expect(before).toBe(10);
    const listed = sqliteList(db, whatsappVerifySql(3, "14155550100@s.whatsapp.net"));
    const rows = parseOutbound(listed, true);
    expect(rows.map((r) => r.rowid)).toEqual([8]);
    expect(verifyOutcome(rows)).toMatchObject({ verified: true, row: { rowid: 8 } });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

/** The irreversible app boundary is replaced; SQL fixtures use native sqlite. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  canonicalRecipient, imessageScript, imessageVerifySql, IMESSAGE_PARTICIPANT_SCRIPT,
  parseOutbound, performMessageSend, RECIPIENT_NOT_A_HANDLE, verifyOutcome,
  whatsappOpenUrl, whatsappSnapshotSql, whatsappVerifySql, WHATSAPP_SCRIPT,
  type MessageSendDeps, type MessageSendRequest, type OutboundRow,
} from "@domo/device-core";

const hex = (value: string) => Buffer.from(value, "utf8").toString("hex");
const row = (over: Partial<OutboundRow> = {}): OutboundRow => ({
  rowid: 9, chatId: 1, chat: "iMessage;-;ada@example.com", sent: true,
  body: "hello", needsDecodedBody: false, attributedBodyHex: "", messageId: "message-9", ...over,
});
const listed = (r = row()): string => [
  r.rowid, hex(r.chat), Number(r.sent), Number(r.body !== null), hex(r.body ?? ""),
  Number(r.needsDecodedBody), hex(r.messageId), r.chatId, r.attributedBodyHex,
].join("|");
const imessage = (over: Partial<MessageSendRequest> = {}): MessageSendRequest => ({
  intentId: "i1", app: "imessage", recipient: "ada@example.com", body: "hello",
  accessibility: "granted", ...over,
});

function harness(over: Partial<MessageSendDeps> = {}) {
  return {
    query: vi.fn(async (sql: string) => sql.includes("coalesce(max") ? "4" : listed()),
    runScript: vi.fn(async () => ({ exitCode: 0, stderr: "" })),
    audit: vi.fn(),
    ...over,
  } satisfies MessageSendDeps;
}

async function perform(req: MessageSendRequest, deps: MessageSendDeps) {
  const pending = performMessageSend(req, deps);
  await vi.advanceTimersByTimeAsync(5_000);
  return pending;
}

afterEach(() => vi.useRealTimers());

describe("canonicalRecipient", () => {
  it("canonicalizes handles but refuses display names", () => {
    expect(canonicalRecipient("imessage", " +1 (415) 555-0100 ")).toBe("+14155550100");
    expect(canonicalRecipient("imessage", "Ada@Example.com")).toBe("ada@example.com");
    expect(canonicalRecipient("imessage", "any;-;+14155550100")).toBe("any;-;+14155550100");
    expect(canonicalRecipient("whatsapp", "+1 415 555 0100")).toBe("14155550100@s.whatsapp.net");
    expect(canonicalRecipient("whatsapp", "120363123@g.us")).toBe("120363123@g.us");
    expect(canonicalRecipient("imessage", "Ada Lovelace")).toBeNull();
    expect(canonicalRecipient("whatsapp", "Ada")).toBeNull();
    expect(RECIPIENT_NOT_A_HANDLE).not.toMatch(/Ada/);
  });
});

describe("outbound correlation", () => {
  it("requires one sent row with the exact body and a native ID", () => {
    expect(verifyOutcome([row()], "hello")).toEqual({ verified: true, row: row() });
    for (const candidate of [row({ body: "another send" }), row({ body: null }), row({ sent: false }), row({ messageId: "" })]) {
      expect(verifyOutcome([candidate], "hello")).toEqual({ verified: false, reason: "none" });
    }
    expect(verifyOutcome([], "hello")).toEqual({ verified: false, reason: "none" });
  });

  it("refuses same-body and mixed-success races instead of selecting a successful row", () => {
    for (const second of [row({ rowid: 10 }), row({ rowid: 10, sent: false }), row({ rowid: 10, body: "other" })]) {
      expect(verifyOutcome([row(), second], "hello")).toEqual({ verified: false, reason: "many" });
    }
  });

  it("preserves pipes, CRLF, tabs, combining characters, and Unicode through shell rows", () => {
    const body = "don't | split\n  line\r\n\t🙂漢字 e\u0301";
    expect(parseOutbound(listed(row({ body })) + "\r\n")[0]?.body).toBe(body);
    expect(verifyOutcome(parseOutbound(listed(row({ body }))), body.normalize("NFC")).verified).toBe(false);
  });

  it.each(["9|chat|1", listed().replace(/^9/, "9007199254740993"), listed().replace(/^9/, "1e3"),
    listed().replace(hex("hello"), "0"), listed().replace(hex("hello"), "ff")])("refuses malformed output %j", (output) => {
    expect(() => parseOutbound(output)).toThrow();
  });
});

describe("performMessageSend", () => {
  beforeEach(() => vi.useFakeTimers());

  it("sends exact text in argv once and reports the correlated native row", async () => {
    const body = 'say "hi"\n  🙂';
    const h = harness({ query: vi.fn(async (sql) => sql.includes("coalesce(max") ? "4" : listed(row({ body }))) });
    expect(await perform(imessage({ body }), h)).toMatchObject({ status: "verified", row: { rowid: 9, message_id: "message-9" } });
    expect(h.runScript).toHaveBeenCalledOnce();
    expect(h.runScript).toHaveBeenCalledWith(IMESSAGE_PARTICIPANT_SCRIPT, [body, "ada@example.com"]);
    expect(IMESSAGE_PARTICIPANT_SCRIPT).not.toContain(body);
    expect(imessageScript("any;-;chat")).not.toBe(IMESSAGE_PARTICIPANT_SCRIPT);
  });

  it("waits for a delayed sent flag, checking the same snapshot without resending", async () => {
    const query = vi.fn().mockResolvedValueOnce("4").mockResolvedValueOnce("")
      .mockResolvedValueOnce(listed(row({ sent: false }))).mockResolvedValue(listed());
    const h = harness({ query });
    expect(await perform(imessage(), h)).toMatchObject({ status: "verified" });
    expect(new Set(query.mock.calls.slice(1).map(([sql]) => sql))).toEqual(new Set([imessageVerifySql(4, "ada@example.com")]));
    expect(h.runScript).toHaveBeenCalledOnce();
  });

  it("observes a second same-body row that arrives after the first successful check", async () => {
    const query = vi.fn().mockResolvedValueOnce("4").mockResolvedValueOnce(listed())
      .mockResolvedValue(listed() + "\n" + listed(row({ rowid: 10, messageId: "message-10" })));
    const h = harness({ query });
    expect(await perform(imessage(), h)).toMatchObject({ status: "unverified", reason: "many" });
    expect(h.runScript).toHaveBeenCalledOnce();
  });

  it.each(["other concurrent body", null])("cannot attribute a different or unknown body %j", async (body) => {
    const h = harness({ query: vi.fn(async (sql) => sql.includes("coalesce(max") ? "4" : listed(row({ body }))) });
    expect(await perform(imessage(), h)).toMatchObject({ status: "unverified" });
    expect(h.runScript).toHaveBeenCalledOnce();
  });

  it("uses the native decoded body instead of a stale text column", async () => {
    const readDecodedBody = vi.fn(async () => "hello");
    const h = harness({ query: vi.fn(async (sql) => sql.includes("coalesce(max") ? "4" : listed(row({ body: "stale", needsDecodedBody: true }))), readDecodedBody });
    expect(await perform(imessage(), h)).toMatchObject({ status: "verified" });
    expect(readDecodedBody).toHaveBeenCalled();
    expect(readDecodedBody.mock.calls[0]?.[0]).toMatchObject({ rowid: 9, chatId: 1, needsDecodedBody: true });
  });

  it("fails closed when a modern body's decoder is unavailable", async () => {
    const h = harness({ query: vi.fn(async (sql) => sql.includes("coalesce(max") ? "4" : listed(row({ needsDecodedBody: true }))) });
    expect(await perform(imessage(), h)).toMatchObject({ status: "unverified" });
  });

  it("refreshes the store after a slow decode and catches a concurrent row at the deadline", async () => {
    const modern = row({ body: null, needsDecodedBody: true, attributedBodyHex: "010203" });
    let concurrent = false;
    const query = vi.fn(async (sql: string) => sql.includes("coalesce(max") ? "4"
      : listed(modern) + (concurrent ? "\n" + listed(row({ rowid: 10 })) : ""));
    const readDecodedBody = vi.fn(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 5_000));
      concurrent = true;
      return "hello";
    });
    const h = harness({ query, readDecodedBody });
    expect(await perform(imessage(), h)).toMatchObject({ status: "unverified", reason: "many" });
    expect(query).toHaveBeenCalledTimes(3);
    expect(readDecodedBody).toHaveBeenCalledOnce();
    expect(h.runScript).toHaveBeenCalledOnce();
  });

  it("a failed script cannot be verified by somebody else's matching outbound row", async () => {
    const h = harness({ runScript: vi.fn(async () => ({ exitCode: 1, stderr: "send failed" })) });
    expect(await perform(imessage(), h)).toMatchObject({ status: "unverified", script_exit: 1 });
    expect(h.query).toHaveBeenCalledOnce();
    expect(h.runScript).toHaveBeenCalledOnce();
  });

  it.each(["", " \n", "1e3", "0x10", "9007199254740993", "-1", "1.5", "1\n2", "nope"])("never sends with an invalid snapshot %j", async (snapshot) => {
    const h = harness({ query: vi.fn(async () => snapshot) });
    expect(await perform(imessage(), h)).toMatchObject({ status: "error" });
    expect(h.runScript).not.toHaveBeenCalled();
  });

  it("records a pre-send read failure for host diagnosis without running a script", async () => {
    const h = harness({ query: vi.fn(async () => { throw new Error("sqlite down"); }) });
    await expect(performMessageSend(imessage(), h)).rejects.toThrow("sqlite down");
    expect(h.runScript).not.toHaveBeenCalled();
    expect(h.audit).toHaveBeenCalledWith("message_send_refused", expect.objectContaining({ cause: "snapshot" }));
  });

  it("a post-send read error stays unverified and never causes a retry", async () => {
    const h = harness({ query: vi.fn().mockResolvedValueOnce("4").mockRejectedValue(new Error("sqlite down")) });
    expect(await perform(imessage(), h)).toMatchObject({ status: "unverified" });
    expect(h.runScript).toHaveBeenCalledOnce();
  });

  it("stops reads after the observation window if no row appears", async () => {
    const h = harness({ query: vi.fn(async (sql) => sql.includes("coalesce(max") ? "4" : "") });
    expect(await perform(imessage(), h)).toMatchObject({ status: "unverified" });
    const reads = h.query.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.query).toHaveBeenCalledTimes(reads);
    expect(reads).toBeLessThanOrEqual(22);
    expect(h.runScript).toHaveBeenCalledOnce();
  });

  it("refuses WhatsApp before any keystroke when Accessibility is absent", async () => {
    const h = harness();
    expect(await perform(imessage({ app: "whatsapp", recipient: "14155550100@s.whatsapp.net", accessibility: "denied" }), h))
      .toMatchObject({ status: "blocked", host_gate: "accessibility" });
    expect(h.runScript).not.toHaveBeenCalled();
    expect(h.query).not.toHaveBeenCalled();
  });

  it("passes the WhatsApp target and body as values and sends once", async () => {
    const h = harness();
    await perform(imessage({ app: "whatsapp", recipient: "14155550100@s.whatsapp.net" }), h);
    expect(h.runScript).toHaveBeenCalledWith(WHATSAPP_SCRIPT, ["hello", whatsappOpenUrl("14155550100@s.whatsapp.net"), "14155550100@s.whatsapp.net"]);
    expect(h.runScript).toHaveBeenCalledOnce();
  });

  it("classifies an Accessibility refusal after the script without retrying", async () => {
    const h = harness({ runScript: vi.fn(async () => ({ exitCode: 1, stderr: "not allowed assistive access. (-1719)" })) });
    expect(await perform(imessage({ app: "whatsapp" }), h)).toMatchObject({ status: "blocked", host_gate: "accessibility" });
    expect(h.runScript).toHaveBeenCalledOnce();
  });

  it.each(["LATCH_RECIPIENT_UNVERIFIED", "LATCH_COMPOSER_UNVERIFIED"])("keeps pre-send refusal %s blocked even if another matching row exists", async (sentinel) => {
    const h = harness({ runScript: vi.fn(async () => ({ exitCode: 1, stderr: sentinel })) });
    expect(await perform(imessage({ app: "whatsapp" }), h)).toMatchObject({ status: "blocked", send_attempted: false });
    expect(h.query).toHaveBeenCalledOnce();
    expect(h.runScript).toHaveBeenCalledOnce();
  });
});

const nativeDirs: string[] = [];
afterEach(() => { while (nativeDirs.length) fs.rmSync(nativeDirs.pop()!, { recursive: true, force: true }); });
const textSql = (text: string) => `cast(X'${hex(text)}' as text)`;
function database() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "domo-send-native-"));
  nativeDirs.push(dir);
  const db = path.join(dir, "messages.sqlite");
  const exec = (sql: string) => execFileSync("/usr/bin/sqlite3", [db, sql], { encoding: "utf8" });
  exec([
    "create table handle (ROWID integer primary key, id text);",
    "create table chat (ROWID integer primary key, guid text, chat_identifier text, style integer default 45);",
    "create table message (ROWID integer primary key, handle_id integer default 1, is_from_me integer default 1, is_sent integer default 1, error integer default 0, text text, attributedBody blob, guid text, item_type integer default 0, associated_message_type integer default 0, service text default 'iMessage');",
    "create table chat_message_join (chat_id integer, message_id integer);",
    "insert into handle values (1, 'ada@example.com'); insert into chat values (1, 'iMessage;-;ada@example.com', 'ada@example.com', 45);",
    "create table ZWACHATSESSION (Z_PK integer primary key, ZCONTACTJID text);",
    "insert into ZWACHATSESSION values (1, '14155550100@s.whatsapp.net');",
    "create table ZWAMESSAGE (ZCHATSESSION integer default 1, ZISFROMME integer default 1, ZMESSAGESTATUS integer default 6, ZMESSAGEERRORSTATUS integer default 0, ZMESSAGETYPE integer default 0, ZTEXT text, ZSTANZAID text);",
  ].join(" "));
  return {
    exec,
    read: (app: "imessage" | "whatsapp", snapshot = 0) => parseOutbound(execFileSync("/usr/bin/sqlite3", ["-readonly", "-list", db,
      app === "imessage" ? imessageVerifySql(snapshot, "ada@example.com") : whatsappVerifySql(snapshot, "14155550100@s.whatsapp.net")], { encoding: "utf8" })),
    insert: (app: "imessage" | "whatsapp", id: number, body: string) => app === "imessage"
      ? exec(`insert into message (ROWID,text,guid) values (${id},${textSql(body)},'message-${id}'); insert into chat_message_join values (1,${id});`)
      : exec(`insert into ZWAMESSAGE (rowid,ZTEXT,ZSTANZAID) values (${id},${textSql(body)},'message-${id}');`),
    db,
  };
}

describe.skipIf(process.platform !== "darwin")("verification against real sqlite -list", () => {
  it.each(["imessage", "whatsapp"] as const)("matches %s text exactly across quotes, delimiters, CRLF, and Unicode", (app) => {
    const h = database();
    const body = "don't | split\n  second\r\n\t🙂漢字 e\u0301";
    h.insert(app, 4, "older message");
    h.insert(app, 9, body);
    const rows = h.read(app, 4);
    expect(rows[0]?.body).toBe(body);
    expect(verifyOutcome(rows, body)).toMatchObject({ verified: true, row: { rowid: 9 } });
    expect(verifyOutcome(rows, "another body").verified).toBe(false);
    h.insert(app, 10, body);
    expect(verifyOutcome(h.read(app, 4), body)).toEqual({ verified: false, reason: "many" });
  });

  it.each([0, 2, 3, 5, 7, 9, 999, null])("does not claim WhatsApp success for unconfirmed state %j", (state) => {
    const h = database(); h.insert("whatsapp", 1, "hello");
    h.exec(`update ZWAMESSAGE set ZMESSAGESTATUS=${state ?? "null"};`);
    expect(verifyOutcome(h.read("whatsapp"), "hello").verified).toBe(false);
  });

  it.each([1, 6, 8])("requires a zero native error for accepted WhatsApp state %i", (state) => {
    const h = database(); h.insert("whatsapp", 1, "hello");
    h.exec(`update ZWAMESSAGE set ZMESSAGESTATUS=${state};`);
    expect(verifyOutcome(h.read("whatsapp"), "hello").verified).toBe(true);
    for (const error of [99, null]) {
      h.exec(`update ZWAMESSAGE set ZMESSAGEERRORSTATUS=${error ?? "null"};`);
      expect(verifyOutcome(h.read("whatsapp"), "hello").verified).toBe(false);
    }
  });

  it.each([1, 6, 10, 99])("does not mistake WhatsApp media/system type %i for a text send", (kind) => {
    const h = database(); h.insert("whatsapp", 1, "hello");
    h.exec(`update ZWAMESSAGE set ZMESSAGETYPE=${kind};`);
    expect(verifyOutcome(h.read("whatsapp"), "hello").verified).toBe(false);
  });

  it("requires iMessage sent=1, error=0, and excludes reaction/system rows", () => {
    const h = database(); h.insert("imessage", 1, "hello");
    for (const update of ["is_sent=0", "is_sent=1,error=22", "error=null"]) {
      h.exec(`update message set ${update};`);
      expect(verifyOutcome(h.read("imessage"), "hello").verified).toBe(false);
    }
    h.exec("update message set is_sent=1,error=0; insert into message (ROWID,text,guid,associated_message_type) values (2,'hello','reaction',2000); insert into chat_message_join values (1,2);");
    expect(verifyOutcome(h.read("imessage"), "hello")).toMatchObject({ verified: true, row: { rowid: 1 } });
  });

  it("never treats the old text column as the decoded modern iMessage body", () => {
    const h = database(); h.insert("imessage", 1, "hello");
    h.exec("update message set attributedBody=X'010203';");
    expect(h.read("imessage")[0]).toMatchObject({ body: null, needsDecodedBody: true });
    expect(verifyOutcome(h.read("imessage"), "hello").verified).toBe(false);
  });

  it("cannot verify a direct iMessage from a group or SMS row with the same participant", () => {
    const h = database(); h.insert("imessage", 1, "hello");
    h.exec("update chat set style=43;");
    expect(h.read("imessage")).toEqual([]);
    h.exec("update chat set style=45; update message set service='SMS';");
    expect(h.read("imessage")).toEqual([]);
    h.exec("update message set service='iMessage'; update chat set chat_identifier='different@example.com';");
    expect(h.read("imessage")).toEqual([]);
  });

  it("ignores inbound/other-recipient rows and snapshots the existing WhatsApp maximum", () => {
    const h = database(); h.insert("whatsapp", 3, "old"); h.insert("whatsapp", 8, "hello");
    h.exec("insert into ZWAMESSAGE (rowid,ZISFROMME,ZTEXT) values (9,0,'hello'); insert into ZWACHATSESSION values (2,'other@s.whatsapp.net'); insert into ZWAMESSAGE (rowid,ZCHATSESSION,ZTEXT) values (10,2,'hello');");
    expect(verifyOutcome(h.read("whatsapp", 3), "hello")).toMatchObject({ verified: true, row: { rowid: 8 } });
    expect(Number(execFileSync("/usr/bin/sqlite3", ["-readonly", "-list", h.db, whatsappSnapshotSql()], { encoding: "utf8" }).trim())).toBe(10);
  });
});

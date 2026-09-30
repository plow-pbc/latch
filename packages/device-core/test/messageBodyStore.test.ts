import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { withMessageBodyStore } from "../src/messageBodyStore.js";
import type { OutboundRow } from "../src/messageSend.js";

const row: OutboundRow = {
  rowid: 17, chatId: 9, chat: "iMessage;-;ada@example.com", sent: true,
  body: null, needsDecodedBody: true, attributedBodyHex: "010203", messageId: "native-id",
};

describe.skipIf(process.platform !== "darwin")("isolated native message body store", () => {
  it("copies only the exact blob with NULL legacy text, restrictive permissions, and original identity", async () => {
    let scratch = "";
    expect(await withMessageBodyStore(row, async (db) => {
      scratch = db;
      expect(fs.statSync(db).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(db)).mode & 0o777).toBe(0o700);
      const stored = JSON.parse(execFileSync("/usr/bin/sqlite3", ["-readonly", "-json", db,
        "select m.ROWID as rowid, c.ROWID as chat_id, c.guid, m.is_from_me, m.text, hex(m.attributedBody) as blob from message m join chat_message_join j on j.message_id=m.ROWID join chat c on c.ROWID=j.chat_id;"], { encoding: "utf8" }));
      expect(stored).toEqual([{ rowid: 17, chat_id: 9, guid: row.chat, is_from_me: 1, text: null, blob: "010203" }]);
      return null;
    })).toBeNull();
    expect(fs.existsSync(path.dirname(scratch))).toBe(false);
  });

  it("removes the private store when the decoder fails", async () => {
    let scratch = "";
    await expect(withMessageBodyStore(row, async (db) => {
      scratch = db;
      throw new Error("decoder failed");
    })).rejects.toThrow("decoder failed");
    expect(fs.existsSync(path.dirname(scratch))).toBe(false);
  });

  it.each(["", "001", "ff');drop table message;--", "01".repeat(131073)])("refuses missing, malformed, and oversized blobs before decoding %#", async (blob) => {
    let called = false;
    expect(await withMessageBodyStore({ ...row, attributedBodyHex: blob }, async () => {
      called = true;
      return "hello";
    })).toBeNull();
    expect(called).toBe(false);
  });
});

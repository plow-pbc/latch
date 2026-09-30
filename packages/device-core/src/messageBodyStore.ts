import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OutboundRow } from "./messageSend.js";

/** The pinned native decoder falls back to message.text on malformed blobs.
 * Give it only this row's bounded blob and NULL text, so fallback cannot
 * certify a stale legacy body. The sandbox never needs the live store. */
export async function withMessageBodyStore(
  row: OutboundRow,
  decode: (db: string) => Promise<string | null>,
): Promise<string | null> {
  const blob = row.attributedBodyHex;
  if (blob === "" || blob.length > 262144 || !/^(?:[0-9a-f]{2})+$/i.test(blob)) return null;
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "latch-message-body-")));
  const db = path.join(dir, "body.sqlite");
  try {
    fs.writeFileSync(db, "", { mode: 0o600, flag: "wx" });
    const chat = Buffer.from(row.chat, "utf8").toString("hex");
    const sql = [
      "create table handle (ROWID integer primary key, id text);",
      "create table chat (ROWID integer primary key, guid text, chat_identifier text, display_name text);",
      "create table message (ROWID integer primary key, handle_id integer, date integer, is_from_me integer, text text, attributedBody blob, item_type integer, associated_message_type integer);",
      "create table chat_message_join (chat_id integer, message_id integer);",
      `insert into chat values (${row.chatId}, cast(X'${chat}' as text), null, null);`,
      `insert into message values (${row.rowid}, null, 0, 1, null, X'${blob}', 0, 0);`,
      `insert into chat_message_join values (${row.chatId}, ${row.rowid});`,
    ].join("\n");
    await new Promise<void>((resolve, reject) => {
      const child = execFile("/usr/bin/sqlite3", ["-batch", db], {
        timeout: 5_000, killSignal: "SIGKILL",
      }, (error) => error ? reject(new Error("could not prepare the message body decoder")) : resolve());
      child.stdin!.on("error", () => reject(new Error("could not prepare the message body decoder")));
      child.stdin!.end(sql);
    });
    return await decode(db);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

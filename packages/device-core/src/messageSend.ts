/**
 * Send one iMessage or WhatsApp message for an approved `message_send`.
 *
 * The body is not part of the rule key (`normalizedCapability` strips
 * `bodyPreview`). One always-allow covers later text to the same canonical
 * recipient and does not cover a different one. A send that cannot be
 * verified is reported as unverified and is not tried again. A retry is how
 * the same approval becomes two messages.
 */
import { execFile } from "node:child_process";
import { FileOpsError } from "./fileOps.js";
import { APP_DISPLAY_NAME } from "./hostGate/diagnose.js";
import { errnoFromHint, stderrHint } from "./hostGate/errors.js";
import { IMESSAGE_QUERIES, imessageStorePath } from "./imessageSkill.js";
import { WHATSAPP_SCRIPT } from "./whatsappSend.js";
export { WHATSAPP_SCRIPT } from "./whatsappSend.js";

export type MessageApp = "imessage" | "whatsapp";

/** Fixed sentence. The caller's spelling of a name never appears in it. */
export const RECIPIENT_NOT_A_HANDLE = "recipient must be a phone, an email, or a chat id";

export function accessibilityRefusal(): string {
  return `In System Settings > Privacy & Security > Accessibility, allow ${APP_DISPLAY_NAME}.`;
}

/**
 * A handle the card can key a rule on. A display name returns null.
 */
export function canonicalRecipient(app: MessageApp, raw: string): string | null {
  const text = raw.trim();
  if (text === "" || text.length > 200) return null;
  if (app === "whatsapp") {
    const jid = text.toLowerCase().replace(/\s+/g, "");
    if (/^[0-9]+@s\.whatsapp\.net$/.test(jid) || /^[0-9-]+@g\.us$/.test(jid)) return jid;
    const compact = text.replace(/[\s()-]/g, "");
    if (!/^\+?[0-9]{8,15}$/.test(compact)) return null;
    return `${compact.replace(/^\+/, "")}@s.whatsapp.net`;
  }
  if (text.includes(";")) {
    return /^[A-Za-z0-9;:+._@-]{3,200}$/.test(text) ? text : null;
  }
  const compact = text.replace(/[\s()-]/g, "");
  if (/^\+?[0-9]{8,15}$/.test(compact)) return compact;
  if (!/\s/.test(text) && /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(text)) {
    return text.toLowerCase();
  }
  return null;
}

export const IMESSAGE_PARTICIPANT_SCRIPT = `on run argv
  tell application "Messages" to send (item 1 of argv) to participant (item 2 of argv) of (first account whose service type = iMessage)
end run
`;

export const IMESSAGE_CHAT_SCRIPT = `on run argv
  tell application "Messages" to send (item 1 of argv) to chat id (item 2 of argv)
end run
`;

/** A group guid contains `;`. A phone or email does not. */
export function imessageScript(recipient: string): string {
  return recipient.includes(";") ? IMESSAGE_CHAT_SCRIPT : IMESSAGE_PARTICIPANT_SCRIPT;
}

/** The URL is built from the canonical jid, never from a search-box name. */
export function whatsappOpenUrl(jid: string): string {
  if (jid.endsWith("@g.us")) return `whatsapp://send?jid=${jid}`;
  return `whatsapp://send?phone=${jid.replace(/@s\.whatsapp\.net$/, "")}`;
}

function whatsappStorePath(home: string): string {
  return `${home}/Library/Group Containers/group.net.whatsapp.WhatsApp.shared/ChatStorage.sqlite`;
}

export interface OutboundRow {
  rowid: number;
  chat: string;
  sent: boolean;
  body: string | null;
  needsDecodedBody: boolean;
  messageId: string;
  chatId: number;
  attributedBodyHex: string;
}

/** Exactly one new successful outbound row is verified. Zero or several is
 *  unverified. Several is a race, and picking one is how a retry duplicates. */
export function verifyOutcome(
  rows: readonly OutboundRow[],
  body: string,
): { verified: true; row: OutboundRow } | { verified: false; reason: "none" | "many" } {
  if (rows.length > 1) return { verified: false, reason: "many" };
  if (rows[0]?.sent && rows[0].body === body && rows[0].messageId !== "") {
    return { verified: true, row: rows[0] };
  }
  return { verified: false, reason: "none" };
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function imessageVerifySql(snapshot: number, recipient: string): string {
  const target = recipient.includes(";")
    ? `c.guid = ${sqlLiteral(recipient)}`
    : `h.id = ${sqlLiteral(recipient)} and c.chat_identifier = ${sqlLiteral(recipient)} and c.style = 45 and m.service = 'iMessage'`;
  return `select m.ROWID, hex(c.guid),
       case when m.is_sent = 1 and m.error = 0 then 1 else 0 end,
       m.text is not null, hex(m.text),
       case when length(m.attributedBody) > 0 then 1 else 0 end,
       hex(m.guid), c.ROWID,
       case when length(m.attributedBody) <= 131072 then hex(m.attributedBody) else '' end
  from message m
  join chat_message_join j on j.message_id = m.ROWID
  join chat c on c.ROWID = j.chat_id
  left join handle h on h.ROWID = m.handle_id
 where m.is_from_me = 1 and m.ROWID > ${snapshot}
   and coalesce(m.item_type, 0) = 0 and coalesce(m.associated_message_type, 0) = 0
   and (${target})
 order by m.ROWID limit 2;`;
}

export function whatsappSnapshotSql(): string {
  return "select coalesce(max(rowid), 0) from ZWAMESSAGE;";
}

export function whatsappVerifySql(snapshot: number, jid: string): string {
  // Native states: 1 sent, 6 delivered, 8 read. An unknown state, a
  // nonzero/NULL error, or a system/media row cannot prove this text send.
  return (
    "select m.rowid, hex(s.ZCONTACTJID), " +
    "case when m.ZMESSAGESTATUS in (1, 6, 8) and m.ZMESSAGEERRORSTATUS = 0 " +
    "and m.ZMESSAGETYPE in (0, 7) then 1 else 0 end, " +
    "m.ZTEXT is not null, hex(m.ZTEXT), 0, hex(m.ZSTANZAID), s.Z_PK, '' from ZWAMESSAGE m " +
    "join ZWACHATSESSION s on m.ZCHATSESSION = s.Z_PK " +
    `where m.ZISFROMME = 1 and m.rowid > ${snapshot} and s.ZCONTACTJID = ${sqlLiteral(jid)} ` +
    "order by m.rowid limit 2;"
  );
}

/** Every text cell is hex so delimiters, newlines, and Unicode survive the
 * sqlite shell unchanged. Invalid output is uncertainty, never a lost row. */
export function parseOutbound(text: string): OutboundRow[] {
  if (text.trim() === "") return [];
  return text
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      const cols = line.split("|");
      const rowid = Number(cols[0]);
      const chatId = Number(cols[7]);
      if (cols.length !== 9 || !/^[1-9][0-9]*$/.test(cols[0]!) || !Number.isSafeInteger(rowid)
        || !/^[1-9][0-9]*$/.test(cols[7]!) || !Number.isSafeInteger(chatId)
        || ![cols[2], cols[3], cols[5]].every((flag) => flag === "0" || flag === "1")
        || cols[8]!.length > 262144 || !/^(?:[0-9a-f]{2})*$/i.test(cols[8]!)) {
        throw new Error("invalid message store row");
      }
      return {
        rowid, chatId, chat: hexText(cols[1]!), messageId: hexText(cols[6]!), sent: cols[2] === "1",
        body: cols[3] === "1" && cols[5] === "0" ? hexText(cols[4]!) : null,
        needsDecodedBody: cols[5] === "1",
        attributedBodyHex: cols[8]!,
      };
    });
}

function hexText(hex: string): string {
  if (!/^(?:[0-9a-f]{2})*$/i.test(hex)) throw new Error("invalid message store text");
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(hex, "hex"));
}

export interface MessageSendDeps {
  query: (sql: string) => Promise<string>;
  /** Uses the staged plow-messages native decoder for attributedBody rows. */
  readDecodedBody?: (row: OutboundRow) => Promise<string | null>;
  runScript: (script: string, args: readonly string[]) => Promise<{ exitCode: number | null; stderr: string }>;
  audit: (event: string, fields: Record<string, string | number | boolean | null>) => void;
}

export interface MessageSendRequest {
  intentId: string;
  app: MessageApp;
  recipient: string;
  body: string;
  accessibility: "granted" | "denied" | "not_asked" | "unknown";
}

/** The app may return before its database records the send. Keep the same
 * pre-send snapshot and only re-read; a second script would duplicate it. */
async function waitForOutbound(
  deps: MessageSendDeps,
  sql: string,
  body: string,
): Promise<ReturnType<typeof verifyOutcome>> {
  const deadline = Date.now() + 5_000;
  let decoded: { key: string; body: string | null } | undefined;
  for (;;) {
    const rows = parseOutbound(await deps.query(sql));
    if (rows.length === 1 && rows[0]!.needsDecodedBody) {
      const row = rows[0]!;
      const key = JSON.stringify([row.rowid, row.chatId, row.chat, row.messageId, row.attributedBodyHex]);
      if (decoded?.key !== key) {
        if (Date.now() >= deadline) return { verified: false, reason: "none" };
        decoded = { key, body: await deps.readDecodedBody?.(row) ?? null };
        // Decoding can take the rest of the window. Re-read cardinality,
        // native status, and identity after it, never accept a stale row.
        continue;
      }
      row.body = decoded.body;
    }
    const outcome = verifyOutcome(rows, body);
    // Observe the full window even after a match. A second same-body row
    // arriving on the next tick must make the send ambiguous too.
    if ((!outcome.verified && outcome.reason === "many") || Date.now() >= deadline) return outcome;
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * One attempt. `runScript` is called at most once. A WhatsApp send whose
 * Accessibility grant is missing is refused before any keystroke.
 */
export async function performMessageSend(
  req: MessageSendRequest,
  deps: MessageSendDeps,
): Promise<Record<string, unknown>> {
  if (req.app === "whatsapp" && req.accessibility !== "granted") {
    deps.audit("message_send_refused", { intentId: req.intentId, app: req.app, cause: "accessibility" });
    return { status: "blocked", error: accessibilityRefusal(), host_gate: "accessibility" };
  }
  const snapshotSql = req.app === "imessage" ? IMESSAGE_QUERIES.verifySendSnapshot : whatsappSnapshotSql();
  let snapshot: string;
  try {
    snapshot = (await deps.query(snapshotSql)).trim();
  } catch (error) {
    deps.audit("message_send_refused", { intentId: req.intentId, app: req.app, cause: "snapshot" });
    throw error;
  }
  const before = Number(snapshot);
  if (!/^[0-9]+$/.test(snapshot) || !Number.isSafeInteger(before)) {
    deps.audit("message_send_refused", { intentId: req.intentId, app: req.app, cause: "snapshot" });
    return { status: "error", error: "could not read the store before sending" };
  }
  const script = req.app === "imessage" ? imessageScript(req.recipient) : WHATSAPP_SCRIPT;
  const args = req.app === "imessage" ? [req.body, req.recipient] : [req.body, whatsappOpenUrl(req.recipient), req.recipient];
  deps.audit("message_send_start", { intentId: req.intentId, app: req.app, recipient: req.recipient });
  const ran = await deps.runScript(script, args);
  const verifySql =
    req.app === "imessage" ? imessageVerifySql(before, req.recipient) : whatsappVerifySql(before, req.recipient);
  let outcome: ReturnType<typeof verifyOutcome> = { verified: false, reason: "none" };
  try {
    if (ran.exitCode === 0) outcome = await waitForOutbound(deps, verifySql, req.body);
  } catch {
    // The script already ran. A failed store read or native decode must
    // stay unverified; throwing a retryable execution error can resend it.
  }
  return finishMessageSend(req, deps, ran, outcome);
}

function finishMessageSend(
  req: MessageSendRequest,
  deps: MessageSendDeps,
  ran: { exitCode: number | null; stderr: string },
  outcome: ReturnType<typeof verifyOutcome>,
): Record<string, unknown> {
  const result: Record<string, unknown> = outcome.verified ? {
    status: "verified", app: req.app, recipient: req.recipient,
    row: { rowid: outcome.row.rowid, chat: outcome.row.chat, message_id: outcome.row.messageId },
  } : unverified(req, ran.exitCode, ran.stderr, outcome.reason);
  if (result.status === "blocked") {
    deps.audit("message_send_refused", { intentId: req.intentId, app: req.app,
      cause: result.send_attempted === false ? "target_validation" : "accessibility" });
  } else {
    deps.audit("message_send_result", {
      intentId: req.intentId, app: req.app, recipient: req.recipient, verified: outcome.verified,
      rowid: outcome.verified ? outcome.row.rowid : null, script_exit: ran.exitCode,
    });
  }
  return result;
}

function unverified(
  req: MessageSendRequest,
  scriptExit: number | null,
  stderr: string,
  reason: "none" | "many",
): Record<string, unknown> {
  if (req.app === "whatsapp" && /LATCH_(?:RECIPIENT|COMPOSER)_UNVERIFIED/.test(stderr)) {
    return {
      status: "blocked", app: req.app, recipient: req.recipient, send_attempted: false,
      error: "WhatsApp could not confirm the approved recipient and message composer; no message was sent",
    };
  }
  if (stderrHint(stderr) === "assistive_access_refused") {
    return { status: "blocked", error: accessibilityRefusal(), host_gate: "accessibility" };
  }
  return {
    status: "unverified",
    app: req.app,
    recipient: req.recipient,
    reason,
    script_exit: scriptExit,
  };
}

export function storePathFor(app: MessageApp, home: string): string {
  return app === "imessage" ? imessageStorePath(home) : whatsappStorePath(home);
}

export function sqliteText(db: string, sql: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/sqlite3", ["-readonly", "-list", db, sql], {
      encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL",
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new FileOpsError("could not read the message store", false, {
          code: errnoFromHint(stderrHint(stderr)), syscall: "open", path: db,
        }));
      } else resolve(stdout);
    });
  });
}

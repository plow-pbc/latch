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
import { APP_DISPLAY_NAME } from "./hostGate/diagnose.js";
import { stderrHint } from "./hostGate/errors.js";
import { IMESSAGE_QUERIES, imessageStorePath } from "./imessageSkill.js";

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

export const WHATSAPP_SCRIPT = `on run argv
  open location (item 2 of argv)
  delay 0.5
  tell application "System Events"
    tell process "WhatsApp"
      set frontmost to true
      keystroke (item 1 of argv)
      key code 36
    end tell
  end tell
end run
`;

function whatsappStorePath(home: string): string {
  return `${home}/Library/Group Containers/group.net.whatsapp.WhatsApp.shared/ChatStorage.sqlite`;
}

export interface OutboundRow {
  rowid: number;
  chat: string;
  sent: boolean;
}

/** Exactly one new successful outbound row is verified. Zero or several is
 *  unverified. Several is a race, and picking one is how a retry duplicates. */
export function verifyOutcome(
  rows: readonly OutboundRow[],
): { verified: true; row: OutboundRow } | { verified: false; reason: "none" | "many" } {
  const ok = rows.filter((r) => r.sent);
  if (ok.length === 1) return { verified: true, row: ok[0] };
  return { verified: false, reason: ok.length === 0 ? "none" : "many" };
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function imessageVerifySql(snapshot: number, recipient: string): string {
  return IMESSAGE_QUERIES.verifySend
    .replaceAll("MAX_ROWID_BEFORE_THE_SEND", String(snapshot))
    .replaceAll("'HANDLE_FROM_THE_QUERY_ABOVE'", sqlLiteral(recipient))
    .replaceAll("'CHAT_GUID_FROM_THE_QUERY_ABOVE'", sqlLiteral(recipient));
}

export function whatsappSnapshotSql(): string {
  return "select coalesce(max(rowid), 0) from ZWAMESSAGE;";
}

export function whatsappVerifySql(snapshot: number, jid: string): string {
  return (
    "select m.rowid, s.ZCONTACTJID, 1 from ZWAMESSAGE m " +
    "join ZWACHATSESSION s on m.ZCHATSESSION = s.Z_PK " +
    `where m.ZISFROMME = 1 and m.rowid > ${snapshot} and s.ZCONTACTJID = ${sqlLiteral(jid)};`
  );
}

export function parseOutbound(text: string, whatsapp: boolean): OutboundRow[] {
  if (text.trim() === "") return [];
  return text
    .trim()
    .split("\n")
    .map((line) => {
      const cols = line.split("|").map((cell) => cell.replace(/\r/g, ""));
      const rowid = Number(cols[0]);
      if (whatsapp) return { rowid, chat: cols[1] ?? "", sent: true };
      // verifySend selects ROWID, chat guid, handle, is_sent, is_delivered, error.
      const sentOk = cols[3] === "1" && (cols[5] === "0" || cols[5] === "");
      return { rowid, chat: cols[1] ?? "", sent: sentOk };
    })
    .filter((r) => Number.isInteger(r.rowid));
}

export interface MessageSendDeps {
  query: (sql: string) => Promise<string>;
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
  const before = Number((await deps.query(snapshotSql)).trim());
  if (!Number.isInteger(before) || before < 0) {
    deps.audit("message_send_refused", { intentId: req.intentId, app: req.app, cause: "snapshot" });
    return { status: "error", error: "could not read the store before sending" };
  }
  const script = req.app === "imessage" ? imessageScript(req.recipient) : WHATSAPP_SCRIPT;
  const args = req.app === "imessage" ? [req.body, req.recipient] : [req.body, whatsappOpenUrl(req.recipient)];
  const ran = await deps.runScript(script, args);
  const verifySql =
    req.app === "imessage" ? imessageVerifySql(before, req.recipient) : whatsappVerifySql(before, req.recipient);
  let listed: string;
  try {
    listed = await deps.query(verifySql);
  } catch {
    deps.audit("message_send_result", {
      intentId: req.intentId,
      app: req.app,
      recipient: req.recipient,
      verified: false,
      rowid: null,
      script_exit: ran.exitCode,
    });
    return unverified(req, ran.exitCode, ran.stderr, "none");
  }
  const rows = parseOutbound(listed, req.app === "whatsapp");
  const outcome = verifyOutcome(rows);
  deps.audit("message_send_result", {
    intentId: req.intentId,
    app: req.app,
    recipient: req.recipient,
    verified: outcome.verified,
    rowid: outcome.verified ? outcome.row.rowid : null,
    script_exit: ran.exitCode,
  });
  if (!outcome.verified) return unverified(req, ran.exitCode, ran.stderr, outcome.reason);
  return {
    status: "verified",
    app: req.app,
    recipient: req.recipient,
    row: { rowid: outcome.row.rowid, chat: outcome.row.chat },
  };
}

function unverified(
  req: MessageSendRequest,
  scriptExit: number | null,
  stderr: string,
  reason: "none" | "many",
): Record<string, unknown> {
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
    execFile("/usr/bin/sqlite3", ["-readonly", "-list", db, sql], { encoding: "utf8" }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

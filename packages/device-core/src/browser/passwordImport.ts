/**
 * Password imports: the exports other password managers write, read into the
 * shapes this vault saves.
 *
 * Three inputs, all text: the CSV Apple Passwords exports, the CSV 1Password
 * exports ("CSV — export only certain fields"), and the JSON behind
 * 1Password's "Copy item JSON" on a single item. Logins only — a row here is
 * a login or it is skipped, never guessed into another type.
 *
 * Pure on purpose: parsing takes text and returns values, so every format
 * quirk is testable without a vault, a file, or a window. The one impure
 * function is importLogins, which loops the vault's own save — each import
 * lands exactly the way a hand-typed item does, audit line included.
 *
 * A rule that holds everywhere below: no error message, no warning, and no
 * skip reason ever contains a field's VALUE. The text being parsed is a file
 * of passwords, and everything this module returns is shown on screen.
 */
import type { LocalVault } from "./localVault.js";
import { checkedUrls } from "./vaultItems.js";
import { totpParams } from "./vaultTotp.js";

/** One login as the export described it, normalized and ready to save. */
export interface ImportedLogin {
  title: string;
  urls: string[];
  username: string;
  password: string;
  /** A key totpParams accepts, or "" — a key that cannot make a code is
   * dropped at parse time (with a warning), never handed to save to refuse. */
  totp: string;
  notes: string;
  /** Facts the owner should see before importing — "no password", say. */
  warnings: string[];
  /** Set by markAgainstVault: an item with the same name, username and site
   * is already in the vault holding the same secrets, so importing this row
   * would double it. */
  duplicate?: boolean;
  /** Set by markAgainstVault instead of `duplicate` when the matched item's
   * password or key CHANGED in the source: the save this row becomes is an
   * edit of that item, touching only the fields named here. */
  update?: { itemId: string; revision: string; fields: ("password" | "totp")[] };
}

/** A row that will not be imported, and the reason it will not. */
export interface SkippedRow {
  title: string;
  reason: string;
}

export interface ParsedImport {
  /** Where the text came from, as well as it can be told: "Apple Passwords",
   * "1Password", "1Password item", "Chrome", or "CSV" for a header we merely
   * recognize. */
  source: string;
  logins: ImportedLogin[];
  skipped: SkippedRow[];
}

/** Larger than any real passwords export; a cap, not a target. */
const MAX_IMPORT_BYTES = 20 * 1024 * 1024;

/**
 * RFC 4180, which both apps write: quoted fields may hold commas, newlines
 * and doubled quotes, and passwords routinely do. A leading BOM is stripped —
 * spreadsheet round-trips add one.
 */
export function csvRows(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === "") {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // A trailing newline (or a stray blank line) is not an empty login.
  return rows.filter((r) => !(r.length === 1 && r[0]!.trim() === ""));
}

/** Header cells the known exports use, folded to the fields this vault has.
 * Apple:     Title,URL,Username,Password,Notes,OTPAuth
 * 1Password: Title,Url,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes
 * Chrome:    name,url,username,password,note
 * Favorite and Tags have no home here and are dropped; Archived rows are
 * skipped — 1Password's own UI hides them. */
const HEADER_KEYS: Record<string, string> = {
  title: "title",
  name: "title",
  url: "url",
  urls: "url",
  website: "url",
  username: "username",
  password: "password",
  notes: "notes",
  note: "notes",
  otpauth: "totp",
  totp: "totp",
  favorite: "favorite",
  archived: "archived",
  tags: "tags",
};

const APPLE_HEADER = "title,url,username,password,notes,otpauth";
const ONEPW_HEADER = "title,url,username,password,otpauth,favorite,archived,tags,notes";
const CHROME_HEADER = "name,url,username,password,note";

/**
 * Whatever the owner handed over — a chosen file or a paste. Text opening
 * with `{` is read as 1Password item JSON; everything else as CSV.
 */
export function parsePasswordExport(text: string): ParsedImport {
  if (text.length > MAX_IMPORT_BYTES) {
    throw new Error("that is too large to be a passwords export");
  }
  const lead = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).trimStart();
  if (lead === "") throw new Error("there is nothing to read");
  if (lead.startsWith("{")) return parseOnePasswordItemJson(lead);
  return parseCsvExport(text);
}

function parseCsvExport(text: string): ParsedImport {
  const rows = csvRows(text);
  const header = rows[0]?.map((h) => h.trim().toLowerCase()) ?? [];
  const joined = header.join(",");
  const mapped = header.map((h) => HEADER_KEYS[h]);
  const has = (key: string) => mapped.includes(key);
  if (!has("title") || !has("url") || !has("username") || !has("password")) {
    throw new Error(
      "this doesn't look like a passwords export. Expected the CSV that Apple Passwords " +
        "or 1Password writes, with Title, URL, Username and Password columns",
    );
  }
  const source =
    joined === APPLE_HEADER ? "Apple Passwords"
    : joined === ONEPW_HEADER ? "1Password"
    : joined === CHROME_HEADER ? "Chrome"
    : "CSV";

  const logins: ImportedLogin[] = [];
  const skipped: SkippedRow[] = [];
  for (const row of rows.slice(1)) {
    const rec: Record<string, string> = {};
    row.forEach((cell, i) => {
      const key = mapped[i];
      if (key && !(key in rec)) rec[key] = cell;
    });
    const login = rowToLogin(rec, skipped);
    if (login) logins.push(login);
  }
  return { source, logins, skipped };
}

/** True for the ways a CSV cell says yes. */
const truthy = (cell: string | undefined): boolean =>
  /^(true|yes|1)$/i.test((cell ?? "").trim());

function rowToLogin(rec: Record<string, string>, skipped: SkippedRow[]): ImportedLogin | null {
  const title = (rec.title ?? "").trim();
  const url = (rec.url ?? "").trim();
  const username = (rec.username ?? "").trim();
  const password = rec.password ?? "";
  // A row with nothing in it at all is padding, not a loss worth reporting.
  if (!title && !url && !username && !password) return null;
  if (truthy(rec.archived)) {
    skipped.push({ title: title || "(untitled)", reason: "archived in 1Password" });
    return null;
  }
  if (!url) {
    // The vault refuses a login with no site — it can never be filled — so the
    // row is set aside here, where the reason can be said before the import.
    skipped.push({
      title: title || "(untitled)",
      reason: "has no website address; add it by hand as a new item if you still use it",
    });
    return null;
  }
  let urls: string[];
  try {
    urls = checkedUrls([url]);
  } catch {
    skipped.push({ title: title || "(untitled)", reason: "its website address could not be read" });
    return null;
  }
  const warnings: string[] = [];
  const name = title || hostOf(urls[0]!) || "(untitled)";
  if (!password) warnings.push("the export holds no password for it");
  const totp = checkTotp(rec.totp, warnings);
  return { title: name, urls, username, password, totp, notes: rec.notes ?? "", warnings };
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/**
 * A key the vault could not later make codes from is dropped here, while the
 * import can still say so — not at save, where the refusal would sink the
 * whole row. The warning is deliberately generic: totpParams' own message can
 * quote a character of what was pasted, and this one is going on screen next
 * to a hundred others.
 */
function checkTotp(raw: string | undefined, warnings: string[]): string {
  const totp = (raw ?? "").trim();
  if (!totp) return "";
  try {
    totpParams(totp);
    return totp;
  } catch {
    warnings.push("its one-time password key could not be read and was not imported");
    return "";
  }
}

/**
 * The JSON behind 1Password's "Copy item JSON": overview for the display
 * facts, details.fields for the credentials, sections for the TOTP key.
 * Only a login template ("001") is accepted — a card pasted here must be
 * refused, not squeezed into a login-shaped item.
 */
function parseOnePasswordItemJson(text: string): ParsedImport {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(
      'that is not readable as 1Password item JSON. Right-click the item, choose "Copy item JSON", and paste all of it',
    );
  }
  const item = raw as Record<string, unknown>;
  const overview = item.overview as Record<string, unknown> | undefined;
  const details = item.details as Record<string, unknown> | undefined;
  if (!overview || !details) {
    throw new Error('that JSON is not a 1Password item; expected the shape "Copy item JSON" produces');
  }
  if (typeof item.templateUuid === "string" && item.templateUuid !== "001") {
    throw new Error("only logins can be imported, and this 1Password item is a different type");
  }

  const title = typeof overview.title === "string" ? overview.title.trim() : "";
  if (!title) throw new Error("this 1Password item has no title");

  const fields = Array.isArray(details.fields) ? (details.fields as Array<Record<string, unknown>>) : [];
  const named = (want: string): string | null => {
    const found = fields.find((f) => f.designation === want) ?? fields.find((f) => f.name === want);
    return found && typeof found.value === "string" ? found.value : null;
  };
  const password = named("password");
  const username = named("username");
  if (password === null && username === null) {
    throw new Error("this 1Password item has no username or password fields, so it does not look like a login");
  }

  // The TOTP key lives in a section field: concealed, named TOTP_<uuid> (its
  // label, "one-time password", is the fallback — labels are translated).
  let totpRaw = "";
  const sections = Array.isArray(details.sections) ? (details.sections as Array<Record<string, unknown>>) : [];
  for (const section of sections) {
    const sfields = Array.isArray(section.fields) ? (section.fields as Array<Record<string, unknown>>) : [];
    for (const f of sfields) {
      const isTotp =
        (typeof f.n === "string" && /^TOTP_/i.test(f.n)) ||
        (typeof f.t === "string" && /one[\s-]?time password/i.test(f.t));
      if (isTotp && typeof f.v === "string" && f.v.trim()) totpRaw = f.v.trim();
    }
  }

  const urlList = Array.isArray(overview.URLs) ? (overview.URLs as Array<Record<string, unknown>>) : [];
  const rawUrls = urlList.map((u) => (typeof u.u === "string" ? u.u.trim() : "")).filter(Boolean);
  if (rawUrls.length === 0 && typeof overview.url === "string" && overview.url.trim()) {
    rawUrls.push(overview.url.trim());
  }
  const skipped: SkippedRow[] = [];
  if (rawUrls.length === 0) {
    skipped.push({
      title,
      reason: "has no website address; add it by hand as a new item instead",
    });
    return { source: "1Password item", logins: [], skipped };
  }
  let urls: string[];
  try {
    urls = checkedUrls(rawUrls);
  } catch {
    skipped.push({ title, reason: "its website address could not be read" });
    return { source: "1Password item", logins: [], skipped };
  }

  const warnings: string[] = [];
  if (!password) warnings.push("the item holds no password");
  const totp = checkTotp(totpRaw, warnings);
  const notes = typeof details.notesPlain === "string" ? details.notesPlain : "";
  return {
    source: "1Password item",
    logins: [{ title, urls, username: username ?? "", password: password ?? "", totp, notes, warnings }],
    skipped,
  };
}

const dupKey = (title: string, username: string, url: string): string =>
  `${title} ${username} ${url}`;

/**
 * Sort each row against what the vault already holds: the same name, username
 * and first site is THE SAME ITEM, and then the secrets decide. Identical
 * secrets flag a duplicate the commit leaves alone — running an export twice
 * must not double the vault. A password or key that CHANGED in the source
 * flags an update instead: the row becomes an edit of the matched item,
 * pinned to the revision read here so a save landing in between is refused,
 * not overwritten. The comparison happens inside the vault (secretsDiffer);
 * no stored value surfaces to make it.
 */
export async function markAgainstVault(vault: LocalVault, logins: ImportedLogin[]): Promise<void> {
  const existing = new Map(
    (await vault.list())
      .filter((s) => s.type === "login")
      .map((s) => [dupKey(s.title, s.subtitle, s.urls[0] ?? ""), s]),
  );
  for (const login of logins) {
    const match = existing.get(dupKey(login.title, login.username, login.urls[0] ?? ""));
    if (!match) continue;
    const diff = await vault.secretsDiffer(match.id, { password: login.password, totp: login.totp });
    const fields = (["password", "totp"] as const).filter((f) => diff[f]);
    if (fields.length) login.update = { itemId: match.id, revision: diff.revision, fields: [...fields] };
    else login.duplicate = true;
  }
}

/** One preview row — everything the screen shows, and never a secret value. */
export interface ImportPreviewItem {
  title: string;
  username: string;
  url: string;
  hasPassword: boolean;
  hasTotp: boolean;
  warnings: string[];
  duplicate: boolean;
  /** Which secrets changed on an item the vault already holds — importing
   * this row updates that item's named fields. Empty for a new row. */
  changed: ("password" | "totp")[];
}

export interface ImportPreview {
  source: string;
  items: ImportPreviewItem[];
  skipped: SkippedRow[];
}

/** What the renderer is shown before it may commit: facts about each row,
 * with the password and the key reduced to whether one is there. */
export function importPreview(parsed: ParsedImport): ImportPreview {
  return {
    source: parsed.source,
    items: parsed.logins.map((l) => ({
      title: l.title,
      username: l.username,
      url: l.urls[0] ?? "",
      hasPassword: l.password !== "",
      hasTotp: l.totp !== "",
      warnings: l.warnings,
      duplicate: l.duplicate === true,
      changed: l.update ? [...l.update.fields] : [],
    })),
    skipped: parsed.skipped,
  };
}

export interface ImportResult {
  saved: number;
  /** Existing items whose changed password or key was written over. */
  updated: number;
  /** Rows left alone because markAgainstVault flagged them identical. */
  duplicates: number;
  failed: SkippedRow[];
}

/**
 * Save every un-flagged login through the vault's own save — validation,
 * encryption and the CREATED/UPDATED audit lines are all the ordinary ones.
 * An update row edits ONLY the secret fields that changed: the name, sites,
 * username and notes the owner may have tuned in the vault stay theirs, and
 * the revision pinned at inspect makes a save that landed in between a
 * refusal, not an overwrite. One bad row must not sink the rest, so failures
 * are collected, not thrown.
 */
export async function importLogins(vault: LocalVault, logins: ImportedLogin[]): Promise<ImportResult> {
  let saved = 0;
  let updated = 0;
  let duplicates = 0;
  const failed: SkippedRow[] = [];
  for (const login of logins) {
    if (login.duplicate) {
      duplicates++;
      continue;
    }
    try {
      if (login.update) {
        await vault.save({
          itemId: login.update.itemId,
          revision: login.update.revision,
          ...(login.update.fields.includes("password") ? { password: login.password } : {}),
          ...(login.update.fields.includes("totp") ? { totp: login.totp } : {}),
        });
        updated++;
        continue;
      }
      await vault.save({
        type: "login",
        name: login.title,
        urls: login.urls,
        username: login.username,
        password: login.password,
        ...(login.totp ? { totp: login.totp } : {}),
        notes: login.notes,
      });
      saved++;
    } catch (err) {
      failed.push({ title: login.title, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return { saved, updated, duplicates, failed };
}

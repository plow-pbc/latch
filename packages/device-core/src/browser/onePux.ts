/**
 * 1PUX — 1Password's unencrypted export. A zip holding export.attributes,
 * export.data and a files/ folder of attachments; export.data nests items
 * inside their vaults inside their accounts. Only export.data is read, and
 * of it only login items: everything else is set aside with its reason, the
 * way the CSV path sets rows aside. Every row names its vault, which is
 * what lets the Import sheet offer a pick before anything is saved.
 *
 * The zip reader below is the minimum the format needs — stored or deflated
 * entries, no zip64, no encryption — so no dependency ships for it. The
 * standing rule of passwordImport.ts holds here: no error, warning or skip
 * reason ever contains a field's value.
 */
import zlib from "node:zlib";
import { checkedUrls } from "./vaultItems.js";
import { finishImportedLogin, type ImportedLogin, type ParsedImport, type SkippedRow } from "./passwordImport.js";

const NOT_1PUX = "this doesn't look like a 1PUX export. In 1Password choose File > Export, pick your account, and choose the 1PUX format";

// A legitimate export.data is at most a few MB even with thousands of items;
// this bounds what a corrupted or hostile entry can inflate to, so a bad
// stream fails fast instead of exhausting memory (a classic zip bomb).
const MAX_INFLATED_BYTES = 64 * 1024 * 1024;

/** What a non-login category is called when it is set aside. */
const CATEGORY_NAMES: Record<string, string> = {
  "002": "a credit card",
  "003": "a secure note",
  "004": "an identity",
  "005": "a saved password",
  "006": "a document",
  "100": "a software license",
  "101": "a bank account",
  "110": "a server",
  "111": "an email account",
  "112": "an API credential",
  "114": "an SSH key",
  "115": "a crypto wallet",
};

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : {});
const list = (v: unknown): Rec[] => (Array.isArray(v) ? v.map(rec) : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function parseOnePux(bytes: Uint8Array): ParsedImport {
  const data = zipEntry(bytes, "export.data");
  if (!data) throw new Error(NOT_1PUX);
  let root: Rec;
  try {
    root = rec(JSON.parse(Buffer.from(data).toString("utf8")));
  } catch {
    throw new Error(NOT_1PUX);
  }
  if (!Array.isArray(root.accounts)) throw new Error(NOT_1PUX);

  const logins: ImportedLogin[] = [];
  const skipped: SkippedRow[] = [];
  for (const account of list(root.accounts)) {
    for (const vault of list(account.vaults)) {
      const vaultName = str(rec(vault.attrs).name).trim() || "Vault";
      for (const item of list(vault.items)) {
        const login = itemToLogin(item, vaultName, skipped);
        if (login) logins.push(login);
      }
    }
  }
  return { source: "1Password", logins, skipped };
}

function itemToLogin(item: Rec, vault: string, skipped: SkippedRow[]): ImportedLogin | null {
  const overview = rec(item.overview);
  const details = rec(item.details);
  const rawTitle = str(overview.title).trim();
  const title = rawTitle || "(untitled)";
  const skip = (reason: string) => { skipped.push({ title, reason, vault }); return null; };

  const category = str(item.categoryUuid);
  if (category !== "001") return skip(`${CATEGORY_NAMES[category] ?? "another kind of item"}, not a login`);
  if (str(item.state) === "archived") return skip("archived in 1Password");

  const rawUrls = list(overview.urls).map((u) => str(u.url).trim()).filter(Boolean);
  if (rawUrls.length === 0 && str(overview.url).trim()) rawUrls.push(str(overview.url).trim());
  if (rawUrls.length === 0) return skip("has no website address; add it by hand as a new item if you still use it");
  // One bad URL should not sink the whole login: keep whichever ones
  // checkedUrls accepts on their own, and only give up when none survive.
  const urls = rawUrls.flatMap((u) => {
    try {
      return checkedUrls([u]);
    } catch {
      return [];
    }
  });
  if (urls.length === 0) return skip("its website address could not be read");

  const fields = list(details.loginFields);
  const designated = (want: string) => str(fields.find((f) => f.designation === want)?.value);

  // The TOTP lives in a section field: a `totp` value, or a concealed one
  // under a TOTP_<id> field or a "one-time password" label (labels are
  // translated, so the id is the surer sign).
  let totpRaw = "";
  for (const section of list(details.sections)) {
    for (const f of list(section.fields)) {
      const value = rec(f.value);
      const looksTotp = /^TOTP_/i.test(str(f.id)) || /one[\s-]?time password/i.test(str(f.title));
      const candidate = str(value.totp) || (looksTotp ? str(value.concealed) : "");
      if (candidate.trim()) totpRaw = candidate.trim();
    }
  }

  const login = finishImportedLogin(
    { title: rawTitle, urls, username: designated("username").trim(), password: designated("password"), totpRaw, notes: str(details.notesPlain) },
    [],
  );
  return { ...login, vault };
}

/**
 * The bytes of one named entry, or null when the zip has no such entry.
 * Throws NOT_1PUX for anything that is not a zip this reader understands.
 * Walks the central directory from the end record, then the entry's local
 * header — the sizes in the local header can legally be zero (streamed
 * writers), so the central directory's are the ones used.
 */
function zipEntry(bytes: Uint8Array, name: string): Uint8Array | null {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.length < 22 || buf.readUInt16LE(0) !== 0x4b50) throw new Error(NOT_1PUX);
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error(NOT_1PUX);
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  for (let n = 0; n < count; n++) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== 0x02014b50) throw new Error(NOT_1PUX);
    const method = buf.readUInt16LE(at + 10);
    const compressed = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const entryName = buf.toString("utf8", at + 46, at + 46 + nameLen);
    at += 46 + nameLen + extraLen + commentLen;
    if (entryName !== name) continue;
    if (compressed === 0xffffffff || local === 0xffffffff) throw new Error("that export is too large to read");
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new Error(NOT_1PUX);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + compressed);
    if (method === 0) return data;
    if (method === 8) {
      try {
        return zlib.inflateRawSync(data, { maxOutputLength: MAX_INFLATED_BYTES });
      } catch {
        throw new Error(NOT_1PUX);
      }
    }
    throw new Error("that export is compressed in a way this importer cannot read");
  }
  return null;
}

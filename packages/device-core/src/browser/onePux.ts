/**
 * 1PUX — 1Password's unencrypted export. A zip holding export.attributes,
 * export.data and a files/ folder of attachments; export.data nests items
 * inside their vaults inside their accounts. Only export.data is read, and
 * of it only login items: everything else is set aside with its reason, the
 * way the CSV path sets rows aside. Every row names its vault, which is
 * what lets the Import sheet offer a pick before anything is saved.
 *
 * export.data is read with adm-zip: stored and deflated entries, the CRC
 * checked. The read is bounded before it happens: a deflated entry inflates
 * up to its declared size (refused when it declares none), a stored one is
 * copied at its compressed length, and both must be under 64 MiB — so
 * neither a lying header nor a zip bomb can run away with memory.
 * The standing rule of passwordImport.ts holds here: no error, warning or
 * skip reason ever contains a field's value.
 */
import AdmZip from "adm-zip";
import { finishImportedLogin, normalizeImportUrls, type ImportedLogin, type ImportVault, type ParsedImport, type SkippedRow } from "./passwordImport.js";

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
  let zip: AdmZip;
  try {
    zip = new AdmZip(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  } catch {
    throw new Error(NOT_1PUX);
  }
  const entry = zip.getEntry("export.data");
  if (!entry) throw new Error(NOT_1PUX);
  if (entry.header.size <= 0) throw new Error(NOT_1PUX); // a zero declares no bound at all
  // Both sizes are bounded BEFORE the read: a deflated entry inflates up to
  // its declared size, and a stored one is copied at its compressed length
  // whatever the header declares — so neither may exceed the cap.
  const { size, compressedSize } = entry.header;
  if (size > MAX_INFLATED_BYTES || compressedSize > MAX_INFLATED_BYTES) {
    throw new Error("that export is too large to read");
  }
  let data: Buffer;
  try {
    data = entry.getData();
  } catch {
    throw new Error(NOT_1PUX);
  }
  let root: Rec;
  try {
    root = rec(JSON.parse(data.toString("utf8")));
  } catch {
    throw new Error(NOT_1PUX);
  }
  if (!Array.isArray(root.accounts)) throw new Error(NOT_1PUX);

  const logins: ImportedLogin[] = [];
  const skipped: SkippedRow[] = [];
  for (const account of list(root.accounts)) {
    for (const vault of list(account.vaults)) {
      const attrs = rec(vault.attrs);
      const name = str(attrs.name).trim() || "Vault";
      const from: ImportVault = { id: str(attrs.uuid).trim() || name, name };
      for (const item of list(vault.items)) {
        const login = itemToLogin(item, from, skipped);
        if (login) logins.push(login);
      }
    }
  }
  return { source: "1Password", logins, skipped };
}

function itemToLogin(item: Rec, vault: ImportVault, skipped: SkippedRow[]): ImportedLogin | null {
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
  // One bad URL should not sink the whole login: only give up when none survive.
  const { urls, dropped } = normalizeImportUrls(rawUrls);
  if (urls.length === 0) return skip("its website address could not be read");
  const warnings: string[] = [];
  if (dropped) warnings.push("one of its website addresses could not be read and was left off");

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
    warnings,
  );
  return { ...login, vault };
}

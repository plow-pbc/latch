/**
 * Credential exchange: passwords handed over app-to-app by macOS 26's
 * AuthenticationServices credential-exchange flow (Apple Passwords' "Export to
 * another app…"), read into the shapes this vault saves.
 *
 * The input here is NOT what Apple's API returns. The desktop app's Swift shim
 * (apps/desktop/native/credential-import.swift) receives the system's
 * ASExportedCredentialData — Swift-only types whose JSON encoding is Apple's
 * to change — and re-emits the small, versioned wire JSON parsed below. That
 * keeps every mapping decision HERE, pure and testable, and keeps the Swift
 * side a dumb transcription with nothing to get wrong twice.
 *
 * Same rules as passwordImport.ts, whose ParsedImport this produces: logins
 * only, and no error message, warning or skip reason ever contains a field's
 * VALUE — everything returned is shown on screen.
 */
import { finishImportedLogin } from "./passwordImport.js";
import type { ImportedLogin, ParsedImport, SkippedRow } from "./passwordImport.js";
import { checkedUrls } from "./vaultItems.js";
import { base32Encode } from "./vaultTotp.js";

/** An authenticator key as the exchange carries it: raw bytes plus the
 * parameters, not yet any of the spellings the vault stores. */
export interface ExchangeTotp {
  secretBase64: string;
  period: number;
  digits: number;
  /** "sha1" | "sha256" | "sha512" — the exchange's own enum, lowercased. */
  algorithm: string;
  issuer?: string | null;
  userName?: string | null;
}

/** One exported item, already flattened by the Swift shim: the first
 * basic-authentication credential's fields, the first authenticator key, the
 * note text, and the NAMES of every credential type that had no home here. */
export interface ExchangeItem {
  title: string;
  urls: string[];
  username?: string | null;
  password?: string | null;
  totp?: ExchangeTotp | null;
  notes?: string | null;
  /** Wire names of credentials the shim did not carry: "passkey",
   * "creditCard", "sshKey", … — said to the owner, never silently dropped. */
  unsupported: string[];
}

export interface ExchangePayload {
  /** Bumped when the shim's output changes shape; parse refuses what it does
   * not understand rather than guess. */
  version: number;
  /** The exporting app's display name ("Passwords") — shown as the source. */
  exporter: string;
  items: ExchangeItem[];
}

/** The version this parser understands; the Swift shim writes the same one. */
export const EXCHANGE_WIRE_VERSION = 1;

/** Larger than any real exchange; a cap, not a target (passwordImport's). */
const MAX_EXCHANGE_BYTES = 20 * 1024 * 1024;

/** How the wire names read when the owner is told what did not come across. */
const UNSUPPORTED_NAMES: Record<string, string> = {
  passkey: "a passkey",
  address: "an address",
  apiKey: "an API key",
  creditCard: "a credit card",
  customFields: "custom fields",
  driversLicense: "a driver's license",
  generatedPassword: "a generated password",
  identityDocument: "an identity document",
  itemReference: "a linked item",
  passport: "a passport",
  personName: "a name record",
  sshKey: "an SSH key",
  wifi: "a Wi-Fi password",
};

const friendly = (wire: string): string => UNSUPPORTED_NAMES[wire] ?? "data of a kind this vault does not store";

/** "a passkey", "a passkey and a credit card", "a passkey, an SSH key and…" */
const listJoin = (names: string[]): string =>
  names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

/**
 * The wire JSON the Swift shim produced, as the same ParsedImport the CSV
 * paths make — so markAgainstVault, importPreview and importLogins need no
 * second spelling of anything.
 */
export function parseCredentialExchange(json: string): ParsedImport {
  if (json.length > MAX_EXCHANGE_BYTES) {
    throw new Error("that is too large to be a passwords export");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("the hand-off from the other app could not be read");
  }
  const payload = raw as Partial<ExchangePayload>;
  if (payload.version !== EXCHANGE_WIRE_VERSION || !Array.isArray(payload.items)) {
    throw new Error("the hand-off from the other app is a shape this build does not understand");
  }
  const source = typeof payload.exporter === "string" && payload.exporter.trim() !== ""
    ? payload.exporter.trim()
    : "another app";

  const logins: ImportedLogin[] = [];
  const skipped: SkippedRow[] = [];
  for (const item of payload.items) {
    const login = itemToLogin(item, skipped);
    if (login) logins.push(login);
  }
  return { source, logins, skipped };
}

function itemToLogin(item: ExchangeItem, skipped: SkippedRow[]): ImportedLogin | null {
  const title = (item.title ?? "").trim();
  const username = (item.username ?? "").trim();
  const password = item.password ?? "";
  const extras = (Array.isArray(item.unsupported) ? item.unsupported : []).map(friendly);

  // Nothing login-shaped at all: a credit card, an identity document, a bare
  // note. Said with what it IS, so the owner knows the item was seen.
  if (!username && !password && !item.totp) {
    skipped.push({
      title: title || "(untitled)",
      reason: extras.length
        ? `is ${listJoin([...new Set(extras)])}, not a login`
        : "holds no username, password or one-time password key",
    });
    return null;
  }

  const rawUrls = (Array.isArray(item.urls) ? item.urls : [])
    .filter((u): u is string => typeof u === "string" && u.trim() !== "");
  if (rawUrls.length === 0) {
    // The vault refuses a login with no site — it can never be filled — same
    // as the CSV path, and said the same way.
    skipped.push({
      title: title || "(untitled)",
      reason: "has no website address; add it by hand as a new item if you still use it",
    });
    return null;
  }
  // One unreadable address must not sink an item that has readable ones.
  const urls: string[] = [];
  for (const u of rawUrls) {
    try {
      urls.push(...checkedUrls([u]));
    } catch {
      /* counted below by comparing lengths */
    }
  }
  if (urls.length === 0) {
    skipped.push({ title: title || "(untitled)", reason: "its website address could not be read" });
    return null;
  }

  const warnings: string[] = [];
  if (urls.length < rawUrls.length) {
    warnings.push("one of its website addresses could not be read and was left off");
  }
  // The shared last mile (passwordImport.ts): title fallback, no-password
  // warning, and the key checked and warned about in the one place that
  // words those — this parser only SPELLS the key first (below).
  const login = finishImportedLogin(
    {
      title,
      urls,
      username,
      password,
      totpRaw: item.totp ? totpKeySpelling(item.totp, title) : "",
      notes: item.notes ?? "",
    },
    warnings,
  );
  if (extras.length) {
    login.warnings.push(`also carries ${listJoin([...new Set(extras)])}, which was not imported`);
  }
  return login;
}

/**
 * The stored spelling of an exchanged authenticator key: bare base32 when the
 * parameters are the defaults every issuer uses, the full otpauth:// URI when
 * they are not — that URI is the only spelling that can carry them. Spelling
 * only: validation and the drop-with-a-warning live in checkTotp, inside
 * finishImportedLogin above, so a secret that cannot become a key is handed
 * over as a spelling checkTotp is certain to refuse rather than warned about
 * in a second voice here.
 */
function totpKeySpelling(t: ExchangeTotp, title: string): string {
  const secret = Buffer.from(t.secretBase64 ?? "", "base64");
  if (secret.length === 0) return "!"; // no base32 alphabet — refused downstream
  const b32 = base32Encode(secret);
  const algorithm = (t.algorithm || "sha1").toLowerCase();
  const digits = t.digits || 6;
  const period = t.period || 30;
  if (algorithm === "sha1" && digits === 6 && period === 30) return b32;
  const issuer = (t.issuer ?? "").trim();
  const user = (t.userName ?? "").trim();
  const label = issuer && user ? `${issuer}:${user}` : issuer || user || title || "login";
  const params = new URLSearchParams({
    secret: b32,
    algorithm: algorithm.toUpperCase(),
    digits: String(digits),
    period: String(period),
  });
  if (issuer) params.set("issuer", issuer);
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}

/**
 * Vault items, in the clear and back again.
 *
 * Everything a vault item carries is an EncString: its name, its notes, and
 * every field of whichever of the four shapes it has. This module is the whole
 * translation between what the vault stores and what the app shows — no HTTP,
 * no state, so the round trip is testable without a vault.
 *
 * Newer items carry their own key, wrapped with the account key; older ones are
 * encrypted with the account key directly. Both are read here, and an item is
 * always written back under the key it already had.
 */
import crypto from "node:crypto";
import { decString, encString } from "./vaultCrypto.js";
import { expiryPart, parseIso } from "./dateFormat.js";

/** The four types this vault models. (Its enum reserves 5-8; no client here
 * can create one, so nothing below knows about them.) */
export type VaultItemType = "login" | "card" | "identity" | "note";

const TYPE_CODE: Record<VaultItemType, number> = { login: 1, note: 2, card: 3, identity: 4 };
const TYPE_NAME: Record<number, VaultItemType> = { 1: "login", 2: "note", 3: "card", 4: "identity" };
/** Where each type keeps its fields inside a cipher. */
const TYPE_BODY: Record<number, string> = { 1: "login", 2: "secureNote", 3: "card", 4: "identity" };

const LOGIN_KEYS = ["username", "password", "totp"] as const;
const CARD_KEYS = ["cardholderName", "brand", "number", "expMonth", "expYear", "code"] as const;
const IDENTITY_KEYS = [
  "title", "firstName", "middleName", "lastName", "company",
  "address1", "address2", "address3", "city", "state", "postalCode", "country",
  "email", "phone", "ssn", "username", "passportNumber", "licenseNumber",
  "birthDate",
] as const;

/** Values never handed back with the item. They are asked for one at a time. */
const SECRET_KEYS: Record<number, readonly string[]> = {
  1: ["password", "totp"],
  3: ["number", "code"],
  4: ["ssn", "passportNumber", "licenseNumber"],
};

const KEYS_FOR: Record<number, readonly string[]> = {
  1: LOGIN_KEYS,
  2: [],
  3: CARD_KEYS,
  4: IDENTITY_KEYS,
};

export interface VaultKey {
  enc: Buffer;
  mac: Buffer;
}

/** A 64-byte account or item key, split into its two halves. */
export function splitKey(key: Buffer): VaultKey {
  return { enc: key.subarray(0, 32), mac: key.subarray(32, 64) };
}

export interface Cipher {
  id?: string;
  type?: number;
  key?: string | null;
  name?: string;
  notes?: string | null;
  /** Nonzero when the vault has been told to ask for the password again
   * before this item is shown or changed. */
  reprompt?: number;
  login?: {
    username?: string | null;
    password?: string | null;
    totp?: string | null;
    /** A stored entry carries a match rule this app does not interpret, and a
     * checksum of its address that every other client verifies. */
    uris?: Array<{ uri?: string | null; uriChecksum?: string | null; match?: number | null }> | null;
  } | null;
  card?: Record<string, string | null> | null;
  identity?: Record<string, string | null> | null;
  secureNote?: { type?: number } | null;
  [k: string]: unknown;
}

export interface VaultItemSummary {
  id: string;
  title: string;
  /** One of the four editable types, or "unsupported": a shape migrated from
   * the old vault (an SSH key, say) that this app's forms cannot edit. Listed
   * rather than hidden or fatal — hidden reads as a lost item, and one such
   * item must never take the whole vault down with it. */
  type: VaultItemType | "unsupported";
  /** One line of context: the username, or the card's brand, or the name on an identity. */
  subtitle: string;
  urls: string[];
}

export interface VaultItem {
  id: string;
  /** What the vault says this item's last write was. Handed back on save so a
   * form that has gone stale is refused instead of overwriting the newer one. */
  revision: string;
  name: string;
  type: VaultItemType;
  notes: string;
  urls: string[];
  /** The type's own fields; a secret one is present but null. */
  fields: Record<string, string | null>;
  /** Which of those fields hold a secret the owner can ask to see. */
  secrets: string[];
}

/** What the app sends to write an item. Omitted keys keep what is stored. */
export interface VaultItemInput {
  itemId?: string;
  /** The revision the form was opened on. Supplied, and no longer the vault's
   * current one, means someone else wrote this item first. */
  revision?: string;
  type?: VaultItemType;
  name?: string;
  notes?: string;
  /** Every URL the form showed, in order. Omitted means "leave them alone". */
  urls?: string[];
  [field: string]: string | string[] | undefined;
}

/**
 * The key this item's own fields are encrypted with: its own, when it has one,
 * else the account key. Writing an item back under a different key than it was
 * read with is how a vault loses data, so this is the one place that decides.
 */
function itemKey(cipher: Cipher, account: VaultKey): VaultKey {
  if (!cipher.key) return account;
  return splitKey(decString(cipher.key, account.enc, account.mac));
}

const dec = (value: string | null | undefined, key: VaultKey): string =>
  value ? decString(value, key.enc, key.mac).toString("utf8") : "";

const enc = (value: string, key: VaultKey): string | null =>
  value ? encString(Buffer.from(value, "utf8"), key.enc, key.mac) : null;

function body(cipher: Cipher): Record<string, string | null> {
  const at = TYPE_BODY[cipher.type ?? 1];
  return ((cipher[at] as Record<string, string | null> | null) ?? {}) as Record<string, string | null>;
}

/**
 * The checksum a URL is stored with: base64 SHA-256 of the address itself,
 * encrypted like everything else.
 *
 * Every current client drops, silently, a URL whose checksum is missing on an
 * item that carries its own key — the guard against a server slipping an extra
 * site into a login. Ours carry their own key, so a URL written without one is
 * a URL that only this app can see: the vault's page shows none, the CLI lists
 * none, and a fill refuses for want of a site.
 */
function checksum(url: string, key: VaultKey): string | null {
  return enc(crypto.createHash("sha256").update(url, "utf8").digest("base64"), key);
}

function urlsOf(cipher: Cipher, key: VaultKey): string[] {
  return (cipher.login?.uris ?? []).map((u) => dec(u?.uri, key)).filter(Boolean);
}

/** One line about the item that is not a secret and not its name. */
function subtitleOf(type: number, fields: Record<string, string>): string {
  if (type === 1) return fields.username ?? "";
  if (type === 3) return [fields.brand, fields.expMonth && fields.expYear ? `${fields.expMonth}/${fields.expYear}` : ""].filter(Boolean).join(" · ");
  if (type === 4) return [fields.firstName, fields.lastName].filter(Boolean).join(" ") || (fields.email ?? "");
  return "";
}

/**
 * The type this item is, or a refusal.
 *
 * The enum reserves 5-8 (SSH key, bank account, licence, passport), and a
 * vault migrated from the old server can hold a 5. Treating one of those as a
 * login would show a form of empty login fields and accept a save that
 * silently went nowhere — the item's real body is not the one being written.
 */
function typeOf(cipher: Cipher): number {
  const type = cipher.type ?? 1;
  if (!TYPE_NAME[type]) {
    throw new Error(`this app cannot edit item type ${type}; it can only be deleted here`);
  }
  return type;
}

export function decryptSummary(cipher: Cipher, account: VaultKey): VaultItemSummary {
  const key = itemKey(cipher, account);
  if (!TYPE_NAME[cipher.type ?? 1]) {
    // A shape the forms cannot edit still gets a row: its name decrypts like
    // any other (the name is outside the typed body), and one such item must
    // not make the whole listing fail — the only other way in is gone.
    return {
      id: String(cipher.id ?? ""),
      title: dec(cipher.name, key),
      type: "unsupported",
      subtitle: "",
      urls: [],
    };
  }
  const type = typeOf(cipher);
  const raw = body(cipher);
  const shown: Record<string, string> = {};
  for (const field of KEYS_FOR[type] ?? []) {
    if (!(SECRET_KEYS[type] ?? []).includes(field)) shown[field] = dec(raw[field], key);
  }
  return {
    id: String(cipher.id ?? ""),
    title: dec(cipher.name, key),
    type: TYPE_NAME[type],
    subtitle: subtitleOf(type, shown),
    urls: urlsOf(cipher, key),
  };
}

/** What the tab calls each type, so "card" finds the cards and "note" the notes. */
const TYPE_LABEL: Record<VaultItemType, string> = { login: "Login", card: "Card", identity: "Identity", note: "Secure note" };

/**
 * Every string of one item, in the clear, for the tab's search — which runs
 * HERE, so the listing the renderer holds stays secret-free. The name, the
 * notes, every URL, every typed field, every custom field a migrated item
 * still carries, and the type's name.
 *
 * Secrets are in it too — the owner wants a password to be searchable —
 * except for an item marked `reprompt`. That item demands proof of presence
 * before a value is shown, and a search hit is an oracle for the value (type
 * a guess, see whether the row stays), so it matches on its open fields only.
 * A custom field's value is treated as a secret when the field is hidden
 * (type 1) and open otherwise; its name is always open.
 *
 * An item of a type the forms refuse is still searchable by what it holds:
 * the search is the only way its owner can reach it by content. A migrated
 * SSH key's public key and fingerprint are open and its private key is a
 * secret; the enum's 6-8 (bank account, licence, passport) are all of them
 * details a gated item must not answer for, so their body is a secret whole.
 */
export function decryptHaystack(cipher: Cipher, account: VaultKey): string[] {
  const key = itemKey(cipher, account);
  const gated = !!cipher.reprompt;
  const out: string[] = [dec(cipher.name, key), dec(cipher.notes, key), ...urlsOf(cipher, key)];
  const type = cipher.type ?? 1;
  if (TYPE_NAME[type]) {
    out.push(TYPE_LABEL[TYPE_NAME[type]]);
    const raw = body(cipher);
    const secret = SECRET_KEYS[type] ?? [];
    for (const field of KEYS_FOR[type] ?? []) {
      if (gated && secret.includes(field)) continue;
      out.push(dec(raw[field], key));
    }
  } else {
    const ssh = decryptRecord(cipher.sshKey as Record<string, string | null> | null | undefined, key) ?? {};
    for (const [field, value] of Object.entries(ssh)) {
      if (!(gated && field === "privateKey")) out.push(value);
    }
    if (!gated) {
      const legacy = decryptRecord(cipher.legacyData as Record<string, string | null> | null | undefined, key) ?? {};
      out.push(...Object.values(legacy));
    }
  }
  const customs = cipher.fields as Array<{ name?: string | null; value?: string | null; type?: number }> | null | undefined;
  for (const f of Array.isArray(customs) ? customs : []) {
    out.push(dec(f?.name, key));
    if (!(gated && f?.type === 1)) out.push(dec(f?.value, key));
  }
  return out.filter(Boolean);
}

/** The whole item an edit form is filled from — with every secret left out. */
export function decryptItem(cipher: Cipher, account: VaultKey): VaultItem {
  const key = itemKey(cipher, account);
  const type = typeOf(cipher);
  const raw = body(cipher);
  const secret = SECRET_KEYS[type] ?? [];
  const fields: Record<string, string | null> = {};
  const held: string[] = [];
  for (const field of KEYS_FOR[type] ?? []) {
    if (secret.includes(field)) {
      fields[field] = null;                       // present, so the form shows it
      if (raw[field]) held.push(field);           // but only offered when there is one
    } else {
      fields[field] = dec(raw[field], key);
    }
  }
  return {
    id: String(cipher.id ?? ""),
    revision: String(cipher.revisionDate ?? ""),
    name: dec(cipher.name, key),
    type: TYPE_NAME[type],
    notes: dec(cipher.notes, key),
    urls: urlsOf(cipher, key),
    fields,
    secrets: held,
  };
}

/** One field in the clear, for the owner who asked to see it. */
export function decryptField(cipher: Cipher, account: VaultKey, field: string): string {
  const key = itemKey(cipher, account);
  if (field === "notes") return dec(cipher.notes, key);
  const value = body(cipher)[field];
  if (!value) throw new Error(`this item has no ${field}`);
  return dec(value, key);
}

/**
 * The cipher to send back, folding what the app supplied onto what is stored.
 *
 * Omitted and empty are different on purpose: a field the app did not send
 * keeps its stored value — which is what lets an edit leave a password alone —
 * and one sent empty is cleared.
 */
export function encryptCipher(
  input: VaultItemInput,
  existing: Cipher | null,
  account: VaultKey,
): Cipher {
  const type = existing ? typeOf(existing) : TYPE_CODE[input.type ?? "login"];
  // A new item gets its own key, the way current clients write them; an
  // existing one keeps whatever key it already has.
  const wrapped = existing ? existing.key ?? null : encString(crypto.randomBytes(64), account.enc, account.mac);
  const key = existing ? itemKey(existing, account) : splitKey(decString(wrapped as string, account.enc, account.mac));
  const stored = existing ? body(existing) : {};

  // An edit is the stored item with the supplied fields written over it.
  // Rebuilding it from scratch instead would quietly drop everything this
  // screen does not show — favourite, reprompt, custom fields, password
  // history — which is data loss dressed up as a save.
  const cipher: Cipher = existing
    ? { ...existing }
    : { favorite: false, reprompt: 0, fields: [], passwordHistory: null };
  cipher.type = type;
  cipher.key = wrapped;
  if (typeof input.name === "string") cipher.name = enc(input.name, key) ?? "";
  if (typeof input.notes === "string") cipher.notes = enc(input.notes, key);

  const out: Record<string, string | null> = { ...stored };
  for (const field of KEYS_FOR[type] ?? []) {
    const given = input[field];
    if (typeof given !== "string") continue;
    if (field === "birthDate" && given !== "" && parseIso(given).d === null) {
      throw new Error("a date of birth is stored as YYYY-MM-DD");
    }
    const normalized = (field === "expMonth" || field === "expYear") && given !== "" ? expiryPart(field, given) : given;
    out[field] = enc(normalized, key);
  }

  cipher.login = null;
  cipher.secureNote = null;
  cipher.card = null;
  cipher.identity = null;
  if (type === 1) {
    // The form shows every URL, so an edit sends every URL, and an emptied row
    // travels as a blank holding its place. A row is therefore the entry that
    // sits at its own position — which is only sound because a save built on a
    // version of the item the vault has since replaced never gets here:
    // staleEdit refuses it first. See LocalVault.save.
    const previous = existing?.login?.uris ?? [];
    delete out.uris;
    let uris = previous;
    if (input.urls !== undefined) {
      uris = input.urls
        .map((u, i) => {
          if (!u) return null;                                // the owner emptied this row
          const held = previous[i];
          const same = !!held && dec(held.uri, key) === u;
          // Unchanged, and visible to every other client: the stored entry as it is.
          if (same && held.uriChecksum) return held;
          // Changed or added, or stored without a checksum — a URL nothing else
          // can see, where rewriting it is the repair. The repair keeps the
          // match rule; a row the owner actually edited does not.
          return { uri: enc(u, key), uriChecksum: checksum(u, key), match: same ? held.match ?? null : null };
        })
        .filter((u): u is NonNullable<typeof u> => u !== null);
    }
    cipher.login = { ...out, uris } as Cipher["login"];
  } else if (type === 2) {
    cipher.secureNote = (existing?.secureNote as { type?: number } | null) ?? { type: 0 };
  } else if (type === 3) {
    cipher.card = out;
  } else {
    cipher.identity = out;
  }
  return cipher;
}

/**
 * One item in the clear, in the wire shape the Bitwarden CLI used to print —
 * which is the shape the credential classifier (credentialClassify.ts) was
 * written against and the mask-classification fixture freezes. Total over
 * item types on purpose, unlike decryptItem: the broker must be able to LOOK
 * at anything a migrated vault holds (an SSH key made in the old web vault,
 * say), even though this app's own forms refuse to edit it.
 */
export interface RawItem {
  id: string;
  type: number;
  name: string;
  notes?: string;
  login?: {
    username?: string;
    password?: string;
    totp?: string;
    uris?: Array<{ uri: string }>;
  };
  card?: Record<string, string>;
  identity?: Record<string, string>;
  sshKey?: Record<string, string>;
  fields?: Array<{ name?: string; value?: string; type?: number; linkedId?: number | null }>;
}

function decryptRecord(raw: Record<string, string | null> | null | undefined, key: VaultKey): Record<string, string> | undefined {
  if (!raw) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string" && v) out[k] = dec(v, key);
  }
  return out;
}

export function decryptRaw(cipher: Cipher, account: VaultKey): RawItem {
  const key = itemKey(cipher, account);
  const out: RawItem = {
    id: String(cipher.id ?? ""),
    type: cipher.type ?? 1,
    name: dec(cipher.name, key),
  };
  if (cipher.notes) out.notes = dec(cipher.notes, key);
  if (cipher.login) {
    out.login = {
      ...(cipher.login.username ? { username: dec(cipher.login.username, key) } : {}),
      ...(cipher.login.password ? { password: dec(cipher.login.password, key) } : {}),
      ...(cipher.login.totp ? { totp: dec(cipher.login.totp, key) } : {}),
      uris: (cipher.login.uris ?? [])
        .map((u) => ({ uri: dec(u?.uri, key) }))
        .filter((u) => u.uri),
    };
  }
  out.card = decryptRecord(cipher.card, key);
  out.identity = decryptRecord(cipher.identity, key);
  out.sshKey = decryptRecord(cipher.sshKey as Record<string, string | null> | null | undefined, key);
  const customs = cipher.fields as Array<{ name?: string | null; value?: string | null; type?: number; linkedId?: number | null }> | null | undefined;
  if (Array.isArray(customs)) {
    out.fields = customs.map((f) => ({
      ...(f.name ? { name: dec(f.name, key) } : {}),
      ...(typeof f.value === "string" && f.value !== "" ? { value: dec(f.value, key) } : {}),
      ...(typeof f.type === "number" ? { type: f.type } : {}),
      ...(f.linkedId !== undefined ? { linkedId: f.linkedId } : {}),
    }));
  }
  return out;
}

/**
 * Whether a save was composed against an item the vault has since rewritten.
 *
 * The form sends the revision it was opened on. If that is no longer the
 * vault's, everything the owner is looking at may be out of date — not only
 * the URLs — so the save has nothing safe to write. An edit that names no
 * revision made no claim about what it saw, which is the same position:
 * it cannot be trusted over whatever is stored. Only a new item is exempt,
 * having no stored version to be behind.
 */
export function staleEdit(existing: Cipher | null, revision: string | undefined): boolean {
  return !!existing && revision !== String(existing.revisionDate ?? "");
}

/**
 * Every URL an item is saved with has to be one a fill can match, and people
 * type "github.com" rather than "https://github.com". A bare host is completed
 * here; anything with no host at all is refused, because a login the fill path
 * can never match is not worth storing.
 */
export function checkedUrls(urls: string[]): string[] {
  if (urls.length === 0) {
    throw new Error("a login needs at least one site URL, or it can never be filled");
  }
  return urls.map((raw) => {
    const candidate = raw.trim().includes("://") ? raw.trim() : `https://${raw.trim()}`;
    let host = "";
    try {
      host = new URL(candidate).hostname;
    } catch {
      host = "";
    }
    if (!host) throw new Error(`could not read a site from ${JSON.stringify(raw)}`);
    return candidate;
  });
}

export { TYPE_CODE, TYPE_NAME };

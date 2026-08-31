/**
 * One-way migration from the old Bitwarden-based vault (a Vaultwarden SQLite
 * database plus a safeStorage-wrapped account) into the local store.
 *
 * This is the code that stays after everything else Bitwarden was deleted,
 * and it is small because of one decision: the new master key IS the old
 * account's user key. Every cipher row is copied verbatim — the EncStrings
 * are never decrypted, so there is no moment where a secret exists in the
 * clear, and a crash at any point leaves either the old vault intact and the
 * new one absent, or both complete (the item file is written last, atomically).
 *
 * The old files are left in place as the owner's backup; the new store's
 * existence is the migration marker. Kept dependencies: masterKeys and
 * decString (vaultCrypto.ts — the live item format anyway), VaultSecretStore
 * (reads the old account; its safeStorage identity is frozen in
 * vaultKeychain.ts, which is why old ciphertext still opens), and
 * /usr/bin/sqlite3, which every macOS ships (Electron 33's Node has no
 * node:sqlite).
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decString, encString, masterKeys } from "./vaultCrypto.js";
import { Cipher, splitKey } from "./vaultItems.js";
import { VaultKeyStore } from "./vaultKeyStore.js";
import { VaultSecretStore } from "./vaultSecretStore.js";
import { VaultStore } from "./vaultStore.js";

const SQLITE = "/usr/bin/sqlite3";

/** Where each type keeps its body inside a cipher — including type 5, which
 * this app's forms refuse but a migrated vault may hold. */
const BODY_KEY: Record<number, string> = { 1: "login", 2: "secureNote", 3: "card", 4: "identity", 5: "sshKey" };

interface LegacyRow {
  uuid: string;
  atype: number;
  name: string;
  notes: string | null;
  fields: string | null;
  data: string;
  password_history: string | null;
  reprompt: number | null;
  key: string | null;
  updated_at: string;
  organization_uuid: string | null;
  user_uuid: string | null;
}

/**
 * Whether a legacy vault worth protecting is here. The database is the
 * evidence — it holds the items — but only a database WITH an account in it:
 * the old server created db.sqlite3 at startup, before its account bootstrap,
 * so an interrupted first run leaves a valid, user-less database that holds
 * nothing and must read as a fresh vault, not as locked forever. A database
 * that cannot be read at all falls back on the other traces of a real
 * account (the account file, the bootstrap marker) — the conservative
 * direction, because "fresh" over real data is the one irreversible answer.
 */
export function legacyVaultPresent(dir: string): boolean {
  const db = path.join(dir, "db.sqlite3");
  if (!fs.existsSync(db)) return false;
  try {
    const out = execFileSync(SQLITE, ["-readonly", db, "SELECT count(*) FROM users;"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"], // the CLI's stderr is our catch, not console noise
    });
    return Number(out.trim()) > 0;
  } catch {
    return (
      fs.existsSync(path.join(dir, "vault-account.enc")) ||
      fs.existsSync(path.join(dir, "account-created"))
    );
  }
}

/**
 * Migrate, if there is anything to migrate. Called from openVaultKey — the
 * shared open path — whenever the item file has not landed yet; a machine
 * with no legacy vault returns without touching anything.
 */
export function migrateLegacyVault(dir: string, keyStore: VaultKeyStore, store: VaultStore): void {
  if (store.exists() || !legacyVaultPresent(dir)) return;

  const secretState = new VaultSecretStore(dir).readState();
  if (secretState.status !== "ok") {
    // The old vault exists and we cannot open its account: locked, not empty,
    // and definitely not a reason to build a new vault over it.
    throw new Error(
      secretState.status === "locked"
        ? "the old vault's account cannot be decrypted on this machine, so its items cannot be migrated"
        : "the old vault has items but no account file; its items cannot be migrated",
    );
  }
  const account = secretState.account;

  const db = readLegacyDb(
    dir,
    [account.email, ...(account.pending ? [account.pending.email] : [])],
  );
  // An interrupted account change left BOTH pairs on disk on purpose (see
  // VaultAccount.pending): the old server may have accepted either before the
  // crash, and only the pair it took unwraps the user key. Try each against
  // the database's own akey — its HMAC says which one is real.
  const pairs = [account, ...(account.pending ? [account.pending] : [])];
  let userKey: Buffer | null = null;
  for (const pair of pairs) {
    const derived = masterKeys(pair.email, pair.password);
    try {
      userKey = decString(db.akey, derived.stretchedEnc, derived.stretchedMac);
      break;
    } catch {
      /* not the pair the vault took; try the other */
    }
  }
  if (!userKey) {
    throw new Error(
      "the old vault's account does not open its key — the account file and the database disagree, so its items cannot be migrated",
    );
  }

  // Anything that can refuse, refuses BEFORE the first write: an org row
  // whose key cannot be recovered aborts here with the key store untouched.
  rewrapOrganizationRows(db, userKey);

  // Key first, items last: a crash in between leaves a key with no items, and
  // THIS run is the one that completes it — migration retries whenever the
  // legacy vault exists and the item file does not, so the half-done state is
  // finished rather than skipped. A key that is already here must be the
  // legacy user key; anything else is some other vault's key, and copying
  // ciphertext it cannot open would read as an empty vault forever.
  const existing = keyStore.readKey();
  if (existing) {
    if (!existing.equals(userKey)) {
      throw new Error(
        "this machine already holds a different vault key; refusing to migrate the old vault over it",
      );
    }
  } else if (keyStore.state().status === "locked") {
    throw new Error("this vault's key cannot be opened on this machine, so the old vault cannot be migrated");
  } else {
    keyStore.writeKey(userKey);
  }
  store.replaceAll(db.rows.map(cipherOf));
}

/**
 * An organization-owned cipher's key is wrapped by the ORG key, not the user
 * key — copied verbatim it would fail its integrity check and take the whole
 * listing down with it. The org key is reachable, though: the database holds
 * it RSA-wrapped to the user's public key, and the user's private key sits
 * beside it under the user key. So each org row's item key is re-wrapped
 * under the user key — the field ciphertexts are never touched — and a row
 * whose org key cannot be recovered ABORTS the migration before anything is
 * written, rather than migrating a vault that cannot open.
 */
function rewrapOrganizationRows(db: LegacyDb, userKey: Buffer): void {
  const orgRows = db.rows.filter((r) => r.organization_uuid);
  if (orgRows.length === 0) return;
  if (!db.privateKey) {
    throw new Error("the old vault holds organization items but no private key to recover their key with");
  }
  const user = splitKey(userKey);
  const privateKey = crypto.createPrivateKey({
    key: decString(db.privateKey, user.enc, user.mac),
    format: "der",
    type: "pkcs8",
  });
  const orgKeyByUuid = new Map<string, Buffer>();
  for (const { org_uuid, akey } of db.orgKeys) {
    if (akey) orgKeyByUuid.set(org_uuid, decRsaString(akey, privateKey));
  }
  for (const row of orgRows) {
    const orgKey = orgKeyByUuid.get(row.organization_uuid!);
    if (!orgKey) {
      throw new Error(
        "the old vault holds an organization item whose key this account cannot recover; its items cannot be migrated",
      );
    }
    const org = splitKey(orgKey);
    // With its own key: unwrap from the org key, re-wrap under the user key.
    // Without one: the fields sit directly under the org key, so the org key
    // BECOMES the item's own key — the fields stay byte-identical either way.
    const itemKey = row.key ? decString(row.key, org.enc, org.mac) : orgKey;
    row.key = encString(itemKey, user.enc, user.mac);
  }
}

/** A Bitwarden RSA EncString (types 3-6: OAEP sha256/sha1, with or without a
 * trailing mac this side has no key for and Bitwarden's own clients ignore). */
function decRsaString(enc: string, privateKey: crypto.KeyObject): Buffer {
  const dot = enc.indexOf(".");
  const type = enc.slice(0, dot);
  const oaepHash = type === "3" || type === "5" ? "sha256" : type === "4" || type === "6" ? "sha1" : null;
  if (!oaepHash) throw new Error(`unexpected RSA EncString type ${type}`);
  const body = enc.slice(dot + 1).split("|")[0];
  return crypto.privateDecrypt(
    { key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash },
    Buffer.from(body, "base64"),
  );
}

/**
 * The one way a vault gets opened — shared by the owner's side (LocalVault)
 * and the agent's (BrokerCore), so a fresh install and a pending migration
 * behave the same whichever side asks first: migrate a legacy vault, mint a
 * key for a genuinely empty one, and refuse a locked one. Returns the master
 * key.
 */
export function openVaultKey(dir: string, keyStore: VaultKeyStore, store: VaultStore): Buffer {
  // A legacy vault is migrated whenever its items have not landed yet — key
  // present or not, so a crash between the key write and the item write is
  // completed on the next open instead of stranding the items.
  if (!store.exists() && legacyVaultPresent(dir)) {
    migrateLegacyVault(dir, keyStore, store);
  }
  const key = keyStore.readKey();
  if (key) return key;
  const state = keyStore.state();
  if (state.status === "empty") {
    if (store.exists()) {
      // Items without a key is a vault someone half-deleted; minting a fresh
      // key would decrypt none of them and LOOK like an empty vault.
      throw new Error("this vault has items but no key; its key file is missing");
    }
    return keyStore.createKey();
  }
  throw new Error(
    state.status === "locked" && state.reason === "no-storage"
      ? "this vault's key needs the app's secure storage, which is not available here"
      : "this vault's key cannot be opened on this machine",
  );
}

interface LegacyDb {
  akey: string;
  privateKey: string | null;
  rows: LegacyRow[];
  orgKeys: Array<{ org_uuid: string; akey: string | null }>;
}

interface LegacyUser {
  uuid: string;
  email: string;
  akey: string;
  private_key: string | null;
}

/**
 * The database, scoped to THE SAVED ACCOUNT — never "the first user". A
 * multi-user database (the old web vault allowed invitations) holds other
 * accounts' keys and other members' RSA-wrapped org keys, none of which this
 * machine's credentials can open: the user row is matched by the saved
 * emails, memberships are that user's rows alone, and ciphers are that
 * user's own plus those of organizations it belongs to. Rows outside that
 * set were never this account's to see and are not this key's to decrypt.
 * (Collection-level ACLs are deliberately NOT replicated: they governed what
 * the server would LIST, not what the org key decrypts, and this is one
 * person's Mac.)
 */
function readLegacyDb(dir: string, emails: string[]): LegacyDb {
  // Read a CLONE: the sqlite CLI may need to recover the WAL, and the old
  // files are the owner's backup — nothing writes to them, ever.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vault-migrate-"));
  try {
    for (const suffix of ["", "-wal", "-shm"]) {
      const from = path.join(dir, `db.sqlite3${suffix}`);
      if (fs.existsSync(from)) fs.copyFileSync(from, path.join(tmp, `db.sqlite3${suffix}`));
    }
    const dbPath = path.join(tmp, "db.sqlite3");
    const users = query<LegacyUser>(dbPath, "SELECT uuid, email, akey, private_key FROM users;");
    if (users.length === 0) throw new Error("the old vault database has no account in it");
    const wanted = emails.map((e) => e.toLowerCase());
    const user = users.find((u) => wanted.includes(u.email.toLowerCase()));
    if (!user) {
      throw new Error("the saved account is not in the old vault database, so its items cannot be migrated");
    }
    const memberships = query<{ org_uuid: string; akey: string | null; user_uuid: string }>(
      dbPath,
      "SELECT org_uuid, akey, user_uuid FROM users_organizations;",
    ).filter((m) => m.user_uuid === user.uuid);
    const orgIds = new Set(memberships.map((m) => m.org_uuid));
    const rows = query<LegacyRow>(
      dbPath,
      "SELECT uuid, atype, name, notes, fields, data, password_history, reprompt, key, updated_at, organization_uuid, user_uuid " +
        "FROM ciphers WHERE deleted_at IS NULL;",
    ).filter((r) => (r.organization_uuid ? orgIds.has(r.organization_uuid) : r.user_uuid === user.uuid));
    return { akey: user.akey, privateKey: user.private_key, rows, orgKeys: memberships };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function query<T>(dbPath: string, sql: string): T[] {
  const out = execFileSync(SQLITE, ["-json", dbPath, sql], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out.trim() ? (JSON.parse(out) as T[]) : [];
}

function cipherOf(row: LegacyRow): Cipher {
  const cipher: Cipher = {
    id: row.uuid,
    type: row.atype,
    name: row.name,
    notes: row.notes ?? null,
    reprompt: row.reprompt ?? 0,
    key: row.key ?? null,
    favorite: false,
    revisionDate: isoOf(row.updated_at),
    fields: row.fields ? (lowerKeys(JSON.parse(row.fields)) as unknown[]) : [],
    passwordHistory: row.password_history ? lowerKeys(JSON.parse(row.password_history)) : null,
  };
  const bodyKey = BODY_KEY[row.atype];
  if (bodyKey) {
    cipher[bodyKey] = lowerKeys(JSON.parse(row.data || "{}"));
  } else {
    // A type these forms have no body slot for (the enum's 6-8). The
    // ciphertext is carried through VERBATIM under a neutral key rather than
    // guessed into a shape or dropped: the row lists as Unsupported either
    // way, and a future reader finds everything still there.
    cipher.legacyData = lowerKeys(JSON.parse(row.data || "{}"));
  }
  return cipher;
}

/** Vaultwarden's own reader lowercases the first letter of every JSON key when
 * it serves these columns (legacy rows were written PascalCase); mirror that
 * so a verbatim copy reads the same as an API response did. */
function lowerKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(lowerKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k.charAt(0).toLowerCase() + k.slice(1)] = lowerKeys(v);
    }
    return out;
  }
  return value;
}

/** "2026-08-20 16:47:33.123456" (Vaultwarden's naive UTC) → ISO-8601. */
function isoOf(updatedAt: string): string {
  const trimmed = updatedAt.trim();
  if (!trimmed) return "";
  if (trimmed.includes("T")) return trimmed;
  return `${trimmed.replace(" ", "T")}Z`;
}

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
 * existence is the migration marker. Kept dependencies: masterKeyAndHash and
 * decString (vaultCrypto.ts — the live item format anyway), VaultSecretStore
 * (reads the old account; its safeStorage identity is frozen in
 * vaultKeychain.ts, which is why old ciphertext still opens), and
 * /usr/bin/sqlite3, which every macOS ships (Electron 33's Node has no
 * node:sqlite).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decString, masterKeyAndHash } from "./vaultCrypto.js";
import { Cipher } from "./vaultItems.js";
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
}

/** The database ALONE is the evidence: it holds the items. An account file
 * without it has nothing to migrate; a database without the account file is a
 * vault whose items exist and cannot be opened — locked, never fresh. */
export function legacyVaultPresent(dir: string): boolean {
  return fs.existsSync(path.join(dir, "db.sqlite3"));
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

  const db = readLegacyDb(dir);
  // An interrupted account change left BOTH pairs on disk on purpose (see
  // VaultAccount.pending): the old server may have accepted either before the
  // crash, and only the pair it took unwraps the user key. Try each against
  // the database's own akey — its HMAC says which one is real.
  const pairs = [account, ...(account.pending ? [account.pending] : [])];
  let userKey: Buffer | null = null;
  for (const pair of pairs) {
    const derived = masterKeyAndHash(pair.email, pair.password);
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

function readLegacyDb(dir: string): { akey: string; rows: LegacyRow[] } {
  // Read a CLONE: the sqlite CLI may need to recover the WAL, and the old
  // files are the owner's backup — nothing writes to them, ever.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vault-migrate-"));
  try {
    for (const suffix of ["", "-wal", "-shm"]) {
      const from = path.join(dir, `db.sqlite3${suffix}`);
      if (fs.existsSync(from)) fs.copyFileSync(from, path.join(tmp, `db.sqlite3${suffix}`));
    }
    const dbPath = path.join(tmp, "db.sqlite3");
    const users = query<{ akey: string }>(dbPath, "SELECT akey FROM users LIMIT 1;");
    if (users.length === 0) throw new Error("the old vault database has no account in it");
    const rows = query<LegacyRow>(
      dbPath,
      "SELECT uuid, atype, name, notes, fields, data, password_history, reprompt, key, updated_at " +
        "FROM ciphers WHERE deleted_at IS NULL;",
    );
    return { akey: users[0].akey, rows };
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
  if (bodyKey) cipher[bodyKey] = lowerKeys(JSON.parse(row.data || "{}"));
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

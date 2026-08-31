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

export function legacyVaultPresent(dir: string): boolean {
  return fs.existsSync(path.join(dir, "db.sqlite3")) && fs.existsSync(path.join(dir, "vault-account.enc"));
}

/**
 * Migrate, if there is anything to migrate. Called by LocalVault.open before
 * it would otherwise mint a fresh key; a machine with no legacy vault returns
 * without touching anything.
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
  const { email, password } = secretState.account;

  const db = readLegacyDb(dir);
  const derived = masterKeyAndHash(email, password);
  const userKey = decString(db.akey, derived.stretchedEnc, derived.stretchedMac);

  // Key first, items last: a crash in between leaves a key with no items,
  // which the next run overwrites nothing to complete (replaceAll is the
  // single atomic write that makes the migration "done").
  if (keyStore.state().status === "empty") keyStore.writeKey(userKey);
  store.replaceAll(db.rows.map(cipherOf));
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

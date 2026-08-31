/**
 * Migration from the old Bitwarden vault: a real Vaultwarden-shaped SQLite
 * database is built with real EncStrings, then migrated, then read back
 * through the new vault. The property the design rests on is asserted
 * directly: ciphertext is copied VERBATIM — the migration never decrypts an
 * item — because the new master key is the old account's user key.
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { encString, masterKeyAndHash } from "../src/browser/vaultCrypto.js";
import { encryptCipher, splitKey, Cipher } from "../src/browser/vaultItems.js";
import { BrokerCore } from "../src/browser/brokerCore.js";
import { LocalVault } from "../src/browser/localVault.js";
import { VaultKeyStore } from "../src/browser/vaultKeyStore.js";
import { legacyVaultPresent, migrateLegacyVault } from "../src/browser/vaultMigrate.js";
import { VaultSecretStore } from "../src/browser/vaultSecretStore.js";
import { VaultStore } from "../src/browser/vaultStore.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-migrate-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const SCHEMA = `
CREATE TABLE users (uuid TEXT PRIMARY KEY, email TEXT, akey TEXT);
CREATE TABLE ciphers (
  uuid TEXT PRIMARY KEY, atype INTEGER, name TEXT, notes TEXT, fields TEXT,
  data TEXT, password_history TEXT, reprompt INTEGER, "key" TEXT,
  updated_at DATETIME, deleted_at DATETIME
);`;

interface LegacyFixture {
  dir: string;
  userKey: Buffer;
  rows: Cipher[];
}

/** A legacy vault on disk: account file + database, exactly as the old stack
 * left them (the account file lands on the test-tier plaintext fallback, the
 * same file VaultSecretStore has always read). */
function legacyVault(extraSql = ""): LegacyFixture {
  const dir = tempDir();
  const email = "agent-3f2a@local";
  const password = crypto.randomBytes(24).toString("base64url");
  new VaultSecretStore(dir).write({ email, password });

  const derived = masterKeyAndHash(email, password);
  const userKey = crypto.randomBytes(64);
  const akey = encString(userKey, derived.stretchedEnc, derived.stretchedMac);
  const account = splitKey(userKey);

  const rows = [
    encryptCipher(
      { type: "login", name: "Pizza", urls: ["https://pizza.example"], username: "jon", password: "hunter2" },
      null,
      account,
    ),
    encryptCipher({ type: "note", name: "Door", notes: "code 4411" }, null, account),
  ];
  rows[0].id = "11111111-0000-0000-0000-000000000001";
  rows[1].id = "11111111-0000-0000-0000-000000000002";

  const inserts = rows
    .map((c, i) => {
      const bodyKey = c.type === 1 ? "login" : "secureNote";
      return (
        `INSERT INTO ciphers VALUES ('${c.id}', ${c.type}, '${c.name}', ` +
        (c.notes ? `'${c.notes}', ` : "NULL, ") +
        `'[]', '${JSON.stringify(c[bodyKey]).replace(/'/g, "''")}', NULL, 0, '${c.key}', ` +
        `'2026-08-2${i} 10:00:0${i}.123456', NULL);`
      );
    })
    .join("\n");
  execFileSync("/usr/bin/sqlite3", [path.join(dir, "db.sqlite3")], {
    input: `${SCHEMA}\nINSERT INTO users VALUES ('u1', '${email}', '${akey}');\n${inserts}\n${extraSql}`,
  });
  return { dir, userKey, rows };
}

describe("migrateLegacyVault", () => {
  it("migrates by copying ciphertext verbatim under the old user key", async () => {
    const { dir, userKey, rows } = legacyVault();
    const keyStore = new VaultKeyStore(dir, "test");
    expect(legacyVaultPresent(dir)).toBe(true);

    migrateLegacyVault(dir, keyStore, new VaultStore(dir));

    // The new master key IS the old user key.
    expect(keyStore.readKey()).toEqual(userKey);
    // Ciphertext byte-for-byte: name EncString and wrapped item key survive.
    const migrated = new VaultStore(dir).get(rows[0].id!)!;
    expect(migrated.name).toBe(rows[0].name);
    expect(migrated.key).toBe(rows[0].key);
    // The old files stay — they are the owner's backup.
    expect(fs.existsSync(path.join(dir, "db.sqlite3"))).toBe(true);

    // And the whole vault reads back through the ordinary path.
    const vault = new LocalVault(dir, keyStore);
    const items = await vault.list();
    expect(items.map((i) => i.title).sort()).toEqual(["Door", "Pizza"]);
    expect(await vault.reveal(rows[0].id!, "password")).toBe("hunter2");
  });

  it("runs implicitly on first vault use, and only once", async () => {
    const { dir, rows } = legacyVault();
    const vault = new LocalVault(dir, new VaultKeyStore(dir, "test"));
    expect((await vault.list()).map((i) => i.title).sort()).toEqual(["Door", "Pizza"]);

    // A later edit is not undone by a second migration attempt.
    await vault.remove(rows[1].id!);
    const again = new LocalVault(dir, new VaultKeyStore(dir, "test"));
    expect((await again.list()).map((i) => i.title)).toEqual(["Pizza"]);
  });

  it("leaves soft-deleted items behind — the old trash does not come along", () => {
    const { dir } = legacyVault(
      "UPDATE ciphers SET deleted_at = '2026-08-25 00:00:00' WHERE uuid = '11111111-0000-0000-0000-000000000002';",
    );
    migrateLegacyVault(dir, new VaultKeyStore(dir, "test"), new VaultStore(dir));
    expect(new VaultStore(dir).readAll()).toHaveLength(1);
  });

  it("lowercases legacy PascalCase JSON keys the way the old server's reader did", async () => {
    const { dir } = legacyVault();
    // Rewrite one row's data with the PascalCase shape early Vaultwarden rows
    // carry. Values must survive; only key spelling changes.
    const db = path.join(dir, "db.sqlite3");
    const [row] = JSON.parse(
      execFileSync("/usr/bin/sqlite3", ["-json", db, "SELECT data FROM ciphers WHERE atype = 1;"], { encoding: "utf8" }),
    ) as [{ data: string }];
    const camel = JSON.parse(row.data) as { username: string; password: string; uris: unknown };
    const pascal = JSON.stringify({ Username: camel.username, Password: camel.password, Uris: camel.uris });
    execFileSync("/usr/bin/sqlite3", [db, `UPDATE ciphers SET data = '${pascal.replace(/'/g, "''")}' WHERE atype = 1;`]);

    migrateLegacyVault(dir, new VaultKeyStore(dir, "test"), new VaultStore(dir));
    const vault = new LocalVault(dir, new VaultKeyStore(dir, "test"));
    const login = (await vault.list()).find((i) => i.type === "login")!;
    expect(login.subtitle).toBe("jon"); // Username → username, decrypted fine
  });

  it("completes a migration that crashed between the key write and the item write", async () => {
    // The crash window vaultMigrate deliberately leaves open: key on disk,
    // items not yet. The next open must finish the copy, not skip it because
    // a key exists — skipped, the owner's items read as an empty vault forever.
    const { dir, userKey, rows } = legacyVault();
    const keyStore = new VaultKeyStore(dir, "test");
    keyStore.writeKey(userKey); // the state the crash leaves behind

    const vault = new LocalVault(dir, keyStore);
    expect((await vault.list()).map((i) => i.title).sort()).toEqual(["Door", "Pizza"]);
    expect(await vault.reveal(rows[0].id!, "password")).toBe("hunter2");
  });

  it("refuses to migrate over a DIFFERENT existing key", () => {
    // A key that is not the legacy user key belongs to some other vault;
    // copying ciphertext it cannot open would read as an empty vault forever.
    const { dir } = legacyVault();
    const keyStore = new VaultKeyStore(dir, "test");
    keyStore.writeKey(crypto.randomBytes(64));
    expect(() => migrateLegacyVault(dir, keyStore, new VaultStore(dir))).toThrow(/different vault key/);
    expect(new VaultStore(dir).exists()).toBe(false);
  });

  it("runs through the agent side too — the broker completes a pending migration", () => {
    // plow_vault list on a just-upgraded machine, before the owner has opened
    // the Vault tab: the broker shares the open path, so the listing works.
    const { dir } = legacyVault();
    const broker = new BrokerCore({ dir, store: new VaultStore(dir), keyStore: new VaultKeyStore(dir, "test") });
    expect(broker.whatsHere().map((i) => i.title).sort()).toEqual(["Door", "Pizza"]);
    expect(new VaultStore(dir).exists()).toBe(true);
  });

  it("refuses to migrate — and to start fresh — when the old account is locked", () => {
    const { dir } = legacyVault();
    fs.writeFileSync(path.join(dir, "vault-account.enc"), Buffer.concat([Buffer.from("ENC1"), Buffer.from("x")]));
    const keyStore = new VaultKeyStore(dir, "test");
    expect(() => migrateLegacyVault(dir, keyStore, new VaultStore(dir))).toThrow(/cannot be decrypted/);
    // Nothing was half-written.
    expect(new VaultStore(dir).exists()).toBe(false);
    expect(keyStore.state()).toEqual({ status: "empty" });
  });

  it("does nothing on a machine with no legacy vault", () => {
    const dir = tempDir();
    migrateLegacyVault(dir, new VaultKeyStore(dir, "test"), new VaultStore(dir));
    expect(new VaultStore(dir).exists()).toBe(false);
  });
});

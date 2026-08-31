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
CREATE TABLE users (uuid TEXT PRIMARY KEY, email TEXT, akey TEXT, private_key TEXT);
CREATE TABLE ciphers (
  uuid TEXT PRIMARY KEY, atype INTEGER, name TEXT, notes TEXT, fields TEXT,
  data TEXT, password_history TEXT, reprompt INTEGER, "key" TEXT,
  updated_at DATETIME, deleted_at DATETIME, organization_uuid TEXT, user_uuid TEXT
);
CREATE TABLE users_organizations (uuid TEXT PRIMARY KEY, user_uuid TEXT, org_uuid TEXT, akey TEXT);`;

interface LegacyFixture {
  dir: string;
  userKey: Buffer;
  rows: Cipher[];
}

/** One INSERT for a cipher row built by encryptCipher. Vaultwarden's rule:
 * a personal row carries user_uuid, an org row carries organization_uuid. */
function cipherInsert(c: Cipher, i: number, bodyKey: string, orgUuid: string | null = null, userUuid = "u1"): string {
  return (
    `INSERT INTO ciphers VALUES ('${c.id}', ${c.type}, '${c.name}', ` +
    (c.notes ? `'${c.notes}', ` : "NULL, ") +
    `'[]', '${JSON.stringify(c[bodyKey]).replace(/'/g, "''")}', NULL, 0, ` +
    (c.key ? `'${c.key}', ` : "NULL, ") +
    `'2026-08-2${i % 10} 10:00:0${i % 10}.123456', NULL, ` +
    (orgUuid ? `'${orgUuid}', NULL);` : `NULL, '${userUuid}');`)
  );
}

/** A legacy vault on disk: account file + database, exactly as the old stack
 * left them (the account file lands on the test-tier plaintext fallback, the
 * same file VaultSecretStore has always read). With `pendingTakes`, the
 * database's key is wrapped under the PENDING pair — the state an interrupted
 * account change leaves when the old server accepted it before the crash.
 * With `org`, the user gets an RSA keypair and one organization login whose
 * key chain runs cipher key -> org key -> RSA -> user private key -> user
 * key, exactly as Vaultwarden stored it. */
function legacyVault(
  extraSql = "",
  opts: { pendingTakes?: boolean; org?: "keyed" | "keyless" | "orphan" | "foreign" } = {},
): LegacyFixture {
  const dir = tempDir();
  const email = "agent-3f2a@local";
  const password = crypto.randomBytes(24).toString("base64url");
  if (opts.pendingTakes) {
    // The current pair is the superseded one; only `pending` opens the key.
    new VaultSecretStore(dir).write({
      email,
      password: crypto.randomBytes(24).toString("base64url"),
      pending: { email, password },
    });
  } else {
    new VaultSecretStore(dir).write({ email, password });
  }

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

  const inserts = [
    ...rows.map((c, i) => cipherInsert(c, i, c.type === 1 ? "login" : "secureNote")),
  ];

  let privateKeySql = "NULL";
  if (opts.org) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    privateKeySql = `'${encString(privateKey.export({ format: "der", type: "pkcs8" }) as Buffer, account.enc, account.mac)}'`;
    const orgKey = crypto.randomBytes(64);
    const orgCipher = encryptCipher(
      { type: "login", name: "Team login", urls: ["https://team.example"], username: "team", password: "org-secret" },
      null,
      splitKey(orgKey),
    );
    orgCipher.id = "11111111-0000-0000-0000-00000000000o";
    if (opts.org === "keyless") {
      // Fields directly under the org key, the shape older org items have —
      // no own item key at all.
      inserts.push(cipherInsert({ ...keylessUnder(splitKey(orgKey)), id: orgCipher.id }, 7, "login", "org-1"));
    } else {
      inserts.push(cipherInsert(orgCipher, 7, "login", "org-1"));
    }
    if (opts.org === "orphan") {
      // A membership whose key was never delivered (invited, not confirmed):
      // the row is visible to this account but its key is unrecoverable.
      inserts.push(`INSERT INTO users_organizations VALUES ('uo1', 'u1', 'org-1', NULL);`);
    } else if (opts.org === "foreign") {
      // The org belongs to somebody else entirely: no membership row for u1.
      inserts.push(`INSERT INTO users VALUES ('u2', 'other@local', '2.x|x|x', NULL);`);
      inserts.push(`INSERT INTO users_organizations VALUES ('uo2', 'u2', 'org-1', '4.${crypto.randomBytes(256).toString("base64")}');`);
    } else {
      const wrapped = crypto.publicEncrypt(
        { key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha1" },
        orgKey,
      );
      inserts.push(`INSERT INTO users_organizations VALUES ('uo1', 'u1', 'org-1', '4.${wrapped.toString("base64")}');`);
    }
  }

  execFileSync("/usr/bin/sqlite3", [path.join(dir, "db.sqlite3")], {
    input: `${SCHEMA}\nINSERT INTO users VALUES ('u1', '${email}', '${akey}', ${privateKeySql});\n${inserts.join("\n")}\n${extraSql}`,
  });
  return { dir, userKey, rows };
}

/** A login whose fields sit DIRECTLY under the given key — no own item key. */
function keylessUnder(key: { enc: Buffer; mac: Buffer }): Cipher {
  const enc = (v: string) => encString(Buffer.from(v, "utf8"), key.enc, key.mac);
  return {
    type: 1,
    name: enc("Team login"),
    notes: null,
    key: null,
    login: { username: enc("team"), password: enc("org-secret"), totp: null, uris: [{ uri: enc("https://team.example") }] },
  };
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

  it.each(["keyed", "keyless"] as const)(
    "rewraps an ORGANIZATION item (%s) so the whole vault still opens",
    async (shape) => {
      const { dir } = legacyVault("", { org: shape });
      const vault = new LocalVault(dir, new VaultKeyStore(dir, "test"));
      const items = await vault.list();
      expect(items.map((i) => i.title).sort()).toEqual(["Door", "Pizza", "Team login"]);
      const team = items.find((i) => i.title === "Team login")!;
      // The field ciphertext was never touched — only its key wrapping moved.
      expect(await vault.reveal(team.id, "password")).toBe("org-secret");
    },
  );

  it("aborts BEFORE writing anything when a member org item's key cannot be recovered", () => {
    // A membership without a delivered key: the row is this account's to see
    // but not to open — refuse the whole migration, fail-closed.
    const { dir } = legacyVault("", { org: "orphan" });
    const keyStore = new VaultKeyStore(dir, "test");
    expect(() => migrateLegacyVault(dir, keyStore, new VaultStore(dir))).toThrow(/cannot recover/);
    // Zero traces: no key minted, no marker written, so a later fix (or a
    // repaired database) still gets to migrate.
    expect(keyStore.state()).toEqual({ status: "empty" });
    expect(new VaultStore(dir).exists()).toBe(false);
  });

  it("skips another account's organization entirely — scoped to the saved account", async () => {
    // A multi-member database: an org this account never belonged to, with
    // another member's RSA-wrapped key that our private key could never open.
    // Its rows were never this account's to see; they are left behind, and
    // the other member's akey must not poison the rewrap.
    const { dir, rows } = legacyVault("", { org: "foreign" });
    const vault = new LocalVault(dir, new VaultKeyStore(dir, "test"));
    expect((await vault.list()).map((i) => i.title).sort()).toEqual(["Door", "Pizza"]);
    expect(await vault.reveal(rows[0].id!, "password")).toBe("hunter2");
  });

  it("refuses a database that does not contain the saved account", () => {
    const { dir } = legacyVault();
    new VaultSecretStore(dir).write({ email: "somebody-else@local", password: "pw" });
    expect(() => migrateLegacyVault(dir, new VaultKeyStore(dir, "test"), new VaultStore(dir))).toThrow(
      /saved account is not in the old vault database/,
    );
    expect(new VaultStore(dir).exists()).toBe(false);
  });

  it("carries an unmapped legacy type's body through verbatim instead of dropping it", () => {
    // Type 7 (driver's licence): our pinned server refused to WRITE these,
    // but an older database can hold one, and silent loss is unretryable
    // once items.json exists.
    const body = JSON.stringify({ LicenseNumber: "2.aaa|bbb|ccc" });
    const { dir } = legacyVault(
      `INSERT INTO ciphers VALUES ('77777777-0000-0000-0000-000000000007', 7, '2.n|n|n', NULL, '[]', '${body}', NULL, 0, NULL, '2026-08-27 10:00:07.123456', NULL, NULL, 'u1');`,
    );
    migrateLegacyVault(dir, new VaultKeyStore(dir, "test"), new VaultStore(dir));
    const row = new VaultStore(dir).get("77777777-0000-0000-0000-000000000007")!;
    expect(row.type).toBe(7);
    expect(row.legacyData).toEqual({ licenseNumber: "2.aaa|bbb|ccc" });
  });

  it("treats a user-less database as NO legacy vault — an interrupted first run starts fresh", async () => {
    // The old server created db.sqlite3 at startup, before account bootstrap;
    // a valid empty database holds nothing worth locking a machine over.
    const dir = tempDir();
    execFileSync("/usr/bin/sqlite3", [path.join(dir, "db.sqlite3")], { input: SCHEMA });
    expect(legacyVaultPresent(dir)).toBe(false);
    const vault = new LocalVault(dir, new VaultKeyStore(dir, "test"));
    expect(await vault.list()).toEqual([]);
  });

  it("falls back to the account traces when the database cannot be read", () => {
    // An unreadable file that sits beside account evidence is treated as a
    // legacy vault (locked) — "fresh" over real data is the one irreversible
    // answer. Without any trace it is not.
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "db.sqlite3"), "not a database");
    expect(legacyVaultPresent(dir)).toBe(false);
    fs.writeFileSync(path.join(dir, "account-created"), "");
    expect(legacyVaultPresent(dir)).toBe(true);
  });

  it("migrates through a PENDING account pair the old server had accepted", async () => {
    // An interrupted password change keeps both pairs on disk on purpose; the
    // database's own key says which one the server took before the crash.
    const { dir, rows } = legacyVault("", { pendingTakes: true });
    const vault = new LocalVault(dir, new VaultKeyStore(dir, "test"));
    expect((await vault.list()).map((i) => i.title).sort()).toEqual(["Door", "Pizza"]);
    expect(await vault.reveal(rows[0].id!, "password")).toBe("hunter2");
  });

  it("treats a legacy database with NO account file as locked, never as fresh", async () => {
    // The items exist and nothing here can open them: minting a new key would
    // report an empty vault sitting beside the owner's real one.
    const { dir } = legacyVault();
    fs.rmSync(path.join(dir, "vault-account.enc"));
    expect(legacyVaultPresent(dir)).toBe(true);

    const keyStore = new VaultKeyStore(dir, "test");
    const vault = new LocalVault(dir, keyStore);
    await expect(vault.list()).rejects.toThrow(/no account file/);
    // Nothing was minted or written.
    expect(keyStore.state()).toEqual({ status: "empty" });
    expect(new VaultStore(dir).exists()).toBe(false);
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

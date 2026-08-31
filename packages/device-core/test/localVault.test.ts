/**
 * The owner's vault over the local store: the whole Vault-tab surface, run
 * headless on the file key provider. The credential audit log is the oracle
 * where one exists — every reveal, code read, save and delete leaves a line,
 * and no line ever carries a value.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalVault } from "../src/browser/localVault.js";
import { VaultKeyStore } from "../src/browser/vaultKeyStore.js";
import { VaultStore } from "../src/browser/vaultStore.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "local-vault-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function vaultIn(dir: string): { vault: LocalVault; auditPath: string } {
  const auditPath = path.join(dir, "credential-audit.log");
  return { vault: new LocalVault(dir, new VaultKeyStore(dir, "test"), auditPath), auditPath };
}

const auditLines = (auditPath: string): string[] =>
  fs.existsSync(auditPath) ? fs.readFileSync(auditPath, "utf8").split("\n").filter(Boolean) : [];

describe("LocalVault", () => {
  it("mints its key on first use and round-trips all four item types", async () => {
    const dir = tempDir();
    const { vault } = vaultIn(dir);
    expect(await vault.list()).toEqual([]);

    const login = await vault.save({
      type: "login", name: "Pizza", urls: ["pizza.example"],
      username: "jon", password: "hunter2", totp: "JBSWY3DPEHPK3PXP",
    });
    await vault.save({ type: "card", name: "Amex", cardholderName: "Jon D", number: "4111111111111111", code: "737", expMonth: "12", expYear: "2030" });
    await vault.save({ type: "identity", name: "Me", firstName: "Jon", lastName: "D", ssn: "078-05-1120" });
    await vault.save({ type: "note", name: "Door code", notes: "side door 4411" });

    const items = await vault.list();
    expect(items.map((i) => i.type).sort()).toEqual(["card", "identity", "login", "note"]);
    // The listing carries context, never secrets.
    expect(JSON.stringify(items)).not.toContain("hunter2");
    expect(JSON.stringify(items)).not.toContain("4111111111111111");

    // What is on disk is ciphertext. Only tokens too long to appear by chance
    // inside base64 are scanned for — a 3-digit CVV shows up in ciphertext by
    // coincidence often enough to make asserting on it a coin flip.
    const raw = fs.readFileSync(path.join(dir, "items.json"), "utf8");
    for (const secret of ["hunter2", "4111111111111111", "078-05-1120", "side door 4411"]) {
      expect(raw).not.toContain(secret);
    }

    // Read fills a form: secret fields present-but-null, offered when held.
    const readBack = await vault.read(login.id);
    expect(readBack.fields.username).toBe("jon");
    expect(readBack.fields.password).toBeNull();
    expect(readBack.secrets).toContain("password");

    // Reveal hands the value to the owner; TOTP hands a code, not the key.
    expect(await vault.reveal(login.id, "password")).toBe("hunter2");
    expect((await vault.totp(login.id)).code).toMatch(/^\d{6}$/);
  });

  it("audits reveals, code reads, saves and deletes — values never", async () => {
    const dir = tempDir();
    const { vault, auditPath } = vaultIn(dir);
    const { id } = await vault.save({ type: "login", name: "A", urls: ["a.example"], password: "pw-secret" });
    await vault.reveal(id, "password");
    await vault.totp(id).catch(() => undefined); // no totp on the item: refused, no line required
    await vault.remove(id);

    const lines = auditLines(auditPath);
    expect(lines.some((l) => l.includes("CREATED"))).toBe(true);
    expect(lines.some((l) => l.includes("SHOWN in app"))).toBe(true);
    expect(lines.some((l) => l.includes("DELETED"))).toBe(true);
    expect(lines.join("\n")).not.toContain("pw-secret");
  });

  it("refuses a stale edit instead of overwriting the newer item", async () => {
    const { vault } = vaultIn(tempDir());
    const { id } = await vault.save({ type: "login", name: "A", urls: ["a.example"], password: "one" });
    const opened = await vault.read(id);
    // Someone else writes it while the form is open.
    await vault.save({ itemId: id, revision: opened.revision, name: "A2" });
    await expect(vault.save({ itemId: id, revision: opened.revision, name: "A3" })).rejects.toThrow(
      /changed somewhere else/,
    );
  });

  it("leaves an omitted secret alone on edit, and clears one sent empty", async () => {
    const { vault } = vaultIn(tempDir());
    const { id } = await vault.save({ type: "login", name: "A", urls: ["a.example"], password: "keepme" });
    let revision = (await vault.read(id)).revision;
    await vault.save({ itemId: id, revision, name: "A renamed" });
    expect(await vault.reveal(id, "password")).toBe("keepme");

    revision = (await vault.read(id)).revision;
    await vault.save({ itemId: id, revision, password: "" });
    await expect(vault.reveal(id, "password")).rejects.toThrow(/has no password/);
  });

  it("keeps a reprompt item shut until the owner answers", async () => {
    const dir = tempDir();
    const { vault } = vaultIn(dir);
    const { id } = await vault.save({ type: "login", name: "A", urls: ["a.example"], password: "pw" });
    // Mark it reprompt the way the vault stores it.
    const store = new VaultStore(dir);
    store.upsert({ ...store.get(id)!, reprompt: 1 });

    await expect(vault.reveal(id, "password")).rejects.toThrow(/confirm it is you/);
    vault.onReprompt = async () => false;
    await expect(vault.reveal(id, "password")).rejects.toThrow(/confirm it is you/);
    vault.onReprompt = async () => true;
    expect(await vault.reveal(id, "password")).toBe("pw");
  });

  it("refuses items-without-key rather than minting a key that opens nothing", async () => {
    const dir = tempDir();
    const { vault } = vaultIn(dir);
    await vault.save({ type: "note", name: "N", notes: "x" });
    fs.rmSync(path.join(dir, "vault-key.enc"));
    const { vault: reopened } = vaultIn(dir);
    await expect(reopened.list()).rejects.toThrow(/items but no key/);
  });

  it("refuses a login save with no usable URL, and a nameless item", async () => {
    const { vault } = vaultIn(tempDir());
    await expect(vault.save({ type: "login", name: "A", urls: [] })).rejects.toThrow(/at least one site URL/);
    await expect(vault.save({ type: "note", name: "  " })).rejects.toThrow(/needs a name/);
  });

  it("refuses a pasted six-digit code where an authenticator key belongs", async () => {
    const { vault } = vaultIn(tempDir());
    await expect(
      vault.save({ type: "login", name: "A", urls: ["a.example"], totp: "123456" }),
    ).rejects.toThrow(/not an authenticator key/);
  });
});

/**
 * Locked is not empty.
 *
 * `read()` collapsed both into `null`, so a vault whose key had moved rendered
 * as "The vault has not started yet." — sending people to look for a server
 * that was running fine. `readState()` keeps the two apart all the way to the
 * screen. These run outside Electron, where `safeStorage` is unavailable, which
 * is itself one of the two locked cases.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VaultSecretStore } from "../src/browser/vaultSecretStore.js";
import { readCredentialsState } from "../src/browser/vaultCredentials.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-state-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("VaultSecretStore.readState", () => {
  it("is empty when no account has ever been written", () => {
    expect(new VaultSecretStore(tempDir()).readState()).toEqual({ status: "empty" });
  });

  it("is ok, and readable, for a plaintext account", () => {
    const dir = tempDir();
    new VaultSecretStore(dir).write({ email: "a@local", password: "pw" });
    expect(new VaultSecretStore(dir).readState()).toEqual({
      status: "ok",
      account: { email: "a@local", password: "pw" },
    });
  });

  it("is LOCKED, not empty, for ciphertext it has no key for", () => {
    const dir = tempDir();
    // An ENC1 file written by an Electron run whose Keychain key is gone — the
    // exact shape the rename left behind on four machines.
    fs.writeFileSync(path.join(dir, "vault-account.enc"), Buffer.concat([Buffer.from("ENC1"), Buffer.from("nonsense")]));
    expect(new VaultSecretStore(dir).readState()).toEqual({ status: "locked", reason: "no-storage" });
  });

  it("is LOCKED, not empty, for a file that will not parse", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "vault-account.enc"), "{ not json");
    expect(new VaultSecretStore(dir).readState()).toEqual({ status: "locked", reason: "undecryptable" });
  });

  it("read() still reports null for both, because bootstrap depends on it", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "vault-account.enc"), Buffer.concat([Buffer.from("ENC1"), Buffer.from("x")]));
    expect(new VaultSecretStore(dir).read()).toBeNull();
  });
});

describe("readCredentialsState", () => {
  it("carries a locked KEY through to the screen instead of flattening it", () => {
    const dir = tempDir();
    // A safeStorage-wrapped key blob outside Electron: ciphertext with no key
    // to open it — the modern version of the rename incident's shape.
    fs.writeFileSync(path.join(dir, "vault-key.enc"), Buffer.concat([Buffer.from("KENC1"), Buffer.from("x")]));
    expect(readCredentialsState(dir)).toEqual({
      status: "locked",
      reason: "no-storage",
    });
  });

  it("says ok for a readable key — and hands over nothing else", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "vault-key.enc"), "KRAW1" + "ab".repeat(64));
    expect(readCredentialsState(dir)).toEqual({ status: "ok" });
  });

  it("reports a legacy vault awaiting migration by its ACCOUNT's state", () => {
    const dir = tempDir();
    // Old Bitwarden vault: database + account file, no new-store key yet.
    fs.writeFileSync(path.join(dir, "db.sqlite3"), "");
    fs.writeFileSync(path.join(dir, "vault-account.enc"), Buffer.concat([Buffer.from("ENC1"), Buffer.from("x")]));
    // Its account cannot be opened here → locked, never "empty": empty is what
    // quietly mints a fresh vault beside the owner's real one.
    expect(readCredentialsState(dir)).toEqual({ status: "locked", reason: "no-storage" });

    new VaultSecretStore(dir).write({ email: "a@local", password: "pw" });
    expect(readCredentialsState(dir)).toEqual({ status: "ok" });
  });

  it("reports a legacy database with NO account file as locked — the items exist", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "db.sqlite3"), "");
    expect(readCredentialsState(dir)).toEqual({ status: "locked", reason: "undecryptable" });
  });

  it("ignores a stray legacy account with no database — nothing is migratable from it", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "vault-account.enc"), Buffer.concat([Buffer.from("ENC1"), Buffer.from("x")]));
    expect(readCredentialsState(dir)).toEqual({ status: "empty" });
  });

  it("says empty when there is genuinely nothing", () => {
    expect(readCredentialsState(tempDir())).toEqual({ status: "empty" });
  });
});

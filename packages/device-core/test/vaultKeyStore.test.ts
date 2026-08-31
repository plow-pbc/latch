/**
 * The master key's home. These run outside Electron with no native addon
 * eligible, so the provider under test is the file fallback — plus the state
 * distinctions (empty vs locked) that every provider must keep, because
 * collapsing them is the incident vaultSecretStore.ts documents.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VAULT_KEY_BYTES, VaultKeyStore } from "../src/browser/vaultKeyStore.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-key-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("VaultKeyStore", () => {
  it("is empty before any key exists, and ok after one is written", () => {
    const store = new VaultKeyStore(tempDir(), "test");
    expect(store.state()).toEqual({ status: "empty" });
    expect(store.readKey()).toBeNull();

    const key = store.createKey();
    expect(key.length).toBe(VAULT_KEY_BYTES);
    expect(store.state()).toEqual({ status: "ok" });
    expect(store.readKey()).toEqual(key);
  });

  it("stores the key file 0600 — the file provider's whole floor", () => {
    const dir = tempDir();
    new VaultKeyStore(dir, "test").createKey();
    const mode = fs.statSync(path.join(dir, "vault-key.enc")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("refuses to create over an existing key in ANY state", () => {
    const dir = tempDir();
    const store = new VaultKeyStore(dir, "test");
    store.createKey();
    expect(() => store.createKey()).toThrow(/refusing to replace/);

    // Even a blob it cannot open: that is somebody's vault key.
    fs.writeFileSync(path.join(dir, "vault-key.enc"), "KENC1garbage");
    expect(() => store.createKey()).toThrow(/refusing to replace/);
  });

  it("reports a safeStorage-wrapped blob as LOCKED (no-storage) outside Electron", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "vault-key.enc"), Buffer.concat([Buffer.from("KENC1"), Buffer.from("x")]));
    const store = new VaultKeyStore(dir, "test");
    expect(store.readKey()).toBeNull();
    expect(store.state()).toEqual({ status: "locked", reason: "no-storage" });
  });

  it("reports a SecItem blob as LOCKED when the addon is not here", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "vault-key.enc"), 'KSEC1{"account":"x"}');
    const store = new VaultKeyStore(dir, "test");
    expect(store.readKey()).toBeNull();
    expect(store.state().status).toBe("locked");
  });

  it("reports a truncated or garbled key as locked, never as a usable key", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "vault-key.enc"), "KRAW1abcd"); // far too short
    const store = new VaultKeyStore(dir, "test");
    expect(store.readKey()).toBeNull();
    expect(store.state()).toEqual({ status: "locked", reason: "undecryptable" });
  });

  it("refuses to write a key of the wrong size", () => {
    const store = new VaultKeyStore(tempDir(), "test");
    expect(() => store.writeKey(Buffer.alloc(32))).toThrow(/64 bytes/);
  });
});

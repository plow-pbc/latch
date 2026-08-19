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
  it("carries locked through to the screen instead of flattening it", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "vault-account.enc"), Buffer.concat([Buffer.from("ENC1"), Buffer.from("x")]));
    expect(readCredentialsState("https://vault.local", dir)).toEqual({
      status: "locked",
      reason: "no-storage",
    });
  });

  it("says ok when it can read the account — and hands over nothing else", () => {
    const dir = tempDir();
    new VaultSecretStore(dir).write({ email: "a@local", password: "pw" });
    // The state is a fact about the account, never the account: the only code
    // that needs the password reads the store itself.
    expect(readCredentialsState("https://vault.local", dir)).toEqual({ status: "ok" });
  });

  it("says empty when there is genuinely nothing", () => {
    expect(readCredentialsState("https://vault.local", tempDir())).toEqual({ status: "empty" });
  });
});

/**
 * Where the OLD vault account's password lives — kept for migration.
 *
 * The Bitwarden-based vault stored one account whose password unwrapped the
 * user key; this reads it so vaultMigrate.ts can carry that key into the new
 * store. Inside the app that is Electron's secure storage, which hands the
 * encryption key to the OS (Keychain on macOS, under the frozen identity in
 * vaultKeychain.ts) — so the password on disk is ciphertext. Outside Electron
 * (tests) it falls back to a file only the user can read, because there is
 * nothing better available there. Read-only by design: nothing writes an
 * account any more — tests that build legacy vaults write the plaintext
 * fallback file themselves.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

/** Empty, locked, or open — see `readState`. */
export type VaultSecretState =
  | { status: "empty" }
  | { status: "locked"; reason: "no-storage" | "undecryptable" }
  | { status: "ok"; account: VaultAccount };

export interface VaultAccount {
  email: string;
  password: string;
  /** A change that was started but not confirmed. Both pairs are kept until we
   * know which one the vault took, so an interrupted change can never leave the
   * vault holding one pair and this machine only the other. */
  pending?: { email: string; password: string };
}

/** Electron's safeStorage when we are running inside the app, else null.
 * Exported for the vault key store, which wraps the master key with the same
 * storage (and the same frozen identity — see vaultKeychain.ts). */
export function safeStorage(): { isEncryptionAvailable(): boolean; encryptString(s: string): Buffer; decryptString(b: Buffer): string } | null {
  try {
    const require_ = createRequire(import.meta.url);
    const electron = require_("electron") as { safeStorage?: ReturnType<typeof safeStorage> };
    const s = electron?.safeStorage;
    return s && s.isEncryptionAvailable() ? s : null;
  } catch {
    return null;
  }
}

export class VaultSecretStore {
  private readonly file: string;

  constructor(dir: string) {
    this.file = path.join(dir, "vault-account.enc");
  }

  /**
   * What is actually on disk — including the case this used to hide.
   *
   * "No account" and "an account we cannot decrypt" are different facts and
   * must not collapse into one `null`. They did, and the app rendered a locked
   * vault as "The vault has not started yet." — so a Keychain that had moved
   * (a rename, a reset, a Mac restored from backup) looked like a machine that
   * had simply never started its vault, and the real cause was invisible.
   */
  readState(): VaultSecretState {
    if (!fs.existsSync(this.file)) return { status: "empty" };
    const raw = fs.readFileSync(this.file);
    const s = safeStorage();
    try {
      // The marker distinguishes the two shapes, so a machine that gains (or
      // loses) Electron's storage does not silently read garbage.
      if (raw.subarray(0, 4).toString() === "ENC1") {
        // Ciphertext we have no key for. The account exists; we cannot open it.
        if (!s) return { status: "locked", reason: "no-storage" };
        return { status: "ok", account: JSON.parse(s.decryptString(raw.subarray(4))) as VaultAccount };
      }
      return { status: "ok", account: JSON.parse(raw.toString("utf8")) as VaultAccount };
    } catch {
      // A file that exists and will not decrypt is locked, never empty.
      return { status: "locked", reason: "undecryptable" };
    }
  }
}

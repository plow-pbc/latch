/**
 * Where the one vault account's password lives.
 *
 * Inside the app that is Electron's secure storage, which on every platform
 * hands the encryption key to the OS (Keychain on macOS) — so the password on
 * disk is ciphertext and we never write Keychain entries of our own. Outside
 * Electron (tests, the headless runner) it falls back to a file only the user
 * can read, because there is nothing better available there.
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

/** Electron's safeStorage when we are running inside the app, else null. */
function safeStorage(): { isEncryptionAvailable(): boolean; encryptString(s: string): Buffer; decryptString(b: Buffer): string } | null {
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

  /**
   * The account, or null when there is not one we can read.
   *
   * Kept exactly as it was, because callers depend on the conservative
   * reading: `ensureVaultAccount` treats null as "no usable account" and then
   * refuses to mint a second one when the `account-created` marker is present.
   * Anything wanting to TELL the two apart asks `readState`.
   */
  read(): VaultAccount | null {
    const state = this.readState();
    return state.status === "ok" ? state.account : null;
  }

  write(account: VaultAccount): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const s = safeStorage();
    const body = JSON.stringify(account);
    if (s) {
      fs.writeFileSync(this.file, Buffer.concat([Buffer.from("ENC1"), s.encryptString(body)]), { mode: 0o600 });
    } else {
      fs.writeFileSync(this.file, body, { mode: 0o600 });
    }
  }
}

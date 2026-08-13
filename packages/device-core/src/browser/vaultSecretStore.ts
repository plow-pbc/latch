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

  read(): VaultAccount | null {
    if (!fs.existsSync(this.file)) return null;
    const raw = fs.readFileSync(this.file);
    const s = safeStorage();
    try {
      // The marker distinguishes the two shapes, so a machine that gains (or
      // loses) Electron's storage does not silently read garbage.
      if (raw.subarray(0, 4).toString() === "ENC1") {
        if (!s) return null;
        return JSON.parse(s.decryptString(raw.subarray(4))) as VaultAccount;
      }
      return JSON.parse(raw.toString("utf8")) as VaultAccount;
    } catch {
      return null;
    }
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

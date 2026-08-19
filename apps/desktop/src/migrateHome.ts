/**
 * Move a pre-rename "Domo…" home to its new "Plow-Latch…" name, wholesale.
 *
 * A plain rename is the whole migration: everything that identifies an
 * install — the relay credential, the device keypair (and with it every
 * always-allow rule key), the audit log, Chromium's state — lives INSIDE the
 * home and keys on nothing outside it, and the vault's Keychain identity is
 * a frozen constant (vaultKeychain.ts), not a path. Nothing on disk or in the
 * Keychain refers to the folder by name.
 *
 * Must run before Electron is ready and before userData/sessionData are put
 * to use — once Chromium has opened files under the old home a rename is no
 * longer safe. main.ts calls this at module top level, right after resolving
 * the instance paths.
 *
 * If the new home already exists the old one is left untouched: the instance
 * has already run under the new name, and its current state wins.
 */
import fs from "node:fs";

export function migrateLegacyHome(paths: { home: string; legacyHome: string | undefined }): boolean {
  if (!paths.legacyHome) return false;
  if (fs.existsSync(paths.home)) return false;
  if (!fs.existsSync(paths.legacyHome)) return false;
  fs.renameSync(paths.legacyHome, paths.home);
  return true;
}

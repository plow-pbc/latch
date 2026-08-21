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
 * The legacy twin is derived from the home's FOLDER NAME, not from how the
 * home was chosen, because `just app` always passes DOMO_HOME explicitly and
 * the per-branch and "-local" homes must migrate too. The prefix must match
 * as a whole word — a home that is not "Plow-Latch"-named (a throwaway test
 * home) has no twin and is never migrated.
 *
 * Must run before Electron is ready and before userData/sessionData are put
 * to use — once Chromium has opened files under the old home a rename is no
 * longer safe. main.ts calls this at module top level, right after resolving
 * the instance paths.
 *
 * If the new home already exists the old one is left untouched: the instance
 * has already run under the new name, and its current state wins.
 *
 * A rename FAILURE must abort startup, so this throws and no caller may
 * swallow it. Continuing would let DeviceAgent mint a fresh identity in the
 * new home; from then on the destination exists, the old home is never looked
 * at again, and a one-time transient error has permanently stranded the
 * credential, the rule keys, the audit log and the vault ciphertext. Crashing
 * is the recoverable outcome: the next launch retries before any state exists.
 */
import fs from "node:fs";
import path from "node:path";
import { HOME_PREFIX } from "./paths.js";

const LEGACY_HOME_PREFIX = "Domo";

export function migrateLegacyHome(home: string): boolean {
  const base = path.basename(home);
  if (base !== HOME_PREFIX && !base.startsWith(`${HOME_PREFIX}-`)) return false;
  const legacyHome = path.join(
    path.dirname(home),
    LEGACY_HOME_PREFIX + base.slice(HOME_PREFIX.length),
  );
  if (fs.existsSync(home) || !fs.existsSync(legacyHome)) return false;
  fs.renameSync(legacyHome, home);
  return true;
}

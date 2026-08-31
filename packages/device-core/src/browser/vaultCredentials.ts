/**
 * Whether this machine can open its own vault — the one fact the vault screen
 * needs before it can show anything.
 *
 * "Locked" and "empty" are different facts and get different words (see
 * vaultSecretStore.ts for the incident that rule comes from). Empty is fine:
 * a fresh vault mints its own key on first use. Locked is the case the screen
 * must explain — a key (or, pre-migration, an old account) that is on disk
 * and will not open here.
 */
import { VaultKeyStore } from "./vaultKeyStore.js";
import { legacyVaultPresent } from "./vaultMigrate.js";
import { VaultSecretStore } from "./vaultSecretStore.js";
import { VaultStore } from "./vaultStore.js";

/** What the vault screen shows: a usable vault, nothing yet, or a locked one. */
export type VaultCredentialsState =
  | { status: "empty" }
  | { status: "locked"; reason: "no-storage" | "undecryptable" }
  | { status: "ok" };

export function readCredentialsState(dir: string, keyStore = new VaultKeyStore(dir)): VaultCredentialsState {
  const key = keyStore.state();
  if (key.status === "ok") return { status: "ok" };
  if (key.status === "locked") return { status: "locked", reason: key.reason };
  // No key yet. A legacy Bitwarden vault waiting to be migrated is this
  // machine's vault too: report it usable when its account opens, and locked
  // when it does not — never as an empty vault that quietly starts fresh
  // beside the owner's real items.
  if (!new VaultStore(dir).exists() && legacyVaultPresent(dir)) {
    const legacy = new VaultSecretStore(dir).readState();
    if (legacy.status === "ok") return { status: "ok" };
    if (legacy.status === "locked") return { status: "locked", reason: legacy.reason };
  }
  return { status: "empty" };
}

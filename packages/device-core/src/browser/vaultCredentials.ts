/**
 * Whether this machine can open its own vault account — the one fact the vault
 * screen needs before it can show anything.
 *
 * Changing the account belonged here too, back when a screen offered it. That
 * screen is gone: the owner edits the vault's CONTENTS in the app now and never
 * signs in on the vault's own page, so nothing asks for the account itself.
 */
import { VaultSecretStore, VaultSecretState } from "./vaultSecretStore.js";
import { httpCa, signIn, VaultHttp } from "./vaultCrypto.js";

/** What the vault screen shows: a usable account, nothing yet, or a locked one. */
export type VaultCredentialsState =
  | { status: "empty" }
  | { status: "locked"; reason: "no-storage" | "undecryptable" }
  | { status: "ok" };

/**
 * The account's state, with the locked case kept intact all the way to the
 * screen — "locked" and "empty" are different facts and get different words.
 * The account itself is deliberately NOT returned: nothing needs it but the
 * code that signs in, which reads the store directly.
 */
export function readCredentialsState(storeDir: string): VaultCredentialsState {
  const state: VaultSecretState = new VaultSecretStore(storeDir).readState();
  if (state.status === "ok") return { status: "ok" };
  return state.status === "locked" ? { status: "locked", reason: state.reason } : { status: "empty" };
}

/**
 * Settle a change that was interrupted: whichever pair the vault accepts is the
 * real one. Runs at startup, costs nothing when there is nothing pending.
 */
export async function settlePendingChange(
  url: string,
  storeDir: string,
  caPath?: string,
): Promise<void> {
  const store = new VaultSecretStore(storeDir);
  const account = store.read();
  if (!account?.pending) return;
  const http: VaultHttp = { url, ca: httpCa(caPath) };
  try {
    await signIn(http, account.pending.email, account.pending.password);
    store.write({ email: account.pending.email, password: account.pending.password });
    return;
  } catch {
    /* the vault never took it */
  }
  store.write({ email: account.email, password: account.password });
}


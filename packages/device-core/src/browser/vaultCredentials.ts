/**
 * The owner's control over their own vault account: read what it is, and change
 * it to whatever they want.
 *
 * The account key never changes — it is unwrapped with the old password and
 * re-wrapped with the new one, so everything already in the vault stays
 * readable. Only the machine's copy of the password changes with it.
 */
import { VaultSecretStore, VaultAccount } from "./vaultSecretStore.js";
import { encString, httpCa, masterKeyAndHash, send, signIn, KDF_ITERATIONS, VaultHttp } from "./vaultCrypto.js";

export interface VaultCredentialsView {
  url: string;
  email: string;
  password: string;
}

/** What the owner needs to sign in on the vault's own page. */
export function readCredentials(url: string, storeDir: string): VaultCredentialsView | null {
  const account = new VaultSecretStore(storeDir).read();
  return account ? { url, email: account.email, password: account.password } : null;
}

/**
 * Change the email, the password, or both. Anything left blank stays as it is.
 * The vault is updated first; the machine's copy only moves once the vault has
 * accepted, so a failure leaves a working account rather than a stranded one.
 */
export async function changeCredentials(
  url: string,
  storeDir: string,
  next: { email?: string; password?: string },
  caPath?: string,
): Promise<VaultAccount> {
  const store = new VaultSecretStore(storeDir);
  const current = store.read();
  if (!current) throw new Error("this machine has no vault account yet");

  const email = next.email?.trim() || current.email;
  const password = next.password || current.password;
  if (email === current.email && password === current.password) return current;

  // Written before the vault is touched, keeping the pair that still works.
  // If this process dies mid-change, the old credentials are still on disk and
  // the vault is still holding one of the two — neither is lost.
  store.write({ email: current.email, password: current.password, pending: { email, password } });

  const http: VaultHttp = { url, ca: httpCa(caPath) };
  const { userKey, passwordHash } = await signIn(http, current.email, current.password);
  // The same account key, re-wrapped under whatever the owner chose.
  const target = masterKeyAndHash(email, password);
  const rewrapped = encString(userKey, target.stretchedEnc, target.stretchedMac);

  if (email !== current.email) {
    // Ask for the change first: without mail configured the vault does not
    // check the token it would have sent, but it still wants the request.
    const asked = await send(
      http,
      "POST",
      "/api/accounts/email-token",
      JSON.stringify({ masterPasswordHash: passwordHash, newEmail: email }),
    );
    if (asked.status < 200 || asked.status >= 300) {
      throw new Error(`vault refused the new address (HTTP ${asked.status})`);
    }
    const done = await send(
      http,
      "POST",
      "/api/accounts/email",
      JSON.stringify({
        masterPasswordHash: passwordHash,
        newEmail: email,
        newMasterPasswordHash: target.hash,
        key: rewrapped,
        token: "",
      }),
    );
    if (done.status < 200 || done.status >= 300) {
      throw new Error(`vault refused the new address (HTTP ${done.status})`);
    }
  } else if (password !== current.password) {
    const done = await send(
      http,
      "POST",
      "/api/accounts/password",
      JSON.stringify({
        masterPasswordHash: passwordHash,
        newMasterPasswordHash: target.hash,
        masterPasswordHint: null,
        key: rewrapped,
      }),
    );
    if (done.status < 200 || done.status >= 300) {
      throw new Error(`vault refused the new password (HTTP ${done.status})`);
    }
  }

  // The vault has accepted, so the new pair is the one that works and the old
  // one is dropped.
  const account = { email, password };
  store.write(account);
  return account;
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

export { KDF_ITERATIONS };

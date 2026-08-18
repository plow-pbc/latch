/**
 * The Keychain identity the vault account's encryption is bound to.
 *
 * Electron's `safeStorage` derives its macOS Keychain item from `app.name`
 * (`<app.name> Safe Storage`). That made the ciphertext hostage to a display
 * string: renaming the app from "Domo Desktop" to "Plow" pointed it at a key
 * that had never existed, and every vault account on disk became unreadable.
 *
 * The fix is to stop asking `app.name` and freeze the string instead. The value
 * below is the OLD naming formula, kept deliberately, because it is what every
 * existing vault was encrypted under — freezing it means the ciphertext already
 * on disk simply keeps working. Nothing is copied, re-encrypted, or migrated;
 * there is no prompt and no path that can damage the only copy of an account.
 *
 * IT IS A LITERAL AND IT MUST NEVER CHANGE. Not for a rename, not for a
 * bundle-id change, not for a product change, and above all not to "match" what
 * the app is called this month — that is precisely the coupling that broke it.
 * It is not read from `app.name`, `appId` or `productName`, and it is not
 * spelled the way the product is spelled any more; that it once matched the app
 * name is history, not a rule.
 *
 * The branch suffix is kept because per-worktree key separation is behaviour we
 * already have and want: two checkouts must not share a vault key. Branch names
 * do not shift under us the way a product name does, so this stays rename-proof.
 */
// ─────────────────────────────────────────────────────────────────────────────
// DO NOT CHANGE THIS STRING. Changing it makes every existing vault account on
// every existing machine permanently unreadable.
//
// What we learned the hard way, written down so nobody has to learn it twice:
//
//  1. Electron's `safeStorage` does not have a key of its own. On macOS it
//     looks up a Keychain item named `<app.name> Safe Storage`, with account
//     `<app.name> Key`, and uses the password in it as the encryption key.
//
//  2. It reads `app.name` at FIRST USE, not at process start, and caches the
//     key for the life of the process. One process gets exactly one key. That
//     is why `bindVaultKeychainIdentity` below can set the name, force the
//     latch, and put the display name back — and why "decrypt under the old
//     name, re-encrypt under the new one" is impossible in a single launch.
//
//  3. Therefore renaming the app orphans every ciphertext it has ever written.
//     PR #42 renamed "Domo Desktop" to "Plow"; `safeStorage` started looking
//     for `Plow Safe Storage`, which had never existed, minted a fresh random
//     key, and four colleagues' vault accounts stopped opening. The data was
//     never lost — the old key and the ciphertext were both fine — but nothing
//     in the app could reach it, and the vault screen said "has not started
//     yet", which sent people looking for a server that was running perfectly.
//
//  4. So this is a frozen literal, and the value is the OLD app name on
//     purpose: it is what every existing vault was encrypted under, so freezing
//     it means the ciphertext already on disk simply keeps working. No copy, no
//     re-encryption, no migration, no prompt, no path that can damage the only
//     copy of anyone's account.
//
// It is NOT read from `app.name`, `appId` or `productName`, and it no longer
// matches what the product is called. That mismatch is the feature. If a future
// change makes you want to "tidy" this to match the app's name, that impulse is
// the exact bug this comment exists to prevent.
// ─────────────────────────────────────────────────────────────────────────────
export const VAULT_STORE_IDENTITY = "Domo Desktop";

/** The identity for this instance: the frozen constant, plus the branch when there is one. */
export function vaultStoreIdentity(branch?: string): string {
  const b = (branch ?? "").trim();
  return b ? `${VAULT_STORE_IDENTITY} (${b})` : VAULT_STORE_IDENTITY;
}

/** What `bindVaultKeychainIdentity` needs from Electron. */
export interface KeychainHost {
  name: string;
  setName(name: string): void;
  /** Force `safeStorage` to fetch and cache its key, now. */
  latch(): void;
}

/**
 * Bind this process's `safeStorage` key to the frozen identity.
 *
 * `safeStorage` latches its key at FIRST USE, not at process start (verified
 * empirically), and holds exactly one key for the life of the process. That is
 * what makes this safe and what makes it necessary: set the name, force the
 * latch, put the display name back. The menu bar, dock and window titles are
 * built later and never see the swap.
 *
 * Call once, before anything else touches `safeStorage` — including before any
 * window exists. If something else latches first, it latches under the display
 * name and the vault stays locked until the next launch.
 */
export function bindVaultKeychainIdentity(host: KeychainHost, identity: string): void {
  const display = host.name;
  host.setName(identity);
  try {
    host.latch();
  } finally {
    host.setName(display);
  }
}

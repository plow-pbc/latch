/**
 * What a long-lived child process is allowed to inherit.
 *
 * The broker is handed the vault's variables where it is invoked — per call, by
 * name — so nothing that outlives a broker call has any use for them. The
 * browser server and every Firefox it spawns are the least trustworthy
 * processes here, and the family carries the bootstrap token, the account's own
 * address and password, and the path to the client state they unlock.
 *
 * This lives beside the spawn sites rather than inside any one of them, because
 * the rule is for whoever adds the NEXT spawn site.
 */

/**
 * Matched by PREFIX on purpose: the next `SEED_VAULT_*` anyone adds is excluded
 * because of what it is, not because someone remembered to list it here. Apply
 * it to the WHOLE environment being handed over, not just the inherited half —
 * a runtime's own env carries `SEED_VAULT_*` too.
 */
export function withoutVaultSecrets(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([k]) => !k.startsWith("SEED_VAULT_") && !k.startsWith("DOMO_VAULT_")),
  );
}

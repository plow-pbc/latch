/**
 * The rules shared by every long-lived child this package supervises: what it
 * is allowed to inherit, and how it is taken down.
 *
 * What it inherits
 * ----------------
 * The broker is handed the vault's variables where it is invoked — per call, by
 * name — so nothing that outlives a broker call has any use for them. The
 * browser server and every Firefox it spawns are the least trustworthy
 * processes here, and the family carries the bootstrap token, the account's own
 * address and password, and the path to the client state they unlock.
 *
 * These live beside the spawn sites rather than inside any one of them, because
 * the rules are for whoever adds the NEXT spawn site.
 */
import { type ChildProcess } from "node:child_process";

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

/**
 * Signal a child's whole process GROUP, falling back to the child alone.
 *
 * Both supervisors here spawn `detached`, so their children have children —
 * Camoufox leaves Firefox behind, the vault leaves whatever Rocket spawned.
 * Signalling `-pid` reaches all of them; the fallback covers the child that
 * never became a group leader. No-op once it is gone.
 */
export function signalProcessGroup(child: ChildProcess | null, signal: NodeJS.Signals): void {
  const pid = child?.pid;
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}

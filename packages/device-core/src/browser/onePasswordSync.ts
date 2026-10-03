/**
 * Keeping the vault's logins in step with one 1Password vault, with nobody at the Mac.
 *
 * A 1Password service account reads its vault with no biometric prompt, which is
 * the whole point: the owner is often away from this Mac, and an agent that needs
 * a login must not wait on a fingerprint. This pulls that vault's logins through
 * the `op` CLI and lands them by the Import sheet's own path — markAgainstVault
 * then importLogins — so an unchanged login is left alone, a changed password or
 * key updates its item, a new login is saved, each with its audit line, and two
 * passes in a row change nothing. Nothing here deletes: an item gone from
 * 1Password stays until the owner removes it.
 *
 * The values travel `op` stdout → vault.save and nowhere else: no message,
 * warning or error built here quotes a field value (passwordImport.ts holds the
 * same rule for everything it returns).
 */
import type { LocalVault } from "./localVault.js";
import {
  finishImportedLogin,
  importLogins,
  markAgainstVault,
  normalizeImportUrls,
  type ImportedLogin,
} from "./passwordImport.js";

/** Runs `op <args>` with the service-account token in its environment and
 * resolves to stdout. Its errors must not carry stdout. */
export type OpRunner = (args: string[]) => Promise<string>;

/** Counts only: a pass reports how it went, never which item or why in its
 * own words, so nothing here can carry what an item holds. */
export interface SyncResult {
  /** Listed, matched an `exclude` entry, and so never fetched. */
  excluded: number;
  saved: number;
  updated: number;
  unchanged: number;
  /** Not a login, no site to fill on, refused by `op`, or matching an item
   * here that asks for the owner (left alone, never prompted for). */
  skipped: number;
  failed: number;
}

type OpField = { id?: unknown; type?: unknown; purpose?: unknown; label?: unknown; value?: unknown };

/** One `op item get --format json` login as an import row, or null when it is
 * not one the vault can fill (not a login, or no site). */
export function loginFromOpItem(raw: unknown): ImportedLogin | null {
  const item = (raw ?? {}) as Record<string, unknown>;
  const title = typeof item.title === "string" ? item.title.trim() : "";
  if (item.category !== "LOGIN") return null;
  const fields = Array.isArray(item.fields) ? (item.fields as OpField[]) : [];
  const value = (pick: (f: OpField) => boolean): string => {
    const f = fields.find(pick);
    return f && typeof f.value === "string" ? f.value : "";
  };
  const raws = (Array.isArray(item.urls) ? (item.urls as Array<Record<string, unknown>>) : [])
    .map((u) => (typeof u.href === "string" ? u.href.trim() : ""))
    .filter(Boolean);
  const { urls, dropped } = normalizeImportUrls(raws);
  // The vault refuses a login with no site: it could never be filled anyway.
  if (urls.length === 0) return null;
  const warnings = dropped ? ["one of its website addresses could not be read and was left out"] : [];
  return finishImportedLogin(
    {
      title,
      urls,
      username: value((f) => f.purpose === "USERNAME"),
      password: value((f) => f.purpose === "PASSWORD"),
      totpRaw: value((f) => f.type === "OTP") || undefined,
      notes: value((f) => f.purpose === "NOTES"),
    },
    warnings,
  );
}

/**
 * One pass: every login in `vaultName`, reconciled into `vault`. An `exclude`
 * entry is a 1Password item id (never a title: a rename would re-admit it) and
 * drops the item at the list, so it is never fetched and its values never leave
 * 1Password. `serialize` wraps the reconcile-and-write section, so the caller
 * can keep it from interleaving with the owner's own imports and saves; the
 * `op` fetches stay outside it.
 * ponytail: re-reads every login each pass (1 list + 1 get per login). Ceiling:
 * a 1Password Teams service account allows 1,000 reads an hour, so hundreds of
 * logins at the hourly pace the app uses; upgrade path is skipping items whose
 * `updated_at` matches the previous pass.
 */
export async function syncFromOnePassword(
  vault: LocalVault,
  vaultName: string,
  run: OpRunner,
  opts: { exclude?: string[]; serialize?: <T>(fn: () => Promise<T>) => Promise<T> } = {},
): Promise<SyncResult> {
  const out = new Set((opts.exclude ?? []).map((id) => id.trim()));
  const serialize = opts.serialize ?? (<T>(fn: () => Promise<T>) => fn());
  let listed: unknown;
  try {
    listed = JSON.parse(await run(["item", "list", "--vault", vaultName, "--categories", "Login", "--format", "json"]));
  } catch {
    // A JSON.parse error quotes the text it choked on; this sentence quotes nothing.
    throw new Error("1Password's list of logins could not be read");
  }
  const logins: ImportedLogin[] = [];
  let excluded = 0;
  let skipped = 0;
  for (const entry of Array.isArray(listed) ? (listed as Array<Record<string, unknown>>) : []) {
    if (out.has(String(entry.id))) {
      excluded++;
      continue;
    }
    let login: ImportedLogin | null = null;
    try {
      login = loginFromOpItem(
        JSON.parse(await run(["item", "get", String(entry.id), "--vault", vaultName, "--format", "json", "--reveal"])),
      );
    } catch {
      /* refused by `op` or unreadable: counted below, quoted nowhere */
    }
    if (login) logins.push(login);
    else skipped++;
  }
  return serialize(async () => {
    const leftAlone = await markAgainstVault(vault, logins, { unattended: true });
    const { saved, updated, duplicates, failed } = await importLogins(vault, logins, "ONEPASSWORD");
    return { excluded, saved, updated, unchanged: duplicates - leftAlone, skipped: skipped + leftAlone, failed: failed.length };
  });
}

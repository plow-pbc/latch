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
  type SkippedRow,
} from "./passwordImport.js";

/** Runs `op <args>` with the service-account token in its environment and
 * resolves to stdout. Its errors must not carry stdout. */
export type OpRunner = (args: string[]) => Promise<string>;

export interface SyncResult {
  saved: number;
  updated: number;
  unchanged: number;
  skipped: SkippedRow[];
  failed: SkippedRow[];
}

type OpField = { id?: unknown; type?: unknown; purpose?: unknown; label?: unknown; value?: unknown };

/** One `op item get --format json` login as an import row, or why it is not one. */
export function loginFromOpItem(raw: unknown): { login?: ImportedLogin; skipped?: SkippedRow } {
  const item = (raw ?? {}) as Record<string, unknown>;
  const title = typeof item.title === "string" ? item.title.trim() : "";
  if (item.category !== "LOGIN") return { skipped: { title: title || "(untitled)", reason: "not a login" } };
  const fields = Array.isArray(item.fields) ? (item.fields as OpField[]) : [];
  const value = (pick: (f: OpField) => boolean): string => {
    const f = fields.find(pick);
    return f && typeof f.value === "string" ? f.value : "";
  };
  const raws = (Array.isArray(item.urls) ? (item.urls as Array<Record<string, unknown>>) : [])
    .map((u) => (typeof u.href === "string" ? u.href.trim() : ""))
    .filter(Boolean);
  const { urls, dropped } = normalizeImportUrls(raws);
  if (urls.length === 0) {
    // The vault refuses a login with no site: it could never be filled anyway.
    return { skipped: { title: title || "(untitled)", reason: "has no website address it can be filled on" } };
  }
  const warnings = dropped ? ["one of its website addresses could not be read and was left out"] : [];
  const login = finishImportedLogin(
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
  return { login };
}

/**
 * One pass: every login in `vaultName`, reconciled into `vault`.
 * ponytail: re-reads every login each pass (1 list + 1 get per login). Ceiling:
 * a 1Password Teams service account allows 1,000 reads an hour, so hundreds of
 * logins at the hourly pace the app uses; upgrade path is skipping items whose
 * `updated_at` matches the previous pass.
 */
export async function syncFromOnePassword(vault: LocalVault, vaultName: string, run: OpRunner): Promise<SyncResult> {
  let listed: unknown;
  try {
    listed = JSON.parse(await run(["item", "list", "--vault", vaultName, "--categories", "Login", "--format", "json"]));
  } catch {
    // A JSON.parse error quotes the text it choked on; this sentence quotes nothing.
    throw new Error("1Password's list of logins could not be read");
  }
  const logins: ImportedLogin[] = [];
  const skipped: SkippedRow[] = [];
  for (const entry of Array.isArray(listed) ? (listed as Array<Record<string, unknown>>) : []) {
    const title = typeof entry.title === "string" ? entry.title : "(untitled)";
    let item: unknown;
    try {
      item = JSON.parse(await run(["item", "get", String(entry.id), "--vault", vaultName, "--format", "json", "--reveal"]));
    } catch {
      skipped.push({ title, reason: "1Password would not hand it over" });
      continue;
    }
    const row = loginFromOpItem(item);
    if (row.login) logins.push(row.login);
    else if (row.skipped) skipped.push(row.skipped);
  }
  await markAgainstVault(vault, logins);
  const { saved, updated, duplicates, failed } = await importLogins(vault, logins);
  return { saved, updated, unchanged: duplicates, skipped, failed };
}

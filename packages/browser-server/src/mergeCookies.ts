#!/usr/bin/env node
/**
 * Add what a browser session did to the user's cookies, and nothing else — the
 * TypeScript port of vendor/browser-server/merge_cookies.py. Called when a
 * session ends: it browsed on a clone of the user's profile, and what it did
 * there has to reach the profile itself without throwing away what another
 * browser did at the same time.
 *
 * The clone is compared against the baseline it started from, so the merge knows
 * what this session actually DID rather than what it looks like now:
 *   - a row whose columns differ from the baseline was changed here and is
 *     written back;
 *   - a row that is gone was signed out of, and is removed from the profile, but
 *     only while the profile still holds exactly what the baseline did;
 *   - everything else was merely read. Reading moves `lastAccessed`, which is
 *     why that column is not part of "changed".
 *
 * Columns are read from the table rather than written down here: Firefox adds
 * one every few releases, and a list that went stale would quietly drop whatever
 * it did not name. `id` is left out on purpose — it is the row number of the
 * store being written, not part of the cookie.
 *
 * node-sqlite3-wasm gives the same ATTACH-based multi-database merge Python's
 * sqlite3 did, so the SQL is line for line what it was. It is a WASM build with a
 * synchronous, file-backed API: no native binary, no ABI, no Electron rebuild —
 * one arch-neutral module loads identically under the tests' Node and the
 * packaged app's Electron runtime. (better-sqlite3 was ABI-locked and would have
 * had to be rebuilt per-arch for Electron; DESIGN.md §11a.)
 */
// node-sqlite3-wasm is CommonJS; a NAMED esm import (`import { Database }`)
// throws "Named export not found" when this file runs as a real ESM script under
// node (vitest's transform hides it, the packaged spawn does not). The default
// import is the interop-safe form.
import sqlite3 from "node-sqlite3-wasm";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const { Database } = sqlite3;

const KEY = ["name", "host", "path", "originAttributes"];
/** Moved by a read, so it says nothing about what the session changed. */
const READ_ONLY_COLUMN = "lastAccessed";

/** `IS`, not `=`: a NULL column matches a NULL column. */
function match(left: string, right: string, cols: string[]): string {
  return cols.map((c) => `${left}.${c} IS ${right}.${c}`).join(" AND ");
}

/**
 * `into` the user's profile, `extra` the session's clone, `baseline` what that
 * clone started from (absent only on a profile with no cookie store).
 */
export function mergeCookies(into: string, extra: string, baseline: string): void {
  const db = new Database(into);
  try {
    // A session closing must not stall on a store another browser is writing.
    db.run("PRAGMA busy_timeout = 10000");
    db.run("ATTACH ? AS extra", [extra]);
    const columns = (db.all("PRAGMA main.table_info(moz_cookies)") as { name: string }[])
      .map((r) => r.name)
      .filter((n) => n !== "id");
    if (columns.length === 0) throw new Error("no moz_cookies table to merge into");
    const keys = KEY.filter((k) => columns.includes(k));
    const state = columns.filter((c) => c !== READ_ONLY_COLUMN);
    const names = columns.join(",");

    // A session that changed the same cookie more recently already won: true
    // with a baseline and without one, which is why it is the only condition
    // two sessions racing on a brand-new profile have.
    const conditions = [
      "NOT EXISTS (SELECT 1 FROM main.moz_cookies AS mine WHERE " +
        `${match("mine", "theirs", keys)} AND mine.lastAccessed >= theirs.lastAccessed)`,
    ];

    const hasBaseline = fs.existsSync(baseline);
    if (hasBaseline) {
      // ATTACH cannot run inside a transaction, so it precedes BEGIN.
      db.run("ATTACH ? AS base", [baseline]);
      // Changed here: some state column differs from what it started as.
      conditions.push(
        "NOT EXISTS (SELECT 1 FROM base.moz_cookies AS was WHERE " +
          `${match("was", "theirs", keys)} AND ${match("was", "theirs", state)})`,
      );
    }

    // The delete (sign-outs) and the insert (changes) are one atomic write: a
    // crash or a lock timeout between them must not leave the profile with the
    // sign-outs applied but the new tokens missing — that is a half-merged
    // login. ROLLBACK on any failure leaves the profile exactly as it was.
    db.run("BEGIN IMMEDIATE");
    try {
      if (hasBaseline) {
        // Signed out here: gone from the clone, and the profile still holds
        // exactly what this session started from.
        db.run(
          "DELETE FROM main.moz_cookies WHERE EXISTS (" +
            `  SELECT 1 FROM base.moz_cookies AS was WHERE ${match("was", "moz_cookies", keys)} ` +
            `AND ${match("was", "moz_cookies", state)}` +
            ") AND NOT EXISTS (" +
            `  SELECT 1 FROM extra.moz_cookies AS theirs WHERE ${match("theirs", "moz_cookies", keys)}` +
            ")",
        );
      }
      db.run(
        `INSERT OR REPLACE INTO main.moz_cookies (${names}) ` +
          `SELECT ${names} FROM extra.moz_cookies AS theirs WHERE ${conditions.join(" AND ")}`,
      );
      db.run("COMMIT");
    } catch (err) {
      try {
        db.run("ROLLBACK");
      } catch {
        /* the transaction was already undone by the failure */
      }
      throw err;
    }
  } finally {
    db.close();
  }
}

// CLI: into, extra, baseline — the argv shape BrowserHost spawns.
//
// "am I the entry script" compared as RESOLVED FILESYSTEM PATHS, never as
// `import.meta.url === \`file://${argv[1]}\``: that string form fails whenever
// the path holds a character the URL escapes — a space in "Plow Latch.app" is
// the shipping case — and the block would then never run, the process would exit
// 0 having merged nothing, and the caller would delete the session clone on the
// strength of it, losing every login made in the session.
if (isMain()) {
  const [into, extra, baseline] = process.argv.slice(2);
  mergeCookies(into, extra, baseline);
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(import.meta.url);
  const real = (p: string): string => {
    try {
      return fs.realpathSync(p);
    } catch {
      return p;
    }
  };
  return real(self) === real(entry);
}

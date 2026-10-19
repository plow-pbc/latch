/**
 * What the recipe tests share: each builds a real SQLite store shaped like an
 * app's database, runs the exact SQL the agent is handed against it, and
 * asserts on the rows that come back.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const SQLITE = "/usr/bin/sqlite3";
/** Core Data counts from 2001-01-01; both stores' dates rest on it. */
export const CORE_DATA_EPOCH = 978307200;

/**
 * Every child a recipe test spawns goes through here, so the TZ pin has ONE owner.
 *
 * The recipes render dates with 'localtime', which means the machine's zone.
 * Left to the environment, an assertion on a rendered date passes or fails on
 * where the suite runs.
 */
export function run(cmd: string, args: string[], opts: { cwd?: string } = {}): string {
  return execFileSync(cmd, args, {
    ...opts,
    encoding: "utf8",
    stdio: "pipe",
    env: { ...process.env, TZ: "UTC" },
  });
}

export const sqlite = (args: string[], opts: { cwd?: string } = {}): string =>
  run(SQLITE, args, opts);

/**
 * Run SQL against a store and hand back the rows, split into cells.
 *
 * `-list` rather than the `-csv` the skill teaches an agent to use: csv quotes
 * any cell with a space in it, and unquoting here would be a second parser to
 * get wrong. The recipes under test are the SQL, not the output format.
 */
export function query(store: string, sql: string): string[][] {
  const out = sqlite(["-readonly", "-list", store, sql]).trim();
  return out === "" ? [] : out.split("\n").map((line) => line.split("|"));
}

const dirs: string[] = [];
/** A per-test scratch dir; `cleanupTempDirs` (run it in `afterEach`) removes it. */
export function tempDir(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** Remove a dir, including one a test made read-only to reproduce a real failure. */
export const cleanup = (d: string): void => {
  fs.chmodSync(d, 0o755);
  fs.rmSync(d, { recursive: true, force: true });
};

export const cleanupTempDirs = (): void => dirs.splice(0).forEach(cleanup);

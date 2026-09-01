/**
 * The cookie merger, run as the executable BrowserHost spawns — including from a
 * path with a SPACE in it, which the shipping "Plow Latch.app" always has.
 *
 * The bug this guards: `import.meta.url === \`file://${argv[1]}\`` percent-encodes
 * the space on one side only, so the CLI block never ran, the process exited 0
 * having merged nothing, and the caller deleted the session clone on that false
 * success — losing every login made in the session. `isMain()` now compares
 * resolved filesystem paths, so a spaced path merges like any other.
 *
 * Runs against the built dist (compiled here if stale), because the merge is a
 * real subprocess (the WASM sqlite merge is synchronous).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import sqlite3 from "node-sqlite3-wasm";
const { Database } = sqlite3;
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const MERGE_JS = fileURLToPath(new URL("../dist/mergeCookies.js", import.meta.url));

const COLS =
  "CREATE TABLE IF NOT EXISTS moz_cookies (id INTEGER PRIMARY KEY, name TEXT, value TEXT," +
  " host TEXT, path TEXT, expiry INTEGER, lastAccessed INTEGER, creationTime INTEGER, isSecure INTEGER," +
  " isHttpOnly INTEGER, inBrowserElement INTEGER, sameSite INTEGER, rawSameSite INTEGER, schemeMap INTEGER," +
  " originAttributes TEXT, CONSTRAINT moz_uniqueid UNIQUE (name, host, path, originAttributes))";

function store(file: string, hosts: string[], usedAt = 1): void {
  const db = new Database(file);
  db.exec(COLS);
  const ins = db.prepare(
    "INSERT OR REPLACE INTO moz_cookies (name,value,host,path,expiry,lastAccessed,creationTime," +
      "isSecure,isHttpOnly,inBrowserElement,sameSite,rawSameSite,schemeMap,originAttributes)" +
      " VALUES ('sid','v',?,'/',0,?,1,1,1,0,0,0,1,'')",
  );
  hosts.forEach((h, i) => ins.run([h, usedAt + i]));
  db.close();
}

function hosts(file: string): string[] {
  const db = new Database(file, { readOnly: true });
  const rows = db.prepare("SELECT host FROM moz_cookies ORDER BY host").all() as { host: string }[];
  db.close();
  return rows.map((r) => r.host);
}

let dir: string;

beforeAll(() => {
  if (!fs.existsSync(MERGE_JS)) {
    execFileSync("npx", ["tsc", "-b", "packages/browser-server"], { cwd: repoRoot });
  }
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "merge-cli-"));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

/** Run the merger the way BrowserHost does: node <script> into extra baseline. */
function runMerge(script: string, into: string, extra: string, baseline: string): void {
  execFileSync(process.execPath, [script, into, extra, baseline], { stdio: "pipe" });
}

describe("the cookie merger as a spawned executable", () => {
  it("merges a new sign-in from the session clone into the user's profile", () => {
    const into = path.join(dir, "into.sqlite");
    const extra = path.join(dir, "extra.sqlite");
    const baseline = path.join(dir, "base.sqlite");
    store(into, ["a.example"]);
    store(baseline, ["a.example"]);
    store(extra, ["a.example", "b.example"], 50); // b.example signed in this session
    runMerge(MERGE_JS, into, extra, baseline);
    expect(hosts(into)).toEqual(["a.example", "b.example"]);
  });

  it("STILL merges when the script path contains a space (the Plow Latch.app case)", () => {
    // A directory with a space, and the merger reached through it. The old string
    // comparison made isMain() false here, so the merge silently did nothing.
    const spaced = path.join(dir, "Plow Latch");
    fs.mkdirSync(spaced, { recursive: true });
    const link = path.join(spaced, "merge cookies.js");
    fs.symlinkSync(MERGE_JS, link);

    const into = path.join(dir, "into2.sqlite");
    const extra = path.join(dir, "extra2.sqlite");
    const baseline = path.join(dir, "base2.sqlite");
    store(into, ["a.example"]);
    store(baseline, ["a.example"]);
    store(extra, ["a.example", "b.example"], 50);

    runMerge(link, into, extra, baseline);
    // The merge ran: b.example is now in the profile. Under the old bug the
    // subprocess exited 0 and into still held only a.example.
    expect(hosts(into)).toEqual(["a.example", "b.example"]);
  });
});

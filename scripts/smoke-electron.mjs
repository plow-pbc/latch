/**
 * Runtime smoke for the browser stack UNDER ELECTRON'S NODE — the one thing the
 * vitest suite can't cover, because it runs on the host's own (newer) Node. Run
 * via `just smoke-electron`, which invokes this with ELECTRON_RUN_AS_NODE so
 * `process.versions.node` is Electron's (20.x for Electron 33), the same runtime
 * the packaged app spawns the browser server on.
 *
 * It catches the class of bug the code review found: a module that loads on the
 * dev Node but not Electron's. Concretely:
 *   - node-sqlite3-wasm (the cookie merge) loads and the REAL merger merges — an
 *     ABI-locked native module (better-sqlite3) crashed here with signal 139;
 *   - playwright-core resolves and exposes `firefox.launch` — it does not launch
 *     a browser (that needs the fetched Camoufox), only proves the driver loads;
 *   - the frozen fingerprint pool parses, when present.
 *
 * No browser, no network, no display — safe for CI on the packaging Mac.
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = path.join(root, "packages", "browser-server");
const fromPkg = (name) => require(require.resolve(name, { paths: [pkg] }));

let failures = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const fail = (m) => {
  console.error(`  FAIL ${m}`);
  failures++;
};

console.log(
  `[smoke-electron] node ${process.versions.node}` +
    `${process.versions.electron ? ` (electron ${process.versions.electron})` : " (NOT electron — run via just smoke-electron)"}`,
);

// 1) The cookie-merge SQLite loads under this runtime, and the REAL merger runs.
const COLS =
  "CREATE TABLE IF NOT EXISTS moz_cookies (id INTEGER PRIMARY KEY, name TEXT, value TEXT," +
  " host TEXT, path TEXT, expiry INTEGER, lastAccessed INTEGER, creationTime INTEGER, isSecure INTEGER," +
  " isHttpOnly INTEGER, inBrowserElement INTEGER, sameSite INTEGER, rawSameSite INTEGER, schemeMap INTEGER," +
  " originAttributes TEXT, CONSTRAINT moz_uniqueid UNIQUE (name, host, path, originAttributes))";

async function smokeMerge() {
  let Database;
  try {
    ({ Database } = fromPkg("node-sqlite3-wasm"));
    ok("node-sqlite3-wasm loaded");
  } catch (e) {
    fail(`node-sqlite3-wasm did not load: ${e.message}`);
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-merge-"));
  try {
    const write = (file, hosts, usedAt) => {
      const db = new Database(path.join(dir, file));
      db.exec(COLS);
      hosts.forEach((h, i) =>
        db.run(
          "INSERT INTO moz_cookies (name,value,host,path,expiry,lastAccessed,creationTime," +
            "isSecure,isHttpOnly,inBrowserElement,sameSite,rawSameSite,schemeMap,originAttributes)" +
            " VALUES ('sid','v',?,'/',0,?,1,1,1,0,0,0,1,'')",
          [h, usedAt + i],
        ),
      );
      db.close();
    };
    write("into.db", ["a.example"], 1);
    write("base.db", ["a.example"], 1);
    write("extra.db", ["a.example", "b.example"], 50); // b.example signed in

    const mergeMod = path.join(pkg, "dist", "mergeCookies.js");
    if (!fs.existsSync(mergeMod)) {
      fail(`${path.relative(root, mergeMod)} not built — run just build`);
      return;
    }
    const { mergeCookies } = await import(mergeMod);
    mergeCookies(path.join(dir, "into.db"), path.join(dir, "extra.db"), path.join(dir, "base.db"));

    const db = new Database(path.join(dir, "into.db"), { readOnly: true });
    const hosts = db.all("SELECT host FROM moz_cookies ORDER BY host").map((r) => r.host);
    db.close();
    if (hosts.join(",") === "a.example,b.example") ok("cookie merge ran (b.example landed)");
    else fail(`cookie merge wrong: got [${hosts.join(",")}]`);
  } catch (e) {
    fail(`cookie merge threw: ${e.message}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// 2) The browser driver loads (does not launch — that needs the fetched browser).
function smokePlaywright() {
  try {
    const { firefox } = fromPkg("playwright-core");
    if (typeof firefox.launch === "function") ok("playwright-core loaded (firefox.launch present)");
    else fail("playwright-core loaded but firefox.launch is missing");
  } catch (e) {
    fail(`playwright-core did not load: ${e.message}`);
  }
}

// 3) The frozen fingerprint pool parses, when it has been generated.
function smokePool() {
  const file = path.join(pkg, "fingerprints.json");
  if (!fs.existsSync(file)) {
    console.log("  skip fingerprints.json absent (run just fetch-browser)");
    return;
  }
  try {
    const pool = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Array.isArray(pool.entries) && pool.entries.length > 0) {
      ok(`fingerprint pool parses (${pool.entries.length} entries, browser ${pool.browserVersion})`);
    } else fail("fingerprints.json has no entries");
  } catch (e) {
    fail(`fingerprints.json did not parse: ${e.message}`);
  }
}

await smokeMerge();
smokePlaywright();
smokePool();

if (failures > 0) {
  console.error(`[smoke-electron] ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("[smoke-electron] all checks passed");

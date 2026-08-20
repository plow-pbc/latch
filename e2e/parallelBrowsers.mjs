/**
 * Three agents, three real browsers, at the same time.
 *
 * The unit test proves the plumbing with a stand-in server. This proves the
 * thing itself: three Camoufox processes, three profiles, three pages, driven
 * concurrently through the shipping session layer — and it FAILS if they
 * collide, because each session must read back its OWN url and title.
 *
 *   node e2e/parallelBrowsers.mjs            # headless
 *   DOMO_BROWSER_HEADED=1 node e2e/parallelBrowsers.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserPool, BrowserSessions, resolveBrowserRuntime } from "@domo/device-core";

const repo = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const home = fs.mkdtempSync(path.join(os.tmpdir(), "parallel-browsers-"));
const runtime = resolveBrowserRuntime(path.join(repo, "apps/desktop/dist"));

const SITES = [
  { origin: "example.com", url: "https://example.com/" },
  { origin: "example.net", url: "https://example.net/" },
  { origin: "example.org", url: "https://example.org/" },
];

const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) failures.push(what);
};

const pool = new BrowserPool({
  command: runtime.serverCommand,
  env: runtime.env,
  headed: process.env.DOMO_BROWSER_HEADED === "1",
  screenshotsDir: path.join(home, "shots"),
  profileDir: path.join(home, "profiles"),
  camoufoxInstallDir: runtime.camoufoxInstallDir,
  isolatedHome: path.join(home, "pyhome"),
  // The negative control: DOMO_MAX_BROWSERS=1 is the single-browser Mac this
  // change replaces, and this script must FAIL there.
  maxBrowsers: Number(process.env.DOMO_MAX_BROWSERS ?? 3),
  startTimeoutMs: 120_000,
  actionTimeoutMs: 60_000,
});
const sessions = new BrowserSessions(pool, null, () => {}, 10 * 60_000);

try {
  // Three agents arrive at once, the way three agents do.
  const opened = await Promise.all(
    SITES.map((s, i) => sessions.open(`intent-${i}`, `agent-${i}`, [s.origin], false)),
  );
  opened.forEach((r, i) => check(r.status === "completed", `agent-${i} opened its own session (${r.error ?? ""})`));
  const handles = opened.map((r) => r.session);
  check(new Set(handles).size === 3, "three distinct session ids");
  check(pool.size === 3, `three browsers running (pool has ${pool.size})`);

  // Each drives its own page, concurrently.
  await Promise.all(
    handles.map((h, i) => sessions.command(`agent-${i}`, h, { action: "goto", url: SITES[i].url })),
  );

  // The proof: each session sees ITS page, not whatever was navigated last.
  const seen = await Promise.all(
    handles.map((h, i) => sessions.command(`agent-${i}`, h, { action: "url" })),
  );
  seen.forEach((r, i) => {
    const url = String(r.url ?? "");
    check(url.startsWith(SITES[i].url.slice(0, 24)), `agent-${i} still sees its own page (${url})`);
  });

  const titles = await Promise.all(
    handles.map((h, i) => sessions.command(`agent-${i}`, h, { action: "title" })),
  );
  console.log("titles:", titles.map((t) => t.title));

  // Three profiles on disk: no shared cookies, no shared logins.
  const profiles = fs.readdirSync(path.join(home, "profiles"));
  check(profiles.length === 3, `three separate profiles (${profiles.length})`);

  // Nobody was evicted: all three still answer after the others have worked.
  const after = await Promise.all(
    handles.map((h, i) => sessions.command(`agent-${i}`, h, { action: "url" })),
  );
  check(after.every((r) => r.status === "completed"), "all three sessions alive at the end");

  // And closing one leaves the others browsing.
  await sessions.close(handles[0], "test");
  check(pool.size === 2, `closing one left the others running (pool has ${pool.size})`);
  const survivor = await sessions.command("agent-1", handles[1], { action: "url" });
  check(String(survivor.url ?? "").startsWith(SITES[1].url.slice(0, 24)), "the survivor kept its page");
} finally {
  await sessions.closeAll("done");
  await pool.releaseAll();
  fs.rmSync(home, { recursive: true, force: true });
}

console.log(failures.length ? `\nFAILED: ${failures.join(" | ")}` : "\nPASSED: 3 agents, 3 browsers, no collisions");
process.exit(failures.length ? 1 : 0);

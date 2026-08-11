#!/usr/bin/env node
/**
 * Fake apw (Apple Passwords CLI) for unit tests: speaks the same CLI surface
 * as the vendored deno binary — `start` (foreground daemon), `auth request` /
 * `auth response --pin`, `pw list|get`, `otp get` — with the same JSON output
 * shapes, stderr error lines ({error, status, results}) and exit codes. The
 * real binary is exercised manually / by `just app`; this fake keeps the TS
 * layer testable with no deno, no Chromium, and no iCloud.
 *
 * Env:
 *   FAKE_APW_STATE  dir holding daemon/pairing markers ("daemon",
 *                   "pin-requested", "paired") so short-lived CLI invocations
 *                   can see the daemon's state, like the real Unix socket does.
 *   FAKE_APW_VAULT  JSON file: [{ "username", "domain", "sites": ["https://…"],
 *                   "password", "otp" }]
 *   FAKE_APW_PIN    the accepted pairing PIN (default "123456")
 *   FAKE_APW_FAIL   "no-browser" → `start` fails like apw with no Chromium
 *   FAKE_APW_EXIT_AFTER  ms after which a started daemon exits on its own
 *                   (simulates a crashed helper)
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const stateDir = process.env.FAKE_APW_STATE;
const PIN = process.env.FAKE_APW_PIN || "123456";

// apw's status codes.
const GENERIC_ERROR = 1;
const INVALID_SESSION = 9;

function marker(name) {
  return path.join(stateDir, name);
}

function fail(status, message) {
  process.stderr.write(JSON.stringify({ error: message, status, results: [] }) + "\n");
  process.exit(status);
}

function ok(payload) {
  process.stdout.write(JSON.stringify({ ...payload, status: 0 }) + "\n");
}

function requirePaired() {
  if (!fs.existsSync(marker("daemon")) || !fs.existsSync(marker("paired"))) {
    fail(INVALID_SESSION, "APW is not running or not authenticated, run `apw start` then `apw auth`");
  }
}

function vault() {
  return JSON.parse(fs.readFileSync(process.env.FAKE_APW_VAULT, "utf8"));
}

function hostOf(url) {
  try {
    return new URL(url.includes("://") ? url : `https://${url}`).hostname;
  } catch {
    return null;
  }
}

/** Apple-style domain matching: the page host equals the saved domain or is a
 * subdomain of it (the helper matches on high-level domain). Faithful quirk:
 * the real helper matches NOTHING when the query carries a scheme/path — it
 * wants a bare hostname (observed live; the broker must strip URLs first). */
function matches(entry, url) {
  if (String(url).includes("://")) return false;
  const host = hostOf(url);
  if (!host) return false;
  const domains = [entry.domain, ...(entry.sites || []).map(hostOf)].filter(Boolean);
  return domains.some((d) => host === d || host.endsWith("." + d));
}

const args = process.argv.slice(2).filter((a) => a !== "--json" && a !== "-j");
const [cmd, sub, ...rest] = args;

if (cmd === "start") {
  if (process.env.FAKE_APW_FAIL === "no-browser") {
    fail(GENERIC_ERROR, "No supported browser found. Install one:\n  brew install --cask ungoogled-chromium");
  }
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(marker("daemon"), String(process.pid));
  const cleanup = () => {
    for (const m of ["daemon", "pin-requested", "paired"]) fs.rmSync(marker(m), { force: true });
    process.exit(0);
  };
  process.on("SIGTERM", cleanup);
  process.on("SIGINT", cleanup);
  // The two readiness lines ApwDaemon watches for, same wording as apw.
  process.stdout.write(`[apw] launched headless Fake Browser; extension loaded.\n`);
  process.stdout.write(`[apw] Unix socket at ${marker("apw.sock")}\n`);
  process.stdout.write(`[apw] extension connected\n`);
  const exitAfter = Number(process.env.FAKE_APW_EXIT_AFTER || 0);
  if (exitAfter > 0) setTimeout(cleanup, exitAfter);
  setInterval(() => {}, 1000); // stay alive until signalled
} else if (cmd === "auth" && sub === "request") {
  if (!fs.existsSync(marker("daemon"))) fail(INVALID_SESSION, "APW is not running");
  fs.writeFileSync(marker("pin-requested"), "");
  ok({});
} else if (cmd === "auth" && sub === "response") {
  if (!fs.existsSync(marker("daemon"))) fail(INVALID_SESSION, "APW is not running");
  const i = rest.indexOf("--pin");
  const pin = i !== -1 ? rest[i + 1] : null;
  // Faithful to apw's bridge: the response is acked as soon as the PIN is
  // DELIVERED — exit 0 even for a wrong PIN. Only a correct PIN actually
  // establishes the session (later queries reveal which happened).
  if (fs.existsSync(marker("pin-requested")) && pin === PIN) {
    fs.writeFileSync(marker("paired"), "");
  }
  ok({});
} else if (cmd === "pw" && sub === "list") {
  requirePaired();
  const url = rest[0] || "";
  const results = vault()
    .filter((e) => matches(e, url))
    .map((e) => ({ username: e.username, domain: e.domain, sites: e.sites || [] }));
  ok({ results });
} else if (cmd === "pw" && sub === "get") {
  requirePaired();
  const [url, username] = rest;
  const results = vault()
    .filter((e) => matches(e, url || "") && (!username || e.username === username))
    .map((e) => ({ username: e.username, domain: e.domain, sites: e.sites || [], password: e.password }));
  ok({ results }); // like apw, no matches is an empty result set, not an error
} else if (cmd === "otp" && sub === "get") {
  requirePaired();
  const url = rest[0] || "";
  const results = vault()
    .filter((e) => matches(e, url) && e.otp)
    .map((e) => ({ username: e.username, domain: e.domain, code: e.otp }));
  ok({ results });
} else {
  fail(GENERIC_ERROR, `unknown command: ${args.join(" ")}`);
}

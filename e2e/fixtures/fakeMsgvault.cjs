#!/usr/bin/env node
/**
 * Fake msgvault CLI for unit tests: speaks the argv surface the MsgvaultClient
 * uses (search / show-message / stats / import-imessage / daemon stop /
 * --version) and records every invocation so tests can assert on the exact
 * argv and environment the real binary would have seen.
 *
 * Env knobs:
 *   FAKE_MSGVAULT_LOG       append one JSON line {argv, msgvaultHome} per call
 *   FAKE_MSGVAULT_DELAY_MS  sleep before answering (drives timeout/deferral tests)
 *   FAKE_MSGVAULT_FAIL      exit 1 with this message on stderr
 *   FAKE_MSGVAULT_NO_STATS_JSON  reject `stats --json` (exercise the fallback)
 */
"use strict";
const fs = require("node:fs");

const argv = process.argv.slice(2);

if (process.env.FAKE_MSGVAULT_LOG) {
  fs.appendFileSync(
    process.env.FAKE_MSGVAULT_LOG,
    JSON.stringify({ argv, msgvaultHome: process.env.MSGVAULT_HOME ?? null }) + "\n",
  );
}

function argValue(flag) {
  const i = argv.indexOf(flag);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : null;
}

/** Everything after the `--` terminator, joined — the positional the real
 * cobra parser would see. */
function positional() {
  const i = argv.indexOf("--");
  return i === -1 ? null : argv.slice(i + 1).join(" ");
}

function finish(fn) {
  const delay = Number(process.env.FAKE_MSGVAULT_DELAY_MS ?? "0");
  setTimeout(() => {
    if (process.env.FAKE_MSGVAULT_FAIL) {
      process.stderr.write(process.env.FAKE_MSGVAULT_FAIL + "\n");
      process.exit(1);
    }
    fn();
    process.exit(0);
  }, delay);
}

const cmd = argv[0];

if (cmd === "version") {
  finish(() => process.stdout.write("msgvault v0.19.3\n  commit: fake\n"));
} else if (cmd === "search") {
  const limit = Number(argValue("--limit") ?? "50");
  const query = positional() ?? "";
  const all = [
    { id: "m1", from: "Alice", date: "2026-01-05T10:00:00Z", snippet: `about ${query}` },
    { id: "m2", from: "Bob", date: "2026-02-01T12:30:00Z", snippet: "see you then" },
    { id: "m3", from: "Alice", date: "2026-03-11T09:15:00Z", snippet: "flight AA100" },
  ];
  finish(() => process.stdout.write(JSON.stringify(all.slice(0, limit)) + "\n"));
} else if (cmd === "show-message") {
  const id = positional() ?? "";
  finish(() =>
    process.stdout.write(
      JSON.stringify({ id, from: "Alice", date: "2026-01-05T10:00:00Z", body: "full text" }) + "\n",
    ),
  );
} else if (cmd === "stats") {
  if (argv.includes("--json") && !process.env.FAKE_MSGVAULT_NO_STATS_JSON) {
    finish(() => process.stdout.write(JSON.stringify({ messages: 100, sources: ["imessage"] }) + "\n"));
  } else if (argv.includes("--json")) {
    process.stderr.write("Error: unknown flag: --json\n");
    process.exit(1);
  } else {
    finish(() => process.stdout.write("Messages: 100\nSources: imessage\n"));
  }
} else if (cmd === "import-imessage") {
  const limit = argValue("--limit") ?? "all";
  finish(() => process.stdout.write(`Importing iMessages\nImported ${limit} messages\n`));
} else if (cmd === "daemon" && argv[1] === "stop") {
  finish(() => process.stdout.write("Daemon stopped\n"));
} else {
  process.stderr.write(`fake msgvault: unknown command: ${argv.join(" ")}\n`);
  process.exit(1);
}

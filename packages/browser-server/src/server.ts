#!/usr/bin/env node
/**
 * The Camoufox browser server — the executable that replaces
 * vendor/browser-server/server.py. Started directly by the device supervisor
 * (BrowserHost). Protocol unchanged: JSON lines over stdio — requests
 * {"id", "action", ...} on stdin, responses {"id", "result"|"error"} on stdout,
 * preceded by one {"status":"ready", ...} line once the browser is up.
 *
 * Node needs none of Python's fd juggling: nothing but this code writes to our
 * stdout, and Playwright/Firefox noise goes to their own stderr. Exit paths —
 * SIGTERM, a {"action":"quit"} request, or EOF on stdin — all close the browser
 * context so Firefox children die.
 */
import fs from "node:fs";
import readline from "node:readline";
import { JSONValue } from "@domo/protocol";
import { launchBrowser, type LaunchedBrowser } from "./launch.js";
import { SerialQueue } from "./serialize.js";
import { Session } from "./session.js";

const MAX_ERROR_LEN = 500;

interface Args {
  screenshotsDir: string;
  executable: string;
  profileDir?: string;
  headed: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> & { headed: boolean } = { headed: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--screenshots-dir") out.screenshotsDir = argv[++i];
    else if (a === "--executable") out.executable = argv[++i];
    else if (a === "--profile-dir") out.profileDir = argv[++i];
    else if (a === "--headed") out.headed = true;
  }
  if (!out.screenshotsDir) throw new Error("--screenshots-dir is required");
  if (!out.executable) throw new Error("--executable is required");
  return out as Args;
}

function respond(payload: { [k: string]: JSONValue }): void {
  process.stdout.write(JSON.stringify(payload) + "\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  fs.mkdirSync(args.screenshotsDir, { recursive: true });

  // The frozen fingerprint pool lives at the package root (build-time output of
  // scripts/build-browser-runtime.mjs); this file is dist/server.js, one level
  // under it.
  const { fileURLToPath } = await import("node:url");
  const path = await import("node:path");
  const poolDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

  let launched: LaunchedBrowser;
  try {
    launched = await launchBrowser({
      executablePath: args.executable,
      poolDir,
      headed: args.headed,
      profileDir: args.profileDir,
      pinPath: process.env.DOMO_FINGERPRINT_PIN,
    });
  } catch (err) {
    respond({ status: "error", error: String((err as Error).message).slice(0, MAX_ERROR_LEN) });
    process.exit(1);
  }

  const session = new Session(launched.page);
  respond({ status: "ready", pid: process.pid, browser_version: launched.version });

  let closing = false;
  const shutdown = async (code: number): Promise<void> => {
    if (closing) return;
    closing = true;
    try {
      await launched.close();
    } catch {
      /* already gone */
    }
    process.exit(code);
  };
  process.on("SIGTERM", () => void shutdown(0));

  const rl = readline.createInterface({ input: process.stdin });
  // Actions run STRICTLY ONE AT A TIME (SerialQueue), the way the Python server's
  // `for line in sys.stdin` did — otherwise the async handlers overlap and a
  // `view` poll, a `quit`, or a fill can interleave. EOF-close is chained onto
  // the SAME queue so an action in flight finishes before the context closes
  // (the supervisor SIGKILLs the group if that stalls).
  const queue = new SerialQueue();
  rl.on("line", (raw) => queue.run(() => onLine(raw)));
  rl.on("close", () => queue.run(() => shutdown(0)));

  async function onLine(raw: string): Promise<void> {
    const line = raw.trim();
    if (!line) return;
    let cmd: { [k: string]: JSONValue };
    try {
      cmd = JSON.parse(line) as { [k: string]: JSONValue };
    } catch {
      respond({ id: null, error: "invalid JSON" });
      return;
    }
    const rid = (cmd.id as JSONValue) ?? null;
    if (cmd.action === "quit") {
      respond({ id: rid, result: { ok: true } });
      await shutdown(0);
      return;
    }
    let reply: { [k: string]: JSONValue };
    try {
      const result = await session.run(cmd, args.screenshotsDir);
      reply = { id: rid, result };
    } catch (exc) {
      reply = { id: rid, error: String((exc as Error).message).slice(0, MAX_ERROR_LEN) };
    }
    respond(session.replyWithFailures(reply));
  }
}

void main().catch((err) => {
  respond({ status: "error", error: String((err as Error).message).slice(0, MAX_ERROR_LEN) });
  process.exit(1);
});

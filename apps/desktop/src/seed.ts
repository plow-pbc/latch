/**
 * Build the LTMM fact store on first launch, so recall has something to answer
 * from without the user configuring anything.
 *
 * `ltmm run` with no arguments resolves the owner's #1 contact itself and builds
 * from that conversation, so Domo never needs to know or hardcode a conversation
 * id. The build is a multi-hour batch over years of messages: it is spawned
 * detached and never awaited.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

/**
 * `started` means the spawn was *attempted*, not that ltmm is running: spawn
 * reports a missing binary asynchronously on the child's `error` event, long
 * after this function has returned. There is deliberately no failure variant --
 * this function cannot know, and inventing one would certify a path production
 * never takes.
 */
export type SeedOutcome = "started" | "already-running";

export interface SeedDeps {
  buildIsRunning(): boolean;
  /** Spawn the build *and* write down its pid. One act, not two. */
  startBuild(bin: string, args: string[]): void;
}

/** Where Domo records the pid of the build it started, under DOMO_HOME. */
export const seedPidPath = (home: string): string => path.join(home, "device/seed.pid");

/**
 * Liveness, not completion — the whole state machine.
 *
 * `ltmm run` is resumable by design: it records processed days in a `progress`
 * table and skips them next time. So "did the last build finish?" never needs
 * answering. Re-spawning after a death is correct and cheap, and re-spawning
 * over a *live* build is the only thing worth preventing.
 *
 * Anything unreadable or malformed counts as not running, which is the safe
 * direction: the cost is a resumed build, and the cost of being wrong the other
 * way is a user who silently never gets facts at all.
 */
function recordedPid(home: string): number | null {
  try {
    const pid = Number.parseInt(fs.readFileSync(seedPidPath(home), "utf8"), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isAlive(pid: number | null): boolean {
  if (pid === null) return false;
  try {
    // Signal 0 runs the permission and existence checks without delivering
    // anything; it throws ESRCH when no such process exists.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export const liveDeps = (home: string): SeedDeps => ({
  buildIsRunning: () => isAlive(recordedPid(home)),
  startBuild: (bin, args) => {
    const child = spawn(bin, args, { detached: true, stdio: "ignore" });
    // Required, not optional: spawn delivers a missing binary as an async
    // `error` event, and an EventEmitter with no `error` listener re-throws it
    // as an uncaught exception -- which in the Electron main process takes the
    // whole app down on any Mac that has no ltmm installed.
    child.on("error", (e) => console.log(`[seed] ltmm unavailable: ${e.message}`));
    // Let the build outlive this process: it takes hours, and quitting the app
    // would otherwise throw away everything built so far.
    child.unref();
    // A spawn that failed has no pid, and recording nothing is exactly right --
    // the next launch finds no live build and tries again.
    if (child.pid === undefined) return;
    const pidFile = seedPidPath(home);
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    fs.writeFileSync(pidFile, `${child.pid}\n`);
  },
});

export function seedIfMissing(deps: SeedDeps): SeedOutcome {
  if (deps.buildIsRunning()) return "already-running";
  // Deliberately unguarded, and that rests on the binary name being non-empty
  // rather than on the argv being constant: `spawn("")` throws
  // ERR_INVALID_ARG_VALUE *synchronously*, before any child exists to emit
  // `error`, and it would escape this unguarded app-ready handler. `||` rather
  // than `??` is what makes that unreachable -- `??` keeps an empty string, and
  // `DOMO_LTMM_BIN=$(which ltmm)` on a Mac with no ltmm sets exactly that.
  deps.startBuild(process.env.DOMO_LTMM_BIN?.trim() || "ltmm", ["run"]);
  return "started";
}

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
import { execFileSync, spawn } from "node:child_process";

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
function recordedBuild(home: string): { pid: number; startedAt: number } | null {
  try {
    const [pid, startedAt] = fs
      .readFileSync(seedPidPath(home), "utf8")
      .trim()
      .split(/\s+/)
      .map((field) => Number.parseInt(field, 10));
    if (!Number.isInteger(pid) || pid <= 0) return null;
    if (!Number.isInteger(startedAt)) return null;
    return { pid, startedAt };
  } catch {
    return null;
  }
}

/**
 * `lstart` has one-second resolution and is read a moment after the recorded
 * `Date.now()`, so they agree to within a second in practice. Wide enough to
 * absorb that, far narrower than the gap to any unrelated process.
 */
const START_TOLERANCE_MS = 5_000;

function isRunning(record: { pid: number; startedAt: number } | null): boolean {
  if (record === null) return false;
  try {
    // Identity, not liveness. A pid is a slot the OS reuses: macOS hands them
    // out sequentially and wraps at 99999, so on a Mac with weeks of uptime the
    // number recorded for a finished build comes back around to something else
    // the user is running -- and since nothing rewrites this record, believing
    // it would skip seeding for as long as that process lives.
    //
    // Pid plus start time is the durable identity. Deliberately NOT `comm`:
    // `ltmm` is a Python console script, and `ps -o comm=` reports the
    // interpreter for a shebang script (measured: a `#!/bin/sh` script reports
    // `/bin/sh`), so name-matching would fail for the real binary and respawn a
    // duplicate build on every launch. Deliberately NOT boot-time arithmetic
    // either: comparing a recorded wall clock against one re-derived from
    // uptime breaks under an NTP correction, and errs toward a second build.
    // Both sides here are the same wall-clock instant, recorded once.
    const lstart = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(record.pid)], {
      encoding: "utf8",
      timeout: 5_000,
    }).trim();
    const actualStart = Date.parse(lstart);
    return (
      !Number.isNaN(actualStart) && Math.abs(actualStart - record.startedAt) <= START_TOLERANCE_MS
    );
  } catch {
    // No such process, or ps itself failed. Falls through to running the build,
    // the safe direction everywhere in this file.
    return false;
  }
}

export const liveDeps = (home: string): SeedDeps => ({
  buildIsRunning: () => isRunning(recordedBuild(home)),
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
    try {
      fs.mkdirSync(path.dirname(pidFile), { recursive: true });
      // The start time rides along because the pid alone is not an identity;
      // see isRunning.
      fs.writeFileSync(pidFile, `${child.pid} ${Date.now()}\n`);
    } catch (recordFailed) {
      // This runs inside an unguarded app-ready handler, and it now runs on
      // every launch that starts a build rather than once ever, so an EACCES or
      // ENOSPC on DOMO_HOME must not take the app down. The build has already
      // spawned; the only cost of losing the record is starting it again later,
      // which ltmm resumes.
      console.log(`[seed] could not record build start: ${String(recordFailed)}`);
    }
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

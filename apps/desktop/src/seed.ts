/**
 * Build the LTMM fact store on first launch, so recall has something to answer
 * from without the user configuring anything.
 *
 * `ltmm run` with no arguments resolves the owner's #1 contact itself and builds
 * from that conversation, so Domo never needs to know or hardcode a conversation
 * id. The build is a multi-hour batch over years of messages: it is spawned
 * detached and never awaited, and only ever once.
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
export type SeedOutcome = "started" | "already-seeded";

export interface SeedDeps {
  alreadySeeded(): boolean;
  /** Spawn the build *and* write down that it was spawned. One act, not two. */
  startBuild(bin: string, args: string[]): void;
}

/**
 * Domo's own record that it has started a build, under DOMO_HOME.
 *
 * Deliberately not a probe of ltmm's store file. Where ltmm writes that file is
 * a fact this repo cannot see — its DEFAULT_STORE is currently the relative
 * `facts.db`, not an absolute path — and a probe that guesses wrong answers "no
 * store" on every launch forever. For a detached multi-hour batch that is not a
 * missed optimisation: it stacks one more concurrent build over the owner's
 * messages on every single launch. "Have I already started this?" is Domo's
 * question, so Domo writes the answer down where it can also read it.
 *
 * Still presence, not completion: an interrupted build is not restarted. That is
 * the safe direction to be wrong in — `ltmm run` resumes from its own progress
 * whenever it is next run, whereas a duplicate build cannot be taken back.
 */
export const seedMarkerPath = (home: string): string => path.join(home, "device/seed-started");

export const liveDeps = (home: string): SeedDeps => ({
  alreadySeeded: () => fs.existsSync(seedMarkerPath(home)),
  startBuild: (bin, args) => {
    const marker = seedMarkerPath(home);
    const child = spawn(bin, args, { detached: true, stdio: "ignore" });
    // Required, not optional: spawn delivers a missing binary as an async
    // `error` event, and an EventEmitter with no `error` listener re-throws it
    // as an uncaught exception -- which in the Electron main process takes the
    // whole app down on any Mac that has no ltmm installed.
    //
    // It also undoes the record below, which spawn returning was never evidence
    // for. Without that, a Mac where ltmm is not on the launchd PATH writes the
    // marker, fails a moment later, and reports `already-seeded` forever after
    // -- including once the user installs ltmm -- with no path that ever clears
    // it. The failure we can already detect has to reopen the door.
    child.on("error", (e) => {
      console.log(`[seed] ltmm unavailable: ${e.message}`);
      try {
        fs.rmSync(marker, { force: true });
      } catch (unlinkFailed) {
        // This handler exists to keep a failure out of the main process's
        // uncaught path; it must not become one itself. `force` already absorbs
        // a missing file, so anything reaching here is a real filesystem
        // problem, and the cost is only that seeding is not retried.
        console.log(`[seed] could not clear ${marker}: ${String(unlinkFailed)}`);
      }
    });
    // Let the build outlive this process: it takes hours, and quitting the app
    // would otherwise throw away everything built so far.
    child.unref();
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, `${new Date().toISOString()}\n`);
  },
});

export function seedIfMissing(deps: SeedDeps): SeedOutcome {
  if (deps.alreadySeeded()) return "already-seeded";
  // Deliberately unguarded, and that rests on the binary name being non-empty
  // rather than on the argv being constant: `spawn("")` throws
  // ERR_INVALID_ARG_VALUE *synchronously*, before any child exists to emit
  // `error`, and it would escape this unguarded app-ready handler. `||` rather
  // than `??` is what makes that unreachable -- `??` keeps an empty string, and
  // `DOMO_LTMM_BIN=$(which ltmm)` on a Mac with no ltmm sets exactly that.
  deps.startBuild(process.env.DOMO_LTMM_BIN?.trim() || "ltmm", ["run"]);
  return "started";
}

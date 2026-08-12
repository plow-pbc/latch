/**
 * Start the LTMM fact-store build on launch, so recall has something to answer
 * from without the user configuring anything.
 *
 * `ltmm run` with no arguments resolves the owner's #1 contact itself and builds
 * from that conversation, so Domo never needs to know or hardcode a conversation
 * id. The build is a multi-hour batch over years of messages, so it is spawned
 * detached and never awaited.
 *
 * Unconditional by design. Domo does not track whether a build is running,
 * finished, or died. Every attempt to answer "have we already seeded?" from this
 * side needed a record of a *previous* run, and any such record is either stale
 * (a build that died, or a store that has since fallen behind new messages,
 * skipped forever) or a lie (a pid is a slot the OS reuses). Asking ltmm has
 * neither failure mode, and a store that has fallen behind now catches up on the
 * next launch.
 *
 * That correctness is borrowed, not local, so state the contract plainly. This
 * depends on three behaviors of whatever `ltmm` is on the machine:
 *
 *  1. `run` resumes from its `progress` table rather than rebuilding.
 *  2. `run` exits 0 with "nothing to do" when every day is processed.
 *  3. Two concurrent `run`s do not corrupt the store.
 *
 * (1) and (2) hold as of the sibling PR that adds `query --json`. **(3) does
 * not hold yet** -- there is no stand-down when another run holds the store, and
 * two runs read `done_days` once at start, so they would process the same days
 * and decay each twice. That PR must land the guard before this ships. Nothing
 * on this side can check any of it: `DOMO_LTMM_BIN` points at whatever the user
 * has, and there is no version floor.
 */
import { spawn } from "node:child_process";

export interface SeedDeps {
  startBuild(bin: string, args: string[]): void;
}

export const liveDeps: SeedDeps = {
  startBuild: (bin, args) => {
    const child = spawn(bin, args, { detached: true, stdio: "ignore" });
    // Required, not optional: spawn delivers a missing binary as an async
    // `error` event, and an EventEmitter with no `error` listener re-throws it
    // as an uncaught exception -- which in the Electron main process takes the
    // whole app down on any Mac that has no ltmm installed.
    child.on("error", (e) => console.log(`[seed] ltmm unavailable: ${e.message}`));
    // The only record that a build was started, now that nothing is written
    // down. `stdio: "ignore"` throws away ltmm's own output, so without this
    // line "how many times, and when, did Domo spawn a build?" is unanswerable
    // -- which is the first question to ask if two ever overlap.
    // Gated on the pid: a failed spawn returns a ChildProcess whose pid is
    // already undefined, so an ungated line would claim a start on every launch
    // of a Mac with no ltmm and contradict the listener above a tick later.
    if (child.pid !== undefined) console.log(`[seed] started ${bin} run (pid ${child.pid})`);
    // Let the build outlive this process: it takes hours, and quitting the app
    // would otherwise throw away everything built so far.
    child.unref();
  },
};

export function startSeeding(deps: SeedDeps = liveDeps): void {
  // Unguarded, and that rests on the binary name being non-empty: `spawn("")`
  // throws ERR_INVALID_ARG_VALUE synchronously, before any child exists to emit
  // `error`, and it would escape the app-ready handler that calls this. `||`
  // rather than `??` is what keeps it unreachable -- `??` keeps an empty string,
  // and `DOMO_LTMM_BIN=$(which ltmm)` on a Mac with no ltmm sets exactly that.
  deps.startBuild(process.env.DOMO_LTMM_BIN?.trim() || "ltmm", ["run"]);
}

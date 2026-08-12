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
 * finished, or died -- `ltmm run` resumes from its own `progress` table and
 * prints "nothing to do: every day is already processed" when it is caught up,
 * so asking it again is the cheapest correct thing Domo can do. Every attempt to
 * answer "have we already seeded?" from this side needed a record of a
 * *previous* run, and any such record is either stale (a build that died, or a
 * store that has since fallen behind new messages, skipped forever) or a lie (a
 * pid is a slot the OS reuses). Asking ltmm has neither failure mode, and a
 * store that has fallen behind now catches up on the next launch.
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

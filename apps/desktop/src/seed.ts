/**
 * Build the LTMM fact store on first launch, so recall has something to answer
 * from without the user configuring anything.
 *
 * `ltmm run` with no arguments resolves the owner's #1 contact itself and builds
 * from that conversation, so Domo never needs to know or hardcode a conversation
 * id. The build is a multi-hour batch over years of messages: it is spawned
 * detached and never awaited, and a launch that finds a store already present
 * does nothing at all.
 */
import fs from "node:fs";
import os from "node:os";
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
  storeExists(): boolean;
  spawn(bin: string, args: string[]): void;
}

/**
 * Where `ltmm` puts its store by default — beside msgvault's own artifacts.
 * `DOMO_LTMM_STORE` overrides it, mirroring `DOMO_LTMM_BIN`, because a store
 * configured elsewhere would otherwise never be found and every launch would
 * start a duplicate build.
 *
 * Known limitation: this is a presence probe, not a completion probe, so it
 * cannot tell a finished store from one an interrupted run left behind — a
 * partial store reads as done and is never resumed. Distinguishing them needs a
 * completion signal `ltmm` does not currently expose.
 */
export const storePath = (): string =>
  process.env.DOMO_LTMM_STORE?.trim() || path.join(os.homedir(), ".msgvault", "ltmm", "facts.db");

export const liveDeps: SeedDeps = {
  storeExists: () => fs.existsSync(storePath()),
  spawn: (bin, args) => {
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

export function seedIfMissing(deps: SeedDeps = liveDeps): SeedOutcome {
  if (deps.storeExists()) return "already-seeded";
  // Deliberately unguarded, and that rests on the binary name being non-empty
  // rather than on the argv being constant: `spawn("")` throws
  // ERR_INVALID_ARG_VALUE *synchronously*, before any child exists to emit
  // `error`, and it would escape this unguarded app-ready handler. `||` rather
  // than `??` is what makes that unreachable -- `??` keeps an empty string, and
  // `DOMO_LTMM_BIN=$(which ltmm)` on a Mac with no ltmm sets exactly that.
  deps.spawn(process.env.DOMO_LTMM_BIN?.trim() || "ltmm", ["run"]);
  return "started";
}

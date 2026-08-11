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

export type SeedOutcome = "started" | "already-seeded" | "unavailable";

export interface SeedDeps {
  storeExists(): boolean;
  spawn(bin: string, args: string[]): void;
}

/** Where `ltmm` puts its store by default — beside msgvault's own artifacts. */
export const STORE_PATH = path.join(os.homedir(), ".msgvault", "ltmm", "facts.db");

export const liveDeps: SeedDeps = {
  storeExists: () => fs.existsSync(STORE_PATH),
  spawn: (bin, args) => {
    const child = spawn(bin, args, { detached: true, stdio: "ignore" });
    // Let the build outlive this process: it takes hours, and quitting the app
    // should not throw away a partial run. `progress` in the store means a
    // resumed run picks up exactly where it stopped.
    child.unref();
  },
};

export function seedIfMissing(deps: SeedDeps = liveDeps): SeedOutcome {
  if (deps.storeExists()) return "already-seeded";
  try {
    deps.spawn(process.env.DOMO_LTMM_BIN ?? "ltmm", ["run"]);
    return "started";
  } catch {
    // ltmm not installed. Recall will report an empty store until it is; that is
    // a better launch than a crash.
    return "unavailable";
  }
}

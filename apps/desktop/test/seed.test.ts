import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { liveDeps, seedIfMissing } from "../src/seed.js";

function deps(overrides: Partial<Parameters<typeof seedIfMissing>[0]> = {}) {
  const started: Array<{ bin: string; args: string[] }> = [];
  return {
    started,
    deps: {
      alreadySeeded: () => false,
      startBuild: (bin: string, args: string[]) => {
        started.push({ bin, args });
      },
      ...overrides,
    },
  };
}

/** A throwaway DOMO_HOME, so liveDeps can be driven for real. */
function withHome(body: (home: string) => void): void {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "domo-seed-"));
  try {
    body(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

afterEach(() => {
  delete process.env.DOMO_LTMM_BIN;
});

describe("seedIfMissing", () => {
  it("starts a build with no conversation argument, so ltmm picks the top contact", () => {
    // The exact argv is the whole point of the zero-argument bootstrap: Domo
    // must not need to know which conversation matters, and must not hardcode
    // one. `toEqual` pins that far more tightly than probing for an absence.
    const { started, deps: d } = deps();
    expect(seedIfMissing(d)).toBe("started");
    expect(started).toHaveLength(1);
    expect(started[0].args).toEqual(["run"]);
  });

  it("does nothing when a build has already been started", () => {
    // Seeding is a multi-hour batch. Re-running it on every launch would
    // relaunch that batch behind the user's back on a store already being built.
    const { started, deps: d } = deps({ alreadySeeded: () => true });
    expect(seedIfMissing(d)).toBe("already-seeded");
    expect(started).toHaveLength(0);
  });

  it("records the build under DOMO_HOME, so a second launch never starts another", () => {
    // The branch that matters most and the one an injected `alreadySeeded` can
    // never cover: if the real probe answers "no" forever, every launch stacks
    // another multi-hour build over the owner's messages. `/usr/bin/true` stands
    // in for ltmm because the marker is the behavior under test, not the build.
    process.env.DOMO_LTMM_BIN = "/usr/bin/true";
    withHome((home) => {
      const live = liveDeps(home);
      expect(live.alreadySeeded()).toBe(false);

      expect(seedIfMissing(live)).toBe("started");

      expect(live.alreadySeeded()).toBe(true);
      expect(seedIfMissing(live)).toBe("already-seeded");
    });
  });

  it("survives a missing ltmm instead of taking the app down", async () => {
    // Drives the REAL liveDeps, because an injected stub cannot reproduce this:
    // spawn reports a missing binary asynchronously on the child's `error`
    // event, and an unlistened `error` re-throws as an uncaught exception in the
    // Electron main process. Without the listener this test file fails on that
    // uncaught exception rather than on an assertion.
    process.env.DOMO_LTMM_BIN = path.join(os.tmpdir(), "domo-no-such-ltmm");
    withHome((home) => {
      expect(seedIfMissing(liveDeps(home))).toBe("started");
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  it("treats an empty DOMO_LTMM_BIN as unset rather than spawning nothing", () => {
    // `DOMO_LTMM_BIN=$(which ltmm)` on a Mac without ltmm sets exactly this,
    // and spawn("") throws ERR_INVALID_ARG_VALUE synchronously — before any
    // child exists to emit `error` — straight out of the app-ready handler.
    //
    // Asserted through the stub rather than liveDeps, unlike the tests above:
    // once the fallback works, real liveDeps spawns a real `ltmm run`, which on
    // a machine that HAS ltmm starts a multi-hour build over the owner's
    // messages. The resolution rule is the fix, and it is what this pins.
    process.env.DOMO_LTMM_BIN = "";
    const { started, deps: d } = deps();
    expect(seedIfMissing(d)).toBe("started");
    expect(started[0].bin).toBe("ltmm");
  });
});

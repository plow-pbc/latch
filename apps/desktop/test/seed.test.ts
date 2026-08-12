import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { liveDeps, seedIfMissing, seedPidPath } from "../src/seed.js";

function deps(overrides: Partial<Parameters<typeof seedIfMissing>[0]> = {}) {
  const started: Array<{ bin: string; args: string[] }> = [];
  return {
    started,
    deps: {
      buildIsRunning: async () => false,
      startBuild: (bin: string, args: string[]) => {
        started.push({ bin, args });
      },
      ...overrides,
    },
  };
}

/** A throwaway DOMO_HOME, so liveDeps can be driven for real. */
async function withHome(body: (home: string) => Promise<void>): Promise<void> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "domo-seed-"));
  try {
    await body(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function writePid(home: string, contents: string): void {
  fs.mkdirSync(path.dirname(seedPidPath(home)), { recursive: true });
  fs.writeFileSync(seedPidPath(home), contents);
}

afterEach(() => {
  delete process.env.DOMO_LTMM_BIN;
});

describe("seedIfMissing", () => {
  it("starts a build with no conversation argument, so ltmm picks the top contact", async () => {
    // The exact argv is the whole point of the zero-argument bootstrap: Domo
    // must not need to know which conversation matters, and must not hardcode
    // one. `toEqual` pins that far more tightly than probing for an absence.
    const { started, deps: d } = deps();
    expect(await seedIfMissing(d)).toBe("started");
    expect(started).toHaveLength(1);
    expect(started[0].args).toEqual(["run"]);
  });

  it("does nothing while a build is already running", async () => {
    // Seeding is a multi-hour batch. Launching a second one alongside the first
    // would run two of them over the same messages.
    const { started, deps: d } = deps({ buildIsRunning: () => true });
    expect(await seedIfMissing(d)).toBe("already-running");
    expect(started).toHaveLength(0);
  });

  it("treats an empty DOMO_LTMM_BIN as unset rather than spawning nothing", async () => {
    // `DOMO_LTMM_BIN=$(which ltmm)` on a Mac without ltmm sets exactly this,
    // and spawn("") throws ERR_INVALID_ARG_VALUE synchronously — before any
    // child exists to emit `error` — straight out of the app-ready handler.
    //
    // Asserted through the stub rather than liveDeps: once the fallback works,
    // real liveDeps spawns a real `ltmm run`, which on a machine that HAS ltmm
    // starts a multi-hour build over the owner's messages.
    process.env.DOMO_LTMM_BIN = "";
    const { started, deps: d } = deps();
    expect(await seedIfMissing(d)).toBe("started");
    expect(started[0].bin).toBe("ltmm");
  });
});

describe("liveDeps", () => {
  it("records the running build, so a second launch does not start another", async () => {
    // `/usr/bin/yes` stands in for ltmm: it runs until killed, which is the one
    // property that matters here — a live pid to find.
    process.env.DOMO_LTMM_BIN = "/usr/bin/yes";
    await withHome(async (home) => {
      const live = liveDeps(home);
      expect(await live.buildIsRunning()).toBe(false);

      expect(await seedIfMissing(live)).toBe("started");

      const [pid] = fs.readFileSync(seedPidPath(home), "utf8").trim().split(/\s+/).map(Number);
      try {
        expect(await live.buildIsRunning()).toBe(true);
        expect(await seedIfMissing(live)).toBe("already-running");
      } finally {
        process.kill(pid);
      }
    });
  });

  it("starts again once the recorded build is gone, rather than skipping forever", async () => {
    // The failure this exists to prevent: a build that dies mid-run leaves its
    // record behind, every later launch skips seeding, and the user silently
    // never gets facts. Re-running is cheap and correct — `ltmm run` records
    // processed days and resumes.
    process.env.DOMO_LTMM_BIN = "/usr/bin/true";
    await withHome(async (home) => {
      const live = liveDeps(home);
      expect(await seedIfMissing(live)).toBe("started");
      expect(fs.existsSync(seedPidPath(home))).toBe(true);

      // A pid that cannot be running: the recorded build is dead.
      writePid(home, `999999 ${Date.now()}\n`);

      expect(await live.buildIsRunning()).toBe(false);
      expect(await seedIfMissing(live)).toBe("started");
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it("ignores a live process that is not the build that was recorded", async () => {
    // The pid-recycling trap, reproduced exactly: this records OUR OWN pid —
    // indisputably alive, so a liveness check alone says "already-running" —
    // against a start time that is not ours. That is what a wrapped-around pid
    // looks like, and believing it skips seeding for as long as that unrelated
    // process lives, which since nothing rewrites the record is forever.
    await withHome(async (home) => {
      const aDayAgo = Date.now() - 24 * 60 * 60 * 1000;
      writePid(home, `${process.pid} ${aDayAgo}\n`);

      expect(await liveDeps(home).buildIsRunning()).toBe(false);
    });
  });

  it.each([
    ["an unreadable record", undefined],
    ["a malformed record", "not-a-pid\n"],
    ["a nonsense pid", `0 ${Date.now()}\n`],
    ["a record with no start time", "4242\n"],
  ])("retries rather than skipping on %s", async (_label, contents) => {
    // Every unreadable case resolves toward running the build again. That is
    // the safe direction: a resumed build costs little, and being wrong the
    // other way means a user who never gets facts at all.
    await withHome(async (home) => {
      if (contents !== undefined) writePid(home, contents);
      expect(await liveDeps(home).buildIsRunning()).toBe(false);
    });
  });

  it("records nothing when the spawn fails, so the next launch tries again", async () => {
    // Drives the REAL liveDeps, because an injected stub cannot reproduce this:
    // spawn reports a missing binary asynchronously on the child's `error`
    // event, and an unlistened `error` re-throws as an uncaught exception in the
    // Electron main process. Without the listener this test file fails on that
    // uncaught exception rather than on an assertion.
    process.env.DOMO_LTMM_BIN = path.join(os.tmpdir(), "domo-no-such-ltmm");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "domo-seed-"));
    try {
      const live = liveDeps(home);
      expect(await seedIfMissing(live)).toBe("started");

      // A spawn that never produced a process has no pid to record, so the door
      // stays open: nothing here can report `already-running` forever.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(fs.existsSync(seedPidPath(home))).toBe(false);
      expect(await live.buildIsRunning()).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

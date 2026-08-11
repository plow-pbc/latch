import { afterEach, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { liveDeps, seedIfMissing } from "../src/seed.js";

function deps(overrides: Partial<Parameters<typeof seedIfMissing>[0]> = {}) {
  const spawned: Array<{ bin: string; args: string[] }> = [];
  return {
    spawned,
    deps: {
      storeExists: () => false,
      spawn: (bin: string, args: string[]) => {
        spawned.push({ bin, args });
      },
      ...overrides,
    },
  };
}

afterEach(() => {
  delete process.env.DOMO_LTMM_BIN;
});

describe("seedIfMissing", () => {
  it("starts a build with no conversation argument, so ltmm picks the top contact", () => {
    // The exact argv is the whole point of the zero-argument bootstrap: Domo
    // must not need to know which conversation matters, and must not hardcode
    // one. `toEqual` pins that far more tightly than probing for an absence.
    const { spawned, deps: d } = deps();
    expect(seedIfMissing(d)).toBe("started");
    expect(spawned).toHaveLength(1);
    expect(spawned[0].args).toEqual(["run"]);
  });

  it("does nothing when a store is already present", () => {
    // Seeding is a multi-hour batch. Re-running it on every launch would
    // relaunch that batch behind the user's back on a store already being built.
    const { spawned, deps: d } = deps({ storeExists: () => true });
    expect(seedIfMissing(d)).toBe("already-seeded");
    expect(spawned).toHaveLength(0);
  });

  it("survives a missing ltmm instead of taking the app down", async () => {
    // Drives the REAL liveDeps.spawn, because an injected stub cannot reproduce
    // this: spawn reports a missing binary asynchronously on the child's `error`
    // event, and an unlistened `error` re-throws as an uncaught exception in the
    // Electron main process. Without the listener this test file fails on that
    // uncaught exception rather than on an assertion.
    process.env.DOMO_LTMM_BIN = path.join(os.tmpdir(), "domo-no-such-ltmm");
    expect(seedIfMissing({ ...liveDeps, storeExists: () => false })).toBe("started");
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  it("treats an empty DOMO_LTMM_BIN as unset rather than spawning nothing", () => {
    // `DOMO_LTMM_BIN=$(which ltmm)` on a Mac without ltmm sets exactly this,
    // and spawn("") throws ERR_INVALID_ARG_VALUE synchronously — before any
    // child exists to emit `error` — straight out of the app-ready handler.
    //
    // Asserted through the stub rather than liveDeps, unlike the test above:
    // once the fallback works, real liveDeps spawns a real `ltmm run`, which on
    // a machine that HAS ltmm starts a multi-hour build over the owner's
    // messages. The resolution rule is the fix, and it is what this pins.
    process.env.DOMO_LTMM_BIN = "";
    const { spawned, deps: d } = deps();
    expect(seedIfMissing(d)).toBe("started");
    expect(spawned[0].bin).toBe("ltmm");
  });
});

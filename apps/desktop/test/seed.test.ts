import { afterEach, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { startSeeding } from "../src/seed.js";

function deps() {
  const started: Array<{ bin: string; args: string[] }> = [];
  return {
    started,
    deps: {
      startBuild: (bin: string, args: string[]) => {
        started.push({ bin, args });
      },
    },
  };
}

afterEach(() => {
  delete process.env.DOMO_LTMM_BIN;
});

describe("startSeeding", () => {
  it("runs ltmm with no conversation argument, so ltmm picks the top contact", () => {
    // The exact argv is the whole point of the zero-argument bootstrap: Domo
    // must not need to know which conversation matters, and must not hardcode
    // one. It is also the whole command — Domo passes no store path and no
    // resume flag, because deciding what is left to do is ltmm's job.
    const { started, deps: d } = deps();
    startSeeding(d);
    expect(started).toHaveLength(1);
    expect(started[0].args).toEqual(["run"]);
  });

  it("treats an empty DOMO_LTMM_BIN as unset rather than spawning nothing", () => {
    // `DOMO_LTMM_BIN=$(which ltmm)` on a Mac without ltmm sets exactly this,
    // and spawn("") throws ERR_INVALID_ARG_VALUE synchronously — before any
    // child exists to emit `error` — straight out of the app-ready handler.
    //
    // Asserted through the stub rather than liveDeps: once the fallback works,
    // real liveDeps spawns a real `ltmm run`, which on a machine that HAS ltmm
    // starts a multi-hour build over the owner's messages.
    process.env.DOMO_LTMM_BIN = "";
    const { started, deps: d } = deps();
    startSeeding(d);
    expect(started[0].bin).toBe("ltmm");
  });

  it("survives a missing ltmm instead of taking the app down", async () => {
    // Drives the REAL liveDeps, because an injected stub cannot reproduce this:
    // spawn reports a missing binary asynchronously on the child's `error`
    // event, and an unlistened `error` re-throws as an uncaught exception in the
    // Electron main process. Without the listener this test file fails on that
    // uncaught exception rather than on an assertion.
    process.env.DOMO_LTMM_BIN = path.join(os.tmpdir(), "domo-no-such-ltmm");
    expect(() => startSeeding()).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
});

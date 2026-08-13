/**
 * The quit-vs-revoke race, from the side a test can reach.
 *
 * `revokeAndSignOut` starts `/self/revoke` before it awaits anything, so a quit
 * during the relay's drain no longer cancels it. What remained was smaller and
 * unfixable from there: starting a request is not completing one, and
 * `app.quit()` does not wait for a pending IPC handler, so a quit inside the
 * revoke's own round-trip exited before it landed and the token stayed valid on
 * the account.
 *
 * These are the two properties that close it and the one that keeps it
 * bearable: the quit waits for an outstanding revoke, the quit happens anyway
 * once the bound elapses, and a quit with nothing outstanding is not touched at
 * all. The bound is driven with fake timers, because a real 2-second wait in a
 * test suite is a 2-second wait in every test suite.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { REVOKE_QUIT_GRACE_MS, ShutdownGate } from "../src/shutdownGate.js";

afterEach(() => {
  vi.useRealTimers();
});

/** A promise plus the handles to settle it whenever the test likes. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("the bound", () => {
  it("is short enough to be a quit and far under the request's own patience", () => {
    // Pinned deliberately. The number is a judgement about two failure modes —
    // a quit that reads as a hang, and a revoke abandoned before it could
    // land — and moving it is a decision, not a tidy-up.
    expect(REVOKE_QUIT_GRACE_MS).toBe(2_000);
    // PlowApi waits 15s for an answer. That is the request's patience, not the
    // quit's: we wait only for a revoke to SUCCEED, never for it to give up.
    expect(REVOKE_QUIT_GRACE_MS).toBeLessThan(15_000);
  });
});

describe("a quit waits for an in-flight revoke, then quits", () => {
  it("holds while the revoke is outstanding and releases when it lands", async () => {
    vi.useFakeTimers();
    const gate = new ShutdownGate();
    const revoke = deferred();
    gate.track(revoke.promise);

    let quits = 0;
    const deferring = gate.deferQuit(() => quits++);

    expect(deferring).toBe(true); // the caller must hold the quit
    expect(quits).toBe(0);

    // Most of the grace period goes by with the revoke still out: still held.
    await vi.advanceTimersByTimeAsync(REVOKE_QUIT_GRACE_MS - 1);
    expect(quits).toBe(0);

    revoke.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(quits).toBe(1);
  });

  it("a FAILING revoke releases the quit like any other outcome", async () => {
    // A revoke that errors is a revoke that is over. Holding the quit for a
    // rejection would turn a network error into an app that will not close.
    vi.useFakeTimers();
    const gate = new ShutdownGate();
    const revoke = deferred();
    gate.track(revoke.promise).catch(() => {}); // the caller's own handling

    let quits = 0;
    gate.deferQuit(() => quits++);

    revoke.reject(new Error("ENOTFOUND api.plow.co"));
    await vi.advanceTimersByTimeAsync(0);
    expect(quits).toBe(1);
  });
});

describe("a quit with a HUNG revoke goes ahead once the bound elapses", () => {
  it("quits at the bound and does not wait for the request's own timeout", async () => {
    // The property that keeps a bound a bound: a revoke that never answers must
    // cost the user two seconds, not fifteen, and not forever.
    vi.useFakeTimers();
    const gate = new ShutdownGate();
    gate.track(new Promise(() => {})); // never settles

    let quits = 0;
    expect(gate.deferQuit(() => quits++)).toBe(true);

    await vi.advanceTimersByTimeAsync(REVOKE_QUIT_GRACE_MS - 1);
    expect(quits).toBe(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(quits).toBe(1);
  });
});

describe("a quit with nothing outstanding is not delayed at all", () => {
  it("does not defer, and starts no timer to be waited on", async () => {
    // The overwhelmingly common quit. It must not pay for any of the above —
    // not a bound, not a timer, not even a microtask.
    vi.useFakeTimers();
    const gate = new ShutdownGate();

    let quits = 0;
    const deferring = gate.deferQuit(() => quits++);

    expect(deferring).toBe(false); // the caller quits immediately, itself
    expect(quits).toBe(0); // …so the callback is not the path taken
    expect(vi.getTimerCount()).toBe(0);
  });

  it("is the state a gate returns to once its revoke settles", async () => {
    // The quit AFTER a completed sign-out. Nothing is outstanding any more, so
    // it must be as undelayed as one that never signed out.
    vi.useFakeTimers();
    const gate = new ShutdownGate();
    const revoke = deferred();
    gate.track(revoke.promise);

    revoke.resolve();
    await vi.advanceTimersByTimeAsync(0);

    expect(gate.deferQuit(() => {})).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("registering a revoke never changes what the caller sees", () => {
  it("a rejection still reaches the caller, and is not an unhandled rejection", async () => {
    // `revokeAndSignOut` absorbs revoke failures itself. The gate must not
    // reject on its own account — a best-effort cleanup that can crash the
    // process is worse than no cleanup.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    const gate = new ShutdownGate();
    const boom = new Error("500 from Plow");
    await expect(gate.track(Promise.reject(boom))).rejects.toBe(boom);
    // Let any stray rejection surface before we look.
    await new Promise((r) => setTimeout(r, 10));

    process.off("unhandledRejection", onUnhandled);
    expect(unhandled).toEqual([]);
  });
});

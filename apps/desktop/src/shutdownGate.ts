/**
 * Work a quit should wait for, and the bound on that wait.
 *
 * There is exactly one kind so far: the sign-out revoke. `revokeAndSignOut`
 * starts `/self/revoke` before it awaits anything, which is what stopped a quit
 * during the relay's drain from cancelling it — but starting a request is not
 * completing one, and `app.quit()` does not wait for a pending IPC handler. A
 * quit inside the revoke's own round-trip still exited before it landed, and
 * the token stayed valid on the account even though this Mac had forgotten it.
 *
 * So the quit waits. Under a bound, and this file is where both halves live,
 * because `main.ts` cannot be imported under vitest — a guard that lives only
 * there is a guard nothing can execute. `main.ts` keeps the `before-quit`
 * registration and delegates the decision here.
 */

/**
 * How long a quit may wait for outstanding revokes. **2 seconds.**
 *
 * Short on purpose: someone who pressed Quit expects the app to go away, and
 * the whole point of a bound is that a dead network must not take the quit
 * hostage. Two seconds is the balance between the two failure modes.
 *
 *   - It is not the request's own patience. `PlowApi.REQUEST_TIMEOUT_MS` is
 *     15 seconds, which is the right amount of time to wait for an answer and
 *     an absurd amount of time to hold a Quit. We are not waiting for the
 *     request to give up; we are waiting only for it to succeed, and what a
 *     short bound forfeits is a revoke that was already best-effort.
 *   - It is comfortably past a working round-trip. `/self/revoke` is one small
 *     authenticated POST; connection setup and all, that lands far inside two
 *     seconds on any network that is going to answer at all. A bound this size
 *     is invisible in the case that matters and is spent only when the answer
 *     was not coming.
 *   - It is under the beat at which a quit reads as a hang rather than as the
 *     app closing.
 */
export const REVOKE_QUIT_GRACE_MS = 2_000;

/**
 * Outstanding work a shutdown should give a moment to finish.
 *
 * Deliberately not a queue and not a scheduler: registering work must never be
 * able to fail, delay, or reject anything, because the caller registering it is
 * a best-effort revoke and the gate is a courtesy.
 */
export class ShutdownGate {
  /** Settled-tracking copies, never the caller's promise. See `track`. */
  private readonly outstanding = new Set<Promise<void>>();

  /** How many pieces of work have yet to settle. */
  get pending(): number {
    return this.outstanding.size;
  }

  /**
   * Register work and hand back the SAME promise, so a caller can wrap a call
   * in this without changing what it awaits or what it catches.
   *
   * What is retained is a copy that absorbs the outcome, never the original.
   * Rejection is an ordinary outcome here — a revoke that fails is a revoke
   * that is over — and a gate that let one become an unhandled rejection would
   * turn best-effort cleanup into a crash.
   */
  track<T>(work: Promise<T>): Promise<T> {
    const settled = work.then(
      () => {},
      () => {},
    );
    this.outstanding.add(settled);
    void settled.then(() => this.outstanding.delete(settled));
    return work;
  }

  /**
   * Wait for everything outstanding, or for `boundMs`, whichever comes first.
   * Resolves true when the work finished, false when the bound elapsed.
   *
   * The set is snapshotted at entry: work registered DURING a drain is not
   * waited on. A shutdown that kept extending itself for newly-arriving work
   * would have no bound at all, which is the one property this must not lose.
   */
  async drain(boundMs: number): Promise<boolean> {
    if (this.outstanding.size === 0) return true;
    let timer: NodeJS.Timeout | undefined;
    const bound = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), boundMs);
    });
    const finished = Promise.allSettled([...this.outstanding]).then(() => true);
    try {
      return await Promise.race([finished, bound]);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * The `before-quit` decision: should this quit be deferred, and if so, when may
 * it proceed?
 *
 * Returns true when the caller must hold the quit — it will be re-issued
 * through `quit` once the work settles or `boundMs` elapses, whichever is
 * first. Returns false when there is nothing outstanding, and then it has done
 * NOTHING: no timer, no microtask, no deferral. A quit with no revoke in flight
 * is the overwhelmingly common one and must not pay for this at all.
 */
export function deferQuitForWork(
  gate: ShutdownGate,
  boundMs: number,
  quit: () => void,
): boolean {
  if (gate.pending === 0) return false;
  void gate.drain(boundMs).then(quit, quit);
  return true;
}

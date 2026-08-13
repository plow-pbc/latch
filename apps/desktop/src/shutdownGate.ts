/**
 * Work a quit should wait for, and the bound on that wait.
 *
 * There is exactly one kind, and the design leans on that. `revokeAndSignOut`
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
 *
 * **One revoke at a time, not a queue.** Sign-out clears the stored credential
 * synchronously, before its first `await`, so the next sign-out reads an empty
 * credential and starts nothing: a second revoke cannot overlap the first
 * without a full re-login in between. A set, a drain and a result code were all
 * generality for a case sign-out cannot produce.
 */

/**
 * How long a quit may wait for an outstanding revoke. **2 seconds.**
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
 * The one revoke a shutdown gives a moment to finish.
 *
 * Deliberately not a scheduler: registering must never be able to fail, delay,
 * or reject anything, because what registers is a best-effort revoke and this
 * is a courtesy.
 */
export class ShutdownGate {
  /** A settled-tracking copy of the outstanding revoke, never the caller's. */
  private outstanding: Promise<void> | null = null;

  /**
   * Register the revoke and hand back the SAME promise, so the caller can wrap
   * a call in this without changing what it awaits or what it catches.
   *
   * What is retained is a copy that absorbs the outcome. Rejection is an
   * ordinary outcome here — a revoke that fails is a revoke that is over — and
   * a gate that let one become an unhandled rejection would turn best-effort
   * cleanup into a crash.
   */
  track<T>(work: Promise<T>): Promise<T> {
    const settled = work.then(
      () => {},
      () => {},
    );
    this.outstanding = settled;
    void settled.then(() => {
      if (this.outstanding === settled) this.outstanding = null;
    });
    return work;
  }

  /**
   * The `before-quit` decision: should this quit be deferred?
   *
   * Returns true when the caller must hold the quit — it will be re-issued
   * through `quit` once the revoke settles or the bound elapses, whichever is
   * first. Returns false when nothing is outstanding, and then it has done
   * NOTHING: no timer, no microtask. A quit with no revoke in flight is the
   * overwhelmingly common one and must not pay for this at all.
   */
  deferQuit(quit: () => void): boolean {
    const outstanding = this.outstanding;
    if (!outstanding) return false;
    let timer: NodeJS.Timeout | undefined;
    const bound = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, REVOKE_QUIT_GRACE_MS);
    });
    void Promise.race([outstanding, bound]).then(() => {
      clearTimeout(timer);
      quit();
    });
    return true;
  }
}

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
 * **Two kinds of work, not a queue.** Sign-out clears the stored credential
 * synchronously, so a second sign-out revoke cannot overlap the first. What
 * can overlap it is a LOGIN finishing in the other window: `finishWithSession`
 * mints a credential, and a quit between that mint and the moment it is either
 * saved or handed back leaves the account holding a live one the app has never
 * heard of. So this holds a set — and nothing more than a set. The drain, the
 * result code and the multi-work API the earlier collapse removed are still
 * gone; what came back is only the ability to be waiting on two things.
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
  /**
   * Settled-tracking copies of the outstanding work, never the callers'.
   *
   * A set rather than a single slot, and that is the ONLY generality here. Two
   * kinds of work can genuinely overlap — a Settings sign-out revoke and a
   * login's mint-to-cleanup span, which belong to different windows and neither
   * of which waits for the other — so a single slot silently dropped one of
   * them. Everything else the earlier collapse removed stays removed: there is
   * no `pending`, no `drain`, no result code, and no way to ask this anything
   * except the one question `before-quit` needs answered.
   */
  private readonly outstanding = new Set<Promise<void>>();

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
    this.outstanding.add(settled);
    void settled.then(() => this.outstanding.delete(settled));
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
    if (this.outstanding.size === 0) return false;
    // Snapshotted: work registered DURING the wait is not waited on, or the
    // bound would keep renewing itself and stop being a bound.
    const settling = Promise.all([...this.outstanding]);
    let timer: NodeJS.Timeout | undefined;
    const bound = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, REVOKE_QUIT_GRACE_MS);
    });
    void Promise.race([settling, bound]).then(() => {
      clearTimeout(timer);
      quit();
    });
    return true;
  }
}

/**
 * A one-at-a-time task queue. Actions on the browser must run STRICTLY
 * sequentially, the way the old Python server's `for line in sys.stdin` did:
 * the owner's viewer polls `view` ~1/s independently of agent actions, so
 * without this a screenshot could read a page another action is mid-navigation
 * on, and a `quit` could close the context while a credential fill is still
 * typing. Each task waits for the previous to settle; a rejection never wedges
 * the queue (the caller answers its own errors, and this is belt).
 */
export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();

  /** Enqueue `task`; it starts only once every earlier task has settled. */
  run(task: () => Promise<void>): void {
    this.tail = this.tail.then(task).catch(() => {});
  }

  /** Resolves when everything enqueued so far has settled (tests/shutdown). */
  idle(): Promise<void> {
    return this.tail;
  }
}

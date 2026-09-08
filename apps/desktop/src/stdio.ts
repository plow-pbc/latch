/**
 * Keep a lost console from taking the app down.
 *
 * `console.log` in the main process writes to whatever stdout/stderr the
 * launcher handed over. Launched from Finder that is /dev/null and every
 * write succeeds; launched from a terminal, an `open` in a script, or an ssh
 * session, it is a pipe or socket whose far end can go away while the app
 * keeps running. The next write then fails with EPIPE, and Node reports a
 * failed write on a socket stream as an `'error'` EVENT on `process.stdout`
 * — not a thrown error at the call site — so with no listener it is an
 * uncaught exception, and Electron ends the main process for a log line.
 * (Seen in the wild as electron-updater's default `console` logger crashing
 * the app when Squirrel.Mac asked the proxy server for the downloaded zip,
 * hours after the launching terminal had gone.)
 *
 * Logging is best-effort by definition: a line nobody can read is dropped,
 * never fatal. This registers the one listener that makes it so. Pure over an
 * injected seam so it is unit-testable without Electron.
 */

/** The slice of a stdio stream this needs: just the ability to listen. */
export interface StdioStream {
  on(event: "error", listener: (err: Error) => void): unknown;
}

/**
 * Swallow write errors on the given stdio streams. Idempotent in effect —
 * an extra listener changes nothing — and never throws: a stream that is
 * missing (some embedders leave one undefined) is skipped.
 */
export function guardStdio(streams: ReadonlyArray<StdioStream | null | undefined>): void {
  for (const stream of streams) {
    if (!stream || typeof stream.on !== "function") continue;
    stream.on("error", () => {
      /* the console is gone; the line is dropped, the app keeps running */
    });
  }
}

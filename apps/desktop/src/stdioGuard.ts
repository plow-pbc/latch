/**
 * Keep a dead console from killing the app.
 *
 * When this process is launched with stdout/stderr on a pipe or socket (a
 * script running the bundle's binary directly, a `tee`, a pager, a parent that
 * has since exited), Node wraps that fd in a `net.Socket` with NO error
 * listener, and a write after the reader has gone away fails with EPIPE.
 * `console.*` guards against this — but only once: its write callback adds a
 * one-shot 'error' listener unless the stream already has `errorEmitted` set,
 * and after the first failure that flag IS set, then reset by the stdio
 * stream's un-destroy just before the second error is emitted. So the first
 * log line to a dead pipe is dropped quietly and the SECOND is an uncaught
 * exception (reproduced on Electron 33 / Node 20.18 and on Node 24) — in a
 * packaged Electron app, the "A JavaScript error occurred in the main
 * process" dialog, over a line of diagnostics nobody was reading. Seen in the
 * field twice: electron-updater's default `console` logger crashing the app
 * when Squirrel.Mac asked for the downloaded zip, hours after the launching
 * terminal had gone; and the `unhandledRejection` listener printing its
 * marker.
 *
 * The fix is the standard one: give every stdio stream a standing 'error'
 * listener that swallows the failure. Node's stdio streams un-destroy
 * themselves after an error, so later writes still go out if the reader comes
 * back and are dropped the same way if it doesn't. This module is pure so the
 * behavior is provable under vitest against a fake writable; `main.ts` hands
 * it the real `process.stdout`/`process.stderr` before its first log line.
 */

import type { EventEmitter } from "node:events";

export interface StdioGuard {
  /** How many writes have been dropped so far — a diagnostic, never a reason
   * to do anything: there is nowhere left to report a console failure TO. */
  readonly dropped: number;
}

/**
 * Attaches a swallowing 'error' listener to each stream. Idempotent per
 * stream: a second call on the same stream adds nothing. Never throws: a
 * stream that is missing (some embedders leave one undefined) is skipped.
 */
export function guardStdio(streams: Iterable<EventEmitter | null | undefined>): StdioGuard {
  for (const stream of streams) {
    if (!stream || typeof stream.on !== "function") continue;
    if (stream.listeners("error").includes(swallow)) continue;
    stream.on("error", swallow);
  }
  return {
    get dropped() {
      return dropped;
    },
  };
}

let dropped = 0;

/** One module-level function, so the idempotence check above can find it on a
 * stream and so a stack trace through it says what it is. */
function swallow(): void {
  dropped += 1;
}

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
 * back and are dropped the same way if it doesn't. Logging is best-effort by
 * definition: a line nobody can read is dropped, never fatal. This module is
 * pure so the behavior is provable under vitest against a fake writable;
 * `main.ts` hands it the real `process.stdout`/`process.stderr` before its
 * first log line.
 */

import type { EventEmitter } from "node:events";

/** Attaches a swallowing 'error' listener to each stream. */
export function guardStdio(streams: readonly EventEmitter[]): void {
  for (const stream of streams) stream.on("error", swallow);
}

function swallow(): void {
  /* the console is gone; the line is dropped, the app keeps running */
}

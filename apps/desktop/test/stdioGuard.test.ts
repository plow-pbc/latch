import { EventEmitter, once } from "node:events";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { guardStdio } from "../src/stdioGuard.js";

/** A writable whose reader is gone: every write fails the way a closed pipe
 * does. Like Node's stdio streams it never destroys itself on error, so the
 * next write is attempted (and fails) again. */
function brokenPipe(): Writable {
  const stream = new Writable({
    write(_chunk, _encoding, callback) {
      callback(Object.assign(new Error("write EPIPE"), { code: "EPIPE", syscall: "write" }));
    },
    // Node's stdio `dummyDestroy`: report the error, then come back for more.
    destroy(error, callback) {
      callback(error);
      (this as unknown as { _undestroy(): void })._undestroy();
    },
  });
  return stream;
}

describe("guardStdio", () => {
  it("a write to a dead pipe is dropped instead of raising an uncaught 'error'", async () => {
    const stream = brokenPipe();
    const guard = guardStdio([stream]);
    // Without the guard this 'error' has no listener and the emit throws
    // (which is what took the app down); with it, the event resolves quietly.
    const error = once(stream, "error");
    stream.write("[app] a line nobody reads\n");
    await error;
    expect(guard.dropped).toBe(1);
  });

  // Node's console guards only the FIRST failed write (see stdioGuard.ts), so
  // a second failure in a later tick is the case that actually crashed.
  it("counts every dropped write, and a working stream is untouched", async () => {
    const dead = brokenPipe();
    const written: string[] = [];
    const alive = new Writable({
      write(chunk, _encoding, callback) {
        written.push(String(chunk));
        callback();
      },
    });
    const guard = guardStdio([dead, alive]);
    const before = guard.dropped;
    const first = once(dead, "error");
    dead.write("one\n");
    await first;
    const second = once(dead, "error");
    dead.write("two\n");
    await second;
    alive.write("three\n");
    expect(guard.dropped - before).toBe(2);
    expect(written).toEqual(["three\n"]);
  });

  it("skips a missing stream rather than failing", () => {
    expect(() => guardStdio([null, undefined, {} as never])).not.toThrow();
  });

  it("guarding the same stream twice attaches one listener", () => {
    const stream = new EventEmitter();
    guardStdio([stream]);
    guardStdio([stream]);
    expect(stream.listenerCount("error")).toBe(1);
  });
});

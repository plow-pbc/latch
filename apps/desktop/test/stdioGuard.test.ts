import { once } from "node:events";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { guardStdio } from "../src/stdioGuard.js";

/** A writable whose reader is gone: every write fails the way a closed pipe
 * does. Like Node's stdio streams it never destroys itself on error, so the
 * next write is attempted (and fails) again. */
function brokenPipe(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback(Object.assign(new Error("write EPIPE"), { code: "EPIPE", syscall: "write" }));
    },
    // Node's stdio `dummyDestroy`: report the error, then come back for more.
    destroy(error, callback) {
      callback(error);
      (this as unknown as { _undestroy(): void })._undestroy();
    },
  });
}

describe("guardStdio", () => {
  // Node's console guards only the FIRST failed write (see stdioGuard.ts), so
  // a second failure in a later tick is the case that actually crashed.
  // Without the guard each 'error' has no listener and the emit throws; with
  // it, `once` resolves and nothing is thrown.
  it("every write to a dead pipe is dropped instead of raising an uncaught 'error'", async () => {
    const stream = brokenPipe();
    guardStdio([stream]);
    for (const line of ["first\n", "second\n"]) {
      const error = once(stream, "error");
      stream.write(line);
      const [err] = await error;
      expect(err).toMatchObject({ code: "EPIPE" });
    }
  });

  it("a working stream is untouched", () => {
    const written: string[] = [];
    const alive = new Writable({
      write(chunk, _encoding, callback) {
        written.push(String(chunk));
        callback();
      },
    });
    guardStdio([alive]);
    alive.write("three\n");
    expect(written).toEqual(["three\n"]);
  });
});

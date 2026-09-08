import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { guardStdio } from "../src/stdio.js";

describe("guardStdio", () => {
  it("an 'error' on a guarded stream is swallowed instead of thrown", () => {
    const out = new EventEmitter();
    const err = new EventEmitter();
    // Unguarded, an EventEmitter throws its 'error' — the exact behavior that
    // makes a lost stdout an uncaught exception.
    expect(() => out.emit("error", new Error("EPIPE"))).toThrow("EPIPE");
    guardStdio([out, err]);
    expect(() => out.emit("error", new Error("EPIPE"))).not.toThrow();
    expect(() => err.emit("error", new Error("EPIPE"))).not.toThrow();
  });

  it("skips a missing stream rather than failing", () => {
    expect(() => guardStdio([null, undefined, {} as never])).not.toThrow();
  });
});

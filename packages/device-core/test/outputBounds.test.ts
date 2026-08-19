/**
 * Reading a command's output is bounded work, not merely raced work.
 *
 * Every other direct tool is held to a ceiling by racing it against a timer.
 * This one cannot be: it is synchronous, so while it copies, the event loop is
 * not running the timer that would cut it short. The old version concatenated
 * every byte the command had ever produced on every single poll — cost growing
 * with the log, and the ceiling's timer stuck behind it. So the bytes are
 * capped instead, and a caller takes the rest with a second call.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Executor, MAX_OUTPUT_BYTES } from "@domo/device-core";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "domo-output-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("reading output is bounded", () => {
  it("caps one call and says where to resume", async () => {
    const executor = new Executor(tempDir());
    // 3 MiB of 'a', well past the 1 MiB per-call cap.
    const total = 3 * 1024 * 1024;
    const result = await executor.run({
      argv: ["/usr/bin/head", "-c", String(total), "/dev/zero"],
      readPaths: ["/dev/zero"],
      writePaths: [],
      network: false,
      waitMs: 20_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.outputLength).toBe(total);
    // The in-call result is capped too — it is the same read.
    expect(result.output.length).toBe(MAX_OUTPUT_BYTES);
    expect(result.nextSince).toBe(MAX_OUTPUT_BYTES);

    // Successive polls walk the rest, each one capped, and the total never
    // changes under them.
    let since = result.nextSince;
    let collected = result.output.length;
    for (let i = 0; i < 5 && since < total; i++) {
      const slice = executor.output(result.handle, since);
      expect(slice.output.length).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
      expect(slice.outputLength).toBe(total);
      expect(slice.nextSince).toBe(since + slice.output.length);
      collected += slice.output.length;
      since = slice.nextSince;
    }
    expect(since).toBe(total);
    expect(collected).toBe(total);

    // At the end there is nothing left, and asking again is not an error.
    const done = executor.output(result.handle, total);
    expect(done.output.length).toBe(0);
    expect(done.nextSince).toBe(total);
  });

  it("honours a smaller cap and never returns more than asked for", async () => {
    const executor = new Executor(tempDir());
    const result = await executor.run({
      argv: ["/bin/echo", "hello-bounded-output"],
      readPaths: [],
      writePaths: [],
      network: false,
      waitMs: 10_000,
    });
    const total = result.outputLength;
    expect(total).toBeGreaterThan(5);

    const first = executor.output(result.handle, 0, 5);
    expect(first.output.toString("utf8")).toBe("hello");
    expect(first.nextSince).toBe(5);
    expect(first.outputLength).toBe(total);

    const rest = executor.output(result.handle, first.nextSince, MAX_OUTPUT_BYTES);
    expect(rest.output.toString("utf8")).toBe("-bounded-output\n");
    expect(rest.nextSince).toBe(total);
  });

  it("bounds a poll for a slice in the middle of the buffer", async () => {
    const executor = new Executor(tempDir());
    const result = await executor.run({
      argv: ["/bin/echo", "0123456789"],
      readPaths: [],
      writePaths: [],
      network: false,
      waitMs: 10_000,
    });
    const middle = executor.output(result.handle, 3, 4);
    expect(middle.output.toString("utf8")).toBe("3456");
    expect(middle.nextSince).toBe(7);
    // A `since` past the end is clamped, not an error.
    const past = executor.output(result.handle, 9_999, 10);
    expect(past.output.length).toBe(0);
    expect(past.nextSince).toBe(result.outputLength);
  });
});

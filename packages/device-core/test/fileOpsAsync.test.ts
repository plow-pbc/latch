/**
 * FileOps must not block the event loop. A synchronous read on a slow or
 * unresponsive volume stops every timer in the process — including the call
 * budget's, which is what turns "this call is slow" into "this call overran the
 * relay's timeout and the agent was told it failed".
 *
 * Proving that needs an operation that is slow on demand, not one that happens
 * to be fast. So the read is gated here: it does not complete until the test
 * says so, and the test observes that the loop kept running meanwhile.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let gate: Promise<void> = Promise.resolve();
let openGate: () => void = () => {};
let entered: Promise<void>;
let markEntered: () => void = () => {};

function closeGate(): void {
  gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
}
closeGate();

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("node:fs/promises");
  const readFile = async (...args: Parameters<typeof actual.readFile>) => {
    if (typeof args[0] === "string" && args[0].includes("gated")) {
      markEntered();
      await gate;
    }
    return actual.readFile(...args);
  };
  return { ...actual, default: { ...actual, readFile }, readFile };
});

const { FileOps } = await import("@domo/device-core");

const cleanups: (() => void)[] = [];
afterEach(() => {
  openGate();
  while (cleanups.length) cleanups.pop()!();
  closeGate();
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "domo-fsasync-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("FileOps does not block the event loop", () => {
  it("timers keep firing while a read is in flight", async () => {
    const dir = tempDir();
    const file = path.join(dir, "gated.txt");
    fs.writeFileSync(file, "data");

    let ticks = 0;
    const interval = setInterval(() => {
      ticks += 1;
    }, 10);
    cleanups.push(() => clearInterval(interval));

    let done = false;
    const read = FileOps.read(file, [dir]).then((buf) => {
      done = true;
      return buf;
    });

    await entered;
    await new Promise((r) => setTimeout(r, 60));
    // The read is still outstanding…
    expect(done).toBe(false);
    // …and the loop was never blocked: a synchronous read would have starved
    // this interval for the whole duration.
    expect(ticks).toBeGreaterThanOrEqual(3);

    openGate();
    expect((await read).toString()).toBe("data");
    expect(done).toBe(true);
  });
});

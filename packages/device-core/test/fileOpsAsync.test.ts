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
afterEach(async () => {
  // Open the gate and let the read it was holding actually finish before the
  // directory goes: deleting underneath an in-flight read hands it an ENOENT
  // nobody is waiting for any more, which surfaces as an unhandled rejection
  // and fails whichever test happens to be running when it lands.
  openGate();
  await new Promise((r) => setImmediate(r));
  while (cleanups.length) cleanups.pop()!();
  closeGate();
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "domo-fsasync-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** How many times the interval must fire while the read is outstanding. */
const REQUIRED_TICKS = 3;

describe("FileOps does not block the event loop", () => {
  it("timers keep firing while a read is in flight", async () => {
    const dir = tempDir();
    const file = path.join(dir, "gated.txt");
    fs.writeFileSync(file, "data");

    // Wait for the TICKS, not for a wall-clock deadline.
    //
    // This used to sleep 60ms and then assert three 10ms ticks had happened.
    // Under load — the whole suite running in parallel — two is a perfectly
    // ordinary number of times a 10ms interval fires in 60ms, and the test
    // failed for being on a busy machine rather than for anything about
    // FileOps. Counting to three and waiting however long that takes measures
    // the same property and cannot lose that race: the only way it does not
    // reach three is a loop that is genuinely stuck, which is the regression.
    let ticks = 0;
    let reached = () => {};
    const ticked = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const interval = setInterval(() => {
      ticks += 1;
      if (ticks >= REQUIRED_TICKS) reached();
    }, 10);
    cleanups.push(() => clearInterval(interval));

    let done = false;
    const read = FileOps.read(file, [dir]).then((buf) => {
      done = true;
      return buf;
    });
    // Observed below — but if an assertion throws first, nothing ever awaits
    // this, and cleanup deleting the file under it would turn a readable
    // failure into an unhandled ENOENT in some other test.
    read.catch(() => {});

    // A synchronous read blocks the process before the mock is ever reached, so
    // that regression hangs here and vitest's own timeout names this line.
    await entered;
    await ticked;

    // The read is still outstanding — the gate has not been opened…
    expect(done).toBe(false);
    // …and the loop kept running the whole time it was.
    expect(ticks).toBeGreaterThanOrEqual(REQUIRED_TICKS);

    openGate();
    expect((await read).toString()).toBe("data");
    expect(done).toBe(true);
  });
});

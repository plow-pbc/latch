/**
 * SerialQueue is what keeps the browser server processing one action at a time
 * (the Python server's `for line in sys.stdin` discipline). The regression it
 * guards: async line handlers dispatched fire-and-forget overlap, so a `view`
 * poll or a `quit` can run mid-fill.
 */
import { describe, expect, it } from "vitest";
import { SerialQueue } from "../src/serialize.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("SerialQueue", () => {
  it("runs tasks strictly one at a time, never overlapping", async () => {
    const q = new SerialQueue();
    let active = 0;
    let maxActive = 0;
    const order: number[] = [];
    for (let i = 0; i < 5; i++) {
      q.run(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        // A later task deliberately finishes fast; if they overlapped, a
        // short task would slip ahead of a slow one before it.
        await sleep(i === 0 ? 30 : 5);
        order.push(i);
        active--;
      });
    }
    await q.idle();
    expect(maxActive).toBe(1); // never two at once
    expect(order).toEqual([0, 1, 2, 3, 4]); // and in submission order
  });

  it("keeps going after a task rejects — one bad action cannot wedge the queue", async () => {
    const q = new SerialQueue();
    const ran: string[] = [];
    q.run(async () => {
      ran.push("a");
    });
    q.run(async () => {
      throw new Error("boom");
    });
    q.run(async () => {
      ran.push("c");
    });
    await q.idle();
    expect(ran).toEqual(["a", "c"]);
  });

  it("orders a later close after the actions already queued", async () => {
    // The stand-in for EOF-close chained onto the same queue: a fill in flight
    // must finish before shutdown runs.
    const q = new SerialQueue();
    const log: string[] = [];
    q.run(async () => {
      await sleep(20);
      log.push("fill");
    });
    q.run(async () => {
      log.push("close");
    });
    await q.idle();
    expect(log).toEqual(["fill", "close"]);
  });
});

import { describe, expect, it } from "vitest";
// @ts-expect-error — plain-JS renderer helper, shipped as-is.
import { singleFlight } from "../src/renderer/onboardingAction.js";

describe("onboarding renderer actions", () => {
  it("ignores a queued mutation until the first bridge call and redraw finish", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const run = singleFlight(() => false);

    const first = run(async () => {
      calls += 1;
      await held;
      return "first";
    });
    const duplicate = run(async () => {
      calls += 1;
      return "duplicate";
    });

    expect(await duplicate).toBeUndefined();
    expect(calls).toBe(1);
    release();
    expect(await first).toBe("first");
    expect(await run(async () => ++calls)).toBe(2);
  });

  it("does not mutate while a background handoff reports busy", async () => {
    let busy = true;
    let calls = 0;
    const run = singleFlight(() => busy);

    expect(await run(async () => ++calls)).toBeUndefined();
    expect(calls).toBe(0);
    busy = false;
    expect(await run(async () => ++calls)).toBe(1);
  });
});

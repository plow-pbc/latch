import { describe, expect, it } from "vitest";
// @ts-expect-error — plain-JS renderer helper, shipped as-is.
import { latestOnly, singleFlight } from "../src/renderer/onboardingAction.js";

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

  // A focus refresh asked before a switch flips can answer after it: the
  // older answer must not overwrite the newer one on screen.
  it.each([
    ["a newer answer landing first keeps an older one off the screen", ["write", "read"], ["write"]],
    ["answers landing in order both show, newest last", ["read", "write"], ["read", "write"]],
  ])("%s", async (_name, order, shown) => {
    const landed: string[] = [];
    const show = latestOnly((answer: string) => landed.push(answer));
    const release: Record<string, () => void> = {};
    const ask = (answer: string) =>
      show(() => new Promise<string>((resolve) => (release[answer] = () => resolve(answer))));
    const asked = { read: ask("read"), write: ask("write") };
    for (const name of order) {
      release[name]!();
      await asked[name as keyof typeof asked];
    }
    expect(landed).toEqual(shown);
    // Each caller still gets its own answer, shown or not.
    expect([await asked.read, await asked.write]).toEqual(["read", "write"]);
  });
});

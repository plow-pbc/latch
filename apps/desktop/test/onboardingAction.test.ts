import { describe, expect, it } from "vitest";
// @ts-expect-error — plain-JS renderer helper, shipped as-is.
import { latestOnly, singleFlight, whenAnswered } from "../src/renderer/onboardingAction.js";

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

  // A focus refresh asked before a switch flips read the old switches: once
  // the switch is asked, the refresh's answer never reaches the screen,
  // whichever answers first.
  it.each([
    ["the newer answering first", ["write", "read"]],
    ["the older answering first", ["read", "write"]],
  ])("shows only the newest request's answer, %s", async (_name, order) => {
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
    expect(landed).toEqual(["write"]);
    // Each caller still gets its own answer, shown or not.
    expect([await asked.read, await asked.write]).toEqual(["read", "write"]);
  });

  // The owner comes back mid-flow: the focus refresh answers first with the
  // grant still open, then the act answers with it met. The act's answer must
  // land, or the Access run re-runs a grant that already landed.
  it("lands a grant's act over a refresh asked while its flow ran", async () => {
    const landed: string[] = [];
    const show = latestOnly((answer: string) => landed.push(answer));
    let finishFlow: (answer: string) => void = () => {};
    const acting = whenAnswered(new Promise<string>((resolve) => (finishFlow = resolve)), show);
    await show(async () => "open");
    finishFlow("met");
    await acting;
    expect(landed).toEqual(["open", "met"]);
  });
});

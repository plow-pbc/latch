/**
 * The fake clock both activation flows are tested on.
 *
 * `onboarding.test.ts` and `claimLine.test.ts` drive the same engine
 * (`activation.ts`) through two different terminal policies, so they share the
 * mechanics of running it without real timers — and only the mechanics. Each
 * file keeps its own stand-in Plow: one records OTP requests and mints, the
 * other records what was asked of `provision_chat` and gates three calls in
 * flight. Merging those would be one fake serving two contracts, which is the
 * shape this extraction exists to avoid, not to create.
 */
import { expect } from "vitest";

/**
 * A clock the poll loop advances by waiting on it.
 *
 * The loop's `wait` moves the same clock its deadline is measured against, so
 * a five-minute give-up takes microseconds and is exact rather than
 * approximately right.
 */
export class FakeClock {
  now: number;
  /** Every wait the loop made, so a test can prove the interval. */
  readonly waits: number[] = [];
  /** Bumped per test; a `wait` built under an older value parks forever. */
  private generation = 0;

  constructor(startAt = 1_700_000_000_000) {
    this.now = startAt;
  }

  /**
   * Retire every loop currently running against this clock.
   *
   * Called from BOTH `beforeEach` and `afterEach`, and the second is the
   * load-bearing one: a claim that never verifies polls forever, and `wait`
   * resolves instantly here — so a loop still live when a file's LAST test
   * ends has nothing to slow or stop it, and spins until its `waits` array
   * hits V8's element limit and takes the worker down. That is a fatal crash,
   * not a failing test: the file reports nothing at all. Bumping on both edges
   * is what makes the park unconditional.
   */
  reset(startAt = 1_700_000_000_000): void {
    this.generation += 1;
    this.now = startAt;
    this.waits.length = 0;
  }

  /** The `wait` to hand a flow under test. Bound to the generation current at
   * construction, so a loop from an earlier test parks rather than mutating
   * this one's clock. */
  waiter(): (ms: number) => Promise<void> {
    const generation = this.generation;
    return async (ms: number) => {
      if (generation !== this.generation) await new Promise(() => {});
      this.waits.push(ms);
      this.now += ms;
    };
  }
}

/** Let a detached poll loop run until it has nothing left to do. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 5000; i += 1) await Promise.resolve();
}

/** Let it run just until a condition holds — for states the loop passes
 * THROUGH rather than ends in, since a stalled screen keeps polling. */
export async function settleUntil(check: () => boolean): Promise<void> {
  for (let i = 0; i < 5000 && !check(); i += 1) await Promise.resolve();
  expect(check()).toBe(true);
}

import { describe, expect, it } from "vitest";
import { seedIfMissing } from "../src/seed.js";

function deps(overrides: Partial<Parameters<typeof seedIfMissing>[0]> = {}) {
  const spawned: Array<{ bin: string; args: string[] }> = [];
  return {
    spawned,
    deps: {
      storeExists: () => false,
      spawn: (bin: string, args: string[]) => {
        spawned.push({ bin, args });
      },
      ...overrides,
    },
  };
}

describe("seedIfMissing", () => {
  it("starts a build when no store exists yet", () => {
    const { spawned, deps: d } = deps();
    expect(seedIfMissing(d)).toBe("started");
    expect(spawned).toHaveLength(1);
    expect(spawned[0].args).toEqual(["run"]);
  });

  it("passes no conversation argument, so ltmm picks the top contact itself", () => {
    // The whole point of the zero-argument bootstrap: Domo must not need to know
    // which conversation matters, and must not hardcode one.
    const { spawned, deps: d } = deps();
    seedIfMissing(d);
    expect(spawned[0].args).not.toContain("--conversation");
  });

  it("does nothing when a store is already present", () => {
    // Seeding is a multi-hour batch. Re-running it on every launch would
    // relaunch that batch behind the user's back on a store already being built.
    const { spawned, deps: d } = deps({ storeExists: () => true });
    expect(seedIfMissing(d)).toBe("already-seeded");
    expect(spawned).toHaveLength(0);
  });

  it("reports rather than throws when ltmm is not installed", () => {
    // A missing ltmm must not take the app down on launch.
    const { deps: d } = deps({
      spawn: () => {
        throw new Error("spawn ENOENT");
      },
    });
    expect(seedIfMissing(d)).toBe("unavailable");
  });
});

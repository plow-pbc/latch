import { describe, expect, it } from "vitest";
import {
  SETUP_STEPS,
  canGoBackFrom,
  isResumableStep,
  setupProgress,
} from "../src/onboardingSteps.js";

describe("the setup step table", () => {
  it("gives every screen in the table a dot, in order", () => {
    SETUP_STEPS.forEach(({ step }, index) => {
      expect(setupProgress(step)).toEqual({ index, total: SETUP_STEPS.length });
    });
  });

  it("counts the waiting screen as the activation screen it still is", () => {
    expect(setupProgress("waiting")).toEqual(setupProgress("activate"));
  });

  it.each(["welcome", "done", "nonsense"])("gives %s no dot", (step) => {
    expect(setupProgress(step)).toBeNull();
  });

  // `activate`/`waiting` are false because the activation secret lives in
  // memory and never on disk: a resumed setup pointing there would show a code
  // it cannot redeem.
  it.each([
    ["activate", false],
    ["waiting", false],
    ["welcome", false],
    ["done", false],
    ["nonsense", false],
    ["privacy", true],
    ["gatekeeper", true],
    ["plugins", true],
    ["access", true],
    ["availability", true],
  ] as const)("reports %s as resumable: %s", (step, expected) => {
    expect(isResumableStep(step)).toBe(expected);
  });

  it.each([
    ["activate", "welcome"],
    ["waiting", "welcome"],
    ["gatekeeper", "privacy"],
    ["plugins", "gatekeeper"],
    // Access may have been skipped entirely, so Availability goes back past it.
    ["access", "plugins"],
    ["availability", "plugins"],
    // No Back from a redeemed code, and none off the ends.
    ["welcome", null],
    ["privacy", null],
    ["done", null],
  ] as const)("goes back from %s to %s", (step, previous) => {
    expect(canGoBackFrom(step)).toBe(previous);
  });
});
